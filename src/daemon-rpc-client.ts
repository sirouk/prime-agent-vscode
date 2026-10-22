/**
 * A Prime Agent session hosted by the background service (the daemon), driven
 * through the same interface as an `RpcClient`.
 *
 * Why this exists. `prime-agent --mode rpc` used to be a daemon client: the
 * agent process created a client-owned worker on the daemon and relayed to it,
 * so a window's own session could spawn subagents, run schedules and heartbeats,
 * message other agents, and run bash. The Rust build (0.10+) made `--mode rpc`
 * an in-process engine that answers all of that with "requires daemon mode" —
 * `rlm.spawn` raises "requires a daemon-backed session: this session has no RLM
 * child runtime". The daemon itself is unchanged, so the extension now does what
 * the old agent process did on its behalf: create the session on the daemon
 * (client-owned, so it ends with this window exactly as the subprocess did) and
 * attach to it. Everything above this class keeps talking RPC.
 *
 * Wire notes, each verified against a live 0.10.1 daemon:
 *  - A daemon `session_event` carries the very event objects RPC streams, so they
 *    are re-emitted untouched.
 *  - `new_session` keeps the same attach handle; there is no re-attach to do.
 *  - Daemon `get_state` answers with the roster *summary*; the RPC-shaped state
 *    (available thinking levels, queue modes, auto-compaction, goal, context
 *    usage) is `get_connection_state`. `get_state` here is both, merged.
 *  - A refused command is an answer (`success:false`), a dead or silent socket is
 *    not: the former resolves, the latter rejects, as `RpcClient.request` does.
 *
 * No vscode dependency: exercised headless against a real daemon.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import { resolveWorkerDescriptor } from "./daemon-owner.js";
import { DaemonCommandError, DaemonSidecar, type DaemonServerMessage } from "./daemon-sidecar.js";
import type { RpcReply } from "./rpc-client.js";

export interface DaemonRpcClientOptions {
	/** Resolved daemon socket (see daemon-endpoint.ts). */
	socketPath: string;
	/** `config` of the session `create` (see session-config.ts). */
	config: Record<string, unknown>;
	/** Environment the session's worker should run in (the client's, like a terminal's). */
	launchEnv?: Record<string, string>;
	/** Opt this session out of telemetry when the environment says so. */
	telemetryDisabled?: boolean;
	/** Wire trace hook invoked for every record (types only). */
	onWire?: (summary: string) => void;
	/** Runaway-peer frame cap; overridable so tests can prove the guard. */
	maxFrameBytes?: number;
}

/** Retry delays after an unexpected socket loss; the wall-clock budget below stays inside the daemon's 30s client-owned grace. */
const RECONNECT_BACKOFF_MS = [300, 700, 1_500, 3_000, 6_000, 10_000];
const ATTACH_CAPABILITIES = ["attach_snapshot", "event_sequence", "slim_attach"];
const CREATE_TIMEOUT_MS = 90_000;

/** The one daemon verb whose spelling differs from the RPC verb the controller sends. */
const RENAMED_COMMANDS: Record<string, string> = {
	get_fork_messages: "get_user_messages_for_forking",
	bash: "execute_bash",
};

/**
 * Refusals the daemon documents as "wait and ask again" (`outbound.rs`): a daemon that is
 * restarting for an update, a worker still recovering, one that is overloaded. Anything
 * else on a re-attach (unknown session) means the session is gone.
 */
const RETRYABLE_REFUSALS = new Set(["update_restarting", "session_recovering", "worker_overloaded"]);
/** Wall-clock bound for getting back to a session after the connection dropped. */
const RECONNECT_BUDGET_MS = 28_000;
/** How long `stop()` waits for a session that is still being created before letting go of the socket. */
const STOP_DURING_OPEN_GRACE_MS = 2_000;

const ok = (data?: unknown): RpcReply => ({ success: true, ...(data === undefined ? {} : { data }) });
const fail = (error: string): RpcReply => ({ success: false, error });

/** Reasons after which the session is gone for good; `update`/`replaced` hand over to a new worker instead. */
const TERMINAL_CLOSE_REASONS = new Set(["killed", "shutdown", "completed"]);

export class DaemonRpcClient extends EventEmitter {
	readonly kind = "daemon" as const;
	/** The daemon's 12-char handle for this session. Stable across `new_session`. */
	activeSessionId: string | null = null;
	/**
	 * The daemon client id that owns the session. A second connection that claims
	 * it can read the owner-scoped roster (this window's own subagents); the
	 * controller's sidecar does exactly that.
	 */
	ownerClientId: string | null = null;
	stderrText = "";

