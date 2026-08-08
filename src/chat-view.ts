/**
 * Chat webview wiring: a sidebar WebviewView plus an editor-tab WebviewPanel that
 * both attach to the shared SessionController.
 */

import * as vscode from "vscode";

declare const PRIME_AGENT_BUILD_REV: string | undefined;
const WEBVIEW_REV = typeof PRIME_AGENT_BUILD_REV === "string" ? PRIME_AGENT_BUILD_REV : "dev";
import type { HostToWebview, WebviewToHost } from "./protocol.js";
import type { SessionController } from "./session-controller.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "primeAgent.chat";
	private view: vscode.WebviewView | null = null;
	private sinkAttached = false;
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
		view.webview.onDidReceiveMessage(
			(message: WebviewToHost) => {
				void handleMessage(message, this.controller);
			},
			undefined,
			this.receiveDisposables,
		);
		if (!this.sinkAttached) {
			this.sinkAttached = true;
			void this.controller.attach(this.dynamicSink);
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
		wireWebview(panel.webview, controller);
		panel.onDidDispose(() => {
			if (ChatPanel.current === this) ChatPanel.current = null;
		});
	}
}

function wireWebview(webview: vscode.Webview, controller: SessionController): void {
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
	// WebviewViews do not fire onDidDispose reliably in all hosts; the sink Set just
	// holds a stale poster in that case, which is harmless (postMessage on a disposed
	// webview resolves false).
	webview.onDidReceiveMessage(
		(message: WebviewToHost) => {
			const marker = process.env.PRIME_AGENT_VSCODE_LOG;
			if (marker) {
				try {
					require("node:fs").appendFileSync(marker, `recv ${(message as { type?: string }).type}\n`);
				} catch {
					// ignore
				}
			}
			void handleMessage(message, controller);
		},
		undefined,
		[],
	);
	void attachment;
}

async function handleMessage(message: WebviewToHost, controller: SessionController): Promise<void> {
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
				await controller.prompt(message.payload);
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
			await controller.browseChild(message.activeSessionId);
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
			controller.persistDraft(message.text);
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
			await controller.searchFiles(message.query, message.requestId);
			return;
		case "openFile":
			await controller.openFile(message.path, message.startLine, message.endLine);
			return;
		case "openDiff":
			await controller.openDiff(message.path);
			return;
		case "pickImage":
			await controller.pickImages(message.requestId);
			return;
		case "attachActiveFile": {
			const file = controller.getActiveFilePath();
			if (file) controller.broadcastInsertMention(file);
			return;
		}
		case "attachSelection": {
			const selection = controller.getActiveSelection();
			if (selection) controller.broadcastInsertSelection(selection);
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
			await vscode.env.openExternal(vscode.Uri.parse(message.url));
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
