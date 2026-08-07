/**
 * Prime Agent chat webview: layout, host message dispatch, view switching.
 */

import { Composer } from "./composer.js";
import { butterfly, el, icon, iconButton } from "./dom.js";
import { HistoryView } from "./history.js";
import { Transcript } from "./transcript.js";
import type {
	AgentEvent,
	HostToWebview,
	RpcModel,
	StatusSnapshot,
	WebviewToHost,
} from "../src/protocol.js";

const vscode = acquireVsCodeApi();

function post(message: WebviewToHost): void {
	vscode.postMessage(message);
}

const app = document.getElementById("app") as HTMLDivElement;
app.classList.add("chat-root");

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

const topbar = el("div", "topbar");
const brand = el("div", "brand");
brand.appendChild(butterfly(20));
brand.appendChild(el("span", "brand-name", "Prime Agent"));
const sessionTitle = el("span", "session-title", "");
topbar.append(brand, sessionTitle, el("span", "spacer"));

const newChatBtn = iconButton("plus", "New session", 16);
const historyBtn = iconButton("history", "Sessions in this workspace", 16);
const menuBtn = iconButton("kebab", "Session actions", 16);
topbar.append(newChatBtn, historyBtn, menuBtn);

const menu = el("div", "menu");
function menuItem(label: string, iconName: Parameters<typeof icon>[0], action: () => void): HTMLButtonElement {
	const item = document.createElement("button");
	item.className = "menu-item";
	item.appendChild(icon(iconName, 13));
	item.appendChild(el("span", "", label));
	item.addEventListener("click", () => {
		menu.classList.remove("visible");
		action();
	});
	return item;
}
menu.append(
	menuItem("Compact context", "compact", () => post({ type: "compact" })),
	menuItem("Export chat as HTML", "export", () => post({ type: "exportHtml" })),
	menuItem("Restart agent process", "refresh", () => {
		transcript.renderSnapshot([]);
		post({ type: "restart" });
	}),
);
menuBtn.addEventListener("click", (event) => {
	event.stopPropagation();
	menu.classList.toggle("visible");
});
document.addEventListener("click", (event) => {
	if (!menu.contains(event.target as Node) && event.target !== menuBtn) {
		menu.classList.remove("visible");
	}
});

// ---------------------------------------------------------------------------
// Notices + views
// ---------------------------------------------------------------------------

const notices = el("div", "notices");

const chatView = el("div", "chat-view");
const scroller = el("div", "messages");
const changedFilesBar = el("div", "changed-files");
chatView.append(scroller, changedFilesBar);

const composerDeps = {
	onSend: (text: string, images: import("../src/protocol.js").ImageAttachment[], selections: import("../src/protocol.js").SelectionAttachment[]) => {
		post({
			type: "prompt",
			payload: { text, images, selections, streamingBehavior: composer.streamingBehavior },
		});
	},
	onStop: () => post({ type: "abort" }),
	onSearchFiles: (query: string, requestId: number) => post({ type: "searchFiles", query, requestId }),
	onPickImage: () => post({ type: "pickImage", requestId: Date.now() }),
	onAttachSelection: () => post({ type: "attachSelection" }),
	onAttachActiveFile: () => post({ type: "attachActiveFile" }),
	onPickModel: () => post({ type: "pickModel" }),
	onPickThinking: () => post({ type: "pickThinkingLevel" }),
	onOpenFile: (path: string, startLine?: number, endLine?: number) => post({ type: "openFile", path, startLine, endLine }),
};
const composer = new Composer(composerDeps);

const transcript = new Transcript(scroller, changedFilesBar, {
	onOpenLink: (href) => post({ type: "openExternal", url: href }),
	onOpenFile: (path, startLine, endLine) => post({ type: "openFile", path, startLine, endLine }),
	onOpenDiff: (path) => post({ type: "openDiff", path }),
	onNewSession: () => post({ type: "newSession" }),
	onShowHistory: () => {
		showView("history");
		historyView.showLoading();
		post({ type: "requestHistory" });
	},
	onFocusComposer: () => composer.focus(),
});

const historyView = new HistoryView({
	onResume: (path) => {
		showView("chat");
		post({ type: "switchSession", path });
	},
	onBack: () => showView("chat"),
});

// ---------------------------------------------------------------------------
// Status strip
// ---------------------------------------------------------------------------

const statusStrip = el("div", "status-strip");
const connDot = el("span", "conn-dot");
const liveLabel = el("span", "live-label", "connecting");
const sessionIdLabel = el("span", "session-id", "");
const statsLabel = el("span", "stats-label", "");
statusStrip.append(connDot, liveLabel, sessionIdLabel, el("span", "spacer"), statsLabel);

