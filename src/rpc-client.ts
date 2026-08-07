/**
 * RPC client for the Prime Agent CLI (`prime-agent --mode rpc`).
 *
 * Spawns the agent as a child process and speaks newline-delimited JSON over
 * stdio. This module has no vscode dependency so it can be smoke-tested headless.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { delimiter } from "node:path";
import * as fs from "node:fs";

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
}

interface PendingRequest {
	resolve: (value: RpcReply) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
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
		this._stderr = "";

		this.process = spawn(command, args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.process.stdout?.setEncoding("utf8");
		this.process.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		this.process.stderr?.setEncoding("utf8");
		this.process.stderr?.on("data", (chunk: string) => {
			this._stderr += chunk;
			if (this._stderr.length > 64_000) {
				this._stderr = this._stderr.slice(-32_000);
			}
			this.emit("stderr", chunk);
		});
		this.process.on("error", (err) => {
			this.failAll(err);
			this.emit("spawnError", err);
		});
		this.process.on("exit", (code, signal) => {
			this.process = null;
			this.failAll(new Error(`prime-agent exited (code ${code ?? "?"}, signal ${signal ?? "none"})`));
			this.emit("exit", code, signal);
		});
	}

	/** Resolve a bare command name to an absolute path where possible so spawn errors are clearer. */
	private resolveCommand(command: string): string {
		if (command.includes("/") || command.includes("\\")) {
			return command;
		}
		const pathEnv = process.env.PATH ?? "";
		const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
		for (const dir of pathEnv.split(delimiter)) {
			for (const ext of extensions) {
				const candidate = `${dir}/${command}${ext}`;
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					return candidate;
				} catch {
					// keep looking
				}
			}
		}
		return command;
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		// Strict JSONL framing: split on \n only (per rpc.md), tolerate trailing \r.
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim().length > 0) {
				this.handleLine(line);
			}
			newline = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			this.emit("protocolError", line);
			return;
		}
		this.options.onWire?.(
			`<- ${String(parsed.type)}${parsed.type === "response" ? `/${String(parsed.command)} success=${String(parsed.success)}` : ""}`,
		);

		if (parsed.type === "response") {
			const id = parsed.id as string | undefined;
			if (id) {
				const entry = this.pending.get(id);
				if (entry) {
					this.pending.delete(id);
					clearTimeout(entry.timer);
					entry.resolve({
						command: parsed.command as string | undefined,
						success: parsed.success === true,
						data: parsed.data,
						error: typeof parsed.error === "string" ? parsed.error : undefined,
					});
					return;
				}
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
		const id = `req-${++this.nextId}`;
		const body = { ...command, id };
		return new Promise<RpcReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request ${command.type} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.writeLine(JSON.stringify(body));
		});
	}

	/** Fire-and-forget message (used for extension_ui_response and abort). */
	sendRaw(message: Record<string, unknown>): void {
		if (!this.process) return;
		this.writeLine(JSON.stringify(message));
	}

	private writeLine(line: string): void {
		try {
			this.options.onWire?.(`-> ${line.slice(0, 140)}`);
			this.process?.stdin?.write(`${line}\n`);
		} catch (err) {
			this.emit("protocolError", err);
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
