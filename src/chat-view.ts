/**
 * Chat webview wiring: a sidebar WebviewView plus an editor-tab WebviewPanel that
 * both attach to the shared SessionController.
 */

import * as vscode from "vscode";

declare const PRIME_AGENT_BUILD_REV: string | undefined;
const WEBVIEW_REV = typeof PRIME_AGENT_BUILD_REV === "string" ? PRIME_AGENT_BUILD_REV : "dev";
import type { HostToWebview, ImageAttachment, PromptPayload, SelectionAttachment, WebviewToHost } from "./protocol.js";
import type { SessionController } from "./session-controller.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "primeAgent.chat";
	private view: vscode.WebviewView | null = null;
	private sinkAttachment: vscode.Disposable | null = null;
	private readonly dynamicSink: { post: (message: HostToWebview) => void };

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: SessionController,
	) {
		// VS Code silently replaces the inner webview object when the panel is
		// re-shown/reloaded; posting through a stale webview object disappears
		// into the void while returning true. Always post through the CURRENT one.
		this.dynamicSink = {
			post: (message: HostToWebview) => {
				const webview = this.view?.webview;
				if (webview) void webview.postMessage(message);
			},
		};
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		// VS Code silently replaces the inner webview object when the panel is
		// hidden/re-shown/reloaded (activity-bar toggles, window restore, Developer:
		// Reload Webviews). Every time it becomes visible again we must re-wire onto
		// the CURRENT webview object: reset html + re-register the receiver. Otherwise
		// webview->host messages silently stop, mirroring the outbound stale-object
		// failure that the dynamic sink fixes.
		this.wire();
		view.onDidChangeVisibility(() => {
			if (view.visible) this.wire();
		}, null, this.viewDisposables);
	}

	private wire(): void {
		const view = this.view;
		if (!view) return;
		// Targeted responses (file searches, native pickers, optimistic verdicts)
		// belong to the document that sent the request. Broadcasting is still
		// dynamic, but a reply must not jump into a reloaded sidebar document.
		const recipient = view.webview;
		const reply = (message: HostToWebview): void => {
			const done = recipient.postMessage(message);
			if (typeof (done as Promise<boolean>).then === "function") {
				void (done as Promise<boolean>).then((ok) => {
					if (!ok) this.controller.debugPostFailure(message);
				});
			}
		};
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
		};
		// Assign the document only when the webview has none. buildHtml() mints a
		// fresh nonce every call, so re-assigning on every activity-bar toggle is
		// always a different string and always reloads the webview — replaying the
		// connecting splash and blanking the transcript, the composer and the
		// operator's draft each time. Reading the property back also self-corrects
		// if VS Code ever hands us a replaced, empty webview object.
		if (!view.webview.html) {
			view.webview.html = buildHtml(view.webview, this.extensionUri);
		}
		for (const d of this.receiveDisposables.splice(0)) d.dispose();
		recipient.onDidReceiveMessage(
		(message: unknown) => {
			dispatchMessage(message, this.controller, reply);
			},
			undefined,
			this.receiveDisposables,
		);
		if (!this.sinkAttachment) {
			this.sinkAttachment = this.controller.attach(this.dynamicSink);
		}
	}

	private viewDisposables: vscode.Disposable[] = [];
	private receiveDisposables: vscode.Disposable[] = [];

	reveal(): void {
		this.view?.show?.(true);
	}

	focusComposer(): void {
		this.view?.webview.postMessage({ type: "focusComposer" } satisfies HostToWebview);
	}

	post(message: HostToWebview): void {
		this.view?.webview.postMessage(message);
	}

	dispose(): void {
		for (const d of this.viewDisposables.splice(0)) d.dispose();
		for (const d of this.receiveDisposables.splice(0)) d.dispose();
		this.sinkAttachment?.dispose();
		this.sinkAttachment = null;
	}
}

export class ChatPanel {
	private static current: ChatPanel | null = null;
	private readonly panel: vscode.WebviewPanel;

