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
import type { DaemonServerMessage, SessionSummaryRef } from "./daemon-sidecar.js";
import type {
	AgentEvent,
	AgentMessage,
	HostToWebview,
	ImageAttachment,
	ModelRef,
	PromptPayload,
	RecentSession,
	RpcExtensionUIRequest,
	RpcSessionState,
	RpcSlashCommand,
	StatusSnapshot,
} from "./protocol.js";
import { DebugFileLog } from "./debug-log.js";
import { listRecentSessions } from "./recent-sessions.js";
import { deleteSession, isSessionActive } from "./session-actions.js";
import { RpcClient } from "./rpc-client.js";

const execFileAsync = promisify(execFile);

interface WebviewSink {
	post(message: HostToWebview): void;
}

export class SessionController implements vscode.Disposable {
	private client: RpcClient | null = null;
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
	private attached: { activeSessionId: string; sessionPath: string } | null = null;
	/** Where browsing-into-a-child should return to. null → the baseline RPC session. */
	private returnTarget: { kind: "rpc" } | { kind: "attached"; activeSessionId: string; sessionPath: string } = { kind: "rpc" };
	private rentedState: RpcSessionState | null = null;

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
		this.intentionalStop = false;

		client.on("event", (raw) => this.onAgentEvent(raw as AgentEvent));
		client.on("extensionUiRequest", (raw) => void this.onExtensionUiRequest(raw as RpcExtensionUIRequest));
		client.on("message", (raw) => this.onOtherMessage(raw as Record<string, unknown>));
		client.on("stderr", (chunk: string) => this.output.append(chunk));
		client.on("spawnError", (err: Error) => {
			this.output.appendLine(`[prime-agent] spawn error: ${err.message}`);
			this.broadcast({
				type: "notice",
				level: "error",
				text: `Could not start "${command}". Install Prime Agent or set primeAgent.command in settings.`,
			});
			this.pushStatus();
		});
		client.on("exit", (code: number | null) => {
			this.output.appendLine(`[prime-agent] exited with code ${code ?? "?"}`);
			this.streaming = false;
			this.compacting = false;
			this.retrying = false;
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
		this.streaming = false;
		this.pushStatus();
	}

	dispose(): void {
		this.stop();
		this.watcher?.dispose();
		for (const d of this.disposables) d.dispose();
	}

	// ------------------------------------------------------------------
	// Event routing
	// ------------------------------------------------------------------

	private onAgentEvent(event: AgentEvent): void {
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
				void this.scheduleChildrenRefresh();
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
			if (payload.images.length > 0) {
				this.broadcast({
					type: "notice",
					level: "warning",
					text: "Images aren't delivered to attached terminal sessions (daemon prompts are text-only).",
				});
			}
			const behavior = this.streaming ? payload.streamingBehavior : "steer";
			try {
				await sidecar.prompt(this.attached.activeSessionId, text, behavior);
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
			const sidecar = await this.ensureSidecar();
			try {
				await sidecar.abort(this.attached.activeSessionId);
			} catch (err) {
				this.output.appendLine(`[prime-agent] attached abort failed: ${String(err)}`);
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
		const response = await this.client.request({ type: "new_session" });
		if (response.success) {
			this.changedFiles.clear();
			this.clearThreadDiffs();
			this.cachedMessages = [];
			this.broadcast({ type: "sessionChildren", children: [] });
			await this.refreshSnapshot();
			void this.scheduleChildrenRefresh();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `New session failed: ${response.error ?? "unknown error"}` });
		}
	}

	async compact(instructions?: string): Promise<void> {
		if (this.attached) {
			const sidecar = await this.ensureSidecar();
			try {
				await sidecar.compact(this.attached.activeSessionId);
			} catch (err) {
				this.broadcast({ type: "notice", level: "error", text: `Compaction failed: ${err instanceof Error ? err.message : String(err)}` });
			}
			return;
		}
		await this.ensureStarted();
		if (!this.client) return;
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
	async forkFromUser(ordinal: number): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		if (this.streaming) {
			this.broadcast({ type: "notice", level: "error", text: "Wait for the current run to finish before forking." });
			return;
		}
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

	/** Copy the whole conversation as Markdown (same summarization as file export). */
	async copyConversation(): Promise<void> {
		try {
			await this.ensureStarted();
		} catch {
			return;
		}
		if (!this.client) return;
		const messagesRes = await this.client.request({ type: "get_messages" }, 60_000);
		if (!messagesRes.success) return;
		const messages = (messagesRes.data as { messages?: Array<Record<string, unknown>> })?.messages ?? [];
		const md = buildMarkdownExport(messages, true, this.state as unknown as { model?: { provider?: string; id?: string } | null; sessionName?: string } | null);
		await vscode.env.clipboard.writeText(md);
		this.broadcast({ type: "notice", level: "info", text: "Conversation copied as Markdown." });
	}

	// ---- sticky composer drafts (per session, survive view reloads) ----

	private draftKey(): string {
		const id = this.state?.sessionId ?? this.state?.sessionFile ?? "none";
		return `pa-draft:${id}`;
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
		const id = this.state?.sessionId ?? this.state?.sessionFile ?? "none";
		return `pa-ct:${id}`;
	}

	compactThreshold(): number | null {
		return this.context.globalState.get<number | null>(this.thresholdKey(), null);
	}

	setCompactThreshold(percent: number | null): void {
		if (percent !== null && (percent < 20 || percent > 80)) return;
		void this.context.globalState.update(this.thresholdKey(), percent ?? undefined);
		this.broadcast({ type: "compactThreshold", percent });
		this.pushStatus();
	}

	private autoCompactSent = false;

	private maybeTriggerAutoCompact(percent: number | null): void {
		const threshold = this.compactThreshold();
		if (percent == null || threshold == null) {
			this.autoCompactSent = false;
			return;
		}
		if (percent < Math.max(20, threshold - 15)) {
			this.autoCompactSent = false;
			return;
		}
		if (percent >= threshold && !this.autoCompactSent && this.streaming && !this.compacting) {
			this.autoCompactSent = true;
			this.broadcast({
				type: "notice",
				level: "info",
				text: `Context hit ${percent}% ≥ ${threshold}% — auto-compacting for this session.`,
			});
			void this.compact();
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
		await this.ensureStarted();
		if (!this.client) return;
		const messagesRes = await this.client.request({ type: "get_messages" }, 90_000);
		if (!messagesRes.success) {
			this.broadcast({ type: "notice", level: "error", text: "Could not load messages for export" });
			return;
		}
		const messages = (messagesRes.data as { messages?: Array<Record<string, unknown>> })?.messages ?? [];
		const md = buildMarkdownExport(messages, includeTools, this.state);
		const target = vscode.Uri.file(path.join(this.workspaceRoot, `prime-agent-session-${Date.now()}.md`));
		const picked = await vscode.window.showSaveDialog({ defaultUri: target, filters: { Markdown: ["md"] } });
		if (!picked) return;
		await vscode.workspace.fs.writeFile(picked, Buffer.from(md, "utf8"));
		void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
	}

	async exportHtml(): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		const target = vscode.Uri.file(path.join(this.workspaceRoot, `prime-agent-session-${Date.now()}.html`));
		const picked = await vscode.window.showSaveDialog({ defaultUri: target, filters: { HTML: ["html"] } });
		if (!picked) return;
		const response = await this.client.request({ type: "export_html", outputPath: picked.fsPath }, 60_000);
		if (response.success) {
			void vscode.window.showInformationMessage(`Chat exported to ${picked.fsPath}`);
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Export failed: ${response.error ?? "unknown error"}` });
		}
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		if (!this.client?.running) return;
		const response = await this.client.request({ type: "set_model", provider, modelId });
		if (response.success) {
			await this.refreshStateAndStats();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `set_model failed: ${response.error ?? "unknown error"}` });
		}
	}

	async setThinkingLevel(level: string): Promise<void> {
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
			const data = response.data as { models?: Array<{ provider: string; id: string; name?: string }> };
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
		if (sessionId === this.state?.sessionId) {
			this.broadcast({ type: "notice", level: "warning", text: "You can't delete the session you're in. Start a new one first." });
			return;
		}
		if (isSessionActive(sessionPath)) {
			this.broadcast({ type: "notice", level: "warning", text: "That session is still live in another client. Close it there first." });
			return;
		}
		const result = await deleteSession(sessionPath);
		if (result.ok) {
			const method = result.method === "trash" ? "moved to Trash" : "deleted";
			this.broadcast({ type: "notice", level: "info", text: `Session ${method} (artifacts removed).` });
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

	async listHistory(): Promise<void> {
		const sessions = await listRecentSessions(this.workspaceRoot, 25);
		this.broadcast({ type: "history", sessions });
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
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
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
			this.changedFiles.clear();
			this.clearThreadDiffs();
			this.broadcast({ type: "sessionChildren", children: [] });
			await this.refreshSnapshot();
			void this.scheduleChildrenRefresh();
			return;
		}
		const error = response.error ?? "unknown error";
		if (/already active/i.test(error)) {
			const id = sessionId ?? path.basename(sessionPath, ".jsonl");
			const attached = await this.attachViaDaemon(id, sessionPath);
			if (attached) {
				this.broadcast({ type: "notice", level: "info", text: "Attached to the live session — you can work here and in the terminal simultaneously." });
				return;
			}
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
			this.sidecar.onClose = () => {
				if (this.attached) {
					this.attached = null;
					this.broadcast({ type: "notice", level: "warning", text: "Lost the daemon connection — detached from the live session." });
					this.pushStatus();
				}
			};
		}
		if (!this.sidecar.connected) {
			await this.sidecar.connect();
		}
		return this.sidecar;
	}

	/**
	 * Attach to a session that is already live somewhere else (a terminal).
	 * The daemon brokers it; both clients see the same stream, both can prompt.
	 */
	private async attachViaDaemon(activeSessionId: string, sessionPath: string): Promise<boolean> {
		// Clear the subagent strip immediately — a different session owns nothing from the last view.
		this.broadcast({ type: "sessionChildren", children: [] });
		try {
			const sidecar = await this.ensureSidecar();
			const result = await sidecar.attach(activeSessionId);
			this.attached = { activeSessionId, sessionPath };
			const snapshot = result.snapshot;
			if (snapshot?.messages) {
				this.cachedMessages = snapshot.messages as AgentMessage[];
			} else {
				try {
					this.cachedMessages = (await sidecar.getMessages(activeSessionId)) as AgentMessage[];
				} catch {
					this.cachedMessages = [];
				}
			}
			this.rentedState = (snapshot?.state ?? null) as RpcSessionState | null;
			void this.refreshChildren();
			this.changedFiles.clear();
			this.clearThreadDiffs();
			this.broadcast({
				type: "snapshot",
				messages: this.cachedMessages,
				state: this.rentedState,
				status: this.buildStatus(),
				steerDefault: vscode.workspace.getConfiguration("primeAgent").get<"steer" | "followUp">("defaultStreamingBehavior", "steer"),
			});
			this.pushStatus();
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
		this.rentedState = null;
	}

	/** Connect the sidecar lazily and refresh children; fire-and-forget. */
	private async scheduleChildrenRefresh(): Promise<void> {
		try {
			await this.ensureSidecar();
			await this.refreshChildren();
		} catch {
			// daemon unavailable — panel stays empty
		}
	}

	/** Refresh and broadcast the children (subagents) of the CURRENT session. */
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
			const children = sessions.filter((s) => {
				const kind = (s as SessionSummaryRef & { runtimeKind?: string }).runtimeKind;
				if (!kind || kind === "root") return false;
				if (this.attached) {
					return (
						(s.parentActiveSessionId && s.parentActiveSessionId === parentActive) ||
						((s as SessionSummaryRef & { parentSessionId?: string }).parentSessionId === parentActive)
					);
				}
				const byParent = (s as SessionSummaryRef & { parentSessionId?: string }).parentSessionId;
				return parentUuid != null && byParent === parentUuid;
			});
			this.broadcast({
				type: "sessionChildren",
				children: children.map((c) => ({
					id: c.id ?? "",
					activeSessionId: c.activeSessionId ?? c.id ?? "",
					name: c.sessionName,
					runtimeKind: (c as SessionSummaryRef & { runtimeKind?: string }).runtimeKind,
					rlmDepth: (c as SessionSummaryRef & { rlmDepth?: number }).rlmDepth,
					isStreaming: (c as SessionSummaryRef & { isStreaming?: boolean }).isStreaming ?? false,
					attachedClients: c.attachedClients ?? 0,
				})),
			});
		} catch {
			// quiet — stale layout tolerated until the next refresh
		}
	}

	/** Browse into a subagent (or any resident session): attach via the daemon. */
	async browseChild(activeSessionId: string): Promise<boolean> {
		// remember where to go back to
		if (this.attached) {
			this.returnTarget = { kind: "attached", ...this.attached };
			const previous = this.attached.activeSessionId;
			this.attached = null;
			if (this.sidecar?.connected) await this.sidecar.detach(previous);
		} else {
			this.returnTarget = { kind: "rpc" };
		}
		const attached = await this.attachViaDaemon(activeSessionId, "");
		if (!attached) {
			this.broadcast({ type: "notice", level: "error", text: "Could not attach to that subagent session (it may be gone)." });
			return false;
		}
		void this.refreshChildren();
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
			await this.attachViaDaemon(id, path);
			return;
		}
		// baseline: own RPC session
		await this.detachFromDaemon();
		await this.refreshSnapshot();
		this.pushStatus();
	}

	/** Route daemon events for the attached session into the normal pipeline. */
	private onDaemonEvent(message: DaemonServerMessage): void {
		const attached = this.attached;
		if (!attached) return;
		const msgSessionId = message.activeSessionId;
		if (message.type === "session_event" && msgSessionId === attached.activeSessionId && message.event) {
			this.onAgentEvent(message.event as AgentEvent);
			return;
		}
		if (message.type === "session_status" && msgSessionId === attached.activeSessionId) {
			void this.refreshAttachedState();
			return;
		}
		if (message.type === "session_replaced" && msgSessionId === attached.activeSessionId) {
			void this.refreshAttachedState();
			this.pushStatus();
			return;
		}
		if (message.type === "session_closed" && msgSessionId === attached.activeSessionId) {
			this.broadcast({ type: "notice", level: "warning", text: "The live session was closed by its other client." });
			this.attached = null;
			this.rentedState = null;
			this.pushStatus();
		}
	}

	private async refreshAttachedState(): Promise<void> {
		const attached = this.attached;
		if (!attached || !this.sidecar?.connected) return;
		try {
			this.rentedState = (await this.sidecar.getState(attached.activeSessionId)) as RpcSessionState;
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
		await this.refreshSnapshot();
		this.pushStatus();
	}

	// ------------------------------------------------------------------
	// Snapshot / status
	// ------------------------------------------------------------------

	async refreshSnapshot(): Promise<void> {
		if (!this.client?.running) return;
		try {
			const [messagesRes, stateRes] = await Promise.all([
				this.client.request({ type: "get_messages" }, 60_000),
				this.client.request({ type: "get_state" }, 30_000),
			]);
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
		this.broadcastThreadDiffs();
		this.pushStatus();
	}

	private async refreshStateAndStats(): Promise<void> {
		if (!this.client?.running) return;
		try {
			const stateRes = await this.client.request({ type: "get_state" }, 30_000);
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
			this.maybeTriggerAutoCompact(data.contextUsage?.percent ?? null);
			return parts.join(" · ");
		} catch {
			return "";
		}
	}

	private lastUsage: { usageTotal?: number; costUsd?: number; contextTokens?: number | null; contextWindow?: number; contextPercent?: number | null } = {};

	private buildStatus(statsText = this.lastStatsText): StatusSnapshot {
		if (this.attached) {
			const st = this.rentedState as (RpcSessionState & { model?: RpcSessionState["model"] }) | null;
			const model = st?.model ?? null;
			const label = model ? `${model.provider}/${model.id}` : "attached session";
			return {
				connected: true,
				streaming: this.streaming,
				compacting: this.compacting,
				retrying: this.retrying,
				restoring: false,
				modelLabel: label,
				thinkingLevel: st?.thinkingLevel ?? "off",
				sessionName: st?.sessionName,
				sessionFile: this.attached.sessionPath,
				sessionId: this.attached.activeSessionId,
				statsText,
				statusText: "attached (shared with terminal)",
				observingId: this.observingId,
				...this.lastUsage,
			};
		}
		const model = this.state?.model;
		const modelLabel = model ? `${model.provider}/${model.id}` : "no model";
		return {
			connected: this.client?.running ?? false,
			streaming: this.streaming || (this.state?.isStreaming ?? false),
			compacting: this.compacting || (this.state?.isCompacting ?? false),
			retrying: this.retrying,
			restoring: this.startingPromise !== null,
			modelLabel,
			thinkingLevel: this.state?.thinkingLevel ?? "off",
			sessionName: this.state?.sessionName,
			sessionFile: this.state?.sessionFile,
			sessionId: this.state?.sessionId,
			statsText,
			statusText: this.extensionStatusText,
			modelProvider: model?.provider,
			modelId: model?.id,
			observingId: this.observingId,
			compactThresholdPercent: this.compactThreshold(),
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
			if (this.statsFetching || !this.client?.running) {
				this.pushStatusLight();
				return;
			}
			this.statsFetching = true;
			void this.fetchStatsText()
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
			const files = uris
				.map((uri) => vscode.workspace.asRelativePath(uri, false))
				.sort((a, b) => a.localeCompare(b));
			this.broadcast({ type: "fileSearchResults", requestId, files });
		} catch {
			this.broadcast({ type: "fileSearchResults", requestId, files: [] });
		}
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
		const uri = this.resolveWorkspaceUri(relPath);
		if (!uri) return;
		try {
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
	// Per-thread diff panel: cumulative edit/write/bash tool-call tracking.
	// State lives host-side so a reloaded webview rebuilds from the push that
	// follows every snapshot.
	// ------------------------------------------------------------------

	private threadDiffFiles = new Map<string, ThreadDiffAccum>();
	/** Staged tool_execution_start payloads keyed by toolCallId until the end event. */
	private threadDiffPendings = new Map<string, ThreadDiffPending>();
	private threadDiffsTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Stage tool-call changes at execution start and commit them at execution
	 * end (dropped when the tool errors). Called from onAgentEvent alongside
	 * trackChangedFilesDone.
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
			if (!pending || event.isError) return;
			this.commitThreadDiff(pending);
		}
	}

	/** Normalize one edit/write/bash tool call into staged pending state. */
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
		if (name === "bash") {
			const command = typeof args.command === "string" ? args.command.trim() : "";
			if (!command) return null;
			return { path: "", source: "shell", hunks: [], command };
		}
		return null;
	}

	/** Merge a staged tool call into the cumulative per-thread state. */
	private commitThreadDiff(pending: ThreadDiffPending): void {
		if (pending.source === "shell") {
			const command = pending.command ?? "";
			if (!command) return;
			const displayCommand =
				command.length > THREAD_DIFF_SHELL_CMD_DISPLAY ? `${command.slice(0, THREAD_DIFF_SHELL_CMD_DISPLAY)}…` : command;
			for (const display of extractShellReferencedPaths(command, this.workspaceRoot)) {
				const accum = this.ensureThreadDiffFile(display);
				if (!accum) continue;
				if (!accum.shellHints.includes(displayCommand)) {
					if (accum.shellHints.length >= THREAD_DIFF_MAX_SHELL_HINTS) accum.shellHints.shift();
					accum.shellHints.push(displayCommand);
				}
				// Bash never overrides the content source of a file with hunks.
				if (accum.hunks.length === 0) accum.source = "shell";
			}
			this.queueThreadDiffsBroadcast();
			return;
		}
		const accum = this.ensureThreadDiffFile(pending.path);
		if (!accum) return;
		accum.source = pending.source;
		for (const hunk of pending.hunks) {
			if (accum.hunks.length >= THREAD_DIFF_MAX_HUNKS_PER_FILE) accum.hunks.shift();
			accum.hunks.push(hunk);
		}
		this.queueThreadDiffsBroadcast();
	}

	private ensureThreadDiffFile(path: string): ThreadDiffAccum | null {
		const existing = this.threadDiffFiles.get(path);
		if (existing) return existing;
		if (this.threadDiffFiles.size >= THREAD_DIFF_MAX_FILES) return null;
		const accum: ThreadDiffAccum = { source: "shell", hunks: [], shellHints: [] };
		this.threadDiffFiles.set(path, accum);
		return accum;
	}

	/**
	 * Push the cumulative per-thread diff state to all attached webviews.
	 * Called after snapshots so a reloaded panel rebuilds from host state.
	 */
	broadcastThreadDiffs(): void {
		this.postThreadDiffs();
	}

	/** Reset per-thread diff state (new session / switch / attach / agent exit). */
	private clearThreadDiffs(): void {
		if (this.threadDiffsTimer) {
			clearTimeout(this.threadDiffsTimer);
			this.threadDiffsTimer = null;
		}
		const had = this.threadDiffFiles.size > 0;
		this.threadDiffFiles.clear();
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
		const files: ThreadDiffFile[] = [];
		for (const [path, accum] of this.threadDiffFiles) {
			files.push({
				path,
				viaSource: accum.source,
				hunks: accum.hunks.map((hunk) => ({
					removed: [...hunk.removed],
					added: [...hunk.added],
					...(hunk.note ? { note: hunk.note } : {}),
				})),
				...(accum.shellHints.length > 0 ? { shellHints: [...accum.shellHints] } : {}),
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

import { existsSync, statSync } from "node:fs";
import type { ThreadDiffFile, ThreadDiffHunk, ThreadDiffSource, ThreadDiffsMessage } from "./protocol.js";

// ---------------------------------------------------------------------------
// Per-thread diff accumulation helpers (module scope; host-only state lives
// on SessionController above).
// ---------------------------------------------------------------------------

const THREAD_DIFF_MAX_FILES = 200;
const THREAD_DIFF_MAX_HUNKS_PER_FILE = 60;
const THREAD_DIFF_SIDE_CAP = 400;
const THREAD_DIFF_WRITE_CAP = 240;
const THREAD_DIFF_MAX_SHELL_HINTS = 5;
const THREAD_DIFF_MAX_SHELL_PATHS = 8;
const THREAD_DIFF_SHELL_CMD_DISPLAY = 160;
const THREAD_DIFF_MAX_PENDING = 200;

/** Per-file accumulated state (append-ordered, chronologically). */
interface ThreadDiffAccum {
	source: ThreadDiffSource;
	hunks: ThreadDiffHunk[];
	shellHints: string[];
}

/** Staged data from tool_execution_start, committed on a non-error end event. */
interface ThreadDiffPending {
	path: string;
	source: ThreadDiffSource;
	hunks: ThreadDiffHunk[];
	command?: string;
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

/**
 * Existing-file heuristic for bash tool calls: a shell command carries no
 * content, so a path is surfaced only when a command token plainly references
 * an existing file inside (or outside, shown absolute) the workspace.
 */
function extractShellReferencedPaths(command: string, workspaceRoot: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	for (const rawToken of command.split(/\s+/)) {
		if (found.length >= THREAD_DIFF_MAX_SHELL_PATHS) break;
		let token = rawToken.trim().replace(/^['"“”‘’`]+|['"“”‘’`]+$/g, "");
		if (!token || token.length > 300 || token.startsWith("-")) continue;
		const eqIndex = token.indexOf("=");
		if (eqIndex > 0) token = token.slice(eqIndex + 1);
		token = token.replace(/[;,|&<>()]+$/g, "");
		if (!token || token.includes("://") || !/[./\\]/.test(token)) continue;
		const absolute = path.isAbsolute(token) ? token : path.resolve(workspaceRoot, token);
		if (seen.has(absolute)) continue;
		let isFile = false;
		try {
			isFile = existsSync(absolute) && statSync(absolute).isFile();
		} catch {
			isFile = false;
		}
		if (!isFile) continue;
		seen.add(absolute);
		const display = normalizeToolPath(absolute, workspaceRoot) ?? absolute;
		if (isThreadDiffPathWorthy(display)) found.push(display);
	}
	return found;
}
