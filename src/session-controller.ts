/**
 * SessionController owns the Prime Agent RPC subprocess for this VS Code window,
 * routes events to all attached chat webviews, and answers extension UI requests
 * using native VS Code dialogs.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { DaemonSidecar } from "./daemon-sidecar.js";
import { resolveOwnerClientId } from "./daemon-owner.js";
import type { AttachSnapshot, DaemonServerMessage, SavedSessionInfo, SessionSummaryRef } from "./daemon-sidecar.js";
import type {
	AgentEvent,
	AgentMessage,
	HostToWebview,
	ImageAttachment,
	ModelRef,
	PromptPayload,
	RecentSession,
	RpcExtensionUIRequest,
	RpcModel,
	RpcSessionState,
	RpcSlashCommand,
	SessionChild,
	StatusSnapshot,
} from "./protocol.js";
import { DebugFileLog } from "./debug-log.js";
import { buildMarkdownExport } from "./markdown-export.js";
import { listRecentSessions, normalizeFsPath } from "./recent-sessions.js";
import { ThreadDiffTracker } from "./thread-diffs.js";
import { archiveSessionFile, deleteSession, isSessionActive, renameSessionOffline } from "./session-actions.js";
import { RpcClient } from "./rpc-client.js";

const execFileAsync = promisify(execFile);

/**
 * History bucket quotas. Separate on purpose: "this workspace" is the operator's
 * own history and must never be crowded out by throwaway sessions from other
 * folders, which is exactly what one shared cap did.
 */
const HISTORY_WORKSPACE_LIMIT = 200;
const HISTORY_OTHER_LIMIT = 40;
/** The saved-session catalog carries every transcript; don't refetch it per keystroke. */
const SAVED_CATALOG_TTL_MS = 15_000;
/**
 * Our own ceiling on a compact reply. Deliberately far above any real
 * compaction: whether a compaction has failed is the agent's call, not a
 * stopwatch's, and a dead transport already settles these promises through the
 * socket/process close paths rather than through this timer.
 */
const COMPACT_REPLY_CEILING_MS = 30 * 60_000;

/** Level order used by the agent itself (packages/ai getSupportedThinkingLevels). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Which thinking levels the model actually accepts, derived exactly the way the
 * agent derives them. RPC `get_state` narrows the session state and drops the
 * agent's own availableThinkingLevels, but it keeps the whole Model — including
 * `thinkingLevelMap` — so we can answer honestly instead of offering a fixed six
 * and letting clampThinkingLevel silently swap the operator's choice.
 * Returns null when we have no model to reason about.
 */
