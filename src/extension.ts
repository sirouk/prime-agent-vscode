/**
 * Prime Agent VS Code extension entry point.
 */

import * as vscode from "vscode";
import { ChatPanel, ChatViewProvider } from "./chat-view.js";
import { GitHeadContentProvider, SessionController } from "./session-controller.js";

let controller: SessionController | null = null;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Prime Agent");
	controller = new SessionController(context, output);
	context.subscriptions.push(controller, output);

	const provider = new ChatViewProvider(context.extensionUri, controller);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider("prime-agent-git-head", new GitHeadContentProvider()),
	);

	const reveal = () => {
		void vscode.commands.executeCommand("primeAgent.chat.focus").then(
			() => provider.reveal(),
			() => provider.reveal(),
		);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("primeAgent.focusChat", () => {
			reveal();
			provider.focusComposer();
		}),
		vscode.commands.registerCommand("primeAgent.openChat", () => {
			ChatPanel.createOrShow(context.extensionUri, controller!);
		}),
		vscode.commands.registerCommand("primeAgent.newSession", () => void controller!.newSession()),
		vscode.commands.registerCommand("primeAgent.abort", () => void controller!.abort()),
		vscode.commands.registerCommand("primeAgent.compact", () => void controller!.compact()),
		vscode.commands.registerCommand("primeAgent.exportHtml", () => void controller!.exportHtml()),
		vscode.commands.registerCommand("primeAgent.restart", () => void controller!.restart()),
		vscode.commands.registerCommand("primeAgent.history", async () => {
			await controller!.listHistory();
			reveal();
		}),
		vscode.commands.registerCommand("primeAgent.addSelectionToChat", () => {
			const selection = controller!.getActiveSelection();
			if (!selection) {
				void vscode.window.showInformationMessage("Select some code first.");
				return;
			}
			controller!.broadcastInsertSelection(selection);
			reveal();
		}),
		vscode.commands.registerCommand("primeAgent.addActiveFileToChat", () => {
			const file = controller!.getActiveFilePath();
			if (!file) return;
			controller!.broadcastInsertMention(file);
			reveal();
		}),
	);
}

export function deactivate(): void {
	controller?.dispose();
	controller = null;
}
