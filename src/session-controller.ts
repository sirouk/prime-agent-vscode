/**
 * SessionController owns the Prime Agent RPC subprocess for this VS Code window,
 * routes events to all attached chat webviews, and answers extension UI requests
 * using native VS Code dialogs.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type {
	AgentEvent,
	AgentMessage,
	HostToWebview,
	ImageAttachment,
	PromptPayload,
	RecentSession,
	RpcExtensionUIRequest,
	RpcSessionState,
	RpcSlashCommand,
	StatusSnapshot,
} from "./protocol.js";
import { listRecentSessions } from "./recent-sessions.js";
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
	private startingPromise: Promise<void> | null = null;
	private intentionalStop = false;

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
		for (const sink of this.sinks) {
			sink.post(message);
		}
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

		this.output.appendLine(`[prime-agent] starting: ${command} --mode rpc ${args.join(" ")}`);
		const client = new RpcClient({ command, args, cwd: this.workspaceRoot });
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
		} else if (type === "observed_session_event" || type === "observed_session_closed") {
			// Not used by the chat UI.
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
		await this.ensureStarted();
		if (!this.client) throw new Error("agent unavailable");

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

		const response = await this.client.request(command);
		if (response.success) {
			this.broadcast({ type: "promptAccepted", kind });
		} else {
			this.broadcast({ type: "promptRejected", error: response.error ?? "prompt rejected" });
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
		const response = await this.client.request({ type: "new_session" });
		if (response.success) {
			this.changedFiles.clear();
			this.cachedMessages = [];
			await this.refreshSnapshot();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `New session failed: ${response.error ?? "unknown error"}` });
		}
	}

	async compact(instructions?: string): Promise<void> {
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

	async switchSession(sessionPath: string): Promise<void> {
		await this.ensureStarted();
		if (!this.client) return;
		const response = await this.client.request({ type: "switch_session", sessionPath }, 60_000);
		if (response.success) {
			this.changedFiles.clear();
			await this.refreshSnapshot();
		} else {
			this.broadcast({ type: "notice", level: "error", text: `Could not resume session: ${response.error ?? "unknown error"}` });
		}
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
			this.broadcast({
				type: "snapshot",
				messages: this.cachedMessages,
				state: this.state,
				status: this.buildStatus(stats),
			});
		} catch (err) {
			this.output.appendLine(`[prime-agent] snapshot failed: ${String(err)}`);
		}
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
			return parts.join(" · ");
		} catch {
			return "";
		}
	}

	private lastUsage: { usageTotal?: number; costUsd?: number; contextTokens?: number | null; contextWindow?: number; contextPercent?: number | null } = {};

	private buildStatus(statsText = this.lastStatsText): StatusSnapshot {
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