app.append(topbar, menu, notices, chatView, historyView.root, composer.root, statusStrip);
historyView.root.style.display = "none";

function showView(view: "chat" | "history"): void {
	chatView.style.display = view === "chat" ? "" : "none";
	composer.root.style.display = view === "chat" ? "" : "none";
	historyView.root.style.display = view === "history" ? "" : "none";
	if (view === "history") historyView.showLoading();
}

newChatBtn.addEventListener("click", () => {
	showView("chat");
	post({ type: "newSession" });
});
historyBtn.addEventListener("click", () => {
	showView("history");
	post({ type: "requestHistory" });
});

// ---------------------------------------------------------------------------
// Status application
// ---------------------------------------------------------------------------

let currentStatus: StatusSnapshot | null = null;

function applyStatus(status: StatusSnapshot): void {
	currentStatus = status;
	connDot.className = `conn-dot${status.connected ? (status.streaming ? " busy" : " live") : ""}`;
	liveLabel.textContent = status.compacting
		? "compacting…"
		: status.retrying
			? "retrying…"
			: status.connected
				? status.streaming
					? "running"
					: "live"
				: "offline";
	liveLabel.className = `live-label${status.connected ? " on" : ""}`;

	if (status.sessionName) {
		sessionTitle.textContent = status.sessionName;
		sessionTitle.style.display = "";
	} else if (status.sessionId) {
		sessionTitle.textContent = "";
		sessionTitle.style.display = "none";
	}
	sessionIdLabel.textContent = status.sessionId ? `#${status.sessionId.slice(0, 8)}` : "";
	sessionIdLabel.title = status.sessionFile ?? "";

	const statsBits: string[] = [];
	if (status.usageTotal != null) statsBits.push(`${formatNumber(status.usageTotal)} tok`);
	if (status.costUsd != null && status.costUsd > 0) statsBits.push(`$${status.costUsd.toFixed(4)}`);
	statsLabel.textContent = statsBits.join(" · ");

	composer.setModel(status.modelLabel);
	composer.setThinking(status.thinkingLevel);
	composer.setStreaming(transcript.isStreaming() || status.streaming);
	composer.setContext(status.contextPercent, status.contextTokens, status.contextWindow);
	if (status.statusText) liveLabel.textContent = status.statusText;
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

function addNotice(level: "info" | "warning" | "error", text: string): void {
	const note = el("div", `notice ${level}`);
	note.appendChild(el("span", "", text));
	const dismiss = el("button", "notice-dismiss");
	dismiss.appendChild(icon("close", 11));
	dismiss.addEventListener("click", () => note.remove());
	note.appendChild(dismiss);
	notices.appendChild(note);
	if (level === "info") setTimeout(() => note.remove(), 9000);
}

// ---------------------------------------------------------------------------
// Host message dispatch
// ---------------------------------------------------------------------------

window.addEventListener("message", (messageEvent) => {
	const message = messageEvent.data as HostToWebview;
	switch (message.type) {
		case "snapshot":
			transcript.renderSnapshot(message.messages ?? []);
			applyStatus(message.status);
			composer.setStreaming(transcript.isStreaming());
			break;
		case "event":
			transcript.handleEvent(message.event);
			if (message.event.type === "agent_start" || message.event.type === "agent_end") {
				composer.setStreaming(message.event.type === "agent_start");
				if (currentStatus) {
					applyStatus({ ...currentStatus, streaming: message.event.type === "agent_start" });
				}
			}
			break;
		case "status":
			applyStatus(message.status);
			break;
		case "models":
			// native QuickPick handles selection; model list cached for future menus
			break;
		case "commands":
			composer.setCommands(message.commands);
			break;
		case "history":
			historyView.render(message.sessions);
			break;
		case "showHistory":
			showView("history");
			break;
		case "notice":
			addNotice(message.level, message.text);
			break;
		case "uiState":
			if (message.statusText && currentStatus) {
				applyStatus({ ...currentStatus, statusText: message.statusText });
			}
			break;
		case "fileSearchResults":
			composer.onFileSearchResults(message.requestId, message.files);
			break;
		case "imagePicked":
			if (message.images.length > 0) composer.addImages(message.images);
			break;
		case "insertSelection":
			composer.addSelection(message.selection);
			break;
		case "insertMention":
			composer.insertMention(message.path);
			showView("chat");
			break;
		case "changedFiles":
			transcript.renderChangedFiles(message.files);
			break;
		case "editorText":
			composer.setText(message.text);
			break;
		case "focusComposer":
			composer.focus();
			break;
		case "promptRejected":
			addNotice("error", `Prompt rejected: ${message.error}`);
			break;
	}
});

function formatNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

transcript.showWelcome();
post({ type: "ready" });