	private sidecar: DaemonSidecar | null = null;
	private openPromise: Promise<void> | null = null;
	private opened = false;
	private closed = false;
	private intentional = false;
	private reconnecting: Promise<boolean> | null = null;
	private closingReason: "update" | "shutdown" | null = null;
	private stopPromise: Promise<void> | null = null;

	constructor(private readonly options: DaemonRpcClientOptions) {
		super();
	}

	/** Usable for requests: opening or open, and not stopped. */
	get running(): boolean {
		return !this.closed && (this.opened || this.openPromise !== null);
	}

	/** RpcClient compatibility: opening is asynchronous, callers that need the result use `open()`. */
	start(): void {
		void this.open().catch(() => {
			/* reported to whoever awaits open() */
		});
	}

	/** Connect, create the session, attach to it. Rejects with the reason the session could not start. */
	open(): Promise<void> {
		if (!this.openPromise) {
			this.openPromise = this.doOpen().catch((error: unknown) => {
				this.closed = true;
				this.disposeSidecar();
				throw error;
			});
		}
		return this.openPromise;
	}

	private newSidecar(impersonate: string | null): DaemonSidecar {
		const sidecar = new DaemonSidecar();
		sidecar.socketOverride = this.options.socketPath;
		sidecar.impersonateClientId = impersonate;
		// A reconnect speaks as the same client id, and the daemon dedupes mutating
		// commands on (clientId, commandId): a fresh prefix keeps a new connection
		// from replaying the answers of the dead one.
		sidecar.idPrefix = impersonate ? `own-${randomUUID().slice(0, 8)}` : "own";
		if (this.options.maxFrameBytes !== undefined) sidecar.maxFrameBytes = this.options.maxFrameBytes;
		sidecar.onAnyLine = () => {};
		sidecar.onEvent = (message) => this.onFrame(sidecar, message);
		sidecar.onClose = () => this.onSocketClosed(sidecar);
		return sidecar;
	}

	private async doOpen(): Promise<void> {
		const sidecar = this.newSidecar(null);
		this.sidecar = sidecar;
		await sidecar.connect();
		if (this.intentional) {
			sidecar.dispose();
			throw new Error("Agent session was stopped while it was starting");
		}
		const clientId = sidecar.hello?.clientId;
		if (!clientId) throw new Error("The Prime Agent daemon did not assign this connection a client id");
		this.ownerClientId = clientId;
		this.options.onWire?.("-> create");
		const created = await sidecar.request<{ activeSessionId?: string; id?: string }>(
			{
				type: "create",
				lifecycle: "client_owned",
				config: this.options.config,
				...(this.options.telemetryDisabled ? { telemetryDisabled: true } : {}),
				...(this.options.launchEnv && Object.keys(this.options.launchEnv).length > 0 ? { launchEnv: this.options.launchEnv } : {}),
			},
			CREATE_TIMEOUT_MS,
		);
		const activeSessionId = created?.activeSessionId ?? created?.id;
		if (!activeSessionId) throw new Error("The Prime Agent daemon created a session without returning its id");
		this.activeSessionId = activeSessionId;
		// A stop that landed while the session was being created could not kill what
		// did not exist yet. Do it now, or the session outlives its window.
		if (this.intentional) {
			await sidecar.request({ type: "kill", activeSessionId }, 2_000).catch(() => {});
			sidecar.dispose();
			throw new Error("Agent session was stopped while it was starting");
		}
		const attached = await sidecar.attach(activeSessionId);
		// The handle the daemon answers with is the current one: a worker replaced
		// between create and attach has already been re-issued a new id.
		if (attached.activeSessionId) this.activeSessionId = attached.activeSessionId;
		this.opened = true;
	}

