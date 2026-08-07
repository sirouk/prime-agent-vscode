/**
 * Minimal client for the prime-agent daemon protocol (prime-agent.daemon v7).
 *
 * The RPC-mode subprocess owns its session (client-owned worker) — it cannot
 * attach to an already-live terminal session ("Session is already active").
 * The terminal client is only ever a VIEW of a daemon-brokered session: any
 * number of terminals attach to and steer the same resident session. To get
 * the same parity from VS Code we speak the daemon protocol directly for the
 * resident-session cases: attach, view, prompt, abort, compact, detach.
 *
 * Socket: unix socket <tmp>/prime-agent-<uid>/daemon.sock (Windows: named
 * pipe), LF-delimited JSON lines. The daemon is guaranteed to exist while our
 * own RPC session runs (RPC mode itself is a daemon client and autostarts it).
 */

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const PROTOCOL_NAME = "prime-agent.daemon";
const PROTOCOL_VERSION = 7;

export interface DaemonHello {
	socketPath?: string;
	protocol?: { name?: string; version?: number };
	schemaRevision?: number;
	appVersion?: string;
	clientId?: string;
}

export interface SessionSummaryRef {
	id?: string;
	activeSessionId?: string;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	sessionName?: string;
	created?: string;
	modified?: string;
	parentActiveSessionId?: string;
	attachedClients?: number;
	isStreaming?: boolean;
	lifecycle?: string;
}

export interface AttachSnapshot {
	summary?: SessionSummaryRef;
	state?: Record<string, unknown>;
	messages?: Array<Record<string, unknown>>;
	children?: SessionSummaryRef[];
	lastEventSequence?: number;
}

export interface AttachResult {
	snapshot?: AttachSnapshot;
	replay?: unknown;
}