	static createOrShow(extensionUri: vscode.Uri, controller: SessionController): ChatPanel {
		if (ChatPanel.current) {
			ChatPanel.current.panel.reveal(vscode.ViewColumn.Active);
			return ChatPanel.current;
		}
		const panel = vscode.window.createWebviewPanel("primeAgent.chatPanel", "Prime Agent", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
		});
		ChatPanel.current = new ChatPanel(panel, extensionUri, controller);
		return ChatPanel.current;
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, controller: SessionController) {
		this.panel = panel;
		panel.webview.html = buildHtml(panel.webview, extensionUri);
		const wiring = wireWebview(panel.webview, controller);
		panel.onDidDispose(() => {
			wiring.dispose();
			if (ChatPanel.current === this) ChatPanel.current = null;
		});
	}
}

function wireWebview(webview: vscode.Webview, controller: SessionController): vscode.Disposable {
	const sink = {
		post: (message: HostToWebview) => {
			const done = webview.postMessage(message);
			if (typeof (done as Promise<boolean>).then === "function") {
				void (done as Promise<boolean>).then((ok) => {
					if (!ok) controller.debugPostFailure(message);
				});
			}
		},
	};
	const attachment = controller.attach(sink);
	const receiver = webview.onDidReceiveMessage(
		(message: unknown) => {
			const marker = process.env.PRIME_AGENT_VSCODE_LOG;
			if (marker) {
				try {
					require("node:fs").appendFileSync(marker, `recv ${(message as { type?: string }).type}\n`);
				} catch {
					// ignore
				}
			}
			dispatchMessage(message, controller, sink.post);
		},
		undefined,
		[],
	);
	return new vscode.Disposable(() => {
		receiver.dispose();
		attachment.dispose();
	});
}

const MAX_PROMPT_TEXT_CHARS = 200_000;
// Keep this transport envelope aligned with the image picker and composer.
const MAX_PROMPT_IMAGES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DATA_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_SELECTIONS = 16;
const MAX_SELECTION_TEXT_CHARS = 100_000;
const MAX_TOTAL_SELECTION_TEXT_CHARS = 500_000;
const MAX_PATH_CHARS = 4_096;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_QUERY_CHARS = 4_096;
const MAX_DRAFT_CHARS = 200_000;
const MAX_COMPACT_INSTRUCTIONS_CHARS = 20_000;
const MAX_LINE_NUMBER = 10_000_000;
const MAX_FORK_ORDINAL = 1_000_000;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
	return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.length > 0) && !value.includes("\0");
}

function isIdentifier(value: unknown): value is string {
	return isBoundedString(value, MAX_IDENTIFIER_CHARS) && IDENTIFIER.test(value);
}

function isPath(value: unknown): value is string {
	return isBoundedString(value, MAX_PATH_CHARS);
}

function isRequestId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLineNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINE_NUMBER;
}

function isBase64(value: string): boolean {
	return value.length > 0 && value.length % 4 === 0 && BASE64.test(value);
}