	/**
	 * Stop answering to the session. The session itself is ended, not just released.
	 * Resolves once the daemon has been told (bounded: it never waits on a dead socket
	 * for long), so a window closing can wait for the kill to actually be delivered.
	 * Repeated calls share the first one's outcome.
	 */
	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.intentional = true;
		this.closed = true;
		const sidecar = this.sidecar;
		const handle = this.activeSessionId;
		this.sidecar = null;
		if (!sidecar) return (this.stopPromise = Promise.resolve());
		if (sidecar.connected && handle) {
			// End the session now rather than leaving the daemon to notice the
			// disconnect: an empty draft disappears, a running turn stops. Except a
			// session another window promoted to a shared one (see
			// `promoteClientOwnedSession`): it no longer belongs to this window, and
			// killing it would pull it out from under whoever is following it.
			const release = this.hasBeenPromoted()
				? sidecar.request({ type: "detach", activeSessionId: handle }, 2_000)
				: sidecar.request({ type: "kill", activeSessionId: handle }, 2_000);
			return (this.stopPromise = release.then(
				() => sidecar.dispose(),
				() => sidecar.dispose(),
			));
		}
		if (this.openPromise && !this.opened) {
			// Still starting: the session may be created a moment from now. Give doOpen a
			// short grace to see the stop, kill whatever it created, and let go of the
			// socket itself; if the daemon is too slow, drop the connection regardless —
			// a client-owned session is reaped when its owner disconnects, and a start
			// that can block for the whole create timeout must not block Restart or exit.
			const settled = this.openPromise.then(
				() => undefined,
				() => undefined,
			);
			const grace = new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, STOP_DURING_OPEN_GRACE_MS);
				timer.unref?.();
			});
			return (this.stopPromise = Promise.race([settled, grace]).then(() => sidecar.dispose()));
		}
		sidecar.dispose();
		return (this.stopPromise = Promise.resolve());
	}

	/**
	 * Whether the worker no longer lists an owner: `promote_owned_session` clears it,
	 * and the descriptor the daemon keeps for the worker is where that shows. A
	 * descriptor that cannot be read (another host, another agent directory) is
	 * "still ours": ending a session we cannot prove is shared is the old behaviour.
	 */
	private hasBeenPromoted(): boolean {
		const handle = this.activeSessionId;
		if (!handle) return false;
		try {
			const descriptor = resolveWorkerDescriptor({ activeSessionId: handle });
			return descriptor !== undefined && !descriptor.ownerClientId;
		} catch {
			return false;
		}
	}

	/** RpcClient compatibility: extension UI responses have no meaning on a daemon session. */
	sendRaw(_message: Record<string, unknown>): void {}

	private disposeSidecar(): void {
		const sidecar = this.sidecar;
		this.sidecar = null;
		sidecar?.dispose();
	}

	// ------------------------------------------------------------------
	// Requests
	// ------------------------------------------------------------------

	private async live(): Promise<DaemonSidecar> {
		if (this.closed) throw new Error("Agent session is closed");
		await this.open();
		if (this.reconnecting) {
			const back = await this.reconnecting;
			if (!back) throw new Error("The connection to the Prime Agent daemon was lost");
		}
		const sidecar = this.sidecar;
		if (!sidecar || !sidecar.connected || this.closed) throw new Error("Agent session is closed");
		return sidecar;
	}

	private async send<T = unknown>(command: Record<string, unknown>, timeoutMs: number): Promise<T> {
		const sidecar = await this.live();
		const handle = this.activeSessionId;
		if (!handle) throw new Error("Agent session is not open");
		this.options.onWire?.(`-> ${String(command.type)}`);
		return sidecar.request<T>({ ...command, activeSessionId: handle }, timeoutMs);
	}

	/**
	 * Send an RPC command, answered as RPC answers it. A transport failure rejects;
	 * a command the daemon refused resolves with `success: false`.
	 */
	async request(command: Record<string, unknown>, timeoutMs = 120_000): Promise<RpcReply> {
		const type = String(command.type ?? "");
		try {
			return await this.dispatch(type, command, timeoutMs);
		} catch (error) {
			if (error instanceof DaemonCommandError) return fail(error.message);
			throw error;
		}
	}

	private async dispatch(type: string, command: Record<string, unknown>, timeoutMs: number): Promise<RpcReply> {
		// The controller correlates by id; the daemon assigns its own, so ours must not travel.
		const { id: _id, type: _type, ...fields } = command;
		switch (type) {
			case "get_state": {
				const [connection, summary] = await Promise.all([
					this.send<Record<string, unknown> | undefined>({ type: "get_connection_state" }, timeoutMs),
					this.send<Record<string, unknown> | undefined>({ type: "get_state" }, timeoutMs).catch((error: unknown) => {
						// The summary only adds the session name and roster fields; a socket
						// that died is still fatal, a refusal is not.
						if (error instanceof DaemonCommandError) return undefined;
						throw error;
					}),
				]);
				return ok({ ...(summary ?? {}), ...(connection ?? {}) });
			}
			case "fork": {
				const result = await this.send<{ cancelled?: boolean; selectedText?: string } | undefined>({ type: "fork", ...fields }, timeoutMs);
				return ok({ cancelled: result?.cancelled ?? false, text: result?.selectedText });
			}
			case "prompt": {
				// The same envelope the attached path sends (DaemonSidecar.prompt): a prompt
				// that lands while a turn is running is queued by its streamingBehavior
				// rather than refused.
				const data = await this.send({ type: "prompt", queueIfBusy: true, ...fields }, timeoutMs);
				return ok(data);
			}
			case "observe":
				// Observation is an RPC-only read channel. Over the daemon the equivalent is
				// a second attach, which the controller already performs and handles.
				return fail("Observing another session is not available on the background-service transport; attach to it instead.");
			case "unobserve":
				return ok();
			default: {
				const data = await this.send({ type: RENAMED_COMMANDS[type] ?? type, ...fields }, timeoutMs);
				return ok(data);
			}
		}
	}

	// ------------------------------------------------------------------
	// Inbound frames
	// ------------------------------------------------------------------

	private onFrame(source: DaemonSidecar, message: DaemonServerMessage): void {
		if (source !== this.sidecar || this.closed) return;
		this.options.onWire?.(`<- ${message.type}`);
		if (message.type === "daemon_closing") {
			this.closingReason = message.reason === "update" ? "update" : "shutdown";
			return;
		}
		// The daemon replaced this session's worker and re-issued its handle. The frame is
		// top-level and carries the NEW id as `activeSessionId`, so it has to be read before
		// the id filter below: the daemon keeps answering commands sent to the old handle,
		// but pushes every later event under the new one, and the filter would drop them all
		// for good — a transcript that freezes while prompts are still accepted.
		if (message.type === "session_binding") {
			const binding = message as { previousActiveSessionId?: unknown; activeSessionId?: unknown };
			if (binding.previousActiveSessionId === this.activeSessionId && typeof binding.activeSessionId === "string") {
				this.activeSessionId = binding.activeSessionId;
				this.emit("resync");
			}
			return;
		}
		if (message.activeSessionId !== this.activeSessionId) return;
		switch (message.type) {
			case "session_event":
				if (message.event) this.emit("event", message.event);
				return;
			case "session_replaced":
			case "session_resynced":
				// The daemon withheld live events (backpressure, worker swap) and sent a
				// catch-up frame instead. The host repaints from a fresh snapshot.
				this.emit("resync");
				return;
			case "session_closed": {
				const reason = typeof message.reason === "string" ? message.reason : "closed";
				if (!TERMINAL_CLOSE_REASONS.has(reason)) return;
				this.finish(`session ${reason}`);
				return;
			}
		}
	}

	private onSocketClosed(source: DaemonSidecar): void {
		if (source !== this.sidecar || this.intentional || this.closed) return;
		// A connection that drops while the session is still being created is the open's
		// own failure (its pending requests reject); reconnecting here would end the
		// session with a second, contradictory "exit" while start() is still awaiting it.
		if (!this.opened) return;
		// A daemon that announced its own shutdown is not coming back for this socket.
		if (this.closingReason === "shutdown") {
			this.finish("daemon shutdown");
			return;
		}
		this.closingReason = null;
		if (!this.reconnecting) {
			this.reconnecting = this.reconnect().finally(() => {
				this.reconnecting = null;
			});
		}
	}

	/** Rebind to the same session after the socket dropped (a daemon update restart, a blip). */
	private async reconnect(): Promise<boolean> {
		const owner = this.ownerClientId;
		if (!this.activeSessionId || !owner) {
			this.finish("daemon connection lost");
			return false;
		}
		const deadline = Date.now() + RECONNECT_BUDGET_MS;
		for (const delay of RECONNECT_BACKOFF_MS) {
			if (Date.now() + delay >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, delay));
			if (this.intentional || this.closed) return false;
			const handle = this.activeSessionId;
			if (!handle) break;
			const sidecar = this.newSidecar(owner);
			let attached: { activeSessionId?: string };
			try {
				await sidecar.connect(3_000);
				attached = await sidecar.attach(handle, Math.max(2_000, Math.min(8_000, deadline - Date.now())));
			} catch (error) {
				sidecar.dispose();
				// A refusal that says "later" (daemon restarting, worker recovering) is retried;
				// any other one means the daemon is back and no longer knows the session.
				if (error instanceof DaemonCommandError && !RETRYABLE_REFUSALS.has(error.code ?? "")) break;
				continue;
			}
			if (this.intentional || this.closed) {
				sidecar.dispose();
				return false;
			}
			this.sidecar = sidecar;
			// A worker replaced while we were away answers with its current handle.
			if (attached.activeSessionId) this.activeSessionId = attached.activeSessionId;
			this.closingReason = null;
			this.emit("resync");
			return true;
		}
		this.finish("daemon connection lost");
		return false;
	}

	/** The session is over: tell the host once, the way a child process exit would. */
	private finish(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.disposeSidecar();
		this.emit("exit", null, reason);
	}
}
