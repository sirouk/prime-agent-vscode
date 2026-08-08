/**
 * SessionController owns the Prime Agent RPC subprocess for this VS Code window,
 * routes events to all attached chat webviews, and answers extension UI requests
 * using native VS Code dialogs.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { DaemonSidecar } from "./daemon-sidecar.js";
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
import { listRecentSessions, normalizeFsPath } from "./recent-sessions.js";
import { archiveSessionFile, deleteSession, isSessionActive } from "./session-actions.js";
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
	/** Session-file uuid, when the daemon told us one. What history rows key on. */
	sessionId?: string;
}

export class SessionController implements vscode.Disposable {
	private client: RpcClient | null = null;
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
	/** Daemon sidecar for resident-session parity (attach/prompt/abort on live sessions). */
	private sidecar: DaemonSidecar | null = null;
	/**
	 * `activeSessionId` is the daemon's 12-char attach handle; `sessionId` is the
	 * session-file uuid the rest of the UI (history rows, delete/rename guards)
	 * keys on. They are never equal, so both have to be carried.
	 */
	private attached: AttachRef | null = null;
	/** Attach attempt remembered across socket drops so a reconnect can re-anchor seamlessly. */
	private attachAttempt: AttachRef | null = null;
	/** Where browsing-into-a-child should return to. null → the baseline RPC session. */
	private returnTarget: { kind: "rpc" } | ({ kind: "attached" } & AttachRef) = { kind: "rpc" };
	private rentedState: RpcSessionState | null = null;
	/** Last history answer, replayed instantly so a reopened sidebar never flashes empty. */
	private lastHistory: RecentSession[] | null = null;
	private savedCatalog: { at: number; rows: SavedSessionInfo[] } | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
	) {
		this.startWatcher();
	}

	get workspaceRoot(): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
	}

	// ------------------------------------------------------------------
	// Webview wiring
	// ------------------------------------------------------------------

	attach(sink: WebviewSink): vscode.Disposable {
		this.sinks.add(sink);
		// Seed the rebuilt document with the last history we computed. The sidebar
		// webview is destroyed on every hide, so without this the operator's next
		// visit to history starts from an empty list and flashes "Loading…".
		if (this.lastHistory) sink.post({ type: "history", sessions: this.lastHistory });
		return new vscode.Disposable(() => this.sinks.delete(sink));
	}

	private broadcast(message: HostToWebview): void {
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
			url: "https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/quickstart.md",
			reason,
		});
	}

	private installWatchdog: NodeJS.Timeout | null = null;

	/** If the agent still isn't reachable ~25s after the first attempt, recommend installing it (once). */
	private armInstallWatchdog(): void {
		if (this.installWatchdog) clearTimeout(this.installWatchdog);
		this.installWatchdog = setTimeout(() => {
			this.installWatchdog = null;
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
		const config = vscode.workspace.getConfiguration("primeAgent");
		const command = config.get<string>("command", "prime-agent");
		const extraArgs = config.get<string[]>("args", []);
		const model = config.get<string>("model", "").trim();

		const args = [...extraArgs];
		if (model) args.push("--model", model);
		// Escape hatch (tests, unusual launch setups): extra space-delimited args.
		const envArgs = process.env.PRIME_AGENT_ARGS?.trim();
		if (envArgs) args.push(...envArgs.split(/\s+/));

		this.output.appendLine(`[prime-agent] starting: ${command} --mode rpc ${args.join(" ")}`);
		const client = new RpcClient({ command, args, cwd: this.workspaceRoot, onWire: (s) => this.debugLog.append(s) });
		this.client = client;
		this.reachable = false;
		this.intentionalStop = false;

		client.on("event", (raw) => this.onAgentEvent(raw as AgentEvent));
		client.on("extensionUiRequest", (raw) => void this.onExtensionUiRequest(raw as RpcExtensionUIRequest));
		client.on("message", (raw) => this.onOtherMessage(raw as Record<string, unknown>));
		client.on("stderr", (chunk: string) => this.output.append(chunk));
		client.on("spawnError", (err: Error) => {
			this.output.appendLine(`[prime-agent] spawn error: ${err.message}`);
			this.reachable = false;
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
		client.on("exit", (code: number | null) => {
			this.output.appendLine(`[prime-agent] exited with code ${code ?? "?"}`);
			this.reachable = false;
			this.clearRunFlags();
			this.changedFiles.clear();
			this.clearThreadDiffs();
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
		this.stop();
		await this.ensureStarted();
	}

	stop(): void {
		this.intentionalStop = true;
		this.client?.stop();
		this.client = null;
		this.state = null;
		this.reachable = false;
		this.clearRunFlags();
		this.pushStatus();
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
		this.stop();
		// Drop the attach intent before tearing the socket down, or the close
		// handler restarts the re-attach backoff against a dead controller.
		this.attached = null;
		this.attachAttempt = null;
		this.clearReattachTimer();
		// A pending strip refresh would fire against a disposed sidecar.
		if (this.childrenTimer) clearTimeout(this.childrenTimer);
		this.childrenTimer = null;
		this.sidecar?.dispose();
		this.watcher?.dispose();
		for (const d of this.disposables) d.dispose();
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
		this.trackThreadDiffs(event);
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

	private onOtherMessage(raw: Record<string, unknown>): void {
		// Non-response, non-event messages (e.g. extension_bus events). Surface notable ones.
		const type = raw.type as string;
		if (type === "extension_error") {
			this.broadcast({ type: "notice", level: "error", text: `Extension error: ${JSON.stringify(raw.error ?? raw)}` });
		} else if (type === "observed_session_event") {
			const sessionId = raw.activeSessionId as string;
			if (sessionId === this.observingId) {
				this.broadcast({ type: "observedEvent", sessionId, event: raw.event as AgentEvent });
			}
		} else if (type === "observed_session_closed") {
			const sessionId = raw.activeSessionId as string;
			if (sessionId === this.observingId) {
				this.observingId = null;
				this.broadcast({ type: "observedClosed", sessionId });
				this.pushStatus();
			}
		}
	}

	private onBusySettled(): void {
		void this.refreshStateAndStats();
		if (this.changedFiles.size > 0) {
			this.broadcast({ type: "changedFiles", files: [...this.changedFiles].sort() });
		}
	}

	// ------------------------------------------------------------------
	// Extension UI requests -> native VS Code dialogs
	// ------------------------------------------------------------------

	private async onExtensionUiRequest(request: RpcExtensionUIRequest): Promise<void> {
		const respond = (body: Record<string, unknown>) => this.client?.sendRaw({ type: "extension_ui_response", id: request.id, ...body });
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
				return;
		}
	}

	// ------------------------------------------------------------------
	// High-level operations
	// ------------------------------------------------------------------

	async prompt(payload: PromptPayload): Promise<void> {
		if (this.attached) {
			const sidecar = await this.ensureSidecar();
			const text = this.composeMessageText(payload);
			const images = payload.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
			// Attaching mid-turn never delivers agent_start, so `this.streaming`
			// alone would silently downgrade a queued follow-up into a steer.
			const behavior = this.effectiveStreaming() ? payload.streamingBehavior : "steer";
			try {
				await sidecar.prompt(this.attached.activeSessionId, text, behavior, images);
				this.broadcast({ type: "promptAccepted", kind: "prompt" });
			} catch (err) {
				this.broadcast({
					type: "promptRejected",
					error: err instanceof Error ? err.message : "daemon prompt failed",
				});
			}
			return;
		}
		await this.ensureStarted();
		if (!this.client) throw new Error("agent unavailable");
		this.output.appendLine(`[prime-agent] prompt: streaming=${this.streaming} behavior=${payload.streamingBehavior} text="${payload.text.slice(0, 60)}"`);
		this.debugLog.append(`prompt entered: streaming=${this.streaming} behavior=${payload.streamingBehavior} text="${payload.text.slice(0, 60)}"`);

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
			const response = await this.client.request(command);
			this.debugLog.append(`prompt response: success=${response.success} error=${response.error ?? ""}`);
			this.output.appendLine(`[prime-agent] prompt response: success=${response.success}${response.error ? ` error="${response.error}"` : ""}`);
			if (response.success) {
				this.broadcast({ type: "promptAccepted", kind });
			} else {
				this.broadcast({ type: "promptRejected", error: response.error ?? "prompt rejected" });
			}
		} catch (err) {
			this.debugLog.append(`prompt failed: ${err instanceof Error ? err.message : String(err)}`);
			this.output.appendLine(`[prime-agent] prompt request failed: ${err instanceof Error ? err.message : String(err)}`);
			this.broadcast({ type: "notice", level: "error", text: `Prompt failed: ${err instanceof Error ? err.message : String(err)}` });
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
		if (this.attached) {
			try {
				const sidecar = await this.ensureSidecar();
				await sidecar.abort(this.attached.activeSessionId);
			} catch (err) {
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
		if (this.observingId) {
			// The RPC `abort` command carries no session target — it would abort our
			// own idle background session while the observed run streams on. Only the
			// daemon can address someone else's session.
			const id = this.observingId;
			try {
				const sidecar = await this.ensureSidecar();
				await sidecar.abort(id);
			} catch (err) {
				this.output.appendLine(`[prime-agent] observed abort failed: ${String(err)}`);
				this.broadcast({
					type: "notice",
					level: "warning",
					text: "You are watching this session read-only and it could not be stopped from here — stop it in the client that owns it.",
				});
			}
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
		await this.ensureStarted();
		if (!this.client) return;
		await this.detachFromDaemon();
		await this.clearObservation();
		this.resetChildrenBaseline();
		const response = await this.client.request({ type: "new_session" });
		if (response.success) {
			this.clearRunFlags();
			this.changedFiles.clear();
			this.clearThreadDiffs();
			this.cachedMessages = [];
			this.broadcast({ type: "sessionChildren", children: [] });
			await this.refreshSnapshot();
			this.scheduleChildrenRefresh();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `New session failed: ${response.error ?? "unknown error"}` });
		}
	}

	/**
	 * `betweenTurnsOnly` is the threshold trigger's contract. Both transports run
	 * AgentSession.compact() without skipAbort, which aborts whatever is in flight
	 * and schedules no continuation — firing it mid-run would swallow the prompt
	 * the operator just sent, with nothing to resend it. Re-checked after every
	 * await because a turn can start while we are connecting.
	 */
	async compact(instructions?: string, opts?: { betweenTurnsOnly?: boolean }): Promise<void> {
		const wouldAbortARun = (): boolean => opts?.betweenTurnsOnly === true && this.effectiveStreaming();
		if (wouldAbortARun()) return;
		if (this.attached) {
			const sidecar = await this.ensureSidecar();
			if (wouldAbortARun()) return;
			try {
				await sidecar.compact(this.attached.activeSessionId);
			} catch (err) {
				this.broadcast({ type: "notice", level: "error", text: `Compaction failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		await this.ensureStarted();
		if (!this.client || wouldAbortARun()) return;
		const response = await this.client.request(
			instructions ? { type: "compact", customInstructions: instructions } : { type: "compact" },
			300_000,
		);
		if (!response.success) {
			this.broadcast({ type: "notice", level: "error", text: `Compaction failed: ${response.error ?? "unknown error"}` });
		} else {
			await this.refreshSnapshot();
		}
	}

	/**
	 * Fork the session from the (N-th) user message — mirrors /fork: resolves
	 * the entryId via get_fork_messages order alignment with user rows.
	 */
	/** Rename the active session: daemon set_session_name on attached mode, RPC otherwise. */
	async renameSession(name: string): Promise<void> {
		const trimmed = name.trim();
		if (this.attached) {
			const sidecar = await this.ensureSidecar();
			try {
				await sidecar.request({ type: "set_session_name", activeSessionId: this.attached.activeSessionId, name: trimmed }, 15_000);
				if (this.rentedState) this.rentedState.sessionName = trimmed || undefined;
				this.pushStatus();
				this.broadcast({ type: "notice", level: "info", text: trimmed ? `Session renamed to "${trimmed}".` : "Session name cleared." });
			} catch (err) {
				this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		await this.ensureStarted();
		if (!this.client) return;
		const response = await this.client.request({ type: "set_session_name", name: trimmed }, 30_000);
		if (response.success) {
			if (this.state) this.state.sessionName = trimmed || undefined;
			this.pushStatusLight();
			this.broadcast({ type: "notice", level: "info", text: trimmed ? `Session renamed to "${trimmed}".` : "Session name cleared." });
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${response.error ?? "unknown error"}` });
		}
	}

	/** Rename any history session: live sessions go through their owner; offline files get a session_info entry. */
	async renameHistorySession(sessionPath: string, sessionId: string, name: string): Promise<void> {
		// History rows carry the session-file uuid, never the 12-char attach
		// handle — comparing only the handle sent the operator to the "rename it
		// from the terminal" refusal for the session they are browsing.
		if (
			this.state?.sessionId === sessionId ||
			this.attached?.activeSessionId === sessionId ||
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
			if (isSessionActive(sessionPath)) {
				this.broadcast({
					type: "notice",
					level: "error",
					text: `Rename failed: ${err instanceof Error ? err.message : String(err)}`,
				});
				return;
			}
		}
		const { renameSessionOffline } = await import("./session-actions.js");
		const result = await renameSessionOffline(sessionPath, name);
		if (result.ok) {
			this.broadcast({ type: "notice", level: "info", text: `Session renamed to "${trimmed}".` });
			this.savedCatalog = null;
			void this.listHistory();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Rename failed: ${result.error ?? "unknown error"}` });
		}
	}

	async forkFromUser(ordinal: number): Promise<void> {
		// Fork what is on screen. Against the RPC subprocess this would fork our
		// idle background session and still report "Forked the session".
		if (this.effectiveStreaming()) {
			this.broadcast({ type: "notice", level: "error", text: "Wait for the current run to finish before forking." });
			return;
		}
		if (this.attached) {
			const id = this.attached.activeSessionId;
			try {
				const sidecar = await this.ensureSidecar();
				const data = await sidecar.request<{ messages?: Array<{ entryId: string; text: string }> }>(
					{ type: "get_user_messages_for_forking", activeSessionId: id },
					30_000,
				);
				const target = (data.messages ?? [])[ordinal];
				if (!target) {
					this.broadcast({ type: "notice", level: "error", text: `No forkable message at position ${ordinal + 1} (${(data.messages ?? []).length} available).` });
					return;
				}
				await sidecar.request({ type: "fork", activeSessionId: id, entryId: target.entryId }, 60_000);
				this.broadcast({ type: "notice", level: "info", text: "Forked the session from that message." });
				await this.refreshSnapshot();
				void this.listHistory();
			} catch (err) {
				this.broadcast({ type: "notice", level: "error", text: `Fork failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		await this.ensureStarted();
		if (!this.client) return;
		const list = await this.client.request({ type: "get_fork_messages" }, 30_000);
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
		const response = await this.client.request({ type: "fork", entryId: target.entryId }, 60_000);
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
		if (this.attached) {
			try {
				const sidecar = await this.ensureSidecar();
				return { messages: await sidecar.getMessages(this.attached.activeSessionId), state: this.rentedState };
			} catch (err) {
				this.broadcast({ type: "notice", level: "error", text: `Could not load the attached session: ${err instanceof Error ? err.message : String(err)}` });
				return null;
			}
		}
		try {
			await this.ensureStarted();
		} catch {
			return null;
		}
		if (!this.client) return null;
		const messagesRes = await this.client.request({ type: "get_messages" }, 90_000);
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
		return this.state?.sessionId ?? this.state?.sessionFile ?? "none";
	}

	// ---- sticky composer drafts (per session, survive view reloads) ----

	private draftKey(): string {
		return `pa-draft:${this.sessionKey()}`;
	}

	persistDraft(text: string): void {
		void this.context.globalState.update(this.draftKey(), text && text.trim() ? text : undefined);
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
		const picked = await vscode.window.showQuickPick(
			[
				{ label: "Markdown, tool calls summarized", detail: "Compact .md for humans — one line per tool call", mode: "md-tools" },
				{ label: "Markdown, without tool calls", detail: "Conversation only (.md)", mode: "md-clean" },
				{ label: "HTML", detail: "Full interactive transcript via the agent", mode: "html" },
			] as Array<{ label: string; detail: string; mode: string }>,
			{ title: "Export chat" },
		);
		if (!picked) return;
		if (picked.mode === "html") return this.exportHtml();
		await this.exportMarkdown(picked.mode === "md-tools");
	}

	/** Export the current transcript as Markdown, generated client-side. */
	async exportMarkdown(includeTools: boolean): Promise<void> {
		const source = await this.messagesForExport();
		if (!source) {
			this.broadcast({ type: "notice", level: "error", text: "Could not load messages for export" });
			return;
		}
		const md = buildMarkdownExport(source.messages, includeTools, source.state);
		const target = vscode.Uri.file(path.join(this.workspaceRoot, `prime-agent-session-${Date.now()}.md`));
		const picked = await vscode.window.showSaveDialog({ defaultUri: target, filters: { Markdown: ["md"] } });
		if (!picked) return;
		await vscode.workspace.fs.writeFile(picked, Buffer.from(md, "utf8"));
		void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
	}

	async exportHtml(): Promise<void> {
		const target = vscode.Uri.file(path.join(this.workspaceRoot, `prime-agent-session-${Date.now()}.html`));
		const picked = await vscode.window.showSaveDialog({ defaultUri: target, filters: { HTML: ["html"] } });
		if (!picked) return;
		if (this.attached) {
			try {
				const sidecar = await this.ensureSidecar();
				await sidecar.request({ type: "export_html", activeSessionId: this.attached.activeSessionId, outputPath: picked.fsPath }, 60_000);
				void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
			} catch (err) {
				this.broadcast({ type: "notice", level: "error", text: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		await this.ensureStarted();
		if (!this.client) return;
		const response = await this.client.request({ type: "export_html", outputPath: picked.fsPath }, 60_000);
		if (response.success) {
			void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Export failed: ${response.error ?? "unknown error"}` });
		}
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		// Attached sessions are owned by the daemon, not by our RPC subprocess.
		// Sending set_model to the subprocess would retarget a session the
		// operator isn't looking at, while the pill claims the switch landed.
		if (this.attached) {
			try {
				const sidecar = await this.ensureSidecar();
				await sidecar.request({ type: "set_model", activeSessionId: this.attached.activeSessionId, provider, modelId }, 30_000);
				await this.refreshAttachedState();
			} catch (err) {
				this.broadcast({ type: "notice", level: "error", text: `set_model failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		if (!this.client?.running) return;
		const response = await this.client.request({ type: "set_model", provider, modelId });
		if (response.success) {
			await this.refreshStateAndStats();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `set_model failed: ${response.error ?? "unknown error"}` });
		}
	}

	async setThinkingLevel(level: string): Promise<void> {
		if (this.attached) {
			try {
				const sidecar = await this.ensureSidecar();
				await sidecar.request({ type: "set_thinking_level", activeSessionId: this.attached.activeSessionId, level }, 30_000);
				await this.refreshAttachedState();
			} catch (err) {
				this.broadcast({ type: "notice", level: "error", text: `set_thinking_level failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		if (!this.client?.running) return;
		const response = await this.client.request({ type: "set_thinking_level", level });
		if (response.success) {
			await this.refreshStateAndStats();
		}
	}

	async listModels(): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		const response = await this.client.request({ type: "get_available_models" }, 60_000);
		if (response.success) {
			// Forwarded verbatim: the payload is the agent's whole Model object, and
			// the webview needs the fields this cast used to hide (thinkingLevelMap).
			const data = response.data as { models?: RpcModel[] };
			this.broadcast({ type: "models", models: data.models ?? [] });
		}
	}

	async listCommands(): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		const response = await this.client.request({ type: "get_commands" }, 30_000);
		if (response.success) {
			const data = response.data as { commands?: RpcSlashCommand[] };
			this.broadcast({ type: "commands", commands: data.commands ?? [] });
		}
	}

	showHistoryView(): void {
		this.broadcast({ type: "showHistory" });
		void this.listHistory();
	}

	// ------------------------------------------------------------------
	// Session deletion (same conventions as the CLI: trash-first + artifacts)
	// ------------------------------------------------------------------

	async deleteSessionByPath(sessionPath: string, sessionId: string): Promise<void> {
		// The attached session is one the operator is in, so it earns the honest
		// refusal rather than "close it there first" — the sentence #19 rejected.
		if (sessionId === this.state?.sessionId || sessionId === this.attached?.sessionId || sessionId === this.attached?.activeSessionId) {
			this.broadcast({ type: "notice", level: "warning", text: "You can't delete the session you're in. Start a new one first." });
			return;
		}
		// The CLI refuses to delete a resident session too (delete_saved_session:
		// "Cannot delete the currently active session") — but it offers Archive for
		// exactly this case, so say that instead of stranding the operator.
		if (isSessionActive(sessionPath)) {
			this.broadcast({
				type: "notice",
				level: "warning",
				text: "That session is live in another client — archive it instead, or stop it there first.",
			});
			return;
		}
		const result = await deleteSession(sessionPath);
		if (result.ok) {
			const method = result.method === "trash" ? "moved to Trash" : "deleted";
			this.broadcast({ type: "notice", level: "info", text: `Session ${method} (artifacts removed).` });
			this.forgetHistoryRow(sessionPath);
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
			return this.rowsFromCatalog(await sidecar.list(true));
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
		// Repaint the previous answer first. The sidebar webview is torn down on
		// every hide, so without a host-side cache the list flashes "Loading…"
		// through a full catalog fetch each time the operator comes back.
		if (this.lastHistory) this.broadcast({ type: "history", sessions: this.lastHistory });
		const sessions = await this.collectHistory();
		this.lastHistory = sessions;
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
		const needle = query.trim().toLowerCase();
		const base = await this.collectHistory();
		this.lastHistory = base;
		if (needle.length < 2) {
			this.broadcast({ type: "history", sessions: base });
			return;
		}
		let saved: SavedSessionInfo[];
		try {
			saved = await this.savedSessionCatalog();
		} catch {
			// No text corpus available — the webview still filters on names/paths.
			this.broadcast({ type: "history", sessions: base });
			return;
		}
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
		this.broadcast({ type: "history", sessions: [...decorated, ...hits] });
	}

	/** Drop a row from the replay cache so a deleted/archived session never flashes back. */
	private forgetHistoryRow(sessionPath: string): void {
		if (!this.lastHistory) return;
		const target = normalizeFsPath(sessionPath);
		this.lastHistory = this.lastHistory.filter((s) => normalizeFsPath(s.path) !== target);
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
	async stopSession(_sessionPath: string, activeSessionId: string): Promise<void> {
		try {
			const sidecar = await this.ensureSidecar();
			await sidecar.abort(activeSessionId);
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
		if (sessionId === this.state?.sessionId || sessionId === this.attached?.sessionId || sessionId === this.attached?.activeSessionId) {
			this.broadcast({ type: "notice", level: "warning", text: "You can't archive the session you're in. Start a new one first." });
			return;
		}
		try {
			const sidecar = await this.ensureSidecar();
			const resident = (await sidecar.list(true)).find(
				(s) => (s.sessionFile ? normalizeFsPath(s.sessionFile) === normalizeFsPath(sessionPath) : false) && s.activeSessionId,
			);
			if (resident?.activeSessionId) {
				await sidecar.request({ type: "kill", activeSessionId: resident.activeSessionId }, 30_000);
			}
		} catch {
			// Daemon down means nothing is resident; the file append below stands alone.
		}
		const result = await archiveSessionFile(sessionPath);
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
		await this.ensureStarted();
		if (!this.client) return;
		const response = await this.client.request({ type: "get_available_models" }, 60_000);
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
		if (picked) {
			await this.setModel(picked.model.provider, picked.model.id);
		}
	}

	async pickThinkingQuickPick(): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		// Same source as the brain popout: offering a level the model rejects only
		// buys the operator a silent clamp to something they did not pick.
		const levels = supportedThinkingLevels(this.state?.model) ?? THINKING_LEVELS.slice(0, 5);
		const current = this.state?.thinkingLevel ?? "off";
		const picked = await vscode.window.showQuickPick(
			levels.map((level) => ({ label: level, description: level === current ? "(current)" : undefined })),
			{ title: "Select thinking level" },
		);
		if (picked) {
			await this.setThinkingLevel(picked.label);
		}
	}

	async switchSession(sessionPath: string, sessionId?: string): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		await this.detachFromDaemon();
		await this.clearObservation();
		const response = await this.client.request({ type: "switch_session", sessionPath }, 60_000);
		if (response.success) {
			this.clearRunFlags();
			this.changedFiles.clear();
			this.clearThreadDiffs();
			// Reset the spawn baseline with the strip: without this the next
			// children refresh reads every subagent of the resumed session as
			// "newly spawned" and blasts a card for each into the transcript.
			this.resetChildrenBaseline();
			this.broadcast({ type: "sessionChildren", children: [] });
			await this.refreshSnapshot();
			this.scheduleChildrenRefresh();
			return;
		}
		const error = response.error ?? "unknown error";
		if (/already active/i.test(error)) {
			const id = sessionId ?? path.basename(sessionPath, ".jsonl");
			const attached = await this.attachViaDaemon(id, sessionPath);
			if (attached) return;
			const observed = await this.startObserving(id);
			if (observed) return;
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
	}

	/** Attach to a resident session read-only through the daemon observe channel. */
	private async startObserving(sessionId: string): Promise<boolean> {
		if (!this.client) return false;
		const response = await this.client.request({ type: "observe", activeSessionId: sessionId }, 30_000);
		if (!response.success) return false;
		this.observingId = sessionId;
		const messages = (response.data as { messages?: AgentMessage[] })?.messages ?? [];
		this.broadcast({ type: "observedSession", sessionId, messages });
		this.pushStatus();
		return true;
	}

	
	// ----------------------------------------------------------------
	// Daemon sidecar: attached live sessions (terminal parity)
	// ----------------------------------------------------------------

	private async ensureSidecar(): Promise<DaemonSidecar> {
		if (!this.sidecar) {
			this.sidecar = new DaemonSidecar();
			this.sidecar.onEvent = (message) => this.onDaemonEvent(message);
			this.sidecar.onAnyLine = (line) => this.debugLog.append(`sidecar-line: ${line.slice(0, 100)}`);
			this.sidecar.onClose = () => {
				if (this.attached) {
					this.attachAttempt = { ...this.attached };
					// The daemon dropped our attach registration with the socket, so we
					// are NOT following this session any more. Leaving `attached` set
					// makes the re-attach guard below permanently false and the notice
					// below a lie: prompts would still land but no events would return.
					this.attached = null;
					this.broadcast({ type: "notice", level: "warning", text: "Daemon connection dropped — re-attaching when it comes back." });
					this.pushStatus();
					this.scheduleReattach(0);
				}
			};
		}
		if (!this.sidecar.connected) {
			await this.sidecar.connect();
		}
		// Seamless re-attach after a drop: pick up exactly where the user was.
		if (this.sidecar.connected && this.attachAttempt && !this.attached) {
			const attempt = this.attachAttempt;
			try {
				const result = await this.sidecar.attach(attempt.activeSessionId);
				this.attached = attempt;
				this.clearReattachTimer();
				this.applyAttachedSnapshot(result.snapshot);
				this.broadcast({
					type: "notice",
					level: "info",
					text: "Re-attached to the live session.",
				});
			} catch {
				// keep the attempt saved? user closed it in the meantime — drop
				this.attachAttempt = null;
				this.clearReattachTimer();
			}
		}
		return this.sidecar;
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
		if (!this.attachAttempt || this.attached) return;
		const delay = SessionController.REATTACH_BACKOFF[Math.min(step, SessionController.REATTACH_BACKOFF.length - 1)];
		this.reattachTimer = setTimeout(() => {
			this.reattachTimer = null;
			if (!this.attachAttempt || this.attached) return;
			void this.ensureSidecar()
				.catch(() => {})
				.finally(() => {
					if (this.attachAttempt && !this.attached) this.scheduleReattach(step + 1);
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
		if (inFlight) this.streaming = true;
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
		this.rebuildThreadDiffsFromMessages(this.cachedMessages);
		this.pushStatus();
	}

	/**
	 * Attach to a session that is already live somewhere else (a terminal).
	 * The daemon brokers it; both clients see the same stream, both can prompt.
	 */
	private async attachViaDaemon(activeSessionId: string, sessionPath: string): Promise<boolean> {
		try {
			const sidecar = await this.ensureSidecar();
			// Resolve the canonical activeSessionId: root-session uuids and 12-char
			// active windows differ, and events are addressed to the canonical id.
			let canonicalId = activeSessionId;
			try {
				const listed = await sidecar.list(true);
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
			const result = await sidecar.attach(canonicalId);
			const returnedId = (result.snapshot as { activeSessionId?: string } | undefined)?.activeSessionId;
			const finalId = returnedId ?? canonicalId;
			const snapshot = result.snapshot;
			// History rows, the delete guard and the rename guard all key on the
			// session-file uuid, never on the 12-char attach handle.
			const uuid =
				(snapshot?.state as { sessionId?: string } | undefined)?.sessionId ?? snapshot?.summary?.sessionId ?? undefined;
			this.attached = { activeSessionId: finalId, sessionPath, sessionId: uuid };
			this.attachAttempt = { activeSessionId: finalId, sessionPath, sessionId: uuid };
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
					this.cachedMessages = (await sidecar.getMessages(finalId)) as AgentMessage[];
				} catch {
					this.cachedMessages = [];
				}
			}
			void this.refreshAttachedState();
			this.broadcast({
				type: "notice",
				level: "info",
				text: "Attached to the live session — you can work here and in the terminal simultaneously.",
			});
			this.scheduleChildrenRefresh();
			this.changedFiles.clear();
			this.clearThreadDiffs();
			// Stats before the first paint: otherwise the gauge shows the previous
			// session's context until the throttled status push catches up.
			await this.fetchAttachedStats();
			this.applyAttachedSnapshot(snapshot);
			return true;
		} catch (error) {
			this.output.appendLine(`[prime-agent] daemon attach failed: ${String(error)}`);
			return false;
		}
	}

	private async detachFromDaemon(): Promise<void> {
		if (this.attached && this.sidecar?.connected) {
			await this.sidecar.detach(this.attached.activeSessionId);
		}
		this.attached = null;
		this.attachAttempt = null;
		this.rentedState = null;
		// The run we were following belongs to the session we just let go of.
		this.clearRunFlags();
		// So do its changes and its subagents' — every caller here is landing on a
		// different session. Leaving them would credit this thread with edits it
		// never made; the snapshot that follows rebuilds the real ones.
		this.clearThreadDiffs();
		this.clearReattachTimer();
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
			if (this.childrenRefreshPending) this.scheduleChildrenRefresh();
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
		this.previousChildIds = null;
		this.lastChildrenPayload = null;
	}

	private async refreshChildren(): Promise<void> {
		if (!this.sidecar?.connected) return;
		try {
			const sessions = await this.sidecar.list(true);
			let parentActive: string;
			let parentUuid: string | undefined;
			if (this.attached) {
				parentActive = this.attached.activeSessionId;
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
			const asChild = (c: SessionSummaryRef): SessionChild => {
				const rich = c as Rich;
				return {
					id: c.id ?? "",
					activeSessionId: byActive(c),
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
				if (this.attached) {
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
			let siblings: SessionChild[] | undefined;
			const currentId = this.attached ? parentActive : undefined;
			const currentSummary = sessions.find((s) => byActive(s) === currentId) as (SessionSummaryRef & Rich) | undefined;
			if (this.attached && currentSummary) {
				const parentActiveId = currentSummary.parentActiveSessionId;
				const parentSummaryRef = parentActiveId
					? sessions.find((s) => byActive(s) === parentActiveId)
					: undefined;
				if (parentSummaryRef) parent = asChild(parentSummaryRef);
				if (parentActiveId) {
					// The session being viewed stays in the list. Dropping it was what
					// made the count fall by one on entry and left the green "currently
					// viewing" highlight with no row to land on.
					siblings = sessions
						.filter((s) => {
							const rich = s as Rich;
							return isChildKind(rich) && rich.parentActiveSessionId === parentActiveId;
						})
						.map(asChild);
				}
			}
			// The Changes panel is "main + subagents combined", and a child's edits
			// live only in the child's own session file. Harvest before the
			// unchanged-roster early return below: a stable roster still edits.
			void this.harvestSubagentDiffs(children);
			const flat = new Set<string>(children.map(stableId));
			const prev = this.previousChildIds;
			const spawnCards = prev === null
				? []
				: children
						.filter((c) => !prev.has(stableId(c)))
						.map((c) => ({
							activeSessionId: byActive(c),
							name: (c as Rich).sessionName,
							created: (c as Rich).created,
						}));
			this.previousChildIds = flat;
			const payload: Extract<HostToWebview, { type: "sessionChildren" }> = {
				type: "sessionChildren",
				children: children.map(asChild),
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
		} catch {
			// quiet — stale layout tolerated until the next refresh
		}
	}

	/** Browse into a subagent (or any resident session): attach via the daemon. */
	async browseChild(activeSessionId: string): Promise<boolean> {
		const previous = this.attached;
		// Attach FIRST, let go second. Tearing the current session down up front
		// meant a subagent the daemon can no longer rehydrate left the operator
		// detached, with the strip and its "‹ parent" row destroyed and nothing
		// left to click — the freeze reported in the build thread.
		const attached = await this.attachViaDaemon(activeSessionId, "");
		if (!attached) {
			this.broadcast({ type: "notice", level: "error", text: "Could not attach to that subagent session (it may be gone)." });
			this.scheduleChildrenRefresh();
			return false;
		}
		this.returnTarget = previous ? { kind: "attached", ...previous } : { kind: "rpc" };
		if (previous && this.sidecar?.connected) {
			try {
				await this.sidecar.detach(previous.activeSessionId);
			} catch {
				// the daemon dropped it for us — nothing left to release
			}
		}
		this.scheduleChildrenRefresh();
		return true;
	}

	async backToParent(): Promise<void> {
		const target = this.returnTarget;
		this.returnTarget = { kind: "rpc" };
		if (target.kind === "attached") {
			const path = target.sessionPath;
			const id = target.activeSessionId;
			if (this.attached && this.sidecar?.connected) {
				await this.sidecar.detach(this.attached.activeSessionId);
			}
			this.attached = null;
			if (await this.attachViaDaemon(id, path)) return;
			// The parent went away while we were inside the child. Land on our own
			// session rather than on nothing — going up must never dead-end.
			this.broadcast({ type: "notice", level: "warning", text: "The parent session is no longer live — returning to this window's session." });
		}
		// baseline: own RPC session
		await this.detachFromDaemon();
		// The strip belongs to whatever session we just landed on, and the spawn
		// baseline still holds the child's (usually empty) set — leaving it would
		// announce every one of the parent's subagents as freshly spawned.
		this.resetChildrenBaseline();
		await this.refreshSnapshot();
		this.pushStatus();
		this.scheduleChildrenRefresh();
	}

	/** Route daemon events for the attached session into the normal pipeline. */
	private onDaemonEvent(message: DaemonServerMessage): void {
		this.debugLog.append(`daemon-event: type=${message.type} sid=${String(message.activeSessionId).slice(0, 20)}${this.attached ? ` attached=${this.attached.activeSessionId.slice(0, 20)}` : " no-attach"}`);
		const attached = this.attached;
		if (!attached) return;
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
			this.attachAttempt = null;
			this.rentedState = null;
			// No agent_end is coming for a session that no longer exists.
			this.clearRunFlags();
			this.clearReattachTimer();
			this.pushStatus();
		}
	}

	private async refreshAttachedState(): Promise<void> {
		const attached = this.attached;
		if (!attached || !this.sidecar?.connected) return;
		try {
			const state = (await this.sidecar.getState(attached.activeSessionId)) as RpcSessionState;
			this.rentedState = state;
			// get_state answers with the daemon summary, which is where the uuid
			// lives when the attach snapshot didn't carry one.
			if (!attached.sessionId && state?.sessionId) {
				attached.sessionId = state.sessionId;
				if (this.attachAttempt?.activeSessionId === attached.activeSessionId) {
					this.attachAttempt.sessionId = state.sessionId;
				}
			}
			this.pushStatus();
		} catch {
			// keep current state
		}
	}

	/** Effective model/status snapshot accounting for daemon-attached sessions. */

private async clearObservation(): Promise<void> {
		if (!this.observingId || !this.client) {
			this.observingId = null;
			return;
		}
		const id = this.observingId;
		this.observingId = null;
		try {
			await this.client.request({ type: "unobserve", activeSessionId: id }, 10_000);
		} catch {
			// best effort
		}
		this.broadcast({ type: "observedClosed", sessionId: id });
	}

	async stopObserving(): Promise<void> {
		await this.clearObservation();
		// Same trap as backToParent: we land on a different session, so the strip
		// and the spawn baseline both belong to the one we just left.
		this.resetChildrenBaseline();
		await this.refreshSnapshot();
		this.pushStatus();
		this.scheduleChildrenRefresh();
	}

	// ------------------------------------------------------------------
	// Snapshot / status
	// ------------------------------------------------------------------

	async refreshSnapshot(): Promise<void> {
		// Hiding and re-showing the view reloads the webview, which asks for a
		// fresh snapshot. Our own background RPC client is still running, so
		// without this branch the attached transcript is repainted with the
		// background session's (usually empty) messages and its sticky draft,
		// while the header keeps naming the terminal session.
		if (this.attached) {
			const id = this.attached.activeSessionId;
			try {
				const sidecar = await this.ensureSidecar();
				this.cachedMessages = (await sidecar.getMessages(id)) as AgentMessage[];
				this.rentedState = (await sidecar.getState(id)) as RpcSessionState;
			} catch {
				// daemon busy — repaint from what we already hold rather than blank
			}
			await this.fetchAttachedStats();
			this.broadcast({
				type: "snapshot",
				messages: this.cachedMessages,
				state: this.rentedState,
				status: this.buildStatus(),
				steerDefault: vscode.workspace.getConfiguration("primeAgent").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
			});
			this.restoreDraft();
			this.rebuildThreadDiffsFromMessages(this.cachedMessages);
			this.pushStatus();
			this.repaintChildrenStrip();
			return;
		}
		if (!this.client?.running) return;
		try {
			const [messagesRes, stateRes] = await Promise.all([
				this.client.request({ type: "get_messages" }, 60_000),
				this.client.request({ type: "get_state" }, 30_000),
			]);
			// A reply — success or not — is proof the agent is answering us.
			this.reachable = true;
			if (messagesRes.success) {
				this.cachedMessages = ((messagesRes.data as { messages?: AgentMessage[] })?.messages ?? []) as AgentMessage[];
			}
			if (stateRes.success) {
				this.state = stateRes.data as RpcSessionState;
			}
			const stats = await this.fetchStatsText();
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
			this.output.appendLine(`[prime-agent] snapshot failed: ${String(err)}`);
		}
		this.restoreDraft();
		this.rebuildThreadDiffsFromMessages(this.cachedMessages);
		this.pushStatus();
		this.repaintChildrenStrip();
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
		if (!this.client?.running) return;
		try {
			const stateRes = await this.client.request({ type: "get_state" }, 30_000);
			this.reachable = true;
			if (stateRes.success) this.state = stateRes.data as RpcSessionState;
		} catch {
			// keep previous state
		}
		this.pushStatus();
	}

	private lastStatsText = "";
	private statsTimer: NodeJS.Timeout | null = null;
	private statsFetching = false;

	/** Broadcast the status immediately using cached stats (cheap, per-event). */
	private pushStatusLight(): void {
		this.broadcast({ type: "status", status: this.buildStatus(this.lastStatsText) });
	}

	private async fetchStatsText(): Promise<string> {
		if (!this.client?.running) return "";
		try {
			const res = await this.client.request({ type: "get_session_stats" }, 30_000);
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
		if (this.attached) {
			const st = this.rentedState as (RpcSessionState & { model?: RpcSessionState["model"] }) | null;
			const model = st?.model ?? null;
			const label = model ? `${model.provider}/${model.id}` : "attached session";
			// Attaching mid-turn never delivers agent_start, so the local flags alone
			// would report idle: no running label, no Stop, no queue/steer toggle.
			const streaming = this.streaming || (st?.isStreaming ?? false);
			const compacting = this.compacting || (st?.isCompacting ?? false);
			return {
				connected: true,
				streaming,
				compacting,
				retrying: this.retrying,
				restoring: false,
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
				statusText: compacting
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
			restoring: this.startingPromise !== null,
			modelLabel,
			thinkingLevel: this.state?.thinkingLevel ?? "off",
			availableThinkingLevels: supportedThinkingLevels(model),
			sessionName: this.state?.sessionName,
			sessionFile: this.state?.sessionFile,
			sessionId: this.state?.sessionId,
			statsText,
			statusText: this.extensionStatusText,
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
		if (this.statsTimer) return;
		this.statsTimer = setTimeout(() => {
			this.statsTimer = null;
			// While attached, the RPC subprocess's stats belong to a session the
			// operator is not looking at — ask the daemon about the one they are.
			const attachedStats = this.attached && this.sidecar?.connected;
			if (this.statsFetching || (!attachedStats && !this.client?.running)) {
				this.pushStatusLight();
				return;
			}
			this.statsFetching = true;
			void (attachedStats ? this.fetchAttachedStats() : this.fetchStatsText())
				.then((stats) => {
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
		if (doc.uri.scheme !== "file") return null;
		const sel = editor.selection;
		if (sel.isEmpty) return null;
		return {
			path: vscode.workspace.asRelativePath(doc.uri, false),
			startLine: sel.start.line + 1,
			endLine: sel.end.line + 1,
			text: doc.getText(sel),
			languageId: doc.languageId,
		};
	}

	getActiveFilePath(): string | null {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== "file") return null;
		return vscode.workspace.asRelativePath(editor.document.uri, false);
	}

	async searchFiles(query: string, requestId: number): Promise<void> {
		const config = vscode.workspace.getConfiguration("primeAgent");
		const max = config.get<number>("maxFileSearchResults", 40);
		const trimmed = query.trim();
		const pattern = trimmed ? `**/*${trimmed.replace(/[\s]+/g, "*")}*` : "**/*";
		const exclude = "**/{node_modules,.git,dist,out,.turbo,.next,coverage}/**";
		try {
			const uris = await vscode.workspace.findFiles(pattern, exclude, max);
			const files = uris.map((uri) => vscode.workspace.asRelativePath(uri, false));
			const dirs = await this.searchDirs(trimmed, Math.max(8, Math.floor(max / 4)));
			const combined = [
				...dirs.map((path) => ({ path, isDir: true })),
				...files.map((path) => ({ path, isDir: false })),
			].sort((a, b) => a.path.localeCompare(b.path));
			this.broadcast({ type: "fileSearchResults", requestId, files: combined });
		} catch {
			this.broadcast({ type: "fileSearchResults", requestId, files: [] });
		}
	}

	/** Lightweight directory listing for @-folder mentions. Pruned, capped, fuzzy. */
	private async searchDirs(query: string, max: number): Promise<string[]> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const out: string[] = [];
		const prune = new Set(["node_modules", ".git", "dist", "out", ".turbo", ".next", "coverage", ".vscode-test"]);
		const needle = query.toLowerCase();
		for (const folder of folders.slice(0, 2)) {
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
		}
		return out;
	}

	async pickImages(requestId: number): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
			openLabel: "Attach image",
		});
		if (!uris || uris.length === 0) {
			this.broadcast({ type: "imagePicked", requestId, images: [] });
			return;
		}
		const mimeByExt: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
		};
		const images: ImageAttachment[] = [];
		for (const uri of uris) {
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
				images.push({
					data: Buffer.from(bytes).toString("base64"),
					mimeType: mimeByExt[ext] ?? "image/png",
					name: path.basename(uri.fsPath),
				});
			} catch {
				// skip unreadable files
			}
		}
		this.broadcast({ type: "imagePicked", requestId, images });
	}

	async openFile(relPath: string, startLine?: number, endLine?: number): Promise<void> {
		const uri = this.resolveWorkspaceUri(relPath.replace(/\/$/, ""));
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

	private resolveWorkspaceUri(relPath: string): vscode.Uri | null {
		if (path.isAbsolute(relPath)) return vscode.Uri.file(relPath);
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) return null;
		return vscode.Uri.joinPath(folder.uri, relPath);
	}

	async openDiff(relPath: string): Promise<void> {
		const uri = this.resolveWorkspaceUri(relPath);
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
			if (rel.startsWith("..") || rel.includes("node_modules/") || rel.includes("/.git/")) return;
			this.changedFiles.add(rel);
		};
		this.watcher.onDidCreate(track, null, this.disposables);
		this.watcher.onDidChange(track, null, this.disposables);
	}

	private trackChangedFilesDone(_event: AgentEvent): void {
		// Reserved for future per-tool tracking; watcher coverage is sufficient for now.
	}

	// ------------------------------------------------------------------
	// Per-thread diff panel: cumulative tracking of what the agent edited.
	//
	// The hunks come from prime-agent itself, not from us: its bundled `edit`
	// skill publishes {path, oldStr, newStr} over display_data, and the ipython
	// tool forwards them on `tool_execution_end.result.details.diffs` (and on the
	// persisted toolResult message). That is the ONLY structured change record
	// the agent exposes — keying on a tool literally named "edit"/"write" can
	// never fire against the real CLI, which registers `ipython` and nothing else.
	//
	// State lives host-side so a reloaded webview rebuilds from the push that
	// follows every snapshot.
	// ------------------------------------------------------------------

	/** Edits made by the session being viewed. */
	private threadDiffFiles = new Map<string, ThreadDiffAccum>();
	/** Edits harvested from this session's subagents, kept apart so a rebuild of
	 *  the parent's own history cannot drop them. */
	private subagentDiffFiles = new Map<string, ThreadDiffAccum>();
	/** Bytes already parsed per child session file, so a refresh reads only new ones. */
	private subagentDiffOffsets = new Map<string, number>();
	private subagentHarvestInFlight = false;
	/** Bumped on every reset. A harvest awaiting a file read when the operator
	 *  switches sessions must not write the old thread's rows into the new one. */
	private threadDiffGeneration = 0;
	/** Staged tool_execution_start payloads keyed by toolCallId until the end event. */
	private threadDiffPendings = new Map<string, ThreadDiffPending>();
	private threadDiffsTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Commit the tool-call changes an execution actually reported. Called from
	 * onAgentEvent alongside trackChangedFilesDone.
	 */
	private trackThreadDiffs(event: AgentEvent): void {
		if (!event || typeof event.type !== "string") return;
		if (event.type === "agent_start") {
			// Pendings left over from an aborted run never got an end event: drop.
			this.threadDiffPendings.clear();
			return;
		}
		if (event.type === "agent_end") {
			// End events missing (abort edge): commit best effort, then reset.
			for (const pending of this.threadDiffPendings.values()) this.commitThreadDiff(pending);
			this.threadDiffPendings.clear();
			return;
		}
		if (event.type === "tool_execution_start") {
			if (typeof event.toolCallId !== "string" || !event.toolCallId) return;
			const pending = this.parseThreadDiffToolCall(event.toolName, event.args);
			if (!pending) return;
			if (this.threadDiffPendings.size >= THREAD_DIFF_MAX_PENDING) this.threadDiffPendings.clear();
			this.threadDiffPendings.set(event.toolCallId, pending);
			return;
		}
		if (event.type === "tool_execution_end") {
			if (typeof event.toolCallId !== "string") return;
			const pending = this.threadDiffPendings.get(event.toolCallId);
			this.threadDiffPendings.delete(event.toolCallId);
			if (event.isError) return;
			// The real source: prime-agent's own diff payloads, which ride on the
			// result details regardless of what the tool is called.
			const details = (event.result as { details?: { diffs?: unknown } } | undefined)?.details;
			if (this.commitKernelDiffs(details?.diffs, this.threadDiffFiles)) this.queueThreadDiffsBroadcast();
			if (pending) this.commitThreadDiff(pending);
		}
	}

	/**
	 * Commit prime-agent's own diff payloads (KernelDiffDisplay:
	 * {path, oldStr, newStr, startLine}). `agent` names the subagent when the
	 * record was harvested from a child session; returns whether anything landed.
	 */
	private commitKernelDiffs(raw: unknown, into: Map<string, ThreadDiffAccum>, agent?: string): boolean {
		if (!Array.isArray(raw)) return false;
		let committed = false;
		for (const entry of raw) {
			if (!entry || typeof entry !== "object") continue;
			const diff = entry as { path?: unknown; oldStr?: unknown; newStr?: unknown };
			if (typeof diff.oldStr !== "string" || typeof diff.newStr !== "string") continue;
			const display = normalizeToolPath(diff.path, this.workspaceRoot);
			if (!display || !isThreadDiffPathWorthy(display)) continue;
			const hunk = capHunkSides(splitCleanLines(diff.oldStr), splitCleanLines(diff.newStr), THREAD_DIFF_SIDE_CAP);
			const accum = this.ensureThreadDiffFile(display, into);
			if (!accum) continue;
			accum.source = "edit";
			if (accum.hunks.length >= THREAD_DIFF_MAX_HUNKS_PER_FILE) accum.hunks.shift();
			accum.hunks.push(agent ? { ...hunk, agent } : hunk);
			committed = true;
		}
		return committed;
	}

	/**
	 * Fallback for tools an extension registered itself. The stock CLI emits
	 * neither name (its single tool is `ipython`), so this path is dead against
	 * a plain install — it exists so a host that DOES register an edit/write tool
	 * still lands on the panel. There is deliberately no `bash` arm: a shell
	 * command carries no before/after content, so every row it could produce
	 * would be a guess about a file the agent may only have read.
	 */
	private parseThreadDiffToolCall(toolName: unknown, args: Record<string, unknown> | undefined): ThreadDiffPending | null {
		const name = typeof toolName === "string" ? toolName.toLowerCase() : "";
		if (!args || typeof args !== "object") return null;
		if (name === "edit") {
			const display = normalizeToolPath(args.path, this.workspaceRoot);
			if (!display || !isThreadDiffPathWorthy(display)) return null;
			const edits = Array.isArray(args.edits)
				? args.edits
				: typeof args.oldText === "string" || typeof args.newText === "string"
					? [args]
					: [];
			let removed: string[] = [];
			let added: string[] = [];
			for (const rawEdit of edits) {
				if (!rawEdit || typeof rawEdit !== "object") continue;
				const edit = rawEdit as { oldText?: unknown; newText?: unknown };
				if (typeof edit.oldText === "string") removed = removed.concat(splitCleanLines(edit.oldText));
				if (typeof edit.newText === "string") added = added.concat(splitCleanLines(edit.newText));
			}
			if (removed.length === 0 && added.length === 0) return null;
			return { path: display, source: "edit", hunks: [capHunkSides(removed, added, THREAD_DIFF_SIDE_CAP)] };
		}
		if (name === "write") {
			const display = normalizeToolPath(args.path, this.workspaceRoot);
			if (!display || !isThreadDiffPathWorthy(display)) return null;
			if (typeof args.content !== "string") return null;
			return { path: display, source: "write", hunks: [capHunkSides([], splitCleanLines(args.content), THREAD_DIFF_WRITE_CAP)] };
		}
		return null;
	}

	/** Merge a staged tool call into the cumulative per-thread state. */
	private commitThreadDiff(pending: ThreadDiffPending): void {
		const accum = this.ensureThreadDiffFile(pending.path, this.threadDiffFiles);
		if (!accum) return;
		accum.source = pending.source;
		for (const hunk of pending.hunks) {
			if (accum.hunks.length >= THREAD_DIFF_MAX_HUNKS_PER_FILE) accum.hunks.shift();
			accum.hunks.push(hunk);
		}
		this.queueThreadDiffsBroadcast();
	}

	private ensureThreadDiffFile(path: string, into: Map<string, ThreadDiffAccum>): ThreadDiffAccum | null {
		const existing = into.get(path);
		if (existing) return existing;
		if (into.size >= THREAD_DIFF_MAX_FILES) return null;
		const accum: ThreadDiffAccum = { source: "edit", hunks: [] };
		into.set(path, accum);
		return accum;
	}

	/**
	 * Rebuild the panel from a thread's own history. Live events only ever cover
	 * what arrives from now on, so resuming yesterday's thread — or coming back
	 * from a subagent — used to show an empty "Changes" panel on a thread the
	 * agent demonstrably rewrote. The persisted toolResult records carry the same
	 * `details.diffs` the live events do, so a full recompute is exact and
	 * idempotent (safe to run again after every snapshot and catch-up frame).
	 */
	private rebuildThreadDiffsFromMessages(messages: AgentMessage[] | undefined): void {
		this.threadDiffFiles.clear();
		for (const message of messages ?? []) {
			if (!message || (message as { role?: unknown }).role !== "toolResult") continue;
			const record = message as ToolResultMessage;
			if (record.isError === true) continue;
			this.commitKernelDiffs(record.details?.diffs, this.threadDiffFiles);
		}
		this.postThreadDiffs();
	}

	/**
	 * Subagent edits, which the parent's own message list knows nothing about:
	 * a subagent is a separate session with a separate file (the daemon roster
	 * hands us its `sessionFile`). We tail each child for the same diff records
	 * the parent's edits produce, so "Changes" is main + subagents combined.
	 * Byte offsets make every refresh after the first read only the new bytes.
	 */
	private async harvestSubagentDiffs(children: SessionSummaryRef[]): Promise<void> {
		if (this.subagentHarvestInFlight) return;
		this.subagentHarvestInFlight = true;
		const generation = this.threadDiffGeneration;
		let committed = false;
		try {
			for (const child of children.slice(0, THREAD_DIFF_MAX_CHILD_FILES)) {
				if (this.threadDiffGeneration !== generation) return;
				const file = child.sessionFile;
				if (!file) continue;
				const label = child.sessionName?.trim() || (child.sessionId ?? child.activeSessionId ?? child.id ?? "").slice(0, 8);
				if (await this.harvestChildDiffFile(file, label || "subagent", generation)) committed = true;
			}
		} finally {
			this.subagentHarvestInFlight = false;
		}
		if (committed && this.threadDiffGeneration === generation) this.postThreadDiffs();
	}

	private async harvestChildDiffFile(file: string, agent: string, generation: number): Promise<boolean> {
		let handle: fs.FileHandle | null = null;
		try {
			const start = this.subagentDiffOffsets.get(file) ?? 0;
			const { size } = await fs.stat(file);
			if (size <= start) return false;
			handle = await fs.open(file, "r");
			const length = Math.min(size - start, THREAD_DIFF_CHILD_READ_BYTES);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, start);
			// The read is where we can lose the race with a session switch.
			if (this.threadDiffGeneration !== generation) return false;
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline < 0) {
				// One record longer than the whole window: step past it rather than
				// re-reading the same bytes on every refresh forever. The next window
				// resumes mid-record, whose fragment simply fails to parse.
				this.subagentDiffOffsets.set(file, start + length);
				return false;
			}
			this.subagentDiffOffsets.set(file, start + lastNewline + 1);
			let committed = false;
			for (const line of buffer.subarray(0, lastNewline).toString("utf8").split("\n")) {
				// Cheap gate: session files are mostly multi-KB message rows and
				// parsing them all would cost more than the read did.
				if (!line.includes('"diffs"')) continue;
				try {
					const entry = JSON.parse(line) as { type?: string; message?: ToolResultMessage };
					if (entry.type !== "message" || entry.message?.role !== "toolResult" || entry.message.isError === true) continue;
					if (this.commitKernelDiffs(entry.message.details?.diffs, this.subagentDiffFiles, agent)) committed = true;
				} catch {
					// malformed or half-written line — the next refresh reads past it
				}
			}
			return committed;
		} catch {
			// The child just spawned and has no file yet, or the daemon named a path
			// we cannot read. Silence is right: the strip already reports the child.
			return false;
		} finally {
			await handle?.close();
		}
	}

	/** Reset per-thread diff state (new session / switch / attach / agent exit). */
	private clearThreadDiffs(): void {
		if (this.threadDiffsTimer) {
			clearTimeout(this.threadDiffsTimer);
			this.threadDiffsTimer = null;
		}
		this.threadDiffGeneration += 1;
		const had = this.threadDiffFiles.size > 0 || this.subagentDiffFiles.size > 0;
		this.threadDiffFiles.clear();
		this.subagentDiffFiles.clear();
		// Offsets go with the rows: the next children refresh re-reads each child
		// from byte 0, which is what restores the panel after a subagent round trip.
		this.subagentDiffOffsets.clear();
		this.threadDiffPendings.clear();
		if (had) this.postThreadDiffs();
	}

	private queueThreadDiffsBroadcast(): void {
		if (this.threadDiffsTimer) return;
		this.threadDiffsTimer = setTimeout(() => {
			this.threadDiffsTimer = null;
			this.postThreadDiffs();
		}, 200);
	}

	private postThreadDiffs(): void {
		// One row per file, own edits first then each subagent's — the hunks carry
		// their own author, so a file both touched reads as one file, not two.
		const byPath = new Map<string, { source: ThreadDiffSource; hunks: ThreadDiffHunk[] }>();
		for (const source of [this.threadDiffFiles, this.subagentDiffFiles]) {
			for (const [path, accum] of source) {
				const existing = byPath.get(path);
				if (existing) existing.hunks.push(...accum.hunks);
				else byPath.set(path, { source: accum.source, hunks: [...accum.hunks] });
			}
		}
		const files: ThreadDiffFile[] = [];
		for (const [path, entry] of byPath) {
			files.push({
				path,
				viaSource: entry.source,
				hunks: entry.hunks.map((hunk) => ({
					removed: [...hunk.removed],
					added: [...hunk.added],
					...(hunk.note ? { note: hunk.note } : {}),
					...(hunk.agent ? { agent: hunk.agent } : {}),
				})),
			});
		}
		const message: HostToWebview = { type: "threadDiffs", files };
		for (const sink of this.sinks) sink.post(message);
	}
}

function formatNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

/**
 * Readonly documents for `git show HEAD:<path>` so the diff view can compare the
 * pre-run file with the agent-modified working tree without the git extension.
 */
export class GitHeadContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const fsPath = uri.with({ scheme: "file" }).fsPath;
		const cwd = path.dirname(fsPath);
		try {
			const { stdout: rel } = await execFileAsync("git", ["-C", cwd, "ls-files", "--full-name", "--", fsPath]);
			const relPath = rel.trim();
			if (!relPath) return "";
			const { stdout: rootOut } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
			const { stdout } = await execFileAsync("git", ["-C", rootOut.trim(), "show", `HEAD:${relPath}`], {
				maxBuffer: 16 * 1024 * 1024,
			});
			return stdout;
		} catch {
			return "";
		}
	}
}


// ---------------------------------------------------------------------------
// Markdown transcript export
// ---------------------------------------------------------------------------

interface ExportToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

function buildMarkdownExport(
	messages: Array<Record<string, unknown>>,
	includeTools: boolean,
	state: { model?: { provider?: string; id?: string } | null; sessionName?: string } | null,
): string {
	const toolCalls = new Map<string, ExportToolCall>();
	const lines: string[] = [];
	const title = state?.sessionName ? `"${state.sessionName}"` : "session";
	const model = state?.model ? `${state.model.provider}/${state.model.id}` : "unknown model";
	lines.push(`# Prime Agent chat export — ${title}`);
	lines.push("");
	lines.push(`_Exported ${new Date().toLocaleString()} · model ${model}_`);
	lines.push("");
	let omittedTools = 0;

	const summarizeTool = (tool: ExportToolCall): string => {
		const args = tool.args ?? {};
		if (tool.name === "edit" && typeof args.path === "string") {
			const edits = Array.isArray(args.edits) ? (args.edits as Array<{ oldText?: string; newText?: string }>) : [];
			let removed = 0;
			let added = 0;
			for (const e of edits) {
				removed += e.oldText ? e.oldText.split("\n").length : 0;
				added += e.newText ? e.newText.split("\n").length : 0;
			}
			return `${args.path} (+${added}/−${removed}${edits.length > 1 ? `, ${edits.length} edits` : ""})`;
		}
		const candidate = args.code ?? args.command ?? args.path ?? args.prompt ?? args.query;
		const first = typeof candidate === "string" ? candidate.split("\n").find((l) => l.trim()) ?? "" : "";
		return first.length > 120 ? `${first.slice(0, 120)}…` : first;
	};

	for (const message of messages) {
		const role = message.role as string;
		const content = message.content;
		if (role === "user") {
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((p) => (p as { type?: string }).type === "text")
								.map((p) => (p as { text: string }).text)
								.join("\n")
						: "";
			const imageCount = Array.isArray(content) ? content.filter((p) => (p as { type?: string }).type === "image").length : 0;
			lines.push(`## You`);
			lines.push("");
			lines.push(text.trim());
			if (imageCount > 0) lines.push(`_${imageCount} image(s) attached_`);
			lines.push("");
		} else if (role === "assistant") {
			const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
			lines.push(`## Prime Agent`);
			lines.push("");
			for (const part of parts) {
				if (part.type === "text") {
					const text = (part.text as string) ?? "";
					if (text.trim()) {
						lines.push(text.trim());
						lines.push("");
					}
				} else if (part.type === "thinking") {
					const thinking = (part.thinking as string) ?? "";
					if (thinking.trim()) {
						lines.push("> **Thinking**");
						lines.push(">");
						for (const line of thinking.trim().split("\n")) lines.push(`> ${line}`);
						lines.push("");
					}
				} else if (part.type === "toolCall") {
					if (includeTools) {
						toolCalls.set(part.id as string, {
							id: part.id as string,
							name: part.name as string,
							args: (part.arguments as Record<string, unknown>) ?? {},
						});
					} else {
						omittedTools += 1;
					}
				}
			}
		} else if (role === "toolResult") {
			if (!includeTools) continue;
			const toolCallId = message.toolCallId as string;
			const tool = toolCalls.get(toolCallId);
			const text = Array.isArray(content)
				? (content as Array<Record<string, unknown>>)
						.filter((p) => p.type === "text")
						.map((p) => p.text as string)
						.join("\n")
				: "";
			const name = (message.toolName as string) ?? tool?.name ?? "tool";
			const summary = tool ? summarizeTool({ ...tool, result: text, isError: !!message.isError }) : "";
			lines.push(`- ⚙ **${name}** ${summary}${message.isError ? " — _(failed)_" : ""}`);
			lines.push("");
			if (toolCallId) toolCalls.delete(toolCallId);
		}
	}
	// Calls without a result (aborted runs) — summarize from arguments anyway.
	for (const orphan of toolCalls.values()) {
		lines.push(`- ⚙ **${orphan.name}** ${summarizeTool(orphan)} — _(no result)_`);
		lines.push("");
	}
	if (!includeTools && omittedTools > 0) {
		lines.push(`_${omittedTools} tool call(s) omitted_`);
		lines.push("");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Appended imports (kept out of the header import block so this feature's
// edits stay strictly append-only).
// ---------------------------------------------------------------------------

import * as fs from "node:fs/promises";
import type { ThreadDiffFile, ThreadDiffHunk, ThreadDiffSource, ThreadDiffsMessage, ToolResultMessage } from "./protocol.js";

// ---------------------------------------------------------------------------
// Per-thread diff accumulation helpers (module scope; host-only state lives
// on SessionController above).
// ---------------------------------------------------------------------------

const THREAD_DIFF_MAX_FILES = 200;
const THREAD_DIFF_MAX_HUNKS_PER_FILE = 60;
const THREAD_DIFF_SIDE_CAP = 400;
const THREAD_DIFF_WRITE_CAP = 240;
const THREAD_DIFF_MAX_PENDING = 200;
/** Child session files tailed per refresh; beyond this the strip is unusable anyway. */
const THREAD_DIFF_MAX_CHILD_FILES = 24;
/** Bytes read from one child session file per refresh. */
const THREAD_DIFF_CHILD_READ_BYTES = 2 * 1024 * 1024;

/** Per-file accumulated state (append-ordered, chronologically). */
interface ThreadDiffAccum {
	source: ThreadDiffSource;
	hunks: ThreadDiffHunk[];
}

/** Staged data from tool_execution_start, committed on a non-error end event. */
interface ThreadDiffPending {
	path: string;
	source: ThreadDiffSource;
	hunks: ThreadDiffHunk[];
}

function splitCleanLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Workspace-relative display form when the path resolves inside the root. */
function normalizeToolPath(rawPath: unknown, workspaceRoot: string): string | null {
	if (typeof rawPath !== "string") return null;
	let display = rawPath.trim();
	if (display.startsWith("./")) display = display.slice(2);
	if (!display) return null;
	if (path.isAbsolute(display)) {
		const rel = path.relative(workspaceRoot, display);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
			display = rel.split(path.sep).join("/");
		}
	}
	return display;
}

/** Watcher parity: never surface vendored or git-internal paths on the panel. */
function isThreadDiffPathWorthy(display: string): boolean {
	return !display.includes("node_modules/") && !display.includes("/.git/") && !display.startsWith(".git/");
}

/** Truncate a hunk side and produce the gutter note when truncated. */
function capHunkSides(removed: string[], added: string[], sideCap: number): ThreadDiffHunk {
	const notes: string[] = [];
	let keptRemoved = removed;
	let keptAdded = added;
	if (keptRemoved.length > sideCap) {
		notes.push(`… (${keptRemoved.length - sideCap} more removed lines)`);
		keptRemoved = keptRemoved.slice(0, sideCap);
	}
	if (keptAdded.length > sideCap) {
		const note = `… (+${keptAdded.length - sideCap} more lines)`;
		notes.push(note);
		keptAdded = keptAdded.slice(0, sideCap);
	}
	return { removed: keptRemoved, added: keptAdded, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) };
}