function base64ByteLength(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function parsePromptPayload(value: unknown): PromptPayload | undefined {
	if (!isRecord(value)) return undefined;
	if (!isBoundedString(value.text, MAX_PROMPT_TEXT_CHARS, true)) return undefined;
	if (value.streamingBehavior !== "steer" && value.streamingBehavior !== "followUp") return undefined;
	if (!Array.isArray(value.images) || value.images.length > MAX_PROMPT_IMAGES) return undefined;
	if (!Array.isArray(value.selections) || value.selections.length > MAX_SELECTIONS) return undefined;

	const images: ImageAttachment[] = [];
	let totalImageBytes = 0;
	for (const image of value.images) {
		if (!isRecord(image)) return undefined;
		if (!isBoundedString(image.data, MAX_IMAGE_DATA_CHARS) || !isBase64(image.data)) return undefined;
		if (typeof image.mimeType !== "string" || !IMAGE_MIME_TYPES.has(image.mimeType)) return undefined;
		if (image.name !== undefined && !isBoundedString(image.name, MAX_NAME_CHARS)) return undefined;
		const imageBytes = base64ByteLength(image.data);
		if (imageBytes > MAX_IMAGE_BYTES) return undefined;
		totalImageBytes += imageBytes;
		if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) return undefined;
		images.push(image.name === undefined
			? { data: image.data, mimeType: image.mimeType }
			: { data: image.data, mimeType: image.mimeType, name: image.name });
	}

	const selections: SelectionAttachment[] = [];
	let totalSelectionTextChars = 0;
	for (const selection of value.selections) {
		if (!isRecord(selection)) return undefined;
		if (!isPath(selection.path) || !isLineNumber(selection.startLine) || !isLineNumber(selection.endLine)) return undefined;
		if (selection.endLine < selection.startLine) return undefined;
		if (!isBoundedString(selection.text, MAX_SELECTION_TEXT_CHARS, true)) return undefined;
		if (!isBoundedString(selection.languageId, MAX_IDENTIFIER_CHARS)) return undefined;
		totalSelectionTextChars += selection.text.length;
		if (totalSelectionTextChars > MAX_TOTAL_SELECTION_TEXT_CHARS) return undefined;
		selections.push({
			path: selection.path,
			startLine: selection.startLine,
			endLine: selection.endLine,
			text: selection.text,
			languageId: selection.languageId,
		});
	}

	if (value.text.length === 0 && images.length === 0 && selections.length === 0) return undefined;
	if (value.clientRequestId !== undefined && !isIdentifier(value.clientRequestId)) return undefined;
	return {
		text: value.text,
		images,
		selections,
		streamingBehavior: value.streamingBehavior,
		...(value.clientRequestId === undefined ? {} : { clientRequestId: value.clientRequestId }),
	};
}

/**
 * Parse the untrusted webview transport payload into a fresh, bounded protocol
 * object. This is intentionally stricter than TypeScript's compile-time union:
 * webview postMessage data can be supplied by a compromised page at runtime.
 */