function supportedThinkingLevels(model: RpcModel | null | undefined): string[] | null {
	if (!model) return null;
	if (model.reasoning === false) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		// xhigh/max exist only where the model declares a mapping for them.
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** A window of `text` around a match, trimmed to word-ish edges, for search evidence. */
function excerpt(text: string, at: number, length: number): string {
	const start = Math.max(0, at - 45);
	const end = Math.min(text.length, at + length + 65);
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

interface WebviewSink {
	post(message: HostToWebview): void;
}

/** A daemon-brokered session we are following, under both of its identities. */
interface AttachRef {
	/** Daemon attach handle (12-char active id). Addresses every daemon command. */
	activeSessionId: string;
	sessionPath: string;
	/** Daemon/session UUID, when available. What history rows and UI identity key on. */
	sessionId?: string;
}

/** A catalog capability plus the immutable JSONL filename it authorizes. */
interface ResolvedHistorySession extends RecentSession {
	/** File-stem identity used only by offline file operations and artifacts. */
	fileId: string;
}

// Re-exported so extension.ts and the controller-bundle harnesses keep one
// import site while the implementation lives in its own module.
export { GitHeadContentProvider } from "./git-head-provider.js";

export class SessionController implements vscode.Disposable {
	private client: RpcClient | null = null;
	private disposed = false;
	/**
	 * "The agent actually answers", not "a process object exists". Only a
	 * completed RPC round-trip sets it; start/stop/exit clear it. A binary that
	 * spawns and then never replies (stale daemon socket, half-finished install,
	 * a build that doesn't understand --mode rpc) is NOT connected, and the whole
	 * UI — status strip, composer, install recommendation — hangs off this.
	 */
	private reachable = false;
	private sinks = new Set<WebviewSink>();
	private disposables: vscode.Disposable[] = [];
	private watcher: vscode.FileSystemWatcher | null = null;
	private changedFiles = new Set<string>();
	private state: RpcSessionState | null = null;
	private cachedMessages: AgentMessage[] = [];
	private extensionStatusText: string | undefined;
	private streaming = false;
	private compacting = false;
	private retrying = false;
	private debugLog = new DebugFileLog();
	private startingPromise: Promise<void> | null = null;
	private intentionalStop = false;
	private observingId: string | null = null;
	/** Identity of the read-only session, kept separately from the hidden RPC state. */
	private observedSession: { activeSessionId: string; sessionId?: string; sessionPath?: string } | null = null;
	/** A just-closed observed session stays non-interactive until our own view repaints. */
	private observationRestoring = false;
	/** Daemon sidecar for resident-session parity (attach/prompt/abort on live sessions). */
	private sidecar: DaemonSidecar | null = null;
	/** Serialize release/attach hand-offs for one daemon handle. */
	private pendingDaemonDetaches = new Map<string, Promise<void>>();
	/**
	 * `activeSessionId` is the daemon's 12-char attach handle; `sessionId` is the
	 * daemon's durable session UUID used by history/UI. Neither is necessarily the
	 * transcript filename stem, so file operations derive that only from a verified
	 * catalog path.
	 */
	private attached: AttachRef | null = null;
	/** View generation that owns the currently attached daemon session. */
	private attachedEpoch: number | null = null;
	/** Attach attempt remembered across socket drops so a reconnect can re-anchor seamlessly. */
	private attachAttempt: AttachRef | null = null;
	/** View generation that owned the reconnect attempt. */
	private attachAttemptEpoch: number | null = null;
	/** Breadcrumbs for nested subagent browsing; each Back returns exactly one level. */
	private returnTargets: Array<{ kind: "rpc" } | ({ kind: "attached" } & AttachRef)> = [];
	private rentedState: RpcSessionState | null = null;
	/** Last history answer, replayed instantly so a reopened sidebar never flashes empty. */
	private lastHistory: RecentSession[] | null = null;
	/** Latest rendered history capability set, including catalog-search-only rows. */
	private actionHistory: RecentSession[] | null = null;
	private savedCatalog: { at: number; rows: SavedSessionInfo[] } | null = null;
	/** Monotonic navigation ownership: late session RPCs cannot repaint a newer view. */
	private viewEpoch = 0;
	/** Supersedes slow history/search answers so they cannot repaint a newer query. */
	private historyRequestGeneration = 0;
	/** Opaque, host-issued capabilities for the currently rendered child strip. */
	private browseableChildren = new Map<string, { activeSessionId: string; parentId?: string; contextId: number }>();
	private browseRefByActiveId = new Map<string, string>();
	/** Invalidates child capabilities only when the displayed session actually changes. */
	private childrenContext = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
	) {
		this.startWatcher();
	}

	get workspaceRoot(): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
	}

	/** This extension is deliberately single-root until paths carry a root id. */
	private isInWorkspaceRoot(uri: vscode.Uri): boolean {
		if (uri.scheme !== "file" || !this.workspaceRoot) return false;
		try {
			// A lexical prefix is not enough: VS Code follows workspace symlinks,
			// which otherwise lets a webview read an arbitrary target through a
			// friendly-looking in-root path.
			const root = realpathSync(this.workspaceRoot);
			const resolved = realpathSync(uri.fsPath);
			const relative = path.relative(root, resolved);
			return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
		} catch {
			return false;
		}
	}

	private workspaceRelativePath(uri: vscode.Uri): string | null {
		if (!this.isInWorkspaceRoot(uri)) return null;
		return path.relative(this.workspaceRoot, uri.fsPath).split(path.sep).join("/");
	}

	// ------------------------------------------------------------------
	// Webview wiring
	// ------------------------------------------------------------------

	attach(sink: WebviewSink): vscode.Disposable {
		if (this.disposed) return new vscode.Disposable(() => {});
		this.sinks.add(sink);
		// Seed the rebuilt document with the last history we computed. The sidebar
		// webview is destroyed on every hide, so without this the operator's next
		// visit to history starts from an empty list and flashes "Loading…".
		if (this.lastHistory) sink.post({ type: "history", sessions: this.lastHistory });
		return new vscode.Disposable(() => this.sinks.delete(sink));
	}

	private broadcast(message: HostToWebview): void {
		if (this.disposed) return;
		if (this.sinks.size === 0) this.debugLog.append(`broadcast ${message.type} with no sinks`);
		for (const sink of this.sinks) {
			sink.post(message);
		}
	}

	debugPostFailure(message: HostToWebview): void {
		this.debugLog.append(`postMessage returned FALSE for type=${message.type}`);
	}

	showErrorNotice(text: string): void {
		this.broadcast({ type: "notice", level: "error", text });
	}

	broadcastInsertSelection(selection: { path: string; startLine: number; endLine: number; text: string; languageId: string }): void {
		this.broadcast({ type: "insertSelection", selection });
	}

	broadcastInsertMention(path: string): void {
		this.broadcast({ type: "insertMention", path });
	}

	// ------------------------------------------------------------------
	// Agent process lifecycle
	// ------------------------------------------------------------------

	async ensureStarted(): Promise<void> {
		if (this.disposed) return;
		if (!this.workspaceRoot) {
			this.broadcast({ type: "notice", level: "warning", text: "Open a workspace folder before starting Prime Agent." });
			return;
		}
		this.debugLog.append("ensureStarted");
		if (this.client?.running) return;
		if (this.startingPromise) return this.startingPromise;
		this.armInstallWatchdog();
		this.startingPromise = this.start()
			.catch((err) => {
				this.output.appendLine(`[prime-agent] failed to start: ${String(err)}`);
				this.broadcast({ type: "notice", level: "error", text: `Failed to start Prime Agent: ${String(err)}` });
			})
			.finally(() => {
				this.startingPromise = null;
			});
		return this.startingPromise;
	}

	// ---- install prompt: one smart banner when prime-agent can't be detected ----

	private installPromptDismissed(): boolean {
		return this.context.workspaceState.get<boolean>("pa-install-prompt-dismissed", false);
	}

	async dismissInstallPrompt(): Promise<void> {
		await this.context.workspaceState.update("pa-install-prompt-dismissed", true);
	}

	private maybeShowInstallPrompt(reason: string): void {
		if (this.installPromptDismissed()) return;
		this.broadcast({
			type: "installPrompt",
			// Prime Intellect's own installer page, not a doc page in a repo: an
			// operator who cannot reach the CLI wants the command that installs it.
			url: "https://app.primeintellect.ai/prime-agent",
			reason,
		});
	}

	private installWatchdog: NodeJS.Timeout | null = null;

	/** If the agent still isn't reachable ~25s after the first attempt, recommend installing it (once). */
	private armInstallWatchdog(): void {
		if (this.installWatchdog) clearTimeout(this.installWatchdog);
		this.installWatchdog = setTimeout(() => {
			this.installWatchdog = null;
			if (this.disposed) return;
			// Reachability, not process liveness: "sees it but cannot connect" is a
			// binary that spawns fine and then never answers a single RPC, which
			// `client.running` reports as perfectly healthy forever.
			if (this.reachable) return;
			const reason = `prime-agent did not answer within 25s (command: ${vscode.workspace.getConfiguration("primeAgent").get<string>("command", "prime-agent")})`;
			this.maybeShowInstallPrompt(reason);
			// Dismissing the card hides the recommendation, not the failure —
			// otherwise the second start after a dismissal is silently dead.
			if (this.installPromptDismissed()) {
				this.broadcast({ type: "notice", level: "warning", text: `Prime Agent isn't responding — ${reason}` });
			}
		}, 25_000);
	}

	private async start(): Promise<void> {
		if (!this.workspaceRoot) throw new Error("Open a workspace folder before starting Prime Agent.");
		const config = vscode.workspace.getConfiguration("primeAgent");
		const configuredCommand = config.get<unknown>("command", "prime-agent");
		const command = typeof configuredCommand === "string" && configuredCommand.trim() ? configuredCommand.trim() : "prime-agent";
		if (command.includes("\0")) throw new Error("primeAgent.command contains an invalid character");
		const configuredArgs = config.get<unknown>("args", []);
		if (!Array.isArray(configuredArgs) || configuredArgs.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
			throw new Error("primeAgent.args must be an array of strings");
		}
		const extraArgs = configuredArgs as string[];
		const model = config.get<string>("model", "").trim();

		const args = [...extraArgs];
		if (model) args.push("--model", model);
		// Escape hatch (tests, unusual launch setups): extra space-delimited args.
		const envArgs = process.env.PRIME_AGENT_ARGS?.trim();
		if (envArgs) args.push(...envArgs.split(/\s+/));

		this.output.appendLine(`[prime-agent] starting: ${command} --mode rpc (${args.length} configured argument${args.length === 1 ? "" : "s"})`);
		const client = new RpcClient({ command, args, cwd: this.workspaceRoot, onWire: (s) => this.debugLog.append(s) });
		this.client = client;
		this.reachable = false;
		this.intentionalStop = false;

	client.on("event", (raw) => {
			if (this.isForegroundRpcClient(client)) this.onAgentEvent(raw as AgentEvent);
		});
		client.on("extensionUiRequest", (raw) => {
			if (this.client === client && !this.disposed) void this.onExtensionUiRequest(client, raw as RpcExtensionUIRequest);
		});
		client.on("message", (raw) => {
			if (this.client === client && !this.disposed) this.onOtherMessage(client, raw as Record<string, unknown>);
		});
		client.on("stderr", (chunk: string) => {
			if (this.client === client && !this.disposed) this.output.append(chunk);
		});
		client.on("spawnError", (err: Error) => {
			if (this.client !== client || this.disposed) return;
			this.output.appendLine(`[prime-agent] spawn error: ${err.message}`);
			this.reachable = false;
			if (!this.isForegroundRpcClient(client)) return;
			this.broadcast({
				type: "notice",
				level: "error",
				text: `Could not start "${command}". Install Prime Agent or set primeAgent.command in settings.`,
			});
			// A spawn failure is definitive — don't make a first-time operator wait
			// out the 25s watchdog behind the connecting splash before we say why.
			if (this.installWatchdog) {
				clearTimeout(this.installWatchdog);
				this.installWatchdog = null;
			}
			this.maybeShowInstallPrompt(`"${command}" could not be launched — ${err.message}`);
			this.pushStatus();
		});
		// A protocol fault kills the connection and the agent with it. Nothing
		// listened for it before, so the operator saw a session simply fail to open
		// with no explanation anywhere but the output channel.
		client.on("protocolError", (err: Error) => {
			if (this.client !== client || this.disposed) return;
			this.output.appendLine(`[prime-agent] protocol error: ${err.message}`);
			this.broadcast({
				type: "notice",
				level: "error",
				text: `The agent connection was reset: ${err.message}. Use Restart to start it again.`,
			});
		});
		client.on("exit", (code: number | null) => {
			if (this.client !== client || this.disposed) return;
			this.output.appendLine(`[prime-agent] exited with code ${code ?? "?"}`);
			this.reachable = false;
			this.state = null;
			// Our worker died with it; stop answering to its owner id so the daemon
			// can reap it instead of keeping it (and its kernels) alive for us.
			//
			// Deliberately ABOVE the foreground guard. That guard is false whenever
			// the operator is attached — including to a subagent of the very worker
			// that just lost its agent — and skipping the release there is exactly
			// how a dead session would be kept running forever. Dropping the socket
			// costs a reconnect, which onClose/runReattach already treat as a normal
			// path and recover from.
			this.releaseOwnerIdentity();
			if (!this.isForegroundRpcClient(client)) return;
			this.clearRunFlags();
			this.clearChangedFiles();
			this.threadDiffs.clear();
			if (!this.intentionalStop) {
				this.broadcast({ type: "notice", level: "warning", text: `Agent process exited (code ${code ?? "?"}). Use Restart to start it again.` });
			}
			this.pushStatus();
		});

		client.start();

		// Give the process a moment to fail fast on spawn problems before declaring success.
		await new Promise((resolve) => setTimeout(resolve, 150));
		await this.refreshSnapshot();
	}

	async restart(): Promise<void> {
		// A restart can race an in-flight startup. `ensureStarted()` intentionally
		// coalesces callers, so let that retiring attempt settle before starting its
		// replacement instead of awaiting it and ending up offline.
		const retiringStart = this.startingPromise;
		this.stop();
		if (retiringStart) await retiringStart;
		if (this.disposed) return;
		await this.ensureStarted();
	}

	stop(): void {
		this.intentionalStop = true;
		this.client?.stop();
		this.client = null;
		this.state = null;
		this.reachable = false;
		this.clearRunFlags();
		if (this.installWatchdog) {
			clearTimeout(this.installWatchdog);
			this.installWatchdog = null;
		}
		if (!this.disposed) this.pushStatus();
	}

	/**
	 * Busy flags describe ONE session's run. They must be dropped whenever the
	 * session on screen changes, or an idle/new session inherits "running", a
	 * Stop button and a steer pill that no agent_end will ever clear.
	 */
	private clearRunFlags(): void {
		this.streaming = false;
		this.compacting = false;
		this.retrying = false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stop();
		// Drop the attach intent before tearing the socket down, or the close
		// handler restarts the re-attach backoff against a dead controller.
		this.attached = null;
		this.attachedEpoch = null;
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.clearReattachTimer();
		// A pending strip refresh would fire against a disposed sidecar.
		if (this.childrenTimer) clearTimeout(this.childrenTimer);
		this.childrenTimer = null;
		if (this.historyRefreshTimer) clearTimeout(this.historyRefreshTimer);
		this.historyRefreshTimer = null;
		if (this.statsTimer) clearTimeout(this.statsTimer);
		this.statsTimer = null;
		if (this.installWatchdog) clearTimeout(this.installWatchdog);
		this.installWatchdog = null;
		this.threadDiffs.clear();
		this.sidecar?.dispose();
		this.watcher?.dispose();
		for (const d of this.disposables) d.dispose();
		this.sinks.clear();
		this.debugLog.dispose();
	}

	// ------------------------------------------------------------------
	// Event routing
	// ------------------------------------------------------------------

	private onAgentEvent(event: AgentEvent): void {
		// Subagent strip: keep counts honest mid-run. scheduleChildrenRefresh
		// coalesces these — a daemon `list all` re-reads every session file on
		// disk, so one per tool call is a real cost on a long turn.
		if (this.sidecar?.connected) {
			if (event.type === "tool_execution_end" || event.type === "agent_start" || event.type === "agent_end" || event.type === "turn_end") {
				this.scheduleChildrenRefresh();
			}
		}
		switch (event.type) {
			case "agent_start":
				this.streaming = true;
				this.changedFiles.clear();
				// The strip and the attribution that filters it are both per-run, so
				// they have to reset together. Keeping attribution cumulative while
				// the strip resets is what let an edit from an earlier run hide your
				// own later save of the same file.
				this.threadDiffs.startRun();
				this.broadcast({ type: "changedFiles", files: [] });
				break;
			case "agent_end":
				this.streaming = false;
				this.retrying = false;
				this.onBusySettled();
				this.scheduleChildrenRefresh();
				break;
			case "compaction_start":
				this.compacting = true;
				break;
			case "compaction_end":
				this.compacting = false;
				// Compaction rewrites the transcript, so the view is stale the moment
				// it ends. Refreshing on the EVENT rather than on the reply to our
				// own request is what makes this correct in the two cases that
				// matter: a compaction another client started on a shared session,
				// and our own request whose reply timed out while the work carried
				// on regardless. Nobody asked for this refresh, so it must not
				// overwrite whatever is being typed right now.
				void this.refreshSnapshot({ keepDraft: true }).catch(() => {
					// Reported through the output channel by refreshSnapshot itself.
				});
				break;
			case "auto_retry_start":
				this.retrying = true;
				break;
			case "auto_retry_end":
				this.retrying = false;
				break;
			case "session_action_update":
				break;
			case "session_info_changed":
			case "thinking_level_changed":
				void this.refreshStateAndStats();
				this.scheduleHistoryRefresh();
				break;
		}
		this.trackChangedFilesDone(event);
		this.threadDiffs.track(event);
		this.broadcast({ type: "event", event });
		// Hot path: reuse cached stats; expensive stats refresh only on transitions.
		if (
			event.type === "agent_start" ||
			event.type === "agent_end" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end" ||
			event.type === "auto_retry_start" ||
			event.type === "auto_retry_end"
		) {
			this.pushStatus();
		} else {
			this.pushStatusLight();
		}
	}

	private onOtherMessage(client: RpcClient, raw: Record<string, unknown>): void {
		// Non-response, non-event messages (e.g. extension_bus events). Surface notable ones.
		const type = raw.type as string;
		if (type === "extension_error") {
			if (this.isForegroundRpcClient(client)) {
				this.broadcast({ type: "notice", level: "error", text: `Extension error: ${JSON.stringify(raw.error ?? raw)}` });
			}
		} else if (type === "observed_session_event") {
			const sessionId = raw.activeSessionId as string;
			if (sessionId === this.observingId) {
				this.broadcast({ type: "observedEvent", sessionId, event: raw.event as AgentEvent });
			}
		} else if (type === "observed_session_closed") {
			const sessionId = raw.activeSessionId as string;
			if (sessionId === this.observingId) {
				this.observingId = null;
				this.observedSession = null;
				this.observationRestoring = true;
				const epoch = ++this.viewEpoch;
				this.broadcast({ type: "observedClosed", sessionId });
				this.pushStatus();
				// The observed transcript is still on screen. Keep the composer disabled
				// until a fresh snapshot of this window's session has replaced it.
				void this.restoreAfterObservationClosed(epoch);
			}
		}
	}

	private async restoreAfterObservationClosed(epoch: number): Promise<void> {
		if (this.disposed || this.attached || this.observingId || epoch !== this.viewEpoch) return;
		this.beginRpcRestore();
		if (await this.restoreOwnRpcView(epoch)) this.scheduleChildrenRefresh();
	}

	private onBusySettled(): void {
		void this.refreshStateAndStats();
		this.changedFilesNeedRecompute = false;
		if (this.changedFiles.size > 0) this.pushChangedFiles();
	}

	/** Set when a diff post could not refresh the strip because a run looked live. */
	private changedFilesNeedRecompute = false;

	/**
	 * The changed-files strip is what the watcher saw MINUS what this session can
	 * prove it edited. Both the main agent's edits and its subagents' count as
	 * this session's work, so both come out — they are already presented, with
	 * attribution, in the Changes panel, and listing them twice invited the
	 * reading that something else had touched them.
	 *
	 * What is left is genuinely outside the session's edit tool: your own saves,
	 * another thread, a build step — plus the one honest overlap, a file the
	 * agent rewrote from a shell or Python cell, which publishes no diff to
	 * attribute it by.
	 */
	private pushChangedFiles(): void {
		// Compare on a canonical key. The watcher's paths come from
		// asRelativePath (always forward slashes, on-disk case) while a tool path
		// is whatever the model wrote — a backslash or a different case on a
		// case-insensitive filesystem is the same file and must filter as one.
		const edited = new Set([...this.threadDiffs.editedPaths()].map((file) => canonicalRelPath(file)));
		this.broadcast({
			type: "changedFiles",
			files: [...this.changedFiles].filter((file) => !edited.has(canonicalRelPath(file))).sort(),
		});
	}

	/** Clear the session-scoped strip in both host state and every visible webview. */
	private clearChangedFiles(): void {
		this.changedFiles.clear();
		this.broadcast({ type: "changedFiles", files: [] });
	}

	// ------------------------------------------------------------------
	// Extension UI requests -> native VS Code dialogs
	// ------------------------------------------------------------------

	private async onExtensionUiRequest(client: RpcClient, request: RpcExtensionUIRequest): Promise<void> {
		// Native dialogs may resolve after a restart. Their response belongs only to
		// the client and view that opened the dialog; never send an approval into a
		// replacement or now-hidden session. We still answer cancellation so the
		// original client cannot remain blocked on a dialog it no longer owns.
		const requestEpoch = this.viewEpoch;
		const respond = (body: Record<string, unknown>) => {
			if (!this.disposed && this.client === client && client.running) {
				const current = this.isCurrentRpcView(client, requestEpoch);
				client.sendRaw({ type: "extension_ui_response", id: request.id, ...(current ? body : { cancelled: true }) });
			}
		};
		// The background RPC keeps running while this window follows a daemon or
		// observed session. Its extension requests must not mutate or prompt over
		// the session on screen; explicitly cancel so it can unwind rather than wait.
		if (!this.isCurrentRpcView(client, requestEpoch)) {
			respond({ cancelled: true });
			return;
		}
		switch (request.method) {
			case "select": {
				const picked = await vscode.window.showQuickPick(request.options, { title: request.title, ignoreFocusOut: true });
				if (picked === undefined) respond({ cancelled: true });
				else respond({ value: picked });
				return;
			}
			case "confirm": {
				const yes = "Yes";
				const no = "No";
				const picked = await vscode.window.showInformationMessage(
					`${request.title}: ${request.message}`,
					{ modal: true },
					yes,
					no,
				);
				if (picked === undefined) respond({ cancelled: true });
				else respond({ confirmed: picked === yes });
				return;
			}
			case "input": {
				const value = await vscode.window.showInputBox({ title: request.title, placeHolder: request.placeholder, ignoreFocusOut: true });
				if (value === undefined) respond({ cancelled: true });
				else respond({ value });
				return;
			}
			case "editor": {
				const value = await vscode.window.showInputBox({ title: request.title, value: request.prefill ?? "", ignoreFocusOut: true });
				if (value === undefined) respond({ cancelled: true });
				else respond({ value });
				return;
			}
			case "notify": {
				const show =
					request.notifyType === "error"
						? vscode.window.showErrorMessage
						: request.notifyType === "warning"
							? vscode.window.showWarningMessage
							: vscode.window.showInformationMessage;
				void show(`Prime Agent: ${request.message}`);
				return;
			}
			case "setStatus": {
				this.extensionStatusText = request.statusText;
				this.broadcast({ type: "uiState", statusText: request.statusText });
				this.pushStatus();
				return;
			}
			case "setTitle": {
				this.broadcast({ type: "uiState", title: request.title });
				return;
			}
			case "set_editor_text": {
				this.broadcast({ type: "editorText", text: request.text });
				return;
			}
			default:
				// Every request carries an id and may be awaited on the agent side
				// (setWidget is one we deliberately do not render). Answering with an
				// explicit cancel unwinds it now instead of at its own timeout.
				respond({ cancelled: true });
				return;
		}
	}

	// ------------------------------------------------------------------
	// High-level operations
	// ------------------------------------------------------------------

	private isReattaching(): boolean {
		return this.attached === null && this.attachAttempt !== null && this.attachAttemptEpoch === this.viewEpoch;
	}

	/** Claim a new displayed-session intent before any validation or startup await. */
	private beginNavigation(): number {
		const epoch = ++this.viewEpoch;
		// A socket-drop reconnect belongs to the view that dropped. Once the user
		// chooses another view, it must never resurrect the old one underneath it.
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.clearReattachTimer();
		return epoch;
	}

	/** Block operations that would otherwise silently address the hidden RPC session. */
	private guardObservedReadOnly(action: string): boolean {
		if (this.attached && this.attachedEpoch !== this.viewEpoch) {
			this.broadcast({ type: "notice", level: "warning", text: `Please wait for the session switch to finish before ${action}.` });
			return true;
		}
		if (!this.observingId && !this.observationRestoring) return false;
		this.broadcast({
			type: "notice",
			level: "warning",
			text: this.observationRestoring
				? `Please wait while your session view is restored before ${action}.`
				: `You are watching another live session read-only. Stop watching it before ${action}.`,
		});
		return true;
	}

	private isCurrentAttachment(attached: AttachRef): boolean {
		return !this.disposed && this.attached === attached && this.attachedEpoch === this.viewEpoch;
	}

	/** Put a failed navigation back on the prior attached view without reviving its old async work. */
	private restoreAttachedView(attached: AttachRef | null, epoch: number): void {
		if (this.disposed || epoch !== this.viewEpoch || !attached) return;
		// The socket can close while an explicit navigation is still resolving. Its
		// old attachment is no longer usable, so recover the hidden RPC view rather
		// than reviving a disconnected reference or letting actions fall through.
		if (this.observationRestoring && this.attached === null) {
			void this.restoreAfterObservationClosed(epoch);
			return;
		}
		if (this.attached !== attached) return;
		this.attached = { ...attached };
		this.attachedEpoch = epoch;
		this.pushStatus();
	}

	/** Whether the subprocess is the session currently represented by this window. */
	private isForegroundRpcClient(client: RpcClient): boolean {
		return (
			this.client === client &&
			!this.disposed &&
			this.attached === null &&
			this.observingId === null &&
			!this.observationRestoring &&
			!this.isReattaching()
		);
	}

	/** A background-RPC reply may only update the same un-attached view that asked. */
	private isCurrentRpcView(client: RpcClient, epoch: number, allowRestoring = false): boolean {
		return (
			this.client === client &&
			!this.disposed &&
			this.attached === null &&
			this.observingId === null &&
			!this.isReattaching() &&
			(allowRestoring || !this.observationRestoring) &&
			epoch === this.viewEpoch
		);
	}

	private resetViewedSessionState(): void {
		this.extensionStatusText = undefined;
		this.lastStatsText = "";
		this.lastUsage = {};
		this.autoCompactSent = false;
		// A refusal belongs to the thread that earned it, and so does the offer to
		// retry it: carrying either across a session change would rule out models
		// for a thread that never refused, and leave a button that acts on the
		// session the operator just left.
		this.compactionModelsTried.clear();
		this.noticeActions.clear();
		this.clearChangedFiles();
	}

	/**
	 * A successful navigation changes the RPC target before its fresh transcript
	 * arrives. Clear the old view and keep controls disabled until that response
	 * proves which session is now on screen.
	 */
	private beginRpcRestore(): void {
		this.observationRestoring = true;
		this.resetChildrenBaseline();
		this.resetViewedSessionState();
		this.cachedMessages = [];
		this.state = null;
		this.rentedState = null;
		this.clearRunFlags();
		this.threadDiffs.clear();
		this.broadcast({ type: "sessionChildren", children: [] });
		this.broadcast({
			type: "snapshot",
			messages: [],
			state: null,
			status: this.buildStatus(),
			steerDefault: vscode.workspace.getConfiguration("primeAgent").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
		});
		this.pushStatus();
	}

	/**
	 * Restore this window's own RPC session. A failed read must NOT latch the
	 * restore lock: `beginRpcRestore()` has already blanked the transcript, and
	 * leaving `observationRestoring` set leaves a permanently disabled composer
	 * that neither Restart nor New Session can clear (both are refused by
	 * guardObservedReadOnly). Retry once through ensureStarted — the subprocess
	 * may have exited while we were following someone else's session — then
	 * release the lock either way and let the status strip report the truth.
	 */
	private async restoreOwnRpcView(epoch: number): Promise<boolean> {
		let restored = await this.refreshSnapshot({ epoch, allowRestoring: true });
		if (!restored && !this.disposed && !this.observingId && !this.attached && epoch === this.viewEpoch) {
			try {
				await this.ensureStarted();
			} catch {
				// reported by ensureStarted itself
			}
			if (!this.disposed && !this.observingId && !this.attached && epoch === this.viewEpoch) {
				restored = await this.refreshSnapshot({ epoch, allowRestoring: true });
			}
		}
		if (this.disposed || this.observingId || this.attached || epoch !== this.viewEpoch) return false;
		this.observationRestoring = false;
		this.pushStatus();
		return restored;
	}

	private rejectPrompt(payload: PromptPayload, error: string, reply: (message: HostToWebview) => void = (message) => this.broadcast(message)): void {
		reply({ type: "promptRejected", error, clientRequestId: payload.clientRequestId });
	}

	async prompt(payload: PromptPayload, reply: (message: HostToWebview) => void = (message) => this.broadcast(message)): Promise<void> {
		if (this.guardObservedReadOnly("sending a prompt")) {
			this.rejectPrompt(payload, "The observed session is read-only in this window.", reply);
			return;
		}
		const attached = this.attached;
		if (attached) {
			let sidecar: DaemonSidecar;
			try {
				sidecar = await this.ensureSidecar();
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.rejectPrompt(payload, err instanceof Error ? err.message : "daemon prompt failed", reply);
				return;
			}
			if (!this.isCurrentAttachment(attached)) {
				this.rejectPrompt(payload, "The viewed session changed before the prompt could be sent.", reply);
				return;
			}
			const text = this.composeMessageText(payload);
			const images = payload.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
			// Attaching mid-turn never delivers agent_start, so `this.streaming`
			// alone would silently downgrade a queued follow-up into a steer.
			const behavior = this.effectiveStreaming() ? payload.streamingBehavior : "steer";
			try {
				await sidecar.prompt(attached.activeSessionId, text, behavior, images);
				if (!this.isCurrentAttachment(attached)) return;
				this.broadcast({ type: "promptAccepted", kind: "prompt" });
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.rejectPrompt(payload, err instanceof Error ? err.message : "daemon prompt failed", reply);
			}
			return;
		}
		if (this.isReattaching()) {
			this.rejectPrompt(payload, "The live session is reconnecting. Please wait for it to re-attach.", reply);
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch)) {
			this.rejectPrompt(payload, "Agent is unavailable.", reply);
			return;
		}
		this.output.appendLine(`[prime-agent] prompt: streaming=${this.streaming} behavior=${payload.streamingBehavior}`);
		this.debugLog.append(`prompt entered: streaming=${this.streaming} behavior=${payload.streamingBehavior}`);

		const text = this.composeMessageText(payload);
		const images = payload.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));

		let command: Record<string, unknown>;
		let kind: "prompt" | "steer" | "followUp";
		if (this.streaming && payload.streamingBehavior === "steer") {
			command = { type: "prompt", message: text, images, streamingBehavior: "steer" };
			kind = "steer";
		} else if (this.streaming && payload.streamingBehavior === "followUp") {
			command = { type: "prompt", message: text, images, streamingBehavior: "followUp" };
			kind = "followUp";
		} else {
			command = { type: "prompt", message: text, images };
			kind = "prompt";
		}

		try {
			const response = await client.request(command);
			if (!this.isCurrentRpcView(client, epoch)) return;
			this.debugLog.append(`prompt response: success=${response.success}`);
			this.output.appendLine(`[prime-agent] prompt response: success=${response.success}`);
			if (response.success) {
				this.broadcast({ type: "promptAccepted", kind });
			} else {
				this.rejectPrompt(payload, response.error ?? "prompt rejected", reply);
			}
		} catch (err) {
			if (!this.isCurrentRpcView(client, epoch)) return;
			const error = err instanceof Error ? err.message : String(err);
			this.debugLog.append("prompt request failed");
			this.output.appendLine("[prime-agent] prompt request failed");
			this.rejectPrompt(payload, error, reply);
		}
	}

	private composeMessageText(payload: PromptPayload): string {
		let text = payload.text;
		const includeSnippets = vscode.workspace.getConfiguration("primeAgent").get<boolean>("sendSelectionSnippet", true);
		for (const sel of payload.selections) {
			if (includeSnippets && sel.text) {
				text += `\n\n<attachment file="${sel.path}" lines="${sel.startLine}-${sel.endLine}">\n${sel.text}\n</attachment>`;
			} else {
				text += ` (${sel.path} lines ${sel.startLine}-${sel.endLine})`;
			}
		}
		return text;
	}

	async abort(): Promise<void> {
		if (this.guardObservedReadOnly("stopping a run")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				await sidecar.abort(attached.activeSessionId);
			} catch (err) {
				if (!this.isCurrentAttachment(attached)) return;
				this.output.appendLine(`[prime-agent] attached abort failed: ${String(err)}`);
				// Silence here means the operator keeps clicking Stop on a run that
				// is still going, with no way to know the request never left us.
				this.broadcast({
					type: "notice",
					level: "error",
					text: `Could not stop the run: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
			return;
		}
		if (this.isReattaching()) {
			this.broadcast({ type: "notice", level: "warning", text: "The live session is reconnecting; Stop is unavailable until it re-attaches." });
			return;
		}
		if (!this.client?.running) return;
		try {
			await this.client.request({ type: "abort" }, 10_000);
		} catch (err) {
			this.output.appendLine(`[prime-agent] abort failed: ${String(err)}`);
		}
	}

	async newSession(): Promise<void> {
		if (this.guardObservedReadOnly("starting a new session")) return;
		const previousAttachment = this.attached;
		const epoch = this.beginNavigation();
		const observedAtStart = this.observingId;
		await this.ensureStarted();
		if (!this.client || this.disposed || epoch !== this.viewEpoch) {
			this.restoreAttachedView(previousAttachment, epoch);
			return;
		}
		const client = this.client;
		let response;
		try {
			response = await client.request({ type: "new_session" });
		} catch (err) {
			if (this.client === client && !this.disposed && epoch === this.viewEpoch) {
				this.broadcast({ type: "notice", level: "error", text: `New session failed: ${err instanceof Error ? err.message : String(err)}` });
				this.restoreAttachedView(previousAttachment, epoch);
			}
			return;
		}
		if (this.client !== client || this.disposed || epoch !== this.viewEpoch) return;
		if (response.success) {
			if (!(await this.detachFromDaemon()) || epoch !== this.viewEpoch) return;
			if (!(await this.clearObservation(observedAtStart, epoch))) return;
			// History and New Session start a new top-level view. A breadcrumb into
			// a prior session would make Back cross an explicit session boundary.
			this.returnTargets = [];
			this.resetChildrenBaseline();
			this.resetViewedSessionState();
			this.beginRpcRestore();
			if (await this.restoreOwnRpcView(epoch)) this.scheduleChildrenRefresh();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `New session failed: ${response.error ?? "unknown error"}` });
			this.restoreAttachedView(previousAttachment, epoch);
		}
	}

	/**
	 * `betweenTurnsOnly` is the threshold trigger's contract. Both transports run
	 * AgentSession.compact() without skipAbort, which aborts whatever is in flight
	 * and schedules no continuation — firing it mid-run would swallow the prompt
	 * the operator just sent, with nothing to resend it. Re-checked after every
	 * await because a turn can start while we are connecting.
	 */
	/**
	 * A reply that never came is not the same as work that failed.
	 *
	 * prime-agent's own daemon client gives up on a request after 30s
	 * (dist/modes/daemon/daemon-client.js: `request(command, timeoutMs = 30000)`,
	 * no special case for `compact`), and compaction on a long thread routinely
	 * outlives that. The error it raises names a socket and a log file, so
	 * relaying it verbatim as "Compaction failed" told the operator their
	 * compaction had died when it was still running — and it kept running.
	 *
	 * So: never present a timeout as a failure without asking the session itself
	 * whether it is still compacting. The transcript refresh does not depend on
	 * this reply either; compaction_end drives it.
	 */
	private async compactionStillRunning(): Promise<boolean> {
		try {
			const attached = this.attached;
			if (attached && this.sidecar?.connected) {
				const state = (await this.sidecar.getState(attached.activeSessionId)) as RpcSessionState;
				return state?.isCompacting === true;
			}
			const client = this.client;
			if (client?.running) {
				const response = await client.request({ type: "get_state" }, 15_000);
				if (response.success) return (response.data as RpcSessionState)?.isCompacting === true;
			}
		} catch {
			// Fall back to what the event stream last told us.
		}
		return this.compacting;
	}

	/** Say the true thing about a compact request that did not answer in time. */
	/**
	 * Turn a compaction failure the operator cannot act on into one they can.
	 *
	 * Two of them are about the model rather than the thread, and both are worth
	 * naming because the fix is the same gesture — pick another model — and the
	 * raw provider text says nothing about that:
	 *
	 * - A refusal is the model declining this thread's content. Measured on a
	 *   real 6,500-message thread: claude-opus-5 refused it in ~2s through two
	 *   different providers, while claude-sonnet-5 and a non-Anthropic model
	 *   summarized the very same content without complaint. Retrying the same
	 *   model just reproduces it.
	 * - "prompt is too long" is a context window smaller than the thread, not a
	 *   fault in the request (claude-haiku-4-5 rejected 484,555 tokens against a
	 *   200,000 ceiling on that same thread).
	 */
	private static compactFailureHint(detail: string): string {
		if (/refus/i.test(detail)) {
			return " The model declined to summarize this thread's content.";
		}
		if (/prompt is too long|context (?:window|length) exceeded|too many tokens/i.test(detail)) {
			return " This thread is larger than the current model's context window. Switch to a model with a bigger window and run it again.";
		}
		return "";
	}

	/**
	 * Pick a model to retry a refused compaction with.
	 *
	 * Deliberately capability-based and name-free: a refusal is a verdict from
	 * one model about one thread, and hard-coding which models "work" would be
	 * wrong the day a provider changes its mind. The only property that can be
	 * checked up front is whether a candidate could hold the thread at all —
	 * claude-haiku-4-5 answers a 484,555-token prefix with "prompt is too long"
	 * against its 200,000 ceiling, which is a wasted round trip, not a fallback.
	 *
	 * So: never shrink the context window, never re-offer something already
	 * refused for this thread, and prefer the roomiest candidate.
	 */
	static pickCompactionFallback(
		models: readonly RpcModel[],
		current: RpcModel | null | undefined,
		tried: ReadonlySet<string>,
	): RpcModel | null {
		const key = (model: { provider?: string; id?: string }): string => `${model.provider ?? ""}/${model.id ?? ""}`;
		const floor = current?.contextWindow ?? 0;
		const candidates = models
			.filter((model) => model.provider && model.id)
			.filter((model) => key(model) !== key(current ?? {}))
			.filter((model) => !tried.has(key(model)))
			.filter((model) => (model.contextWindow ?? 0) >= floor);
		if (candidates.length === 0) return null;
		return candidates.reduce((best, model) =>
			(model.contextWindow ?? 0) > (best.contextWindow ?? 0) ? model : best,
		);
	}

	/** Models already asked to summarize THIS thread, so a retry cannot loop. */
	private compactionModelsTried = new Set<string>();

	/** Host-issued one-shot recoveries offered on a notice; see `runNoticeAction`. */
	private noticeActions = new Map<string, () => Promise<void>>();

	/**
	 * Run a recovery the host itself offered. The webview may be compromised, so
	 * the id is only ever a key into this map — never anything it can compose.
	 */
	async runNoticeAction(id: string): Promise<void> {
		const run = this.noticeActions.get(id);
		if (!run) return;
		this.noticeActions.delete(id);
		await run();
	}

	private offerNoticeAction(label: string, run: () => Promise<void>): { id: string; label: string } {
		// One offer at a time: a stale button from an earlier failure would retry
		// against a session the operator has since left.
		this.noticeActions.clear();
		const id = randomUUID();
		this.noticeActions.set(id, run);
		return { id, label };
	}

	private async fetchAvailableModels(): Promise<RpcModel[]> {
		const attached = this.attached;
		if (attached) {
			const sidecar = await this.ensureSidecar();
			const data = await sidecar.request<{ models?: RpcModel[] }>(
				{ type: "get_available_models", activeSessionId: attached.activeSessionId },
				60_000,
			);
			return data.models ?? [];
		}
		const client = this.client;
		if (!client?.running) return [];
		const response = await client.request({ type: "get_available_models" }, 60_000);
		return response.success ? ((response.data as { models?: RpcModel[] }).models ?? []) : [];
	}

	/** Compact once with `model`, then put the operator's model back. */
	private async compactWithModel(model: RpcModel): Promise<void> {
		const original = this.state?.model ?? this.rentedState?.model ?? null;
		const label = model.name ?? `${model.provider}/${model.id}`;
		this.compactionModelsTried.add(`${model.provider}/${model.id}`);
		this.broadcast({ type: "notice", level: "info", text: `Compacting with ${label}…` });
		try {
			await this.setModel(model.provider, model.id);
			await this.compact();
		} finally {
			// The operator picked their model for the work, not for summarising.
			if (original?.provider && original.id) await this.setModel(original.provider, original.id);
		}
	}

	private async reportCompactFailure(detail: string): Promise<void> {
		if (await this.compactionStillRunning()) {
			this.broadcast({
				type: "notice",
				level: "info",
				text: "Compaction is taking longer than the agent's reply timeout — it is still running. The transcript refreshes when it finishes.",
			});
			return;
		}
		const text = `Compaction failed: ${detail}${SessionController.compactFailureHint(detail)}`;
		if (!/refus/i.test(detail)) {
			this.broadcast({ type: "notice", level: "error", text });
			return;
		}
		let fallback: RpcModel | null = null;
		try {
			const current = this.state?.model ?? this.rentedState?.model ?? null;
			this.compactionModelsTried.add(`${current?.provider ?? ""}/${current?.id ?? ""}`);
			fallback = SessionController.pickCompactionFallback(await this.fetchAvailableModels(), current, this.compactionModelsTried);
		} catch {
			// Catalogue unavailable: report the failure without an offer we cannot honour.
		}
		if (!fallback) {
			// No button to offer, so the text has to carry the whole instruction.
			this.broadcast({ type: "notice", level: "error", text: `${text} Another model usually compacts it — switch model and run it again.` });
			return;
		}
		const label = fallback.name ?? `${fallback.provider}/${fallback.id}`;
		this.broadcast({
			type: "notice",
			level: "error",
			text,
			action: this.offerNoticeAction(`Compact with ${label}`, () => this.compactWithModel(fallback)),
		});
	}

	async compact(instructions?: string, opts?: { betweenTurnsOnly?: boolean }): Promise<void> {
		if (this.guardObservedReadOnly("compacting")) return;
		const wouldAbortARun = (): boolean => opts?.betweenTurnsOnly === true && this.effectiveStreaming();
		if (wouldAbortARun()) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached) || wouldAbortARun()) return;
				await sidecar.compact(attached.activeSessionId);
			} catch (err) {
				if (this.isCurrentAttachment(attached)) await this.reportCompactFailure(err instanceof Error ? err.message : String(err));
			}
			return;
		}
		if (this.isReattaching()) return;
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch) || wouldAbortARun()) return;
		try {
			const response = await client.request(
				instructions ? { type: "compact", customInstructions: instructions } : { type: "compact" },
				COMPACT_REPLY_CEILING_MS,
			);
			if (!this.isCurrentRpcView(client, epoch)) return;
			if (!response.success) {
				await this.reportCompactFailure(response.error ?? "unknown error");
			} else {
				await this.refreshSnapshot();
			}
		} catch (err) {
			if (this.isCurrentRpcView(client, epoch)) {
				await this.reportCompactFailure(err instanceof Error ? err.message : String(err));
			}
		}
	}

	/**
	 * Fork the session from the (N-th) user message — mirrors /fork: resolves
	 * the entryId via get_fork_messages order alignment with user rows.
	 */
	/** Rename the active session: daemon set_session_name on attached mode, RPC otherwise. */
	async renameSession(name: string): Promise<void> {
		if (this.guardObservedReadOnly("renaming a session")) return;
		const trimmed = name.trim();
		// The daemon refuses an empty name ("Session name cannot be empty"), on the
		// attached path and the RPC one alike, so a cleared box can only ever have
		// produced a failed round-trip and an error notice — under a message that
		// claimed the name had been cleared. Emptying the field means "leave it
		// alone", which is also what the operator's Escape does.
		if (!trimmed) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				await sidecar.request({ type: "set_session_name", activeSessionId: attached.activeSessionId, name: trimmed }, 15_000);
				if (!this.isCurrentAttachment(attached)) return;
				if (this.rentedState) this.rentedState.sessionName = trimmed;
				this.pushStatus();
				this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch)) return;
		try {
			const response = await client.request({ type: "set_session_name", name: trimmed }, 30_000);
			if (!this.isCurrentRpcView(client, epoch)) return;
			if (response.success) {
				if (this.state) this.state.sessionName = trimmed;
				this.pushStatusLight();
				this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
			} else {
				this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${response.error ?? "unknown error"}` });
			}
		} catch (err) {
			if (this.isCurrentRpcView(client, epoch)) {
				this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${err instanceof Error ? err.message : String(err)}` });
			}
		}
	}

	/** Rename any history session: live sessions go through their owner; offline files get a session_info entry. */
	async renameHistorySession(sessionPath: string, sessionId: string, name: string): Promise<void> {
		if (this.guardObservedReadOnly("renaming a session")) return;
		const session = await this.resolveHistorySession(sessionPath, sessionId);
		if (!session) return;
		sessionPath = session.path;
		sessionId = session.id;
		// History rows carry the session-file uuid, never the 12-char attach
		// handle — comparing only the handle sent the operator to the "rename it
		// from the terminal" refusal for the session they are browsing.
		if (
			(!this.attached && this.state?.sessionId === sessionId) ||
			this.attached?.sessionId === sessionId ||
			(this.attached?.sessionPath !== undefined && normalizeFsPath(this.attached.sessionPath) === normalizeFsPath(sessionPath))
		) {
			await this.renameSession(name);
			return;
		}
		const trimmed = name.trim();
		// A session being live elsewhere is not a reason to refuse: the daemon
		// brokers renames for any client, and `rename_saved_session` is keyed by
		// path so it needs no attach handle. "Close it there first" is the sentence
		// the operator rejected outright.
		try {
			const sidecar = await this.ensureSidecar();
			await sidecar.request({ type: "rename_saved_session", sessionPath, name: trimmed }, 15_000);
			this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
			this.savedCatalog = null;
			void this.listHistory();
			return;
		} catch (err) {
			// Daemon down, or it has no record of this file — fall through to the
			// file append, which is exactly what the daemon does for an offline row.
			if (await isSessionActive(sessionPath)) {
				this.broadcast({
					type: "notice",
					level: "error",
					text: `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
				});
				return;
			}
		}
		const result = await renameSessionOffline(sessionPath, session.fileId, name);
		if (result.ok) {
			this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
			this.savedCatalog = null;
			void this.listHistory();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${result.error ?? "unknown error"}` });
		}
	}

	async forkFromUser(ordinal: number): Promise<void> {
		if (this.guardObservedReadOnly("forking")) return;
		// Fork what is on screen. Against the RPC subprocess this would fork our
		// idle background session and still report "Forked the session".
		if (this.effectiveStreaming()) {
			this.broadcast({ type: "notice", level: "error", text: "Wait for the current run to finish before forking." });
			return;
		}
		const attached = this.attached;
		if (attached) {
			const id = attached.activeSessionId;
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				const data = await sidecar.request<{ messages?: Array<{ entryId: string; text: string }> }>(
					{ type: "get_user_messages_for_forking", activeSessionId: id },
					30_000,
				);
				if (!this.isCurrentAttachment(attached)) return;
				const target = (data.messages ?? [])[ordinal];
				if (!target) {
					this.broadcast({ type: "notice", level: "error", text: `No forkable message at position ${ordinal + 1} (${(data.messages ?? []).length} available).` });
					return;
				}
				await sidecar.request({ type: "fork", activeSessionId: id, entryId: target.entryId }, 60_000);
				if (!this.isCurrentAttachment(attached)) return;
				this.broadcast({ type: "notice", level: "info", text: "Forked the session from that message." });
				await this.refreshSnapshot();
				void this.listHistory();
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `Fork failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch)) return;
		const list = await client.request({ type: "get_fork_messages" }, 30_000);
		if (!this.isCurrentRpcView(client, epoch)) return;
		if (!list.success) {
			this.broadcast({ type: "notice", level: "error", text: `Fork failed: ${list.error ?? "unknown error"}` });
			return;
		}
		const messages = (list.data as { messages?: Array<{ entryId: string; text: string }> })?.messages ?? [];
		const target = messages[ordinal];
		if (!target) {
			this.broadcast({ type: "notice", level: "error", text: `No forkable message at position ${ordinal + 1} (${messages.length} available).` });
			return;
		}
		const response = await client.request({ type: "fork", entryId: target.entryId }, 60_000);
		if (!this.isCurrentRpcView(client, epoch)) return;
		if (response.success) {
			this.broadcast({ type: "notice", level: "info", text: "Forked the session from that message." });
			await this.refreshSnapshot();
			void this.listHistory();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Fork failed: ${response.error ?? "unknown error"}` });
		}
	}

	/**
	 * Messages of the session on screen — the attached one via the daemon, our
	 * own RPC session otherwise. Export and copy must never quietly hand over a
	 * different (usually empty) conversation under the header they can see.
	 */
	private async messagesForExport(): Promise<{ messages: Array<Record<string, unknown>>; state: RpcSessionState | null } | null> {
		if (this.guardObservedReadOnly("exporting or copying this conversation")) return null;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				const messages = await sidecar.getMessages(attached.activeSessionId);
				if (!this.isCurrentAttachment(attached)) return null;
				return { messages, state: this.rentedState };
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `Could not load the attached session: ${err instanceof Error ? err.message : String(err)}` });
				return null;
			}
		}
		const epoch = this.viewEpoch;
		try {
			await this.ensureStarted();
		} catch {
			return null;
		}
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch)) return null;
		const messagesRes = await client.request({ type: "get_messages" }, 90_000);
		if (!this.isCurrentRpcView(client, epoch)) return null;
		if (!messagesRes.success) return null;
		return { messages: (messagesRes.data as { messages?: Array<Record<string, unknown>> })?.messages ?? [], state: this.state };
	}

	/** Copy the whole conversation as Markdown (same summarization as file export). */
	async copyConversation(): Promise<void> {
		const source = await this.messagesForExport();
		if (!source) return;
		const md = buildMarkdownExport(source.messages, true, source.state as unknown as { model?: { provider?: string; id?: string } | null; sessionName?: string } | null);
		await vscode.env.clipboard.writeText(md);
		this.broadcast({ type: "notice", level: "info", text: "Conversation copied as Markdown." });
	}

	/**
	 * Identity of the thread the operator is looking at. Everything per-thread
	 * (draft, compact override, auto-compact ownership) keys on this — while
	 * attached, the RPC session behind us is a different thread entirely.
	 */
	private sessionKey(): string {
		if (this.attached) return this.attached.sessionId ?? this.attached.activeSessionId;
		return this.state?.sessionId ?? this.rpcFileStem() ?? "none";
	}

	/**
	 * Identity of the RPC session when the agent reports only a file. It must be
	 * the jsonl STEM, not the path: this value is what the webview echoes back on
	 * `draftChanged`, and the host rejects anything that is not an identifier — so
	 * a path-keyed session silently persisted no drafts at all.
	 */
	private rpcFileStem(): string | undefined {
		const file = this.state?.sessionFile;
		if (!file) return undefined;
		const stem = path.basename(file, ".jsonl");
		return /^[A-Za-z0-9_-]+$/.test(stem) ? stem : undefined;
	}

	// ---- sticky composer drafts (per session, survive view reloads) ----

	private draftKey(): string {
		return `pa-draft:${this.sessionKey()}`;
	}

	persistDraft(text: string, sessionId: string): void {
		// The webview sends debounced changes. Refuse a late message from the
		// outgoing thread rather than writing it under the new thread's key.
		if (sessionId !== this.sessionKey()) return;
		const bounded = text.slice(0, 16_000);
		void this.context.globalState.update(this.draftKey(), bounded && bounded.trim() ? bounded : undefined);
	}

	private restoreDraft(): void {
		const text = this.context.globalState.get<string>(this.draftKey());
		this.broadcast({ type: "draft", text: text ?? "" });
	}

	// ---- auto-compact threshold (per session, client-side trigger) ----

	private thresholdKey(): string {
		return `pa-ct:${this.sessionKey()}`;
	}

	compactThreshold(): number | null {
		return this.context.globalState.get<number | null>(this.thresholdKey(), null);
	}

	setCompactThreshold(percent: number | null): void {
		if (this.guardObservedReadOnly("changing the compaction threshold")) return;
		// Floor 20% is the operator's own constraint. The ceiling matches
		// defaultCompactPercent()'s: the agent's own default is ~94% on a 262k
		// window, and refusing anything above 80 made that default unreachable —
		// the slider pinned at 80 while the readout said 94.
		if (percent !== null && (percent < 20 || percent > 97)) return;
		void this.context.globalState.update(this.thresholdKey(), percent ?? undefined);
		this.broadcast({ type: "compactThreshold", percent, defaultPercent: this.defaultCompactPercent() });
		this.pushStatus();
	}

	/** Effective agent default: prime-agent compacts when ~reserveTokens (16384) of the window remain. */
	private defaultCompactPercent(): number | null {
		const cw = this.lastUsage.contextWindow;
		if (!cw || cw <= 0) return null;
		const percent = Math.ceil(((cw - 16_384) / cw) * 100);
		return Math.max(20, Math.min(97, percent));
	}

	private historyRefreshTimer: NodeJS.Timeout | null = null;

	/** Debounced history refresh after rename-affecting signals (CLI or other clients). */
	private scheduleHistoryRefresh(): void {
		if (this.historyRefreshTimer) clearTimeout(this.historyRefreshTimer);
		this.historyRefreshTimer = setTimeout(() => {
			this.historyRefreshTimer = null;
			void this.listHistory();
		}, 800);
	}

	private autoCompactSent = false;

	/**
	 * `owner` is the session the percentage was measured on. compact() targets
	 * the session on screen, so firing on someone else's number would compact the
	 * operator's terminal session because our idle background one filled up.
	 */
	private maybeTriggerAutoCompact(percent: number | null, owner: string): void {
		if (owner !== this.sessionKey()) return;
		const threshold = this.compactThreshold();
		if (percent == null || threshold == null) {
			this.autoCompactSent = false;
			return;
		}
		if (percent < Math.max(20, threshold - 15)) {
			this.autoCompactSent = false;
			return;
		}
		// Between turns, never during one. `compact` aborts the in-flight run and
		// nothing resends the aborted prompt, so the old mid-turn gate answered the
		// operator's message with silence. Idle is also why setting a threshold
		// below the current fill compacts right away: pushStatus() lands here.
		if (percent >= threshold && !this.autoCompactSent && !this.effectiveStreaming() && !this.compacting) {
			this.autoCompactSent = true;
			this.broadcast({
				type: "notice",
				level: "info",
				text: `Context hit ${percent}% ≥ ${threshold}% — auto-compacting for this session.`,
			});
			void this.compact(undefined, { betweenTurnsOnly: true });
		}
	}

	async exportChat(): Promise<void> {
		if (this.guardObservedReadOnly("exporting this conversation")) return;
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const picked = await vscode.window.showQuickPick(
			[
				{ label: "Markdown, tool calls summarized", detail: "Compact .md for humans — one line per tool call", mode: "md-tools" },
				{ label: "Markdown, without tool calls", detail: "Conversation only (.md)", mode: "md-clean" },
				{ label: "HTML", detail: "Full interactive transcript via the agent", mode: "html" },
			] as Array<{ label: string; detail: string; mode: string }>,
			{ title: "Export chat" },
		);
		if (!picked || this.disposed || epoch !== this.viewEpoch || this.attached !== attached || this.observingId || this.observationRestoring) return;
		if (picked.mode === "html") return this.exportHtml();
		await this.exportMarkdown(picked.mode === "md-tools");
	}

	/** Export the current transcript as Markdown, generated client-side. */
	async exportMarkdown(includeTools: boolean): Promise<void> {
		if (this.guardObservedReadOnly("exporting this conversation")) return;
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const source = await this.messagesForExport();
		if (!source) {
			this.broadcast({ type: "notice", level: "error", text: "Could not load messages for export" });
			return;
		}
		const md = buildMarkdownExport(source.messages, includeTools, source.state);
		const target = vscode.Uri.file(path.join(this.workspaceRoot, `prime-agent-session-${Date.now()}.md`));
		const picked = await vscode.window.showSaveDialog({ defaultUri: target, filters: { Markdown: ["md"] } });
		if (!picked || this.disposed || epoch !== this.viewEpoch || this.attached !== attached || this.observingId || this.observationRestoring) return;
		await vscode.workspace.fs.writeFile(picked, Buffer.from(md, "utf8"));
		void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
	}

	async exportHtml(): Promise<void> {
		if (this.guardObservedReadOnly("exporting this conversation")) return;
		if (!this.workspaceRoot) return;
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const target = vscode.Uri.file(path.join(this.workspaceRoot, `prime-agent-session-${Date.now()}.html`));
		const picked = await vscode.window.showSaveDialog({ defaultUri: target, filters: { HTML: ["html"] } });
		if (!picked || this.disposed || epoch !== this.viewEpoch || this.attached !== attached || this.observingId || this.observationRestoring) return;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				await sidecar.request({ type: "export_html", activeSessionId: attached.activeSessionId, outputPath: picked.fsPath }, 60_000);
				if (!this.isCurrentAttachment(attached)) return;
				void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
				} catch (err) {
					if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch)) return;
		try {
			const response = await client.request({ type: "export_html", outputPath: picked.fsPath }, 60_000);
			if (!this.isCurrentRpcView(client, epoch)) return;
			if (response.success) {
				void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
			} else {
				this.broadcast({ type: "notice", level: "error", text: `Export failed: ${response.error ?? "unknown error"}` });
			}
		} catch (err) {
			if (this.isCurrentRpcView(client, epoch)) {
				this.broadcast({ type: "notice", level: "error", text: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
			}
		}
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		if (this.guardObservedReadOnly("changing the model")) return;
		// Attached sessions are owned by the daemon, not by our RPC subprocess.
		// Sending set_model to the subprocess would retarget a session the
		// operator isn't looking at, while the pill claims the switch landed.
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				await sidecar.request({ type: "set_model", activeSessionId: attached.activeSessionId, provider, modelId }, 30_000);
				if (!this.isCurrentAttachment(attached)) return;
				await this.refreshAttachedState();
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `set_model failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		const client = this.client;
		const epoch = this.viewEpoch;
		if (!client?.running) return;
		const response = await client.request({ type: "set_model", provider, modelId });
		if (!this.isCurrentRpcView(client, epoch)) return;
		if (response.success) {
			await this.refreshStateAndStats();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `set_model failed: ${response.error ?? "unknown error"}` });
		}
	}

	async setThinkingLevel(level: string): Promise<void> {
		if (this.guardObservedReadOnly("changing the thinking level")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				await sidecar.request({ type: "set_thinking_level", activeSessionId: attached.activeSessionId, level }, 30_000);
				if (!this.isCurrentAttachment(attached)) return;
				await this.refreshAttachedState();
			} catch (err) {
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "notice", level: "error", text: `set_thinking_level failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		const client = this.client;
		const epoch = this.viewEpoch;
		if (!client?.running) return;
		const response = await client.request({ type: "set_thinking_level", level });
		if (!this.isCurrentRpcView(client, epoch)) return;
		if (response.success) {
			await this.refreshStateAndStats();
		}
	}

	async listModels(): Promise<void> {
		if (this.guardObservedReadOnly("listing models")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				const data = await sidecar.request<{ models?: RpcModel[] }>(
					{ type: "get_available_models", activeSessionId: attached.activeSessionId },
					60_000,
				);
				if (this.isCurrentAttachment(attached)) this.broadcast({ type: "models", models: data.models ?? [] });
			} catch (err) {
				if (this.isCurrentAttachment(attached)) {
					this.broadcast({ type: "notice", level: "error", text: `Could not list attached-session models: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch)) return;
		const response = await client.request({ type: "get_available_models" }, 60_000);
		if (!this.isCurrentRpcView(client, epoch)) return;
		if (response.success) {
			// Forwarded verbatim: the payload is the agent's whole Model object, and
			// the webview needs the fields this cast used to hide (thinkingLevelMap).
			const data = response.data as { models?: RpcModel[] };
			this.broadcast({ type: "models", models: data.models ?? [] });
		}
	}

	/**
	 * The slash catalog is a property of the agent BUILD, not of the session on
	 * screen, and the webview asks for it again every time a session boundary
	 * discards its copy. So it must answer in exactly the states the old guards
	 * refused: while attached to a daemon session, while observing, and while a
	 * restore is in flight — those are precisely when a boundary just happened.
	 * guardObservedReadOnly() also had no business here: it exists to refuse
	 * MUTATIONS on a read-only view, and it made a harmless catalog query pop an
	 * operator-facing "that session is read-only" warning.
	 */
	async listCommands(): Promise<void> {
		await this.ensureStarted();
		const client = this.client;
		if (!client?.running || this.disposed) return;
		const response = await client.request({ type: "get_commands" }, 30_000);
		// Identity only: a reply from the client we asked is valid for any view,
		// because the answer does not describe a session.
		if (this.client !== client || this.disposed) return;
		if (response.success) {
			const data = response.data as { commands?: RpcSlashCommand[] };
			this.broadcast({ type: "commands", commands: data.commands ?? [] });
		}
	}

	showHistoryView(): void {
		this.broadcast({ type: "showHistory" });
		void this.listHistory();
	}

	/**
	 * History actions are capabilities, not arbitrary file operations. A webview
	 * may only act on a session record the host generated from its catalog. If a
	 * sidebar was reloaded, refresh once before rejecting the stale row.
	 */
	private async resolveHistorySession(sessionPath: string, sessionId: string): Promise<ResolvedHistorySession | null> {
		if (typeof sessionPath !== "string" || typeof sessionId !== "string" || !sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
			this.broadcast({ type: "notice", level: "error", text: "Invalid session reference." });
			return null;
		}
		const target = normalizeFsPath(sessionPath);
		let rows = this.actionHistory ?? this.lastHistory;
		let match = rows?.find((row) => row.id === sessionId && normalizeFsPath(row.path) === target);
		if (!match) {
			rows = await this.collectHistory();
			this.lastHistory = rows;
			match = rows.find((row) => row.id === sessionId && normalizeFsPath(row.path) === target);
		}
		if (!match) {
			this.broadcast({ type: "notice", level: "warning", text: "That session is no longer available in history." });
			return null;
		}
		try {
			const stat = await fs.lstat(match.path);
			const resolvedPath = path.resolve(match.path);
			const fileId = path.basename(resolvedPath, ".jsonl");
			if (!stat.isFile() || stat.isSymbolicLink() || !/^[A-Za-z0-9_-]+$/.test(fileId) || path.basename(resolvedPath) !== `${fileId}.jsonl`) {
				throw new Error("not a regular session file");
			}
			// Daemon catalogs may expose a runtime/session UUID that differs from the
			// transcript filename stem. Keep the former for view identity and derive
			// the latter only after resolving this host-issued path for file actions.
			return { ...match, path: resolvedPath, fileId };
		} catch {
			this.broadcast({ type: "notice", level: "warning", text: "That session file is no longer available." });
			return null;
		}
	}

	// ------------------------------------------------------------------
	// Session deletion (same conventions as the CLI: trash-first + artifacts)
	// ------------------------------------------------------------------

	async deleteSessionByPath(sessionPath: string, sessionId: string): Promise<void> {
		if (this.guardObservedReadOnly("deleting a session")) return;
		const session = await this.resolveHistorySession(sessionPath, sessionId);
		if (!session) return;
		sessionPath = session.path;
		sessionId = session.id;
		const fileId = session.fileId;
		// The attached session is one the operator is in, so it earns the honest
		// refusal rather than "close it there first" — the sentence #19 rejected.
		if ((!this.attached && sessionId === this.state?.sessionId) || sessionId === this.attached?.sessionId) {
			this.broadcast({ type: "notice", level: "warning", text: "You can't delete the session you're in. Start a new one first." });
			return;
		}
		// The CLI refuses to delete a resident session too (delete_saved_session:
		// "Cannot delete the currently active session") — but it offers Archive for
		// exactly this case, so say that instead of stranding the operator.
		if (await isSessionActive(sessionPath)) {
			this.broadcast({
				type: "notice",
				level: "warning",
				text: "That session is live in another client — archive it instead, or stop it there first.",
			});
			return;
		}
		const result = await deleteSession(sessionPath, fileId);
		if (result.ok) {
			const method = result.method === "trash" ? "moved to Trash" : "deleted";
			this.broadcast({ type: "notice", level: "info", text: `Session ${method} (artifacts removed).` });
			this.forgetHistoryRow(sessionPath);
			this.savedCatalog = null;
			await this.listHistory();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Could not delete session: ${result.error ?? "unknown error"}` });
		}
	}

	// ------------------------------------------------------------------
	// Favorite models (persisted in globalState)
	// ------------------------------------------------------------------

	private favorites(): ModelRef[] {
		return this.context.globalState.get<ModelRef[]>("primeAgent.favoriteModels", []);
	}

	sendFavorites(): void {
		this.broadcast({ type: "favorites", favorites: this.favorites() });
	}

	async toggleFavoriteModel(provider: string, modelId: string): Promise<void> {
		const current = this.favorites();
		const exists = current.some((f) => f.provider === provider && f.modelId === modelId);
		const next = exists
			? current.filter((f) => !(f.provider === provider && f.modelId === modelId))
			: [...current, { provider, modelId }];
		await this.context.globalState.update("primeAgent.favoriteModels", next);
		this.sendFavorites();
	}

	/**
	 * Mirror of the CLI's classifySessionRosterStatus. isStreaming alone calls a
	 * compacting session, a running bash, a queued follow-up or a session whose
	 * subagents are still working "idle" — the CLI shows all of them running. The
	 * trailing terms are redundant with isSessionActive but keep older daemons honest.
	 */
	private static isRunningSummary(s: SessionSummaryRef): boolean {
		return Boolean(
			s.hasActiveHeartbeat ||
				s.activity === "working" ||
				s.isSessionActive ||
				s.hasRunningRlmChildren ||
				s.isStreaming ||
				s.isCompacting ||
				s.isBashRunning ||
				(s.unfinishedActionCount ?? 0) > 0,
		);
	}

	/**
	 * History rows from the daemon's own catalog. This is the authority: it has
	 * read every session file end to end, so the CURRENT name (a rename appended
	 * megabytes into a file), the message count and the lifecycle are exact —
	 * none of which a bounded tail read can promise.
	 *
	 * Buckets are filled independently. A single global cap applied before
	 * bucketing is what starved "This workspace" down to three rows while 79
	 * sessions from other folders ate the budget.
	 */
	private rowsFromCatalog(catalog: SessionSummaryRef[]): RecentSession[] {
		const root = normalizeFsPath(this.workspaceRoot);
		const inWorkspaceRows: RecentSession[] = [];
		const otherRows: RecentSession[] = [];
		for (const s of catalog) {
			if (!s.sessionFile || !s.cwd) continue;
			// Subagents belong under their parent in the strip, not in history.
			if ((s.rlmDepth ?? 0) > 0) continue;
			// shouldShowAgentsViewSession: live only. Drafts (no message yet) and
			// archived sessions stay out, so the extension and the CLI agree on
			// what "your sessions" means.
			if (s.lifecycle !== "live") continue;
			const modified = s.modified ?? s.lastActivityAt;
			const parsed = modified ? Date.parse(modified) : Number.NaN;
			const inWorkspace = normalizeFsPath(s.cwd) === root;
			(inWorkspace ? inWorkspaceRows : otherRows).push({
				id: s.sessionId ?? path.basename(s.sessionFile, ".jsonl"),
				path: s.sessionFile,
				cwd: s.cwd,
				timestamp: s.created ?? modified ?? new Date().toISOString(),
				modifiedMs: Number.isFinite(parsed) ? parsed : undefined,
				name: s.sessionName,
				firstPrompt: s.firstMessage,
				inWorkspace,
				running: SessionController.isRunningSummary(s),
			});
		}
		const activityOf = (s: RecentSession): number => {
			if (s.modifiedMs !== undefined) return s.modifiedMs;
			const parsed = Date.parse(s.timestamp);
			return Number.isFinite(parsed) ? parsed : 0;
		};
		const byActivityDesc = (a: RecentSession, b: RecentSession): number => activityOf(b) - activityOf(a);
		inWorkspaceRows.sort(byActivityDesc);
		otherRows.sort(byActivityDesc);
		return [...inWorkspaceRows.slice(0, HISTORY_WORKSPACE_LIMIT), ...otherRows.slice(0, HISTORY_OTHER_LIMIT)];
	}

	/** Daemon catalog when it answers, on-disk scan when it does not. */
	private async collectHistory(): Promise<RecentSession[]> {
		try {
			const sidecar = await this.ensureSidecar();
			return this.rowsFromCatalog(await this.listSessions(sidecar));
		} catch {
			// Daemon unreachable: the scan is less exact about names but it is the
			// difference between a stale title and no history at all.
			return listRecentSessions(this.workspaceRoot, {
				workspaceLimit: HISTORY_WORKSPACE_LIMIT,
				otherLimit: HISTORY_OTHER_LIMIT,
			});
		}
	}

	async listHistory(): Promise<void> {
		const generation = ++this.historyRequestGeneration;
		// Repaint the previous answer first. The sidebar webview is torn down on
		// every hide, so without a host-side cache the list flashes "Loading…"
		// through a full catalog fetch each time the operator comes back.
		if (this.lastHistory) this.broadcast({ type: "history", sessions: this.lastHistory });
		let sessions: RecentSession[];
		try {
			sessions = await this.collectHistory();
		} catch (err) {
			if (!this.disposed && generation === this.historyRequestGeneration) {
				this.broadcast({ type: "notice", level: "error", text: `Could not load history: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		if (this.disposed || generation !== this.historyRequestGeneration) return;
		this.lastHistory = sessions;
		this.actionHistory = sessions;
		this.broadcast({ type: "history", sessions });
	}

	/**
	 * Search the way the CLI does: over the conversation itself, not just the row
	 * labels. `allMessagesText` rides only on `list_saved_sessions` (the `list`
	 * catalog does not carry it), so this is a second, heavier call — cached for
	 * a few seconds because the webview searches as the operator types.
	 *
	 * Matching rows come back with a `matchSnippet`, which is what lets the
	 * webview's own filter rank them: it cannot see the transcript, only what we
	 * hand it, and a hit with no visible reason reads as a bug.
	 */
	async searchHistory(query: string): Promise<void> {
		const generation = ++this.historyRequestGeneration;
		const needle = query.trim().toLowerCase();
		let base: RecentSession[];
		try {
			base = await this.collectHistory();
		} catch {
			if (!this.disposed && generation === this.historyRequestGeneration) this.broadcast({ type: "history", sessions: [] });
			return;
		}
		if (this.disposed || generation !== this.historyRequestGeneration) return;
		this.lastHistory = base;
		if (needle.length < 2) {
			this.actionHistory = base;
			this.broadcast({ type: "history", sessions: base });
			return;
		}
		let saved: SavedSessionInfo[];
		try {
			saved = await this.savedSessionCatalog();
		} catch {
			// No text corpus available — the webview still filters on names/paths.
			// Same generation guard as every other exit: a slow failure for an old
			// query must not repaint (nor re-authorize) a newer answer's list.
			if (!this.disposed && generation === this.historyRequestGeneration) {
				this.actionHistory = base;
				this.broadcast({ type: "history", sessions: base });
			}
			return;
		}
		if (this.disposed || generation !== this.historyRequestGeneration) return;
		const snippetByPath = new Map<string, string>();
		const hits: RecentSession[] = [];
		const knownPaths = new Set(base.map((s) => normalizeFsPath(s.path)));
		const root = normalizeFsPath(this.workspaceRoot);
		for (const info of saved) {
			// Same visibility rule as the roster, or search would resurrect exactly
			// the drafts and archived sessions the list deliberately hides.
			if ((info.messageCount ?? 0) === 0 || info.state?.status === "archived" || info.state?.status === "crash") continue;
			const body = info.allMessagesText ?? "";
			const at = body.toLowerCase().indexOf(needle);
			if (at < 0) continue;
			const key = normalizeFsPath(info.path);
			const snippet = excerpt(body, at, needle.length);
			if (knownPaths.has(key)) {
				snippetByPath.set(key, snippet);
				continue;
			}
			// A session the roster capped away still deserves to be findable.
			const modified = info.modified ? Date.parse(info.modified) : Number.NaN;
			hits.push({
				id: info.id,
				path: info.path,
				cwd: info.cwd,
				timestamp: info.created ?? info.modified ?? new Date().toISOString(),
				modifiedMs: Number.isFinite(modified) ? modified : undefined,
				name: info.name,
				firstPrompt: info.firstMessage,
				inWorkspace: normalizeFsPath(info.cwd) === root,
				// `running` stays unset: the saved catalog has no runtime state, and
				// "we did not ask" must not render as "not running".
				matchSnippet: snippet,
			});
		}
		// Copy rather than tag `base` in place — it is the cache replayed on the
		// next visit, and a snippet for a query the operator has already cleared
		// would sit under the row explaining nothing.
		const decorated = base.map((s) => {
			const snippet = snippetByPath.get(normalizeFsPath(s.path));
			return snippet ? { ...s, matchSnippet: snippet } : s;
		});
		const results = [...decorated, ...hits];
		this.actionHistory = results;
		this.broadcast({ type: "history", sessions: results });
	}

	/** Drop a row from the replay cache so a deleted/archived session never flashes back. */
	private forgetHistoryRow(sessionPath: string): void {
		if (!this.lastHistory) return;
		const target = normalizeFsPath(sessionPath);
		this.lastHistory = this.lastHistory.filter((s) => normalizeFsPath(s.path) !== target);
		if (this.actionHistory) this.actionHistory = this.actionHistory.filter((s) => normalizeFsPath(s.path) !== target);
	}

	private async savedSessionCatalog(): Promise<SavedSessionInfo[]> {
		const now = Date.now();
		if (this.savedCatalog && now - this.savedCatalog.at < SAVED_CATALOG_TTL_MS) return this.savedCatalog.rows;
		const sidecar = await this.ensureSidecar();
		const rows = await sidecar.listSavedSessions(this.workspaceRoot, "all");
		this.savedCatalog = { at: now, rows };
		return rows;
	}

	/** Stop a live session from the history view (daemon abort on its active id). */
	async stopSession(sessionPath: string, sessionId: string): Promise<void> {
		if (this.guardObservedReadOnly("stopping a session")) return;
		const session = await this.resolveHistorySession(sessionPath, sessionId);
		if (!session) return;
		try {
			const sidecar = await this.ensureSidecar();
			const resident = (await this.listSessions(sidecar)).find(
				(row) =>
					row.activeSessionId &&
					(row.sessionId === session.id || (row.sessionFile && normalizeFsPath(row.sessionFile) === normalizeFsPath(session.path))),
			);
			if (!resident?.activeSessionId) {
				this.broadcast({ type: "notice", level: "warning", text: "That session is no longer running." });
				return;
			}
			await sidecar.abort(resident.activeSessionId);
			this.broadcast({ type: "notice", level: "info", text: "Stop requested for that session." });
			void this.listHistory();
		} catch (err) {
			this.broadcast({ type: "notice", level: "error", text: `Could not stop the session: ${err instanceof Error ? err.message : String(err)}` });
		}
	}

	/**
	 * Archive: the CLI's non-destructive retire (agents-view-mode.ts binds it to
	 * the delete key on a LIVE row and calls it "stop/deactivate"). Kill the agent
	 * if it is resident, then append {status:"archived"} to the jsonl. The
	 * transcript stays on disk and stays resumable by path; the session just
	 * leaves the roster. The kill has to land first — a resident session would
	 * rewrite the file from its own entry list and drop our entry.
	 */
	async archiveSession(sessionPath: string, sessionId: string): Promise<void> {
		if (this.guardObservedReadOnly("archiving a session")) return;
		const session = await this.resolveHistorySession(sessionPath, sessionId);
		if (!session) return;
		sessionPath = session.path;
		sessionId = session.id;
		const fileId = session.fileId;
		if ((!this.attached && sessionId === this.state?.sessionId) || sessionId === this.attached?.sessionId) {
			this.broadcast({ type: "notice", level: "warning", text: "You can't archive the session you're in. Start a new one first." });
			return;
		}
		try {
			const sidecar = await this.ensureSidecar();
			const resident = (await this.listSessions(sidecar)).find(
				(s) => (s.sessionFile ? normalizeFsPath(s.sessionFile) === normalizeFsPath(sessionPath) : false) && s.activeSessionId,
			);
			if (resident?.activeSessionId) {
				await sidecar.request({ type: "kill", activeSessionId: resident.activeSessionId }, 30_000);
				const stillResident = (await this.listSessions(sidecar)).some(
					(row) => row.activeSessionId === resident.activeSessionId,
				);
				if (stillResident) throw new Error("session is still stopping; try Archive again once it is inactive");
			}
		} catch (err) {
			// If the daemon is unavailable, a live lease is evidence enough that a
			// file append could be overwritten by its owner. Refuse rather than claim
			// an archive that the daemon can immediately undo.
			if (await isSessionActive(sessionPath)) {
				this.broadcast({ type: "notice", level: "error", text: `Could not archive the live session: ${err instanceof Error ? err.message : String(err)}` });
				return;
			}
		}
		const result = await archiveSessionFile(sessionPath, fileId);
		if (result.ok) {
			this.broadcast({ type: "notice", level: "info", text: "Session archived — the transcript is kept, and it stays resumable from the CLI." });
			this.savedCatalog = null;
			this.forgetHistoryRow(sessionPath);
			await this.listHistory();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Could not archive session: ${result.error ?? "unknown error"}` });
		}
	}

	async pickModelQuickPick(): Promise<void> {
		if (this.guardObservedReadOnly("choosing a model")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				const [modelData, state] = await Promise.all([
					sidecar.request<{ models?: RpcModel[] }>({ type: "get_available_models", activeSessionId: attached.activeSessionId }, 60_000),
					sidecar.getState(attached.activeSessionId),
				]);
				if (!this.isCurrentAttachment(attached)) return;
				this.rentedState = state as RpcSessionState;
				const models = modelData.models ?? [];
				const current = this.rentedState.model;
				const picked = await vscode.window.showQuickPick(
					models.map((model) => ({
						label: `${model.provider}/${model.id}`,
						description: model.id === current?.id && model.provider === current?.provider ? "(current)" : model.name,
						model,
					})),
					{ title: "Select model", placeHolder: `${models.length} models available` },
				);
				// Native quick-picks may stay open while the user navigates. A choice
				// made for the old attached session must never retarget the new view.
				if (!picked || !this.isCurrentAttachment(attached)) return;
				await this.setModel(picked.model.provider, picked.model.id);
			} catch (err) {
				if (this.isCurrentAttachment(attached)) {
					this.broadcast({ type: "notice", level: "error", text: `Could not list attached-session models: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch) || this.observationRestoring) return;
		const response = await client.request({ type: "get_available_models" }, 60_000);
		if (!this.isCurrentRpcView(client, epoch) || this.observationRestoring) return;
		if (!response.success) {
			this.broadcast({ type: "notice", level: "error", text: `Could not list models: ${response.error ?? "unknown error"}` });
			return;
		}
		const models = (response.data as { models?: Array<{ provider: string; id: string; name?: string; contextWindow?: number }> }).models ?? [];
		const current = this.state?.model;
		const picked = await vscode.window.showQuickPick(
			models.map((model) => ({
				label: `${model.provider}/${model.id}`,
				description: model.id === current?.id && model.provider === current?.provider ? "(current)" : model.name,
				model,
			})),
			{ title: "Select model", placeHolder: `${models.length} models available` },
		);
		if (picked && this.isCurrentRpcView(client, epoch) && !this.observationRestoring) {
			await this.setModel(picked.model.provider, picked.model.id);
		}
	}

	async pickThinkingQuickPick(): Promise<void> {
		if (this.guardObservedReadOnly("choosing a thinking level")) return;
		const attached = this.attached;
		if (attached) {
			try {
				const sidecar = await this.ensureSidecar();
				if (!this.isCurrentAttachment(attached)) return;
				const state = (await sidecar.getState(attached.activeSessionId)) as RpcSessionState;
				if (!this.isCurrentAttachment(attached)) return;
				this.rentedState = state;
				const levels = supportedThinkingLevels(state.model) ?? THINKING_LEVELS.slice(0, 5);
				const current = state.thinkingLevel ?? "off";
				const picked = await vscode.window.showQuickPick(
					levels.map((level) => ({ label: level, description: level === current ? "(current)" : undefined })),
					{ title: "Select thinking level" },
				);
				if (!picked || !this.isCurrentAttachment(attached)) return;
				await this.setThinkingLevel(picked.label);
			} catch (err) {
				if (this.isCurrentAttachment(attached)) {
					this.broadcast({ type: "notice", level: "error", text: `Could not load attached-session thinking levels: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
			return;
		}
		const epoch = this.viewEpoch;
		await this.ensureStarted();
		const client = this.client;
		if (!client || !this.isCurrentRpcView(client, epoch) || this.observationRestoring) return;
		// Same source as the brain popout: offering a level the model rejects only
		// buys the operator a silent clamp to something they did not pick.
		const levels = supportedThinkingLevels(this.state?.model) ?? THINKING_LEVELS.slice(0, 5);
		const current = this.state?.thinkingLevel ?? "off";
		const picked = await vscode.window.showQuickPick(
			levels.map((level) => ({ label: level, description: level === current ? "(current)" : undefined })),
			{ title: "Select thinking level" },
		);
		if (picked && this.isCurrentRpcView(client, epoch) && !this.observationRestoring) {
			await this.setThinkingLevel(picked.label);
		}
	}

	async switchSession(sessionPath: string, sessionId: string): Promise<void> {
		// Claim navigation ownership before validating the host-issued capability:
		// a slow filesystem validation for an old click must never win over a newer
		// history selection.
		const previousAttachment = this.attached;
		const epoch = this.beginNavigation();
		const observedAtStart = this.observingId;
		const session = await this.resolveHistorySession(sessionPath, sessionId);
		if (!session || this.disposed || epoch !== this.viewEpoch) {
			this.restoreAttachedView(previousAttachment, epoch);
			return;
		}
		sessionPath = session.path;
		sessionId = session.id;
		// Re-attaching an already attached session and then releasing the previous
		// attachment would release the attachment we just refreshed. Treat this as
		// the no-op the history row represents instead.
		if (this.attached && normalizeFsPath(this.attached.sessionPath) === normalizeFsPath(sessionPath)) {
			this.broadcast({ type: "notice", level: "info", text: "You are already viewing that session." });
			this.restoreAttachedView(previousAttachment, epoch);
			return;
		}
		await this.ensureStarted();
		if (!this.client || this.disposed || epoch !== this.viewEpoch) {
			this.restoreAttachedView(previousAttachment, epoch);
			return;
		}
		const client = this.client;
		let response;
		try {
			response = await client.request({ type: "switch_session", sessionPath }, 60_000);
		} catch (err) {
			if (this.client === client && !this.disposed && epoch === this.viewEpoch) {
				this.broadcast({ type: "notice", level: "error", text: `Could not resume session: ${err instanceof Error ? err.message : String(err)}` });
				this.restoreAttachedView(previousAttachment, epoch);
			}
			return;
		}
		if (this.client !== client || this.disposed || epoch !== this.viewEpoch) return;
		if (response.success) {
			if (!(await this.detachFromDaemon(previousAttachment)) || epoch !== this.viewEpoch) return;
			if (!(await this.clearObservation(observedAtStart, epoch))) return;
			this.returnTargets = [];
			this.resetViewedSessionState();
			// Reset the spawn baseline with the strip: without this the next
			// children refresh reads every subagent of the resumed session as
			// "newly spawned" and blasts a card for each into the transcript.
			this.resetChildrenBaseline();
			this.beginRpcRestore();
			if (await this.restoreOwnRpcView(epoch)) this.scheduleChildrenRefresh();
			return;
		}
		const error = response.error ?? "unknown error";
		if (/already active/i.test(error)) {
			const id = sessionId;
			const attached = await this.attachViaDaemon(id, sessionPath, epoch);
			if (this.disposed || epoch !== this.viewEpoch) return;
			if (attached) {
				const currentAttachment = this.attached;
				if (!currentAttachment || epoch !== this.viewEpoch) return;
				if (previousAttachment && currentAttachment !== previousAttachment && this.sidecar?.connected) {
					try {
						await this.detachDaemonSession(this.sidecar, previousAttachment.activeSessionId);
					} catch {
						// The daemon may already have released the prior viewer.
					}
				}
				if (!(await this.clearObservation(observedAtStart, epoch))) return;
				this.returnTargets = [];
				return;
			}
			const observed = await this.startObserving(id, previousAttachment, epoch, sessionPath, observedAtStart);
			if (this.disposed || epoch !== this.viewEpoch) return;
			if (observed) return;
			this.restoreAttachedView(previousAttachment, epoch);
			this.broadcast({
				type: "notice",
				level: "warning",
				text:
					"That session is live in another client (likely a terminal). Close it there first, " +
					"then resume from here.",
			});
			return;
		}
		this.broadcast({ type: "notice", level: "error", text: `Could not resume session: ${error}` });
		this.restoreAttachedView(previousAttachment, epoch);
	}

	/** Attach to a resident session read-only through the daemon observe channel. */
	private async startObserving(
		sessionId: string,
		previousAttachment: AttachRef | null = this.attached,
		epoch = this.viewEpoch,
		sessionPath?: string,
		observedAtStart: string | null = this.observingId,
	): Promise<boolean> {
		if (!this.client) return false;
		const client = this.client;
		const response = await client.request({ type: "observe", activeSessionId: sessionId }, 30_000);
		if (
			this.client !== client ||
			this.disposed ||
			epoch !== this.viewEpoch ||
			this.attached !== previousAttachment ||
			this.observingId !== observedAtStart
		)
			return false;
		if (!response.success) return false;
		// Do not retain a writable attachment beneath an observed transcript. If
		// attaching B failed after we were attached to A, leaving A here made every
		// action that fell through to `attached` silently operate on A.
		if (!(await this.detachFromDaemon(previousAttachment)) || epoch !== this.viewEpoch) return false;
		if (!(await this.clearObservation(observedAtStart, epoch))) return false;
		// A daemon reconnect belongs to the writable attachment that just gave way
		// to this read-only view. Do not let its already-in-flight attach complete
		// underneath observation and start delivering a second event stream.
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.clearReattachTimer();
		this.returnTargets = [];
		this.resetChildrenBaseline();
		this.resetViewedSessionState();
		this.observationRestoring = false;
		this.observingId = sessionId;
		this.observedSession = { activeSessionId: sessionId, sessionId, sessionPath };
		const messages = (response.data as { messages?: AgentMessage[] })?.messages ?? [];
		this.cachedMessages = messages;
		this.broadcast({ type: "observedSession", sessionId, messages });
		this.pushStatus();
		return true;
	}

	
	// ----------------------------------------------------------------
	// Daemon sidecar: attached live sessions (terminal parity)
	// ----------------------------------------------------------------

	private async ensureSidecar(options: { reattach?: boolean } = {}): Promise<DaemonSidecar> {
		// The daemon binds a connection's identity on its first command envelope, so
		// a claim can only be applied to a FRESH socket. Learning our owner id late
		// (the descriptor is written just after the RPC session starts) or moving to
		// a different worker therefore has to replace the connection.
		//
		// Only ever upgrade or switch: a lookup that momentarily comes back empty —
		// a descriptor caught mid-rewrite — must not drop a working claim and tear
		// down a live attachment with it. The claim is released deliberately when
		// the RPC process exits (see `releaseOwnerIdentity`).
		const owner = this.ownedRosterClientId();
		if (this.sidecar && owner && this.sidecar.impersonateClientId !== owner) {
			this.sidecar.dispose();
			this.sidecar = null;
		}
		if (!this.sidecar) {
			this.sidecar = new DaemonSidecar();
			this.sidecar.impersonateClientId = owner ?? null;
			this.sidecar.onEvent = (message) => this.onDaemonEvent(message);
			this.sidecar.onAnyLine = (byteLength) => this.debugLog.append(`sidecar-line bytes=${byteLength}`);
			this.sidecar.onClose = () => {
				if (this.attached) {
					const attachment = this.attached;
					const attachmentEpoch = this.attachedEpoch;
					// The daemon dropped our attach registration with the socket, so we
					// are NOT following this session any more. Leaving `attached` set
					// makes the re-attach guard below permanently false and the notice
					// below a lie: prompts would still land but no events would return.
					this.attached = null;
					this.attachedEpoch = null;
					if (attachmentEpoch === this.viewEpoch) {
						this.attachAttempt = { ...attachment };
						this.attachAttemptEpoch = attachmentEpoch;
						this.broadcast({ type: "notice", level: "warning", text: "Daemon connection dropped — re-attaching when it comes back." });
					} else {
						this.attachAttempt = null;
						this.attachAttemptEpoch = null;
						// A newer explicit navigation owns the display. Keep it
						// non-interactive until that navigation either completes or
						// restores an authoritative RPC snapshot.
						this.observationRestoring = true;
						// ...but that navigation may itself be blocked on the socket
						// that just died. Nothing else would ever clear the lock, so
						// fall back to this window's own session after a grace period.
						const restoreEpoch = this.viewEpoch;
						const settle = setTimeout(() => {
							if (this.disposed || restoreEpoch !== this.viewEpoch) return;
							if (this.attached || this.observingId || !this.observationRestoring) return;
							void this.restoreAfterObservationClosed(restoreEpoch);
						}, 2_000);
						settle.unref?.();
					}
					this.pushStatus();
					if (attachmentEpoch === this.viewEpoch) this.scheduleReattach(0);
				}
			};
		}
		if (!this.sidecar.connected) {
			await this.sidecar.connect();
		}
		// Seamless re-attach after a drop: pick up exactly where the user was.
		// Serialized like connect(): two callers arriving while the socket was down
		// would otherwise both issue `attach` for the same handle, and the loser
		// would detach the attachment the winner had just installed — leaving a
		// live-looking view that receives no events and never recovers.
		if (options.reattach !== false && this.sidecar.connected && this.attachAttempt && !this.attached) {
			if (!this.reattaching) {
				const sidecar = this.sidecar;
				this.reattaching = this.runReattach(sidecar).finally(() => {
					this.reattaching = null;
				});
			}
			await this.reattaching;
		}
		return this.sidecar;
	}

	/** One re-attach attempt for the dropped view. Never run concurrently with itself. */
	private reattaching: Promise<void> | null = null;

	private async runReattach(sidecar: DaemonSidecar): Promise<void> {
		if (this.sidecar !== sidecar || !sidecar.connected || !this.attachAttempt || this.attached) return;
		const attempt = this.attachAttempt;
		const attemptEpoch = this.attachAttemptEpoch;
		if (attemptEpoch === null || attemptEpoch !== this.viewEpoch) {
			if (this.attachAttempt === attempt) {
				this.attachAttempt = null;
				this.attachAttemptEpoch = null;
				this.clearReattachTimer();
			}
			return;
		}
		try {
			// A release of this handle may still be in flight; attaching under it
			// lets the late detach tear down the fresh subscription.
			await this.waitForDaemonDetach(attempt.activeSessionId);
			if (this.sidecar !== sidecar || this.attachAttempt !== attempt || this.viewEpoch !== attemptEpoch || this.attached) return;
			const result = await sidecar.attach(attempt.activeSessionId);
			// The user may have switched, stopped observing, or disposed the panel
			// while the daemon was answering. A late reattach must never reclaim the
			// view (and therefore later prompts) from that newer navigation.
			if (
				this.disposed ||
				this.viewEpoch !== attemptEpoch ||
				this.attachAttempt !== attempt ||
				this.attachAttemptEpoch !== attemptEpoch ||
				this.attached !== null ||
				this.observingId !== null
			) {
				// Never release a handle that is now the live attachment: that is
				// the same daemon registration another attach just installed, and
				// dropping it silently kills the event stream for a view that
				// still looks (and behaves) attached.
				if ((this.attached as AttachRef | null)?.activeSessionId !== attempt.activeSessionId) {
					try {
						await this.detachDaemonSession(sidecar, attempt.activeSessionId);
					} catch {
						// The daemon may already have released the stale viewer.
					}
				}
				return;
			}
			this.attached = attempt;
			this.attachedEpoch = attemptEpoch;
			this.clearReattachTimer();
			this.observationRestoring = false;
			this.applyAttachedSnapshot(result.snapshot);
			this.broadcast({
				type: "notice",
				level: "info",
				text: "Re-attached to the live session.",
			});
		} catch {
			// keep the attempt saved? user closed it in the meantime — drop
			if (
				!this.disposed &&
				this.attachAttempt === attempt &&
				this.attachAttemptEpoch === attemptEpoch &&
				this.viewEpoch === attemptEpoch &&
				this.attached === null
			) {
				this.attachAttempt = null;
				this.attachAttemptEpoch = null;
				this.clearReattachTimer();
				// The shared transcript is still painted. Never make it writable-looking
				// by falling through to the hidden RPC session before that session has
				// produced a fresh snapshot.
				this.observationRestoring = true;
				const epoch = this.beginNavigation();
				this.pushStatus();
				void this.restoreAfterObservationClosed(epoch);
			}
		}
	}

	/** Wait for an earlier release of this daemon handle before attaching it again. */
	private async waitForDaemonDetach(activeSessionId: string): Promise<void> {
		const pending = this.pendingDaemonDetaches.get(activeSessionId);
		if (!pending) return;
		try {
			await pending;
		} catch {
			// A failed release leaves no daemon registration to wait on.
		}
	}

	/**
	 * Serialize detach calls by active handle. Without this, Browse can start
	 * releasing parent A just as Back re-attaches A, and its late detach tears
	 * down the fresh parent subscription.
	 */
	private async detachDaemonSession(sidecar: DaemonSidecar, activeSessionId: string): Promise<void> {
		const prior = this.pendingDaemonDetaches.get(activeSessionId);
		const chained = (prior ? prior.catch(() => {}) : Promise.resolve()).then(() => sidecar.detach(activeSessionId));
		this.pendingDaemonDetaches.set(activeSessionId, chained);
		try {
			await chained;
		} finally {
			if (this.pendingDaemonDetaches.get(activeSessionId) === chained) this.pendingDaemonDetaches.delete(activeSessionId);
		}
	}

	private reattachTimer: NodeJS.Timeout | null = null;
	/** Backoff ladder (ms) for autonomous re-attach after a daemon restart. */
	private static readonly REATTACH_BACKOFF = [1_000, 2_000, 5_000, 10_000, 10_000, 30_000];

	private clearReattachTimer(): void {
		if (this.reattachTimer) clearTimeout(this.reattachTimer);
		this.reattachTimer = null;
	}

	/**
	 * Recovery must not wait for the operator to click something: nothing else
	 * calls ensureSidecar() once the socket is gone (the event traffic that drove
	 * scheduleChildrenRefresh died with it), so the promised re-attach would
	 * never happen on its own.
	 */
	private scheduleReattach(step: number): void {
		this.clearReattachTimer();
		if (this.disposed || !this.isReattaching()) return;
		const delay = SessionController.REATTACH_BACKOFF[Math.min(step, SessionController.REATTACH_BACKOFF.length - 1)];
		this.reattachTimer = setTimeout(() => {
			this.reattachTimer = null;
			if (this.disposed || !this.isReattaching()) return;
			void this.ensureSidecar()
				.catch(() => {})
				.finally(() => {
					if (!this.disposed && this.isReattaching()) this.scheduleReattach(step + 1);
				});
		}, delay);
	}

	/**
	 * Adopt a daemon snapshot (attach reply, re-attach, or a catch-up frame) as
	 * the attached transcript and repaint every webview from it.
	 */
	private applyAttachedSnapshot(snapshot: AttachSnapshot | undefined): void {
		if (snapshot?.messages) this.cachedMessages = snapshot.messages as AgentMessage[];
		if (snapshot?.state) this.rentedState = snapshot.state as RpcSessionState;
		const inFlight = snapshot?.summary?.streamingMessage as AgentMessage | undefined;
		// A turn already under way has no agent_start left to send us; without this
		// the header, the Stop button and the queue/steer toggle all read "idle".
		this.clearRunFlags();
		this.streaming = Boolean(inFlight ?? this.rentedState?.isStreaming);
		this.compacting = this.rentedState?.isCompacting === true;
		this.broadcast({
			type: "snapshot",
			messages: this.cachedMessages,
			state: this.rentedState,
			status: this.buildStatus(),
			steerDefault: vscode.workspace.getConfiguration("primeAgent").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
		});
		// The in-flight assistant message is NOT in snapshot.messages, and its
		// message_start fired before we attached. Replay it so the deltas already
		// on the wire have a bubble to land in — otherwise the transcript freezes
		// mid-turn and the finished answer never appears either.
		if (inFlight?.role === "assistant") {
			this.broadcast({ type: "event", event: { type: "message_start", message: inFlight } as AgentEvent });
		}
		// The Changes panel has to be derived from the snapshot too. Attaching and
		// catch-up frames both land a thread whose edits already happened, and a
		// `session_replaced` frame exists precisely because the live events we
		// accumulate from were withheld.
		this.threadDiffs.rebuildFromMessages(this.cachedMessages);
		this.pushStatus();
	}

	/**
	 * Attach to a session that is already live somewhere else (a terminal).
	 * The daemon brokers it; both clients see the same stream, both can prompt.
	 */
	private async attachViaDaemon(activeSessionId: string, sessionPath: string, epoch = this.beginNavigation()): Promise<boolean> {
		try {
			const sidecar = await this.ensureSidecar({ reattach: false });
			// Resolve the canonical activeSessionId: root-session uuids and 12-char
			// active windows differ, and events are addressed to the canonical id.
			let canonicalId = activeSessionId;
			try {
				const listed = await this.listSessions(sidecar);
				const target =
					listed.find((s) => s.activeSessionId === activeSessionId) ??
					listed.find((s) => (s as { sessionId?: string }).sessionId === activeSessionId) ??
					listed.find((s) => s.id === activeSessionId);
				if (target?.activeSessionId) {
					canonicalId = target.activeSessionId;
				}
			} catch {
				// list failed — fall back to what was asked (attach may still succeed)
			}
			await this.waitForDaemonDetach(canonicalId);
			if (this.disposed || epoch !== this.viewEpoch) return false;
			const result = await sidecar.attach(canonicalId);
			if (this.disposed || epoch !== this.viewEpoch) {
				try {
					await this.detachDaemonSession(sidecar, canonicalId);
				} catch {
					// Late attach belongs to an obsolete navigation.
				}
				return false;
			}
			const returnedId = (result.snapshot as { activeSessionId?: string } | undefined)?.activeSessionId;
			const finalId = returnedId ?? canonicalId;
			const snapshot = result.snapshot;
			// History rows and visible-session guards key on the daemon UUID, never
			// the 12-char attach handle. It may differ from the JSONL filename stem.
			const uuid =
				(snapshot?.state as { sessionId?: string } | undefined)?.sessionId ?? snapshot?.summary?.sessionId ?? undefined;
			// Keep the identity presented to a webview stable for this attachment.
			// The daemon may reveal its UUID only in a later get_state reply; changing
			// `sessionId` mid-view otherwise looks like a new chat and clears its draft.
			const stableSessionId = uuid ?? (sessionPath ? path.basename(sessionPath, ".jsonl") : finalId);
			const attachment = { activeSessionId: finalId, sessionPath, sessionId: stableSessionId };
			this.attached = attachment;
			this.attachedEpoch = epoch;
			this.attachAttempt = { activeSessionId: finalId, sessionPath, sessionId: stableSessionId };
			this.attachAttemptEpoch = epoch;
			// Clear the strip only now that the switch is real — a different session
			// owns nothing from the last view, but a failed attach must leave the
			// operator's current strip (and its back row) exactly where it was.
			this.broadcast({ type: "sessionChildren", children: [] });
			this.resetChildrenBaseline();
			this.rentedState = (snapshot?.state ?? null) as RpcSessionState | null;
			// Local busy flags belong to the session we just left; the snapshot below
			// re-establishes them for this one.
			this.clearRunFlags();
			if (!snapshot?.messages) {
				try {
					const messages = await sidecar.getMessages(finalId);
					if (!this.isCurrentAttachment(attachment) || epoch !== this.viewEpoch) return this.rollbackAttachment(sidecar, attachment);
					this.cachedMessages = messages as AgentMessage[];
				} catch {
					if (!this.isCurrentAttachment(attachment) || epoch !== this.viewEpoch) return this.rollbackAttachment(sidecar, attachment);
					this.cachedMessages = [];
				}
			}
			if (!this.isCurrentAttachment(attachment) || epoch !== this.viewEpoch) return this.rollbackAttachment(sidecar, attachment);
			void this.refreshAttachedState();
			this.broadcast({
				type: "notice",
				level: "info",
				text: "Attached to the live session — you can work here and in the terminal simultaneously.",
			});
			this.scheduleChildrenRefresh();
			this.resetViewedSessionState();
			this.threadDiffs.clear();
			// Stats before the first paint: otherwise the gauge shows the previous
			// session's context until the throttled status push catches up.
			await this.fetchAttachedStats();
			if (!this.isCurrentAttachment(attachment) || epoch !== this.viewEpoch) return this.rollbackAttachment(sidecar, attachment);
			this.observationRestoring = false;
			this.applyAttachedSnapshot(snapshot);
			return true;
		} catch (error) {
			this.output.appendLine(`[prime-agent] daemon attach failed: ${String(error)}`);
			return false;
		}
	}

	/**
	 * Undo a half-installed attachment. Reaching this means a newer navigation
	 * took the view after we had already published `this.attached`: leaving it
	 * set leaks a daemon viewer AND wedges that newer navigation, because its own
	 * `detachFromDaemon(previous)` no longer recognises what it is holding — the
	 * window then stays in "switching sessions…" with every action refused.
	 */
	private async rollbackAttachment(sidecar: DaemonSidecar, attachment: AttachRef): Promise<false> {
		const stillOurs = this.attached === attachment;
		if (stillOurs) {
			this.attached = null;
			this.attachedEpoch = null;
			this.clearRunFlags();
		}
		if (this.attachAttempt?.activeSessionId === attachment.activeSessionId) {
			this.attachAttempt = null;
			this.attachAttemptEpoch = null;
			this.clearReattachTimer();
		}
		// Only release the handle when it is not the one a newer attach installed.
		if (this.attached?.activeSessionId !== attachment.activeSessionId) {
			try {
				await this.detachDaemonSession(sidecar, attachment.activeSessionId);
			} catch {
				// The daemon may already have released this viewer.
			}
		}
		return false;
	}

	private async detachFromDaemon(expected: AttachRef | null = this.attached): Promise<boolean> {
		if (expected && this.sidecar?.connected) {
			await this.detachDaemonSession(this.sidecar, expected.activeSessionId);
		}
		// A concurrent navigation attached a different session while the detach was
		// in flight. Its state belongs to that navigation and must remain intact.
		if (this.attached !== expected) {
			// A sidecar close has already released `expected` and cleared the local
			// attachment. Let the navigation that owned it continue; its epoch guards
			// still reject an obsolete caller, while treating this as failure would
			// strand the requested switch behind a disconnected old view.
			return this.attached === null;
		}
		this.attached = null;
		this.attachedEpoch = null;
		this.attachAttempt = null;
		this.attachAttemptEpoch = null;
		this.rentedState = null;
		// The run we were following belongs to the session we just let go of.
		this.clearRunFlags();
		// So do its changes and its subagents' — every caller here is landing on a
		// different session. Leaving them would credit this thread with edits it
		// never made; the snapshot that follows rebuilds the real ones.
		//
		// Order matters: clearing the tracker posts, and that post recomputes the
		// changed-files strip. Drop the watcher's set FIRST or the strip is
		// recomputed against an empty attribution map and re-lists every file the
		// agent just edited as somebody else's work.
		this.clearChangedFiles();
		this.threadDiffs.clear();
		this.clearReattachTimer();
		return true;
	}

	/**
	 * How long a resolved owner id is trusted. Hits are stable for the life of a
	 * worker; misses are re-checked promptly because the descriptor is written
	 * just after the RPC session starts, and the first refreshes race it.
	 */
	private static readonly OWNER_ID_HIT_TTL_MS = 30_000;
	private static readonly OWNER_ID_MISS_TTL_MS = 2_000;
	private ownerIdCache: { sessionFile: string; id: string | undefined; at: number } | null = null;

	/**
	 * The owner id of the client-owned worker hosting THIS session, or undefined
	 * when the roster can be read as ourselves.
	 *
	 * Keyed by session file, so switching or forking a session drops the previous
	 * worker's identity instead of quietly reusing it.
	 */
	private ownedRosterClientId(): string | undefined {
		const sessionFile = this.state?.sessionFile;
		if (!sessionFile) return undefined;
		const cached = this.ownerIdCache;
		const now = Date.now();
		if (cached && cached.sessionFile === sessionFile) {
			const ttl = cached.id ? SessionController.OWNER_ID_HIT_TTL_MS : SessionController.OWNER_ID_MISS_TTL_MS;
			if (now - cached.at < ttl) return cached.id;
		}
		let id: string | undefined;
		try {
			id = resolveOwnerClientId({ sessionFile });
		} catch {
			// Descriptor layout changed or unreadable: degrade to the plain roster.
			id = undefined;
		}
		this.ownerIdCache = { sessionFile, id, at: now };
		return id;
	}

	/**
	 * Every roster read in this class goes through here.
	 *
	 * A plain `list all` cannot see the client-owned worker that hosts our own
	 * RPC session, so our live root reads as a stale on-disk row and none of our
	 * subagents appear at all. The flag asks for owned workers; the identity that
	 * makes the daemon hand them over is carried by the sidecar connection itself
	 * (see `ensureSidecar`). Without a claim this degrades to the plain roster.
	 */
	private async listSessions(sidecar: DaemonSidecar): Promise<SessionSummaryRef[]> {
		return sidecar.list(true, { includeClientOwned: true });
	}

	/**
	 * Give up the owner identity when the RPC process that owns the worker is
	 * gone.
	 *
	 * The daemon refuses to reap a client-owned worker while any connected client
	 * still answers to its owner id, so holding the claim past the agent's death
	 * would strand that worker and its IPython kernels for as long as this window
	 * stayed open. Dropping the socket is what releases it: the daemon reschedules
	 * cleanup on disconnect. The cache is cleared too, so the next connection
	 * resolves the identity again from scratch — and a descriptor whose process is
	 * dead resolves to nothing.
	 */
	private releaseOwnerIdentity(): void {
		this.ownerIdCache = null;
		if (!this.sidecar?.impersonateClientId) return;
		this.sidecar.dispose();
		this.sidecar = null;
	}

	/**
	 * Throttle window for the subagent strip. `list all` is a socket round-trip
	 * that makes the daemon re-read every session file plus every subagent
	 * registry — one per tool call stalls a long run for no new information.
	 */
	private static readonly CHILDREN_REFRESH_MS = 700;
	private childrenTimer: ReturnType<typeof setTimeout> | null = null;
	private childrenRefreshInFlight = false;
	private childrenRefreshPending = false;
	private lastChildrenRefreshMs = 0;

	/**
	 * Connect the sidecar lazily and refresh children; fire-and-forget.
	 * Coalescing matters twice over: it caps the daemon reads, and it stops the
	 * webview rebuilding the strip (and losing its scroll position) mid-burst.
	 */
	private scheduleChildrenRefresh(): void {
		if (this.disposed) return;
		// A refresh already on the wire will not see events that arrive during it,
		// so remember to run once more instead of racing a second list.
		if (this.childrenRefreshInFlight) {
			this.childrenRefreshPending = true;
			return;
		}
		if (this.childrenTimer) return;
		const wait = Math.max(0, SessionController.CHILDREN_REFRESH_MS - (Date.now() - this.lastChildrenRefreshMs));
		this.childrenTimer = setTimeout(() => {
			this.childrenTimer = null;
			void this.runChildrenRefresh();
		}, wait);
	}

	private async runChildrenRefresh(): Promise<void> {
		if (this.disposed) return;
		this.childrenRefreshInFlight = true;
		this.childrenRefreshPending = false;
		try {
			await this.ensureSidecar();
			await this.refreshChildren();
		} catch {
			// daemon unavailable — panel stays empty
		} finally {
			this.childrenRefreshInFlight = false;
			this.lastChildrenRefreshMs = Date.now();
			if (!this.disposed && this.childrenRefreshPending) this.scheduleChildrenRefresh();
		}
	}

	/** Refresh and broadcast the children (subagents) of the CURRENT session. */
	/** Previous flattened children set (for spawn/retire card derivation). */
	private previousChildIds: Set<string> | null = null;
	/** Last strip payload sent, so an unchanged roster doesn't repaint the strip. */
	private lastChildrenPayload: string | null = null;

	/**
	 * Forget what the strip knows. Both halves must go together: the spawn
	 * baseline decides which subagents count as "new" (a stale one announces a
	 * whole resumed session as freshly spawned), and the payload cache would
	 * otherwise suppress the re-send the webview needs after it wipes its own
	 * copy on a session change.
	 */
	private resetChildrenBaseline(): void {
		this.childrenContext += 1;
		this.previousChildIds = null;
		this.lastChildrenPayload = null;
		this.browseableChildren.clear();
		this.browseRefByActiveId.clear();
	}

	/** Mint a stable opaque capability for a child that is actually in this strip. */
	private browseRefFor(activeSessionId: string, parentId?: string, contextId = this.childrenContext): string | undefined {
		if (!activeSessionId) return undefined;
		let ref = this.browseRefByActiveId.get(activeSessionId);
		if (!ref) {
			ref = randomUUID();
			this.browseRefByActiveId.set(activeSessionId, ref);
		}
		this.browseableChildren.set(ref, { activeSessionId, parentId, contextId });
		return ref;
	}

	private async refreshChildren(): Promise<void> {
		if (!this.sidecar?.connected) return;
		const epoch = this.viewEpoch;
		const attachment = this.attached;
		// The observed transcript is intentionally read-only. Never mine the hidden
		// RPC session for child capabilities while it is on screen.
		if (this.observingId) return;
		try {
			const sessions = await this.listSessions(this.sidecar);
			if (this.disposed || epoch !== this.viewEpoch || this.attached !== attachment || this.observingId) return;
			let parentActive: string;
			let parentUuid: string | undefined;
			if (attachment) {
				parentActive = attachment.activeSessionId;
				parentUuid = undefined;
			} else {
				parentActive = "";
				parentUuid = this.state?.sessionId;
			}
			type Rich = SessionSummaryRef & { runtimeKind?: string; rlmDepth?: number; parentSessionId?: string; isStreaming?: boolean; activity?: string; sessionName?: string };
			const byActive = (s: SessionSummaryRef): string => s.activeSessionId ?? s.id ?? "";
			// Identity that survives passivation. A resident subagent is listed under
			// its 12-char active handle and the same subagent, once finished, under
			// its uuid — diffing on the attach target alone reads that transition as
			// a brand-new subagent and fabricates a spawn card for it.
			const stableId = (s: SessionSummaryRef): string => s.sessionId ?? s.activeSessionId ?? s.id ?? "";
			const asChild = (c: SessionSummaryRef, parentId?: string): SessionChild => {
				const rich = c as Rich;
				const activeSessionId = byActive(c);
				return {
					id: c.id ?? "",
					activeSessionId,
					...(parentId ? { browseRef: this.browseRefFor(activeSessionId, parentId) } : {}),
					name: rich.sessionName,
					runtimeKind: rich.runtimeKind,
					rlmDepth: rich.rlmDepth,
					created: rich.created,
					isStreaming: rich.isStreaming ?? false,
					// No activeSessionId means the daemon served this one from the
					// on-disk registry: it finished and holds no worker. Everything
					// else follows the CLI's own running/idle split, which counts a
					// compacting, retrying or grandchild-blocked agent as running.
					status: !c.activeSessionId ? "inactive" : SessionController.isRunningSummary(c) ? "running" : "idle",
					attachedClients: c.attachedClients ?? 0,
				};
			};
			const isChildKind = (rich: Rich): boolean => !!rich.runtimeKind && rich.runtimeKind !== "root";
			let children = sessions.filter((s) => {
				const rich = s as Rich;
				if (!isChildKind(rich)) return false;
				if (attachment) {
					return (
						(s.parentActiveSessionId && s.parentActiveSessionId === parentActive) ||
						(rich.parentSessionId === parentActive)
					);
				}
				return parentUuid != null && rich.parentSessionId === parentUuid;
			});

			// Viewing context for the strip: parent + siblings (when the current
			// session has a parent of its own), plus the viewed id for the
			// highlight. Works for browsed subagents and terminal-live sessions.
			let parent: SessionChild | undefined;
			let siblingRefs: SessionSummaryRef[] | undefined;
			const currentId = attachment ? parentActive : undefined;
			const currentSummary = sessions.find((s) => byActive(s) === currentId) as (SessionSummaryRef & Rich) | undefined;
			if (attachment && currentSummary) {
				const parentActiveId = currentSummary.parentActiveSessionId;
				const parentSummaryRef = parentActiveId
					? sessions.find((s) => byActive(s) === parentActiveId)
					: undefined;
				if (parentSummaryRef) parent = asChild(parentSummaryRef);
				if (parentActiveId) {
					// The session being viewed stays in the list. Dropping it was what
					// made the count fall by one on entry and left the green "currently
					// viewing" highlight with no row to land on.
					siblingRefs = sessions
						.filter((s) => {
							const rich = s as Rich;
							return isChildKind(rich) && rich.parentActiveSessionId === parentActiveId;
						})
				}
			}
			const childRows = children.map((child) => {
				const rich = child as Rich;
				return asChild(child, child.parentActiveSessionId ?? rich.parentSessionId);
			});
			const siblings = siblingRefs?.map((sibling) => {
				const rich = sibling as Rich;
				return asChild(sibling, sibling.parentActiveSessionId ?? rich.parentSessionId);
			});
			// A row leaves the visual strip when its daemon relationship changes. Its
			// old ref must stop being authority even if a stale webview still holds it.
			const activeRefs = new Set([...childRows, ...(siblings ?? [])].flatMap((row) => (row.browseRef ? [row.browseRef] : [])));
			for (const [ref, capability] of this.browseableChildren) {
				if (activeRefs.has(ref)) continue;
				this.browseableChildren.delete(ref);
				if (this.browseRefByActiveId.get(capability.activeSessionId) === ref) this.browseRefByActiveId.delete(capability.activeSessionId);
			}
			if (this.disposed || epoch !== this.viewEpoch || this.attached !== attachment || this.observingId) return;
			// The Changes panel is "main + subagents combined", and a child's edits
			// live only in the child's own session file. Harvest before the
			// unchanged-roster early return below: a stable roster still edits.
			void this.threadDiffs.harvestSubagents(children);
			const flat = new Set<string>(children.map(stableId));
			const prev = this.previousChildIds;
			const spawnCards = prev === null
				? []
				: children
						.filter((c) => !prev.has(stableId(c)))
						.map((c) => {
							const row = childRows.find((candidate) => candidate.activeSessionId === byActive(c));
							return {
								activeSessionId: byActive(c),
								browseRef: row?.browseRef,
								name: (c as Rich).sessionName,
								created: (c as Rich).created,
							};
						});
			this.previousChildIds = flat;
			const payload: Extract<HostToWebview, { type: "sessionChildren" }> = {
				type: "sessionChildren",
				children: childRows,
				parent,
				siblings,
				viewedActiveSessionId: currentId,
				spawned: spawnCards,
			};
			// An unchanged roster must not be re-sent: the webview rebuilds the whole
			// strip from the message, which throws away the operator's scroll position
			// inside it. Spawn cards always go through — they are one-shot news.
			const fingerprint = JSON.stringify({ ...payload, spawned: [] });
			if (spawnCards.length === 0 && fingerprint === this.lastChildrenPayload) return;
			this.lastChildrenPayload = fingerprint;
			this.broadcast(payload);
		} catch (err) {
			// Stale layout is tolerated until the next refresh, but a programming
			// error in the strip logic must not be indistinguishable from "daemon
			// unavailable" — leave a trace instead of a silently frozen panel.
			this.debugLog.append(`children-refresh failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Browse into a subagent (or any resident session): attach via the daemon. */
	async browseChild(browseRef: string): Promise<boolean> {
		if (this.guardObservedReadOnly("browsing a subagent")) return false;
		const capability = this.browseableChildren.get(browseRef);
		if (!capability || capability.contextId !== this.childrenContext) {
			this.broadcast({ type: "notice", level: "error", text: "Invalid subagent reference." });
			return false;
		}
		// Claim the navigation before either daemon round-trip. A second click wins;
		// this older lookup may still finish, but it cannot attach over the newer view.
		const previous = this.attached;
		const epoch = this.beginNavigation();
		let sidecar: DaemonSidecar;
		let child: SessionSummaryRef | undefined;
		try {
			sidecar = await this.ensureSidecar({ reattach: false });
			child = (await this.listSessions(sidecar)).find((candidate) => (candidate.activeSessionId ?? candidate.id) === capability.activeSessionId);
		} catch {
			if (epoch !== this.viewEpoch) return false;
			this.restoreAttachedView(previous, epoch);
			this.broadcast({ type: "notice", level: "error", text: "Could not verify that subagent session." });
			return false;
		}
		if (this.disposed || epoch !== this.viewEpoch || capability.contextId !== this.childrenContext) return false;
		const parentId = child?.parentActiveSessionId ?? (child as { parentSessionId?: string } | undefined)?.parentSessionId;
		const rich = child as (SessionSummaryRef & { runtimeKind?: string }) | undefined;
		if (!child || !rich || !rich.runtimeKind || rich.runtimeKind === "root" || parentId !== capability.parentId) {
			this.broadcast({ type: "notice", level: "error", text: "That subagent is no longer part of this session." });
			this.restoreAttachedView(previous, epoch);
			return false;
		}
		// Install the breadcrumb before the target's final snapshot finishes. Back
		// can then recover the parent if the user changes their mind mid-attach.
		const breadcrumb = previous ? ({ kind: "attached", ...previous } as const) : ({ kind: "rpc" } as const);
		this.returnTargets.push(breadcrumb);
		// Attach FIRST, let go second. Tearing the current session down up front
		// meant a subagent the daemon can no longer rehydrate left the operator
		// detached, with the strip and its "‹ parent" row destroyed and nothing
		// left to click — the freeze reported in the build thread.
		const attached = await this.attachViaDaemon(capability.activeSessionId, child.sessionFile ?? "", epoch);
		if (this.disposed || epoch !== this.viewEpoch) {
			if (this.returnTargets.at(-1) === breadcrumb) this.returnTargets.pop();
			return false;
		}
		if (!attached) {
			this.broadcast({ type: "notice", level: "error", text: "Could not attach to that subagent session (it may be gone)." });
			if (this.returnTargets.at(-1) === breadcrumb) this.returnTargets.pop();
			this.restoreAttachedView(previous, epoch);
			this.scheduleChildrenRefresh();
			return false;
		}
		if (previous && this.sidecar?.connected && epoch === this.viewEpoch && this.attached !== previous) {
			try {
				await this.detachDaemonSession(this.sidecar, previous.activeSessionId);
			} catch {
			// the daemon dropped it for us — nothing left to release
			}
		}
		if (epoch !== this.viewEpoch) return false;
		this.scheduleChildrenRefresh();
		return true;
	}

	async backToParent(): Promise<void> {
		const epoch = this.beginNavigation();
		const target = this.returnTargets.at(-1) ?? { kind: "rpc" as const };
		if (target.kind === "attached") {
			const path = target.sessionPath;
			const id = target.activeSessionId;
			const current = this.attached;
			if (!(await this.detachFromDaemon(current)) || epoch !== this.viewEpoch) return;
			if (await this.attachViaDaemon(id, path, epoch)) {
				if (epoch !== this.viewEpoch) return;
				this.returnTargets.pop();
				return;
			}
			if (epoch !== this.viewEpoch || this.attached !== null) return;
			// The parent went away while we were inside the child. Land on our own
			// session rather than on nothing — going up must never dead-end.
			this.broadcast({ type: "notice", level: "warning", text: "The parent session is no longer live — returning to this window's session." });
		}
		// baseline: own RPC session.
		//
		// Browsing from this window's own session into a subagent leaves that CHILD
		// attached and pushes an "rpc" breadcrumb, so going back arrives here
		// holding an attachment that must be released first. Refusing whenever one
		// existed — and asking detachFromDaemon to expect none — made "‹ parent" a
		// silent no-op for the most common path there is: root -> child -> back.
		// A newer navigation is still rejected, by the epoch guard that means it.
		if (epoch !== this.viewEpoch) return;
		const landing = this.attached;
		if (!(await this.detachFromDaemon(landing)) || epoch !== this.viewEpoch || this.attached !== null) return;
		this.returnTargets.pop();
		// The strip belongs to whatever session we just landed on, and the spawn
		// baseline still holds the child's (usually empty) set — leaving it would
		// announce every one of the parent's subagents as freshly spawned.
		this.resetChildrenBaseline();
		this.beginRpcRestore();
		if (await this.restoreOwnRpcView(epoch)) this.scheduleChildrenRefresh();
	}

	/** Route daemon events for the attached session into the normal pipeline. */
	private onDaemonEvent(message: DaemonServerMessage): void {
		this.debugLog.append(`daemon-event: type=${message.type} sid=${String(message.activeSessionId).slice(0, 20)}${this.attached ? ` attached=${this.attached.activeSessionId.slice(0, 20)}` : " no-attach"}`);
		const attached = this.attached;
		if (!attached || !this.isCurrentAttachment(attached)) return;
		const msgSessionId = message.activeSessionId;
		if (message.type === "session_event" && msgSessionId === attached.activeSessionId && message.event) {
			this.onAgentEvent(message.event as AgentEvent);
			return;
		}
		if (message.type === "session_status" && msgSessionId === attached.activeSessionId) {
			void this.refreshAttachedState();
			this.scheduleHistoryRefresh();
			return;
		}
		// Catch-up frames REPLACE the live events the daemon withheld while our
		// socket was backpressured or the worker was swapped. Dropping them loses
		// every message from that window with no visible gap in the transcript.
		if (message.type === "session_replaced" && msgSessionId === attached.activeSessionId) {
			this.applyAttachedSnapshot({
				state: message.state as Record<string, unknown> | undefined,
				messages: message.messages as Array<Record<string, unknown>> | undefined,
			});
			void this.refreshAttachedState();
			return;
		}
		if (message.type === "session_resynced" && msgSessionId === attached.activeSessionId) {
			this.applyAttachedSnapshot(message.snapshot as AttachSnapshot | undefined);
			return;
		}
			if (message.type === "session_closed" && msgSessionId === attached.activeSessionId) {
				this.broadcast({ type: "notice", level: "warning", text: "The live session was closed by its other client." });
					this.attached = null;
					this.attachedEpoch = null;
					this.attachAttempt = null;
					this.attachAttemptEpoch = null;
				this.rentedState = null;
			// No agent_end is coming for a session that no longer exists.
				this.clearRunFlags();
				this.clearReattachTimer();
				// The closed shared transcript must never become a writable-looking view
				// of our hidden RPC session. Restore that session before controls return.
				this.observationRestoring = true;
				const epoch = ++this.viewEpoch;
				this.pushStatus();
				void this.restoreAfterObservationClosed(epoch);
			}
	}

	private async refreshAttachedState(): Promise<void> {
		const attached = this.attached;
		if (!attached || !this.sidecar?.connected) return;
		try {
			const state = (await this.sidecar.getState(attached.activeSessionId)) as RpcSessionState;
			if (!this.isCurrentAttachment(attached)) return;
			this.rentedState = state;
			// get_state answers with the daemon summary, which is where the uuid
			// lives when the attach snapshot didn't carry one.
			this.pushStatus();
		} catch {
			// keep current state
		}
	}

	/** Effective model/status snapshot accounting for daemon-attached sessions. */

	private async clearObservation(expectedId: string | null = this.observingId, epoch = this.viewEpoch): Promise<boolean> {
		if (this.disposed || epoch !== this.viewEpoch) return false;
		if (expectedId === null) return this.observingId === null;
		if (this.observingId !== expectedId) return false;
		const id = expectedId;
		this.observingId = null;
		this.observedSession = null;
		const client = this.client;
		if (client) {
			try {
				await client.request({ type: "unobserve", activeSessionId: id }, 10_000);
			} catch {
				// best effort
			}
		}
		if (this.disposed || epoch !== this.viewEpoch) return false;
		this.broadcast({ type: "observedClosed", sessionId: id });
		return true;
	}

	async stopObserving(): Promise<void> {
		if (!this.observingId) return;
		// Clearing `observingId` has to happen before the daemon reply so observed
		// events stop routing here; keep a separate restore lock over that gap so a
		// prompt cannot fall through to this window's hidden RPC session.
		const observedAtStart = this.observingId;
		const epoch = this.beginNavigation();
		this.observationRestoring = true;
		this.pushStatus();
		if (!(await this.clearObservation(observedAtStart, epoch))) {
			// Never leave the restore lock latched behind a refused hand-off: the
			// composer would stay disabled with no way back. A newer navigation owns
			// the lock (and will clear it) only when it also took the epoch.
			if (!this.disposed && epoch === this.viewEpoch && !this.attached) {
				this.observationRestoring = false;
				this.pushStatus();
			}
			return;
		}
		// Same trap as backToParent: we land on a different session, so the strip
		// and the spawn baseline both belong to the one we just left.
		this.beginRpcRestore();
		if (await this.restoreOwnRpcView(epoch)) this.scheduleChildrenRefresh();
	}

	// ------------------------------------------------------------------
	// Snapshot / status
	// ------------------------------------------------------------------

	/**
	 * `keepDraft` is for refreshes the operator did not ask for. restoreDraft()
	 * pushes the host's copy of the composer text, which the webview applies
	 * unconditionally — fine after a navigation, wrong when a background event
	 * (auto-compaction, or another client compacting a shared session) lands
	 * while someone is mid-sentence, because the host's copy is up to one debounce
	 * stale and applying it moves the caret to the end.
	 */
	async refreshSnapshot(options: { epoch?: number; allowRestoring?: boolean; keepDraft?: boolean } = {}): Promise<boolean> {
		// Hiding and re-showing the view reloads the webview, which asks for a
		// fresh snapshot. Our own background RPC client is still running, so
		// without this branch the attached transcript is repainted with the
		// background session's (usually empty) messages and its sticky draft,
		// while the header keeps naming the terminal session.
		const attached = this.attached;
		if (attached) {
			const id = attached.activeSessionId;
			try {
				const sidecar = await this.ensureSidecar();
				const [messages, state] = await Promise.all([sidecar.getMessages(id), sidecar.getState(id)]);
				if (!this.isCurrentAttachment(attached)) return false;
				this.cachedMessages = messages as AgentMessage[];
				this.rentedState = state as RpcSessionState;
			} catch {
				// daemon busy — repaint from what we already hold rather than blank
			}
			if (!this.isCurrentAttachment(attached)) return false;
			await this.fetchAttachedStats();
			if (!this.isCurrentAttachment(attached)) return false;
			this.broadcast({
				type: "snapshot",
				messages: this.cachedMessages,
				state: this.rentedState,
				status: this.buildStatus(),
				steerDefault: vscode.workspace.getConfiguration("primeAgent").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
			});
			if (options.keepDraft !== true) this.restoreDraft();
			this.threadDiffs.rebuildFromMessages(this.cachedMessages);
			this.pushStatus();
			this.repaintChildrenStrip();
			return true;
		}
		if (this.observingId) {
			// A reconstructed webview needs the observed transcript too. The RPC
			// session below is intentionally hidden, so never repaint it here.
			this.broadcast({ type: "observedSession", sessionId: this.observingId, messages: this.cachedMessages });
			this.pushStatusLight();
			return true;
		}
		const client = this.client;
		const epoch = options.epoch ?? this.viewEpoch;
		const allowRestoring = options.allowRestoring === true;
		if (!client?.running || !this.isCurrentRpcView(client, epoch, allowRestoring)) return false;
		try {
			const [messagesRes, stateRes] = await Promise.all([
				client.request({ type: "get_messages" }, 60_000),
				client.request({ type: "get_state" }, 30_000),
			]);
			if (!this.isCurrentRpcView(client, epoch, allowRestoring)) return false;
			if (!messagesRes.success || !stateRes.success) {
				this.output.appendLine(`[prime-agent] snapshot failed: ${messagesRes.error ?? stateRes.error ?? "agent rejected snapshot request"}`);
				return false;
			}
			// A complete snapshot proves the agent is answering this view.
			this.reachable = true;
			this.cachedMessages = ((messagesRes.data as { messages?: AgentMessage[] })?.messages ?? []) as AgentMessage[];
			this.state = stateRes.data as RpcSessionState;
			const stats = await this.fetchStatsText(allowRestoring);
			if (!this.isCurrentRpcView(client, epoch, allowRestoring)) return false;
			const steerDefault = vscode.workspace
				.getConfiguration("primeAgent")
				.get<"steer" | "followUp">("defaultStreamingBehavior", "steer");
			this.broadcast({
				type: "snapshot",
				messages: this.cachedMessages,
				state: this.state,
				status: this.buildStatus(stats),
				steerDefault,
			});
		} catch (err) {
			if (this.isCurrentRpcView(client, epoch, allowRestoring)) this.output.appendLine(`[prime-agent] snapshot failed: ${String(err)}`);
			return false;
		}
		if (!this.isCurrentRpcView(client, epoch, allowRestoring)) return false;
		if (options.keepDraft !== true) this.restoreDraft();
		this.threadDiffs.rebuildFromMessages(this.cachedMessages);
		this.pushStatus();
		this.repaintChildrenStrip();
		return true;
	}

	/**
	 * A full repaint means someone is looking at an empty strip — a reloaded
	 * webview keeps no children of its own. Drop the change filter so the next
	 * refresh is allowed through even when the roster itself hasn't moved.
	 */
	private repaintChildrenStrip(): void {
		this.lastChildrenPayload = null;
		this.scheduleChildrenRefresh();
	}

	private async refreshStateAndStats(): Promise<void> {
		// Attached events describe the daemon session, not our RPC subprocess.
		if (this.attached) {
			await this.refreshAttachedState();
			return;
		}
		const client = this.client;
		const epoch = this.viewEpoch;
		if (!client?.running) return;
		try {
			const stateRes = await client.request({ type: "get_state" }, 30_000);
			if (!this.isCurrentRpcView(client, epoch)) return;
			this.reachable = true;
			if (stateRes.success) this.state = stateRes.data as RpcSessionState;
		} catch {
			// keep previous state
		}
		if (this.isCurrentRpcView(client, epoch)) this.pushStatus();
	}

	private lastStatsText = "";
	private statsTimer: NodeJS.Timeout | null = null;
	private statsFetching = false;

	/** Broadcast the status immediately using cached stats (cheap, per-event). */
	private pushStatusLight(): void {
		this.broadcast({ type: "status", status: this.buildStatus(this.lastStatsText) });
	}

	private async fetchStatsText(allowRestoring = false): Promise<string> {
		const client = this.client;
		const epoch = this.viewEpoch;
		if (!client?.running) return "";
		try {
			const res = await client.request({ type: "get_session_stats" }, 30_000);
			if (!this.isCurrentRpcView(client, epoch, allowRestoring)) return "";
			this.reachable = true;
			if (!res.success) return "";
			const data = res.data as {
				tokens?: { total?: number };
				cost?: number;
				contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
			};
			this.lastUsage = {
				usageTotal: data.tokens?.total,
				costUsd: data.cost,
				contextTokens: data.contextUsage?.tokens ?? null,
				contextWindow: data.contextUsage?.contextWindow,
				contextPercent: data.contextUsage?.percent ?? null,
			};
			const parts: string[] = [];
			if (data.tokens?.total != null) parts.push(`${formatNumber(data.tokens.total)} tokens`);
			if (data.cost != null && data.cost > 0) parts.push(`$${data.cost.toFixed(4)}`);
			if (data.contextUsage && data.contextUsage.percent != null) parts.push(`${data.contextUsage.percent}% of context`);
			// These numbers are always the background RPC session's, which is a
			// different thread from the one on screen whenever we are attached.
			this.maybeTriggerAutoCompact(
				data.contextUsage?.percent ?? null,
				this.state?.sessionId ?? this.state?.sessionFile ?? "none",
			);
			return parts.join(" · ");
		} catch {
			return "";
		}
	}

	/**
	 * Same numbers, sourced from the daemon for the session actually on screen.
	 * fetchStatsText() would answer for our idle background session, so the gauge
	 * would read ~2% while the terminal session sits at 88%.
	 */
	private async fetchAttachedStats(): Promise<string> {
		const attached = this.attached;
		if (!attached || !this.sidecar?.connected) return this.lastStatsText;
		try {
			const data = (await this.sidecar.getSessionStats(attached.activeSessionId)) as {
				tokens?: { total?: number };
				cost?: number;
				contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
			};
			if (!this.isCurrentAttachment(attached)) return this.lastStatsText;
			this.lastUsage = {
				usageTotal: data.tokens?.total,
				costUsd: data.cost,
				contextTokens: data.contextUsage?.tokens ?? null,
				contextWindow: data.contextUsage?.contextWindow,
				contextPercent: data.contextUsage?.percent ?? null,
			};
			const parts: string[] = [];
			if (data.tokens?.total != null) parts.push(`${formatNumber(data.tokens.total)} tokens`);
			if (data.cost != null && data.cost > 0) parts.push(`$${data.cost.toFixed(4)}`);
			if (data.contextUsage && data.contextUsage.percent != null) parts.push(`${data.contextUsage.percent}% of context`);
			this.maybeTriggerAutoCompact(data.contextUsage?.percent ?? null, this.sessionKey());
			this.lastStatsText = parts.join(" · ");
			return this.lastStatsText;
		} catch {
			return this.lastStatsText;
		}
	}

	private lastUsage: { usageTotal?: number; costUsd?: number; contextTokens?: number | null; contextWindow?: number; contextPercent?: number | null } = {};

	/** True while the session on screen is busy, whoever started the turn. */
	private effectiveStreaming(): boolean {
		if (this.attached) return this.streaming || (this.rentedState?.isStreaming ?? false);
		return this.streaming || (this.state?.isStreaming ?? false);
	}

	private buildStatus(statsText = this.lastStatsText): StatusSnapshot {
		if (this.observingId) {
			const observed = this.observedSession;
			return {
				connected: true,
				streaming: false,
				compacting: false,
				retrying: false,
					restoring: false,
				modelLabel: "observed session",
				thinkingLevel: "off",
				availableThinkingLevels: null,
				sessionFile: observed?.sessionPath,
				sessionId: observed?.sessionId ?? this.observingId,
				statsText,
				statusText: "watching another live session (read-only)",
				observingId: this.observingId,
				compactThresholdPercent: this.compactThreshold(),
				compactDefaultPercent: this.defaultCompactPercent(),
			};
		}
		if (this.isReattaching()) {
			const attempt = this.attachAttempt!;
			const state = this.rentedState;
			const model = state?.model ?? null;
			return {
				connected: false,
				streaming: false,
				compacting: false,
				retrying: false,
				restoring: true,
				modelLabel: model ? `${model.provider}/${model.id}` : "attached session",
				thinkingLevel: state?.thinkingLevel ?? "off",
				availableThinkingLevels: supportedThinkingLevels(model),
				sessionName: state?.sessionName,
				sessionFile: attempt.sessionPath,
				sessionId: attempt.sessionId ?? path.basename(attempt.sessionPath, ".jsonl"),
				statsText,
				statusText: "reconnecting to shared session…",
				modelProvider: model?.provider,
				modelId: model?.id,
				observingId: this.observingId,
				compactThresholdPercent: this.compactThreshold(),
				compactDefaultPercent: this.defaultCompactPercent(),
				...this.lastUsage,
			};
		}
		if (this.attached) {
			const st = this.rentedState as (RpcSessionState & { model?: RpcSessionState["model"] }) | null;
			const model = st?.model ?? null;
			const label = model ? `${model.provider}/${model.id}` : "attached session";
			const switching = this.attachedEpoch !== this.viewEpoch || this.observationRestoring;
			// Attaching mid-turn never delivers agent_start, so the local flags alone
			// would report idle: no running label, no Stop, no queue/steer toggle.
			const streaming = this.streaming || (st?.isStreaming ?? false);
			const compacting = this.compacting || (st?.isCompacting ?? false);
			return {
				connected: true,
				streaming,
				compacting,
				retrying: this.retrying,
				restoring: switching,
				modelLabel: label,
				thinkingLevel: st?.thinkingLevel ?? "off",
				availableThinkingLevels: supportedThinkingLevels(model),
				sessionName: st?.sessionName,
				sessionFile: this.attached.sessionPath,
				// History rows key on the jsonl stem. Falling back to the 12-char
				// attach handle here would leave the row for the session on screen
				// unmarked and clickable — the daemon id and the file id are
				// different namespaces and never compare equal.
				sessionId: this.attached.sessionId ?? path.basename(this.attached.sessionPath, ".jsonl"),
				statsText,
				// This label overwrites the running/live word in the header, so it has
				// to carry the running state itself or the run becomes invisible.
				statusText: switching
					? "switching sessions…"
					: compacting
					? "compacting (shared with terminal)"
					: streaming
						? "running (shared with terminal)"
						: "attached (shared with terminal)",
				modelProvider: model?.provider,
				modelId: model?.id,
				observingId: this.observingId,
				compactThresholdPercent: this.compactThreshold(),
				compactDefaultPercent: this.defaultCompactPercent(),
				...this.lastUsage,
			};
		}
		const model = this.state?.model;
		const modelLabel = model ? `${model.provider}/${model.id}` : "no model";
		return {
			// Reachability, never process liveness: a spawn that failed or an agent
			// that never answers must read "offline" and refuse prompts, not paint a
			// green dot over a prompt that will time out 120s later.
			connected: this.reachable,
			streaming: this.streaming || (this.state?.isStreaming ?? false),
			compacting: this.compacting || (this.state?.isCompacting ?? false),
			retrying: this.retrying,
			restoring: this.startingPromise !== null || this.observationRestoring,
			modelLabel,
			thinkingLevel: this.state?.thinkingLevel ?? "off",
			availableThinkingLevels: supportedThinkingLevels(model),
			sessionName: this.state?.sessionName,
			sessionFile: this.state?.sessionFile,
			// Same derivation as sessionKey(): the identity the webview sends back
			// with a draft has to be the identity the draft is stored under.
			sessionId: this.state?.sessionId ?? this.rpcFileStem(),
			statsText,
			statusText: this.observationRestoring ? "restoring your session…" : this.extensionStatusText,
			modelProvider: model?.provider,
			modelId: model?.id,
			observingId: this.observingId,
			compactThresholdPercent: this.compactThreshold(),
			compactDefaultPercent: this.defaultCompactPercent(),
			...this.lastUsage,
		};
	}

	/**
	 * Push status with fresh stats, throttled: at most one stats RPC in flight and
	 * at most one refresh per second. Streaming turns generate hundreds of events,
	 * so callers use pushStatusLight() on the hot path and this on transitions.
	 */
	pushStatus(): void {
		if (this.disposed) return;
		if (this.statsTimer) return;
		this.statsTimer = setTimeout(() => {
			this.statsTimer = null;
			if (this.disposed) return;
			// While attached, the RPC subprocess's stats belong to a session the
			// operator is not looking at — ask the daemon about the one they are.
			const attached = this.attached;
			const epoch = this.viewEpoch;
			const attachedStats = attached && this.sidecar?.connected;
			if (this.statsFetching || (!attachedStats && !this.client?.running)) {
				this.pushStatusLight();
				return;
			}
			this.statsFetching = true;
			void (attachedStats ? this.fetchAttachedStats() : this.fetchStatsText())
				.then((stats) => {
					if (this.disposed || epoch !== this.viewEpoch || this.attached !== attached) return;
					if (stats) this.lastStatsText = stats;
					this.broadcast({ type: "status", status: this.buildStatus() });
				})
				.finally(() => {
					this.statsFetching = false;
				});
		}, 250);
	}

	// ------------------------------------------------------------------
	// Editor context helpers
	// ------------------------------------------------------------------

	getActiveSelection(): { path: string; startLine: number; endLine: number; text: string; languageId: string } | null {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return null;
		const doc = editor.document;
		if (!this.isInWorkspaceRoot(doc.uri)) return null;
		const sel = editor.selection;
		if (sel.isEmpty) return null;
		const text = doc.getText(sel);
		if (text.length > 100_000) return null;
		const relativePath = this.workspaceRelativePath(doc.uri);
		if (!relativePath) return null;
		return {
			path: relativePath,
			startLine: sel.start.line + 1,
			endLine: sel.end.line + 1,
			text,
			languageId: doc.languageId,
		};
	}

	getActiveFilePath(): string | null {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return null;
		return this.workspaceRelativePath(editor.document.uri);
	}

	async searchFiles(query: string, requestId: number, reply: (message: HostToWebview) => void = (message) => this.broadcast(message)): Promise<void> {
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const observingId = this.observingId;
		const config = vscode.workspace.getConfiguration("primeAgent");
		const configuredMax = config.get<number>("maxFileSearchResults", 40);
		const max = Math.max(1, Math.min(100, Number.isFinite(configuredMax) ? Math.floor(configuredMax) : 40));
		const trimmed = query.trim().slice(0, 512);
		// This is a filename filter, not a glob-expression input. Drop glob syntax
		// before building the VS Code glob so a hostile webview cannot widen an
		// otherwise bounded search into an unexpectedly expensive one.
		const literal = trimmed.replace(/[{}\[\]*?!\\]/g, "");
		const pattern = literal ? `**/*${literal.replace(/[\s]+/g, "*")}*` : "**/*";
		const exclude = "**/{node_modules,.git,dist,out,.turbo,.next,coverage}/**";
		try {
			const uris = await vscode.workspace.findFiles(pattern, exclude, max);
			if (this.disposed || epoch !== this.viewEpoch || this.attached !== attached || this.observingId !== observingId) return;
			const files = uris.map((uri) => this.workspaceRelativePath(uri)).filter((file): file is string => file !== null);
			const dirs = await this.searchDirs(trimmed, Math.max(8, Math.floor(max / 4)));
			if (this.disposed || epoch !== this.viewEpoch || this.attached !== attached || this.observingId !== observingId) return;
			const combined = [
				...dirs.map((path) => ({ path, isDir: true })),
				...files.map((path) => ({ path, isDir: false })),
			].sort((a, b) => a.path.localeCompare(b.path));
			reply({ type: "fileSearchResults", requestId, files: combined });
		} catch {
			if (!this.disposed && epoch === this.viewEpoch && this.attached === attached && this.observingId === observingId) {
				reply({ type: "fileSearchResults", requestId, files: [] });
			}
		}
	}

	/** Lightweight directory listing for @-folder mentions. Pruned, capped, fuzzy. */
	private async searchDirs(query: string, max: number): Promise<string[]> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) return [];
		const out: string[] = [];
		const prune = new Set(["node_modules", ".git", "dist", "out", ".turbo", ".next", "coverage", ".vscode-test"]);
		const needle = query.toLowerCase();
		const visit = async (relDir: string, uri: vscode.Uri, depth: number): Promise<void> => {
				if (out.length >= max || depth > 5) return;
				let entries: [string, vscode.FileType][];
				try {
					entries = await vscode.workspace.fs.readDirectory(uri);
				} catch {
					return;
				}
				for (const [name, type] of entries) {
					if (type !== vscode.FileType.Directory || name.startsWith(".") || prune.has(name)) continue;
					const rel = relDir ? `${relDir}/${name}` : name;
					if ((needle === "" || rel.toLowerCase().includes(needle)) && out.length < max) {
						out.push(rel);
					}
					await visit(rel, vscode.Uri.joinPath(uri, name), depth + 1);
					if (out.length >= max) return;
				}
		};
		await visit("", folder.uri, 0);
		return out;
	}

	async pickImages(requestId: number, reply: (message: HostToWebview) => void = (message) => this.broadcast(message)): Promise<void> {
		const epoch = this.viewEpoch;
		const attached = this.attached;
		const observingId = this.observingId;
		const stillCurrent = (): boolean =>
			!this.disposed && epoch === this.viewEpoch && this.attached === attached && this.observingId === observingId && !this.observationRestoring;
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
			openLabel: "Attach image",
		});
		if (!uris || uris.length === 0) {
			if (stillCurrent()) reply({ type: "imagePicked", requestId, images: [] });
			return;
		}
		const mimeByExt: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
		};
		const MAX_IMAGES = 8;
		const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
		const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
		const images: ImageAttachment[] = [];
		let totalBytes = 0;
		let skippedOversized = 0;
		for (const uri of uris.slice(0, MAX_IMAGES)) {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				if (bytes.byteLength > MAX_IMAGE_BYTES || totalBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
					skippedOversized += 1;
					continue;
				}
				const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
				images.push({
					data: Buffer.from(bytes).toString("base64"),
					mimeType: mimeByExt[ext] ?? "image/png",
					name: path.basename(uri.fsPath),
				});
				totalBytes += bytes.byteLength;
			} catch {
				// skip unreadable files
			}
		}
		if (!stillCurrent()) return;
		if (uris.length > MAX_IMAGES || skippedOversized > 0) {
			reply({ type: "notice", level: "warning", text: "Some images were skipped (maximum 8 images, 8 MiB each, 16 MiB total)." });
		}
		reply({ type: "imagePicked", requestId, images });
	}

	async openFile(relPath: string, startLine?: number, endLine?: number): Promise<void> {
		const uri = await this.resolveWorkspaceUri(relPath.replace(/\/$/, ""));
		if (!uri) return;
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.type === vscode.FileType.Directory) {
				await vscode.commands.executeCommand("revealInExplorer", uri);
				return;
			}
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc);
			if (startLine !== undefined) {
				const start = new vscode.Position(Math.max(0, startLine - 1), 0);
				const end = endLine !== undefined ? new vscode.Position(Math.max(0, endLine - 1), 0) : start;
				editor.selection = new vscode.Selection(start, end);
				editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
			}
		} catch {
			this.broadcast({ type: "notice", level: "error", text: `Could not open ${relPath}` });
		}
	}

	private async resolveWorkspaceUri(relPath: string): Promise<vscode.Uri | null> {
		if (!relPath || path.isAbsolute(relPath) || relPath.split(/[\\/]+/).some((part) => part === "..")) return null;
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) return null;
		const candidate = vscode.Uri.joinPath(folder.uri, relPath);
		try {
			const [root, resolved] = await Promise.all([fs.realpath(folder.uri.fsPath), fs.realpath(candidate.fsPath)]);
			const relative = path.relative(root, resolved);
			return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? vscode.Uri.file(resolved) : null;
		} catch {
			return null;
		}
	}

	async openDiff(relPath: string): Promise<void> {
		const uri = await this.resolveWorkspaceUri(relPath);
		if (!uri) return;
		const left = uri.with({ scheme: "prime-agent-git-head" });
		const title = `${relPath} (changes since HEAD)`;
		try {
			await vscode.commands.executeCommand("vscode.diff", left, uri, title);
		} catch {
			await this.openFile(relPath);
		}
	}

	// ------------------------------------------------------------------
	// Changed-file tracking during runs
	// ------------------------------------------------------------------

	private startWatcher(): void {
		this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
		const track = (uri: vscode.Uri) => {
			if (!this.streaming) return;
			const rel = vscode.workspace.asRelativePath(uri, false);
			if (
				rel.startsWith("..") ||
				rel === ".git" ||
				rel.startsWith(".git/") ||
				rel.includes("/.git/") ||
				rel === "node_modules" ||
				rel.startsWith("node_modules/") ||
				rel.includes("/node_modules/")
			) return;
			this.changedFiles.add(rel);
		};
		this.watcher.onDidCreate(track, null, this.disposables);
		this.watcher.onDidChange(track, null, this.disposables);
		this.watcher.onDidDelete(track, null, this.disposables);
	}

	private trackChangedFilesDone(_event: AgentEvent): void {
		// Reserved for future per-tool tracking; watcher coverage is sufficient for now.
	}

	// ------------------------------------------------------------------
	// Per-thread diff panel — owned by ThreadDiffTracker (src/thread-diffs.ts).
	// The controller keeps only the wiring: workspace root, the webview
	// transport, and which transcript is on screen.
	// ------------------------------------------------------------------

	private readonly threadDiffs = new ThreadDiffTracker({
		workspaceRoot: () => this.workspaceRoot,
		currentSessionFile: () =>
			(this.attached?.sessionPath || undefined) ?? (this.rentedState?.sessionFile || undefined) ?? (this.state?.sessionFile || undefined),
		post: (message) => {
			this.broadcast(message);
			// A subagent harvest lands after its child's run — and often after our
			// own agent_end — so a file the strip already listed can become
			// attributable later. Re-file it then. Guarded on the run being over
			// because the strip is only pushed at agent_end; during a run there is
			// nothing on screen to correct.
			// A harvest that lands while the run still looks live cannot correct the
			// strip yet, so remember to do it rather than dropping the correction:
			// effectiveStreaming() reads state refreshed asynchronously at agent_end,
			// and that stale-true window is exactly when a subagent harvest arrives.
			if (this.effectiveStreaming()) this.changedFilesNeedRecompute = true;
			else if (this.changedFiles.size > 0 || this.changedFilesNeedRecompute) {
				this.changedFilesNeedRecompute = false;
				this.pushChangedFiles();
			}
		},
		isDisposed: () => this.disposed,
	});
}

/** Workspace-relative path reduced to a comparison key (separators + case). */
function canonicalRelPath(file: string): string {
	const slashed = file.split(/[\\/]+/).join("/");
	return process.platform === "linux" ? slashed : slashed.toLowerCase();
}

function formatNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}


// ---------------------------------------------------------------------------
// Per-thread diff accumulation helpers (module scope; host-only state lives
// on SessionController above).
// ---------------------------------------------------------------------------
