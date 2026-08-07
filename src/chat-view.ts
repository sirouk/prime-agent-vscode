/**
 * Chat webview wiring: a sidebar WebviewView plus an editor-tab WebviewPanel that
 * both attach to the shared SessionController.
 */

import * as vscode from "vscode";
import type { HostToWebview, WebviewToHost } from "./protocol.js";
import type { SessionController } from "./session-controller.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "primeAgent.chat";
	private view: vscode.WebviewView | null = null;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: SessionController,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
		};
		view.webview.html = buildHtml(view.webview, this.extensionUri);
		wireWebview(view.webview, this.controller);
	}

	reveal(): void {
		this.view?.show?.(true);
	}

	focusComposer(): void {
		this.view?.webview.postMessage({ type: "focusComposer" } satisfies HostToWebview);
	}

	post(message: HostToWebview): void {
		this.view?.webview.postMessage(message);
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
		post: (message: HostToWebview) => void webview.postMessage(message),
	};
	const attachment = controller.attach(sink);
	// WebviewViews do not fire onDidDispose reliably in all hosts; the sink Set just
	// holds a stale poster in that case, which is harmless (postMessage on a disposed
	// webview resolves false).
	webview.onDidReceiveMessage(
		(message: WebviewToHost) => {
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
			return;
		case "prompt":
			await controller.prompt(message.payload);
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
		case "setModel":
			await controller.setModel(message.provider, message.modelId);
			return;
		case "setThinkingLevel":
			await controller.setThinkingLevel(message.level);
			return;
		case "switchSession":
			await controller.switchSession(message.path);
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
	<link href="${styleUri}" rel="stylesheet" />
	<title>Prime Agent</title>
</head>
<body>
	<div id="app"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
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