export function parseWebviewMessage(value: unknown): WebviewToHost | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;

	switch (value.type) {
		case "ready":
		case "abort":
		case "newSession":
		case "exportHtml":
		case "exportChat":
		case "restart":
		case "requestState":
		case "requestModels":
		case "requestCommands":
		case "requestHistory":
		case "stopObserving":
		case "backToParent":
		case "copyConversation":
		case "dismissInstallPrompt":
		case "attachActiveFile":
		case "attachSelection":
		case "pickModel":
		case "pickThinkingLevel":
			return { type: value.type };
		case "prompt": {
			const payload = parsePromptPayload(value.payload);
			return payload ? { type: "prompt", payload } : undefined;
		}
		case "compact":
			if (value.instructions !== undefined && !isBoundedString(value.instructions, MAX_COMPACT_INSTRUCTIONS_CHARS, true)) return undefined;
			return value.instructions === undefined ? { type: "compact" } : { type: "compact", instructions: value.instructions };
		case "forkFromUser":
			return isRequestId(value.ordinal) && value.ordinal <= MAX_FORK_ORDINAL ? { type: "forkFromUser", ordinal: value.ordinal } : undefined;
		case "browseChild":
			return isIdentifier(value.browseRef) ? { type: "browseChild", browseRef: value.browseRef } : undefined;
		case "renameSession":
			return isBoundedString(value.name, MAX_NAME_CHARS, true) ? { type: "renameSession", name: value.name } : undefined;
		case "renameHistorySession":
			return isPath(value.path) && isIdentifier(value.sessionId) && isBoundedString(value.name, MAX_NAME_CHARS, true)
				? { type: "renameHistorySession", path: value.path, sessionId: value.sessionId, name: value.name }
				: undefined;
		case "stopSession":
			return isPath(value.path) && isIdentifier(value.sessionId)
				? { type: "stopSession", path: value.path, sessionId: value.sessionId }
				: undefined;
		case "archiveSession":
			return isPath(value.path) && isIdentifier(value.sessionId)
				? { type: "archiveSession", path: value.path, sessionId: value.sessionId }
				: undefined;
		case "deleteSession":
			return isPath(value.path) && isIdentifier(value.sessionId)
				? { type: "deleteSession", path: value.path, sessionId: value.sessionId }
				: undefined;
		case "draftChanged":
			return isBoundedString(value.text, MAX_DRAFT_CHARS, true) && isIdentifier(value.sessionId)
				? { type: "draftChanged", text: value.text, sessionId: value.sessionId }
				: undefined;
		case "setCompactThreshold":
			return value.percent === null || (isLineNumber(value.percent) && value.percent >= 20 && value.percent <= 97)
				? { type: "setCompactThreshold", percent: value.percent }
				: undefined;
		case "searchHistory":
			return isBoundedString(value.query, MAX_QUERY_CHARS, true) ? { type: "searchHistory", query: value.query } : undefined;
		case "setModel":
			return isBoundedString(value.provider, MAX_IDENTIFIER_CHARS) && isBoundedString(value.modelId, MAX_IDENTIFIER_CHARS)
				? { type: "setModel", provider: value.provider, modelId: value.modelId }
				: undefined;
		case "setThinkingLevel":
			return isBoundedString(value.level, MAX_IDENTIFIER_CHARS) ? { type: "setThinkingLevel", level: value.level } : undefined;
		case "switchSession":
			return isPath(value.path) && isIdentifier(value.sessionId)
				? { type: "switchSession", path: value.path, sessionId: value.sessionId }
				: undefined;
		case "searchFiles":
			return isBoundedString(value.query, MAX_QUERY_CHARS, true) && isRequestId(value.requestId)
				? { type: "searchFiles", query: value.query, requestId: value.requestId }
				: undefined;
		case "openFile": {
			if (!isPath(value.path)) return undefined;
			if (value.startLine !== undefined && !isLineNumber(value.startLine)) return undefined;
			if (value.endLine !== undefined && !isLineNumber(value.endLine)) return undefined;
			if (value.endLine !== undefined && (value.startLine === undefined || value.endLine < value.startLine)) return undefined;
			return {
				type: "openFile",
				path: value.path,
				...(value.startLine === undefined ? {} : { startLine: value.startLine }),
				...(value.endLine === undefined ? {} : { endLine: value.endLine }),
			};
		}
		case "openDiff":
			return isPath(value.path) ? { type: "openDiff", path: value.path } : undefined;
		case "pickImage":
			return isRequestId(value.requestId) ? { type: "pickImage", requestId: value.requestId } : undefined;
		case "toggleFavoriteModel":
			return isBoundedString(value.provider, MAX_IDENTIFIER_CHARS) && isBoundedString(value.modelId, MAX_IDENTIFIER_CHARS)
				? { type: "toggleFavoriteModel", provider: value.provider, modelId: value.modelId }
				: undefined;
		case "openExternal":
			return isBoundedString(value.url, MAX_PATH_CHARS) ? { type: "openExternal", url: value.url } : undefined;
		default:
			return undefined;
	}
}

function dispatchMessage(message: unknown, controller: SessionController, reply: (message: HostToWebview) => void): void {
	const parsed = parseWebviewMessage(message);
	if (!parsed) {
		controller.showErrorNotice("Ignored an invalid webview message.");
		return;
	}
	void handleMessage(parsed, controller, reply).catch((err) => {
		controller.showErrorNotice(`Operation failed: ${err instanceof Error ? err.message : String(err)}`);
	});
}

