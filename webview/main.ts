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
	menuItem("Compact context — runs automatically when context fills; run it now?", "compact", () => post({ type: "compact" })),
	menuItem("Export chat…", "export", () => post({ type: "exportChat" })),
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

const observeBanner = el("div", "observe-banner");
observeBanner.style.display = "none";
{
	const mark = butterfly(14);
	mark.classList.add("working-mark");
	observeBanner.appendChild(mark);
	observeBanner.appendChild(el("span", "observe-text", "Live in another client — read-only"));
	const stopObservingBtn = document.createElement("button");
	stopObservingBtn.className = "observe-stop";
	stopObservingBtn.textContent = "Back to my session";
	stopObservingBtn.title = "Stop watching and return to your chat session";
	stopObservingBtn.addEventListener("click", () => post({ type: "stopObserving" }));
	observeBanner.appendChild(stopObservingBtn);
}

const chatView = el("div", "chat-view");
const scroller = el("div", "messages");
const changedFilesBar = el("div", "changed-files");
chatView.append(scroller, changedFilesBar);

const composerDeps = {
	onSend: (text: string, images: import("../src/protocol.js").ImageAttachment[], selections: import("../src/protocol.js").SelectionAttachment[]) => {
		console.info("[prime-agent] composer send:", text.slice(0, 60));
		transcript.showOptimisticUserMessage(text, images);
		post({
			type: "prompt",
			payload: { text, images, selections, streamingBehavior: composer.streamingBehavior },
		});
	},
	onStop: () => post({ type: "abort" }),
	onSearchFiles: (query: string, requestId: number) => post({ type: "searchFiles", query, requestId }),
	onDraftChanged: (text: string) => post({ type: "draftChanged", text }),
	onSetCompactThreshold: (percent: number | null) => post({ type: "setCompactThreshold", percent }),
	onPickImage: () => post({ type: "pickImage", requestId: Date.now() }),
	onAttachSelection: () => post({ type: "attachSelection" }),
	onAttachActiveFile: () => post({ type: "attachActiveFile" }),
	onSetModel: (provider: string, modelId: string) => post({ type: "setModel", provider, modelId }),
	onSetThinking: (level: string) => post({ type: "setThinkingLevel", level }),
	onToggleFavorite: (provider: string, modelId: string) => post({ type: "toggleFavoriteModel", provider, modelId }),
	onOpenFile: (path: string, startLine?: number, endLine?: number) => post({ type: "openFile", path, startLine, endLine }),
};
const composer = new Composer(composerDeps);

const transcript = new Transcript(scroller, changedFilesBar, {
	onOpenLink: (href) => post({ type: "openExternal", url: href }),
	onOpenFile: (path, startLine, endLine) => post({ type: "openFile", path, startLine, endLine }),
	onOpenDiff: (path) => post({ type: "openDiff", path }),
	onForkFromUser: (ordinal) => post({ type: "forkFromUser", ordinal }),
	onNewSession: () => post({ type: "newSession" }),
	onShowHistory: () => {
		showView("history");
		historyView.showLoading();
		post({ type: "requestHistory" });
	},
	onFocusComposer: () => composer.focus(),
});

const historyView = new HistoryView({
	onResume: (path, sessionId) => {
		showView("chat");
		post({ type: "switchSession", path, sessionId });
	},
	onDelete: (path, sessionId) => {
		post({ type: "deleteSession", path, sessionId });
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
const convCopy = el("button", "strip-icon") as HTMLButtonElement;
convCopy.title = "Copy the whole conversation (Markdown with summarized tool calls)";
convCopy.appendChild(icon("copy", 11));
convCopy.addEventListener("click", (event) => {
	event.stopPropagation();
	post({ type: "copyConversation" });
});
statusStrip.append(connDot, liveLabel, sessionIdLabel, el("span", "spacer"), statsLabel, convCopy);

app.append(topbar, menu, notices, observeBanner, chatView, historyView.root, composer.root, statusStrip);
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
let observing = false;

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

	composer.setModel(status.modelLabel, status.modelProvider, status.modelId);
	composer.setThinking(status.thinkingLevel);
	composer.setStreaming(transcript.isStreaming() || status.streaming);
	composer.setContext(status.contextPercent, status.contextTokens, status.contextWindow);
	if (status.compactThresholdPercent !== undefined) composer.setCompactThreshold(status.compactThresholdPercent);
	if (status.statusText) liveLabel.textContent = status.statusText;
	setObserving(!!status.observingId);
}

function setObserving(value: boolean): void {
	observing = value;
	observeBanner.style.display = value ? "" : "none";
	composer.setObserving(value);
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

const rxRing: string[] = [];
(window as unknown as { __paRx?: string[] }).__paRx = rxRing;

window.addEventListener("message", (messageEvent) => {
	try {
		const t = (messageEvent.data as { type?: string })?.type;
		if (typeof t === "string" && rxRing.push(t) > 30) rxRing.shift();
	} catch { /* ignore */ }
	try {
		dispatchHostMessage(messageEvent.data as HostToWebview);
	} catch (err) {
		// Surface handler errors as a hidden beacon so e2e tooling and end users can report them.
		console.error("[prime-agent] host message handler error:", err);
		const beacon = document.createElement("div");
		beacon.className = "pa-handler-error";
		beacon.style.display = "none";
		beacon.textContent = `${(messageEvent.data as { type?: string })?.type ?? "?"}: ${String((err as Error)?.stack ?? err).slice(0, 500)}`;
		document.body.appendChild(beacon);
	}
});

function dispatchHostMessage(message: HostToWebview): void {
	switch (message.type) {
		case "snapshot":
			transcript.renderSnapshot(message.messages ?? []);
			applyStatus(message.status);
			composer.setStreaming(transcript.isStreaming());
			if (message.steerDefault) composer.setSteerDefault(message.steerDefault);
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
			composer.setModels(message.models);
			break;
		case "favorites":
			composer.setFavorites(message.favorites);
			break;
		case "draft":
			if (message.text && composer.textIsEmpty()) {
				composer.setText(message.text);
				composer.focus();
			}
			break;
		case "compactThreshold":
			composer.setCompactThreshold(message.percent);
			break;
		case "commands":
			composer.setCommands(message.commands);
			break;
		case "history":
			historyView.render(message.sessions, currentStatus?.sessionId);
			break;
		case "showHistory":
			showView("history");
			break;
		case "observedSession":
			setObserving(true);
			transcript.renderSnapshot(message.messages);
			showView("chat");
			break;
		case "observedEvent":
			transcript.handleEvent(message.event);
			break;
		case "observedClosed":
			setObserving(false);
			addNotice("info", "Stopped watching the live session.");
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
}

function formatNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

declare const PRIME_AGENT_BUILD_REV: string | undefined;
if (typeof PRIME_AGENT_BUILD_REV === "string") {
	document.body.dataset.paBuild = PRIME_AGENT_BUILD_REV;
}

transcript.showWelcome();
post({ type: "ready" });