export type DaemonServerMessage = Record<string, unknown> & {
	type: string;
	activeSessionId?: string;
	event?: Record<string, unknown>;
	meta?: { generation?: number; sequence?: number; cursor?: string };
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class DaemonSidecar {
	private socket: net.Socket | null = null;
	private nextIdValue = 1;
	private readonly pending = new Map<string, Pending>();
	private buffer = "";
	private helloResolve: ((hello: DaemonHello) => void) | null = null;
	hello: DaemonHello | null = null;
	connected = false;
	/** Diagnostic: number of parsed socket lines since attach (used by live-driver probes). */
	traceCount = 0;
	lastLineAtom = "";
	/** Hook for EVERY raw socket line (diagnostic routing). */
	onAnyLine: (line: string) => void = () => {};
	/** Hook for every non-response daemon message (session_event, session_status, ...). */
	onEvent: (message: DaemonServerMessage) => void = () => {};
	/** Hook when the socket closes so hosts can invalidate attached state. */
	onClose: () => void = () => {};

	isSupported(): boolean {
		if (!this.hello) return false;
		const nameOk = !this.hello.protocol?.name || this.hello.protocol.name === PROTOCOL_NAME;
		const versionOk = this.hello.protocol?.version == null || this.hello.protocol.version >= PROTOCOL_VERSION;
		return nameOk && versionOk;
	}

	socketPath(): string {
		if (os.platform() === "win32") return "\\\\.\\pipe\\prime-agent-daemon";
		return path.join(os.tmpdir(), `prime-agent-${process.getuid?.() ?? "user"}`, "daemon.sock");
	}

	async connect(timeoutMs = 10_000): Promise<void> {
		if (this.connected && this.hello) return;
		const sockPath = this.socketPath();
		if (this.socket) {
			this.dispose();
		}
		const socket = new net.Socket();
		this.socket = socket;
		const helloWait = new Promise<DaemonHello>((resolve, reject) => {
			this.helloResolve = resolve;
			const timer = setTimeout(() => reject(new Error("daemon hello timed out")), timeoutMs);
			this.helloResolve = (hello) => {
				clearTimeout(timer);
				resolve(hello);
			};
		});
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			let index = this.buffer.indexOf("\n");
			while (index >= 0) {
				const line = this.buffer.slice(0, index).trim();
				this.buffer = this.buffer.slice(index + 1);
				if (line) this.handleLine(line);
				index = this.buffer.indexOf("\n");
			}
		});
		socket.on("close", () => this.onSocketClosed());
		socket.on("error", () => {
			/* errors surface through close/pending time-outs */
		});
		await new Promise<void>((resolve, reject) => {
			const onErr = () => reject(new Error(`daemon socket unavailable at ${sockPath}`));
			socket.once("error", onErr);
			socket.connect({ path: sockPath }, () => {
				socket.off("error", onErr);
				resolve();
			});
		});
		this.hello = await helloWait;
		if (!this.isSupported()) {
			this.dispose();
			throw new Error(
				`daemon protocol mismatch: got ${this.hello.protocol?.name ?? "?"} v${this.hello.protocol?.version ?? "?"}, expected ${PROTOCOL_NAME} v${PROTOCOL_VERSION}+`,
			);
		}
		this.connected = true;
	}

	private onSocketClosed(): void {
		this.connected = false;
		const error = new Error("daemon socket closed");
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.onClose();
	}

	private handleLine(line: string): void {
		this.traceCount += 1;
		this.lastLineAtom = line.slice(0, 60);
		this.onAnyLine(line.slice(0, 120));
		let message: DaemonServerMessage;
		try {
			message = JSON.parse(line) as DaemonServerMessage;
		} catch {
			return;
		}
		if (message.type === "daemon_hello") {
			this.helloResolve?.(message as unknown as DaemonHello);
			return;
		}
		if (message.type === "response" && typeof (message as { id?: unknown }).id === "string") {
			const id = (message as unknown as { id: string }).id;
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				clearTimeout(pending.timer);
				if ((message as { success?: boolean }).success === false) {
					const errorInfo = (message as { errorInfo?: { message?: string; code?: string; activeSessionId?: string } }).errorInfo;
					const detail =
						typeof (message as { error?: unknown }).error === "string"
							? ((message as unknown as { error: string }).error)
							: (errorInfo?.message ?? "daemon error");
					const error = new Error(detail) as Error & { code?: string; activeSessionId?: string };
					error.code = errorInfo?.code;
					error.activeSessionId = errorInfo?.activeSessionId;
					pending.reject(error);
				} else {
					pending.resolve((message as { data?: unknown }).data);
				}
			}
			return;
		}
		this.onEvent(message);
	}

	private nextId(): string {
		return `side-${(this.nextIdValue++).toString(36)}`;
	}

	async request<T = unknown>(command: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
		if (!this.connected || !this.socket) throw new Error("daemon sidecar is not connected");
		const id = this.nextId();
		const line = `${JSON.stringify({
			type: "command",
			id,
			protocol: { name: PROTOCOL_NAME, version: PROTOCOL_VERSION },
			command,
		})}\n`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`daemon command timed out: ${String(command.type)}`));
			}, timeoutMs);
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			this.socket?.write(line, "utf8");
		});
	}

	async list(all = false): Promise<SessionSummaryRef[]> {
		const data = await this.request<{ sessions?: SessionSummaryRef[] }>({ type: "list", all }, 20_000);
		return data.sessions ?? [];
	}

	async attach(activeSessionId: string): Promise<AttachResult> {
		return this.request<AttachResult>(
			{ type: "attach", activeSessionId, capabilities: ["attach_snapshot", "event_sequence", "slim_attach"] },
			30_000,
		);
	}

	async detach(activeSessionId: string): Promise<void> {
		try {
			await this.request({ type: "detach", activeSessionId }, 15_000);
		} catch {
			// already detached is fine
		}
	}

	async prompt(activeSessionId: string, text: string, streamingBehavior: "steer" | "followUp" = "steer"): Promise<void> {
		await this.request({ type: "prompt", activeSessionId, message: text, streamingBehavior, queueIfBusy: true }, 20_000);
	}

	async abort(activeSessionId: string): Promise<void> {
		await this.request({ type: "abort", activeSessionId }, 15_000);
	}

	async compact(activeSessionId: string): Promise<void> {
		await this.request({ type: "compact", activeSessionId }, 300_000);
	}

	async getMessages(activeSessionId: string): Promise<Array<Record<string, unknown>>> {
		const data = await this.request<{ messages?: Array<Record<string, unknown>> }>({ type: "get_messages", activeSessionId }, 60_000);
		return data.messages ?? [];
	}

	async getState(activeSessionId: string): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>({ type: "get_state", activeSessionId }, 20_000);
	}

	dispose(): void {
		try {
			this.socket?.destroy();
		} catch {
			// ignore
		}
		this.socket = null;
		this.connected = false;
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("sidecar disposed"));
		}
		this.pending.clear();
	}
}
