/**
 * RPC client for the Prime Agent CLI (`prime-agent --mode rpc`).
 *
 * Spawns the agent as a child process and speaks newline-delimited JSON over
 * stdio. This module has no vscode dependency so it can be smoke-tested headless.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { searchDirs, splitPath } from "./agent-locator.js";
import { MAX_JSONL_FRAME_BYTES, MAX_JSONL_FRAME_LABEL } from "./wire-limits.js";

export interface RpcClientOptions {
	/** Command or absolute path used to launch the agent (default: "prime-agent") */
	command?: string;
	/** Extra args appended after --mode rpc */
	args?: string[];
	/** Working directory for the agent */
	cwd?: string;
	/** Extra environment variables */
	env?: Record<string, string>;
	/** Optional wire trace hook invoked for every parsed inbound record (types only). */
	onWire?: (summary: string) => void;
	/**
	 * Runaway-peer frame cap. Overridable so the transport regressions can prove
	 * the guard without pushing the real 64 MiB through a pipe.
	 */
	maxFrameBytes?: number;
}

interface PendingRequest {
	resolve: (value: RpcReply) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface LaunchSpec {
	command: string;
	args: string[];
}



export interface RpcReply {
	command?: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export class RpcClient extends EventEmitter {
	private process: ChildProcess | null = null;
	private pending = new Map<string, PendingRequest>();
	private nextId = 0;
	private buffer = "";
	private _stderr = "";

	constructor(private readonly options: RpcClientOptions = {}) {
		super();
	}

	/** Frame cap in force for this client; see wire-limits.ts for the rationale. */
	private get maxFrameBytes(): number {
		return this.options.maxFrameBytes ?? MAX_JSONL_FRAME_BYTES;
	}

	private get maxFrameLabel(): string {
		return this.options.maxFrameBytes === undefined ? MAX_JSONL_FRAME_LABEL : `${this.options.maxFrameBytes} bytes`;
	}

	get stderrText(): string {
		return this._stderr;
	}

	get running(): boolean {
		return this.process !== null;
	}

	start(): void {
		if (this.process) return;
		const command = this.resolveCommand(this.options.command ?? "prime-agent");
		const args = ["--mode", "rpc", ...(this.options.args ?? [])];
		const launch = this.launchSpec(command, args);
		this._stderr = "";
		// A stopped child can emit its final close/error event after a replacement
		// has already started. Keep every handler bound to the child that created it
		// so an old process cannot take the new transport offline.
		this.buffer = "";
		const proc = spawn(launch.command, launch.args, {
			cwd: this.options.cwd,
			// This flag makes Electron applications (including a configured
			// prime-agent wrapper) run as Node, not as their normal binary. It can
			// be inherited from automation hosts, so never leak it into the agent.
			env: (() => {
				const env = { ...process.env, ...this.options.env };
				delete env.ELECTRON_RUN_AS_NODE;
				return env;
			})(),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = proc;

		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => {
			if (this.process !== proc) return;
			this.onStdout(chunk);
		});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			if (this.process !== proc) return;
			this._stderr += chunk;
			if (this._stderr.length > 64_000) {
				this._stderr = this._stderr.slice(-32_000);
			}
			this.emit("stderr", chunk);
		});
		proc.stdin?.on("error", (err) => {
			if (this.process !== proc) return;
			// A broken stdin can no longer carry any command. Do not leave the
			// controller believing a live process is a usable RPC transport.
			this.failProtocol(err instanceof Error ? err : new Error(String(err)));
		});
		proc.on("error", (err) => {
			// A spawn failure (ENOENT/EACCES) emits "error" + "close" and never
			// "exit", so without this `running` latches true over a child that
			// never existed — and every later write is silently swallowed by its
			// destroyed stdin until the request times out.
			if (this.process !== proc) return;
			this.process = null;
			this.buffer = "";
			this.failAll(err);
			this.emit("spawnError", err);
		});
		proc.on("exit", (code, signal) => {
			if (this.process !== proc) return;
			this.process = null;
			this.buffer = "";
			this.failAll(new Error(`prime-agent exited (code ${code ?? "?"}, signal ${signal ?? "none"})`));
			this.emit("exit", code, signal);
		});
	}

	/**
	 * Resolve a bare command name to an absolute path where possible so spawn
	 * errors are clearer. This sees only the inherited PATH; the wider search
	 * that covers a GUI-launched editor lives in agent-locator.ts, and the
	 * controller hands the result here as an absolute path.
	 */
	private resolveCommand(command: string): string {
		if (command.includes("/") || command.includes("\\")) {
			return command;
		}
		return searchDirs(command, splitPath(process.env.PATH)) ?? command;
	}