async function handleMessage(message: WebviewToHost, controller: SessionController, reply: (message: HostToWebview) => void): Promise<void> {
	switch (message.type) {
		case "ready":
			await controller.ensureStarted();
			await controller.refreshSnapshot();
			await controller.listModels();
			await controller.listCommands();
			controller.sendFavorites();
			return;
		case "prompt":
			try {
				await controller.prompt(message.payload, reply);
			} catch (err) {
				controller.showErrorNotice(`Prompt failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		case "abort":
			await controller.abort();
			return;
		case "newSession":
			await controller.newSession();
			return;
		case "compact":
			await controller.compact(message.instructions);
			return;
		case "exportHtml":
			await controller.exportHtml();
			return;
		case "exportChat":
			await controller.exportChat();
			return;
		case "forkFromUser":
			await controller.forkFromUser(message.ordinal);
			return;
		case "browseChild":
			await controller.browseChild(message.browseRef);
			return;
		case "renameSession":
			await controller.renameSession(message.name);
			return;
		case "renameHistorySession":
			await controller.renameHistorySession(message.path, message.sessionId, message.name);
			return;
		case "stopSession":
			await controller.stopSession(message.path, message.sessionId);
			return;
		case "archiveSession":
			await controller.archiveSession(message.path, message.sessionId);
			return;
		case "backToParent":
			await controller.backToParent();
			return;
		case "copyConversation":
			await controller.copyConversation();
			return;
		case "dismissInstallPrompt":
			await controller.dismissInstallPrompt();
			return;
		case "draftChanged":
			controller.persistDraft(message.text, message.sessionId);
			return;
		case "setCompactThreshold":
			controller.setCompactThreshold(message.percent);
			return;
		case "restart":
			await controller.restart();
			await controller.refreshSnapshot();
			return;
		case "requestState":
			await controller.refreshSnapshot();
			return;
		case "requestModels":
			await controller.listModels();
			return;
		case "requestCommands":
			await controller.listCommands();
			return;
		case "requestHistory":
			await controller.listHistory();
			return;
		case "searchHistory":
			await controller.searchHistory(message.query);
			return;
		case "setModel":
			await controller.setModel(message.provider, message.modelId);
			return;
		case "setThinkingLevel":
			await controller.setThinkingLevel(message.level);
			return;
		case "switchSession":
			await controller.switchSession(message.path, message.sessionId);
			return;
		case "stopObserving":
			await controller.stopObserving();
			return;
		case "deleteSession":
			await controller.deleteSessionByPath(message.path, message.sessionId);
			return;
		case "searchFiles":
			await controller.searchFiles(message.query, message.requestId, reply);
			return;
		case "openFile":
			await controller.openFile(message.path, message.startLine, message.endLine);
			return;
		case "openDiff":
			await controller.openDiff(message.path);
			return;
		case "pickImage":
			await controller.pickImages(message.requestId, reply);
			return;
		case "attachActiveFile": {
			const file = controller.getActiveFilePath();
			if (file) reply({ type: "insertMention", path: file });
			return;
		}
		case "attachSelection": {
			const selection = controller.getActiveSelection();
			if (selection) reply({ type: "insertSelection", selection });
			return;
		}
		case "pickModel":
			await controller.pickModelQuickPick();
			return;
		case "pickThinkingLevel":
			await controller.pickThinkingQuickPick();
			return;
		case "toggleFavoriteModel":
			await controller.toggleFavoriteModel(message.provider, message.modelId);
			return;
		case "openExternal":
			try {
				const uri = vscode.Uri.parse(message.url);
				if (uri.scheme !== "https" && uri.scheme !== "mailto") throw new Error("unsupported link scheme");
				await vscode.env.openExternal(uri);
			} catch {
				controller.showErrorNotice("Blocked an unsupported external link.");
			}
			return;
	}
}

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.js"));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "main.css"));
	const nonce = getNonce();
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${styleUri}?v=${WEBVIEW_REV}" rel="stylesheet" />
	<title>Prime Agent</title>
</head>
<body>
	<div id="app"></div>
	<script nonce="${nonce}" src="${scriptUri}?v=${WEBVIEW_REV}"></script>
</body>
</html>`;
}

function getNonce(): string {
	let text = "";
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
