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

export { agentDirForSessionFile, defaultAgentDir, resolveOwnerClientId } from "./daemon-owner.js";
export type { OwnerLookup, WorkerDescriptorRef } from "./daemon-owner.js";

const PROTOCOL_NAME = "prime-agent.daemon";
const PROTOCOL_VERSION = 7;
const MAX_JSONL_FRAME_BYTES = 4 * 1024 * 1024;

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
	/** "live" | "draft" | "archived" — the CLI's roster shows only "live". */
	lifecycle?: string;
	/** > 0 marks a subagent; those belong under their parent, not in history. */
	rlmDepth?: number;
	messageCount?: number;
	/** First user message, already truncated by the daemon. Our row subtitle. */
	firstMessage?: string;
	lastActivityAt?: string;
	// The CLI calls a session "running" from a much wider set of signals than
	// isStreaming (classifySessionRosterStatus). All of these ride on the same
	// summary we already receive; declaring them keeps our verdict identical.
	activity?: string;
	isSessionActive?: boolean;
	hasActiveHeartbeat?: boolean;
	isCompacting?: boolean;
	isBashRunning?: boolean;
	hasRunningRlmChildren?: boolean;
	unfinishedActionCount?: number;
	/**
	 * The assistant message currently being generated. Lives ONLY here — the
	 * snapshot's `messages` is the committed transcript, so a client that reads
	 * messages alone shows nothing at all while a turn is mid-flight.
	 */
	streamingMessage?: Record<string, unknown>;
}