	/**
	 * Node cannot directly spawn Windows .cmd/.bat shims. Route those through
	 * cmd.exe with a single quoted command line, while rejecting the shell
	 * metacharacters that would make a machine setting execute a second command.
	 */
	private launchSpec(command: string, args: string[]): LaunchSpec {
		if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) return { command, args };
		const unsafe = /[\r\n%!?^&|<>()"]/;
		if ([command, ...args].some((value) => unsafe.test(value))) {
			throw new Error("Windows .cmd/.bat launch arguments cannot contain cmd.exe metacharacters; configure an executable command instead");
		}
		const quote = (value: string): string => `"${value}"`;
		const commandLine = [quote(command), ...args.map(quote)].join(" ");
		const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
		return { command: comspec, args: ["/d", "/s", "/c", `"${commandLine}"`] };
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		// Strict JSONL framing: split on \n only (per rpc.md), tolerate trailing \r.
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
				this.failProtocol(new Error(`prime-agent RPC frame exceeded ${this.maxFrameLabel}`));
				return;
			}
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim().length > 0) {
				this.handleLine(line);
			}
			newline = this.buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
			this.failProtocol(new Error(`prime-agent RPC frame exceeded ${this.maxFrameLabel}`));
		}
	}

	/** A framing violation makes the transport unusable; never leave callers to time out. */
	private failProtocol(error: Error): void {
		const proc = this.process;
		this.buffer = "";
		this.emit("protocolError", error);
		this.failAll(error);
		if (!proc) return;
		this.process = null;
		try {
			proc.kill("SIGTERM");
		} catch {
			// The pipe may already be gone.
		}
		// The child exit handler is intentionally identity-guarded, so surface the
		// terminal state once here for hosts that drive their UI from `exit`.
		this.emit("exit", null, "protocol_error");
	}

	private handleLine(line: string): void {
		let parsed: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { type?: unknown }).type !== "string") {
				throw new Error("RPC record must be an object with a string type");
			}
			parsed = value as Record<string, unknown>;
		} catch {
			// JSONL is the whole transport contract. Keeping a pending request alive
			// after a malformed peer record only turns a deterministic protocol fault
			// into an opaque two-minute timeout (and risks logging prompt fragments).
			this.failProtocol(new Error("prime-agent RPC received a malformed JSONL record"));
			return;
		}
		this.options.onWire?.(
			`<- ${String(parsed.type)}${parsed.type === "response" ? `/${String(parsed.command)} success=${String(parsed.success)}` : ""}`,
		);

		if (parsed.type === "response") {
			const id = parsed.id;
			if (typeof id !== "string" || typeof parsed.success !== "boolean") {
				this.failProtocol(new Error("prime-agent RPC received an invalid response envelope"));
				return;
			}
			const entry = this.pending.get(id);
			if (entry) {
				this.pending.delete(id);
				clearTimeout(entry.timer);
				entry.resolve({
					command: typeof parsed.command === "string" ? parsed.command : undefined,
					success: parsed.success,
					data: parsed.data,
					error: typeof parsed.error === "string" ? parsed.error : undefined,
				});
				return;
			}
			this.emit("response", parsed);
			return;
		}

		this.emit("message", parsed);
		if (parsed.type === "extension_ui_request") {
			this.emit("extensionUiRequest", parsed);
		} else {
			this.emit("event", parsed);
		}
	}

	/** Send a command and await its response. Use sendRaw() for extension_ui_response (no response follows). */
	request(command: Record<string, unknown>, timeoutMs = 120_000): Promise<RpcReply> {
		if (!this.process) {
			return Promise.reject(new Error("Agent process is not running"));
		}
		const proc = this.process;
		const id = `req-${++this.nextId}`;
		const body = { ...command, id };
		this.options.onWire?.(`-> ${String(command.type ?? "command")}`);
		return new Promise<RpcReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request ${command.type} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			if (!this.writeLine(JSON.stringify(body), proc)) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error("Agent process stopped before the request could be sent"));
			}
		});
	}

	/** Fire-and-forget message (used for extension_ui_response and abort). */
	sendRaw(message: Record<string, unknown>): void {
		const proc = this.process;
		if (!proc) return;
		this.options.onWire?.(`-> ${String(message.type ?? "message")}`);
		this.writeLine(JSON.stringify(message), proc);
	}

	private writeLine(line: string, proc: ChildProcess): boolean {
		if (this.process !== proc || !proc.stdin?.writable) return false;
		try {
			proc.stdin.write(`${line}\n`);
			return true;
		} catch (err) {
			this.emit("protocolError", err);
			return false;
		}
	}

	private failAll(error: Error): void {
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}

	stop(): void {
		if (!this.process) return;
		const proc = this.process;
		this.process = null;
		this.buffer = "";
		try {
			proc.kill("SIGTERM");
		} catch {
			// already gone
		}
		const killer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// already gone
			}
		}, 1500);
		killer.unref?.();
		this.failAll(new Error("Agent process stopped"));
	}
}