/** A row of the daemon's saved-session catalog (`list_saved_sessions`). */
export interface SavedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: { status?: string };
	rlmDepth?: number;
	created?: string;
	modified?: string;
	messageCount?: number;
	firstMessage?: string;
	/** Flattened conversation text, truncated by the daemon. The search corpus. */
	allMessagesText?: string;
	agentStatus?: { summary?: string };
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
	/** The handshake belongs to one concrete socket, never to the next reconnect. */
	private helloWait:
		| {
				socket: net.Socket;
				resolve: (hello: DaemonHello) => void;
				reject: (error: Error) => void;
				timer: NodeJS.Timeout;
		  }
		| null = null;
	hello: DaemonHello | null = null;
	connected = false;
	/** Diagnostic: number of parsed socket lines since attach (used by live-driver probes). */
	traceCount = 0;
	lastLineAtom = "";
	/** Hook for every socket record's size, without exposing its private payload. */
	onAnyLine: (byteLength: number) => void = () => {};
	/** Hook for every non-response daemon message (session_event, session_status, ...). */
	onEvent: (message: DaemonServerMessage) => void = () => {};
	/** Hook when the socket closes so hosts can invalidate attached state. */
	onClose: () => void = () => {};
	/**
	 * Protocol client id to claim in every command envelope on this connection.
	 *
	 * The daemon rewrites the connection's identity to whatever the envelope
	 * declares (daemon-supervisor.ts: `protocolClientIds.set(client, id)` and
	 * `client.id = id`), which is the only way a second connection can read the
	 * roster of a worker its RPC sibling owns.
	 *
	 * Set this ONLY on a short-lived connection (see `listAsOwner`). A long-lived
	 * client holding an owner id keeps `scheduleOwnedWorkerCleanup` from ever
	 * reaping that worker, so an exited RPC process would leak its worker and
	 * kernels for as long as this extension stays open.
	 */
	impersonateClientId: string | null = null;

	isSupported(): boolean {
		if (!this.hello) return false;
		const nameOk = this.hello.protocol?.name === PROTOCOL_NAME;
		const versionOk = typeof this.hello.protocol?.version === "number" && this.hello.protocol.version >= PROTOCOL_VERSION;
		return nameOk && versionOk;
	}

	socketPath(): string {
		// A private daemon socket lets integration tests (and isolated operator
		// setups) avoid taking ownership of an unrelated default background daemon.
		const configured = process.env.PRIME_AGENT_DAEMON_SOCKET?.trim();
		if (configured) return configured;
		if (os.platform() === "win32") return "\\\\.\\pipe\\prime-agent-daemon";
		return path.join(os.tmpdir(), `prime-agent-${process.getuid?.() ?? "user"}`, "daemon.sock");
	}

	/**
	 * Memoized handshake. Without this, a second caller arriving mid-connect
	 * disposes the socket the first one is still awaiting and steals
	 * `helloResolve` (one shared field), so the first await hangs until its
	 * 10s timeout — which is how a history refresh raced by an agent_end used
	 * to report "nothing is running" for every row.
	 */
	async connect(timeoutMs = 10_000): Promise<void> {
		if (this.connected && this.hello) return;
		if (this.connecting) return this.connecting;
		this.connecting = this.doConnect(timeoutMs).finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private connecting: Promise<void> | null = null;

	private async doConnect(timeoutMs: number): Promise<void> {
		const sockPath = this.socketPath();
		// Safe now that connect() is serialized: any socket still here is dead or
		// abandoned by a timed-out handshake, never one a caller is waiting on.
		if (this.socket) {
			this.dispose();
		}
		const socket = new net.Socket();
		this.socket = socket;
		this.connected = false;
		this.hello = null;
		this.buffer = "";
		const helloWait = new Promise<DaemonHello>((resolve, reject) => {
			const timer = setTimeout(() => this.rejectHello(socket, new Error("daemon hello timed out")), timeoutMs);
			this.helloWait = { socket, resolve, reject, timer };
		});
		socket.setNoDelay(true);
		// Node's decoder preserves a multi-byte UTF-8 character split across TCP
		// packets; Buffer#toString on every packet does not.
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			if (this.socket !== socket) return;
			this.buffer += chunk;
			let index = this.buffer.indexOf("\n");
			while (index >= 0) {
				const line = this.buffer.slice(0, index).trim();
				this.buffer = this.buffer.slice(index + 1);
				if (Buffer.byteLength(line, "utf8") > MAX_JSONL_FRAME_BYTES) {
					this.rejectOversizedFrame(socket);
					return;
				}
				if (line) this.handleLine(socket, line);
				index = this.buffer.indexOf("\n");
			}
			// Apply the cap only to the residual unterminated record. A single TCP
			// read can legitimately contain several complete frames whose aggregate
			// size exceeds the per-frame ceiling.
			if (Buffer.byteLength(this.buffer, "utf8") > MAX_JSONL_FRAME_BYTES) this.rejectOversizedFrame(socket);
		});
		socket.on("close", () => this.onSocketClosed(socket));
		socket.on("error", () => {
			/* errors surface through close/pending time-outs */
		});
		try {
			const connectWait = new Promise<void>((resolve, reject) => {
				let settled = false;
				const cleanUp = (): void => {
					socket.off("error", fail);
					socket.off("close", fail);
				};
				const fail = (): void => {
					if (settled) return;
					settled = true;
					cleanUp();
					reject(new Error(`daemon socket unavailable at ${sockPath}`));
				};
				socket.once("error", fail);
				socket.once("close", fail);
				socket.connect({ path: sockPath }, () => {
					if (settled) return;
					settled = true;
					cleanUp();
					resolve();
				});
			});
			const [, hello] = await Promise.all([connectWait, helloWait]);
			if (this.socket !== socket) throw new Error("daemon socket was replaced during handshake");
			this.hello = hello;
			if (!this.isSupported()) {
				const protocol = hello.protocol;
				this.dispose();
				throw new Error(
					`daemon protocol mismatch: got ${protocol?.name ?? "?"} v${protocol?.version ?? "?"}, expected ${PROTOCOL_NAME} v${PROTOCOL_VERSION}+`,
				);
			}
			this.connected = true;
		} catch (error) {
			this.rejectHello(socket, error instanceof Error ? error : new Error(String(error)));
			if (this.socket === socket) {
				this.socket = null;
				this.connected = false;
				this.hello = null;
				this.buffer = "";
				try {
					socket.destroy();
				} catch {
					// already closed
				}
			}
			throw error;
		}
	}

	private rejectOversizedFrame(socket: net.Socket): void {
		if (this.socket !== socket) return;
		this.buffer = "";
		this.onSocketClosed(socket);
		try {
			socket.destroy(new Error("daemon frame exceeded 4 MiB"));
		} catch {
			// already closed
		}
	}

	/** A non-object/non-JSON line invalidates the peer just like an oversized frame. */
	private rejectMalformedFrame(socket: net.Socket): void {
		if (this.socket !== socket) return;
		this.buffer = "";
		this.onSocketClosed(socket);
		try {
			socket.destroy(new Error("daemon sent a malformed JSONL record"));
		} catch {
			// already closed
		}
	}

	private resolveHello(socket: net.Socket, hello: DaemonHello): void {
		const wait = this.helloWait;
		if (!wait || wait.socket !== socket) return;
		this.helloWait = null;
		clearTimeout(wait.timer);
		wait.resolve(hello);
	}

	private rejectHello(socket: net.Socket, error: Error): void {
		const wait = this.helloWait;
		if (!wait || wait.socket !== socket) return;
		this.helloWait = null;
		clearTimeout(wait.timer);
		wait.reject(error);
	}

	private onSocketClosed(socket: net.Socket): void {
		if (this.socket !== socket) return;
		this.socket = null;
		this.connected = false;
		this.hello = null;
		this.buffer = "";
		const error = new Error("daemon socket closed");
		this.rejectHello(socket, error);
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.onClose();
	}

	private handleLine(socket: net.Socket, line: string): void {
		if (this.socket !== socket) return;
		this.traceCount += 1;
		// Keep diagnostics useful without retaining a fragment of prompts, tool
		// output, or model responses in a long-lived public field.
		this.lastLineAtom = "invalid";
		this.onAnyLine(Buffer.byteLength(line, "utf8"));
		let message: DaemonServerMessage;
		try {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { type?: unknown }).type !== "string") {
				this.rejectMalformedFrame(socket);
				return;
			}
			message = value as DaemonServerMessage;
		} catch {
			this.rejectMalformedFrame(socket);
			return;
		}
		this.lastLineAtom = message.type;
		if (message.type === "daemon_hello") {
			this.resolveHello(socket, message as unknown as DaemonHello);
			return;
		}
		if (message.type === "response") {
			const id = (message as { id?: unknown }).id;
			if (typeof id !== "string" || typeof (message as { success?: unknown }).success !== "boolean") {
				this.rejectMalformedFrame(socket);
				return;
			}
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
		const socket = this.socket;
		if (!this.connected || !socket) throw new Error("daemon sidecar is not connected");
		const id = this.nextId();
		const line = `${JSON.stringify({
			type: "command",
			id,
			protocol: { name: PROTOCOL_NAME, version: PROTOCOL_VERSION },
			...(this.impersonateClientId ? { clientId: this.impersonateClientId } : {}),
			command,
		})}\n`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`daemon command timed out: ${String(command.type)}`));
			}, timeoutMs);
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			if (this.socket !== socket || socket.destroyed) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error("daemon sidecar disconnected before the command could be sent"));
				return;
			}
			try {
				socket.write(line, "utf8");
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async list(all = false, options: { includeClientOwned?: boolean } = {}): Promise<SessionSummaryRef[]> {
		// `data` is optional in the envelope: a success with no payload must read as
		// "no rows", not as a TypeError thrown from inside a caller's try block.
		const data = await this.request<{ sessions?: SessionSummaryRef[] } | undefined>(
			{ type: "list", all, ...(options.includeClientOwned ? { includeClientOwned: true } : {}) },
			20_000,
		);
		return data?.sessions ?? [];
	}

	/**
	 * Roster read that can also see the client-owned worker hosting our own RPC
	 * session — the one carrying our live root and every RLM subagent.
	 *
	 * Both halves are required and neither is sufficient: the daemon needs
	 * `includeClientOwned: true` AND an envelope client id equal to the worker's
	 * `ownerClientId`. Verified against a live daemon: `list all` alone and
	 * `list all + includeClientOwned` both return zero active rows and zero
	 * subagents, while the pair returns the streaming root plus its children.
	 *
	 * The identity is claimed on a THROWAWAY connection that is disposed before
	 * this resolves. The daemon reschedules owned-worker cleanup when a client
	 * disconnects, so a transient claim can at most postpone a reap by the
	 * 30s grace window; a persistent claim would postpone it forever.
	 *
	 * Returns a superset of `list(all)`: the supervisor's filter is
	 * `isVisibleWorker(worker) || (includeClientOwned && accessible)`.
	 */
	static async listAsOwner(ownerClientId: string, all = true, timeoutMs = 10_000): Promise<SessionSummaryRef[]> {
		const owned = new DaemonSidecar();
		owned.impersonateClientId = ownerClientId;
		try {
			await owned.connect(timeoutMs);
			return await owned.list(all, { includeClientOwned: true });
		} finally {
			owned.dispose();
		}
	}

	/**
	 * The saved-session catalog. This is the ONLY daemon command that carries
	 * `allMessagesText` (daemon-mode.ts `list_saved_sessions`); `list` does not,
	 * so a search over conversation bodies has to come from here. The daemon
	 * streams progress rows while it works — those arrive on onEvent and are
	 * ignored; the response carries the whole list.
	 */
	async listSavedSessions(cwd: string, scope: "current" | "all" = "all"): Promise<SavedSessionInfo[]> {
		const data = await this.request<{ sessions?: SavedSessionInfo[] } | undefined>({ type: "list_saved_sessions", cwd, scope }, 60_000);
		return data?.sessions ?? [];
	}

	async attach(activeSessionId: string): Promise<AttachResult> {
		return (
			(await this.request<AttachResult | undefined>(
				{ type: "attach", activeSessionId, capabilities: ["attach_snapshot", "event_sequence", "slim_attach"] },
				30_000,
			)) ?? {}
		);
	}

	async detach(activeSessionId: string): Promise<void> {
		try {
			await this.request({ type: "detach", activeSessionId }, 15_000);
		} catch {
			// already detached is fine
		}
	}

	async prompt(
		activeSessionId: string,
		text: string,
		streamingBehavior: "steer" | "followUp" = "steer",
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
	): Promise<void> {
		await this.request(
			{
				type: "prompt",
				activeSessionId,
				message: text,
				streamingBehavior,
				queueIfBusy: true,
				...(images?.length ? { images } : {}),
			},
			20_000,
		);
	}

	async abort(activeSessionId: string): Promise<void> {
		await this.request({ type: "abort", activeSessionId }, 15_000);
	}

	/**
	 * No meaningful client-side deadline. prime-agent's own daemon client already
	 * times out at 30s and says so; adding a second, shorter stopwatch here only
	 * manufactures a different lie about the same still-running work. A daemon
	 * that dies settles this promise through onSocketClosed, which is the honest
	 * end condition.
	 */
	async compact(activeSessionId: string): Promise<void> {
		await this.request({ type: "compact", activeSessionId }, 30 * 60_000);
	}

	async getMessages(activeSessionId: string): Promise<Array<Record<string, unknown>>> {
		const data = await this.request<{ messages?: Array<Record<string, unknown>> } | undefined>({ type: "get_messages", activeSessionId }, 60_000);
		return data?.messages ?? [];
	}

	async getState(activeSessionId: string): Promise<Record<string, unknown>> {
		return (await this.request<Record<string, unknown> | undefined>({ type: "get_state", activeSessionId }, 20_000)) ?? {};
	}

	async getSessionStats(activeSessionId: string): Promise<Record<string, unknown>> {
		return (await this.request<Record<string, unknown> | undefined>({ type: "get_session_stats", activeSessionId }, 20_000)) ?? {};
	}

	dispose(): void {
		const socket = this.socket;
		this.socket = null;
		this.connected = false;
		this.hello = null;
		this.buffer = "";
		if (socket) this.rejectHello(socket, new Error("sidecar disposed"));
		try {
			socket?.destroy();
		} catch {
			// ignore
		}
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("sidecar disposed"));
		}
		this.pending.clear();
	}
}
