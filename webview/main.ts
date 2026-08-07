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
const brand = el("div", "brand") as HTMLElement & { role?: string };
brand.tabIndex = 0;
brand.title = "Prime Agent — by Prime Intellect";
brand.appendChild(butterfly(20));
brand.appendChild(el("span", "brand-name", "Prime Agent"));
brand.addEventListener("click", () => post({ type: "openExternal", url: "https://www.primeintellect.ai/blog/prime-agent#article-top" }));
brand.addEventListener("keydown", (event) => {
	if (event.key === "Enter" || event.key === " ") post({ type: "openExternal", url: "https://www.primeintellect.ai/blog/prime-agent#article-top" });
});
const sessionTitle = el("span", "session-title", "");
topbar.append(brand, sessionTitle, el("span", "spacer"));

const newChatBtn = iconButton("plus", "New session", 16);
const historyBtn = iconButton("history", "Sessions in this workspace", 16);
const menuBtn = iconButton("kebab", "Session actions", 16);
topbar.append(newChatBtn, historyBtn, menuBtn);

const menu = el("div", "menu");
function menuItem(label: string, iconName: Parameters<typeof icon>[0] | "butterfly", action: () => void, title?: string): HTMLButtonElement {
	const item = document.createElement("button");
	item.className = "menu-item";
	if (title) item.title = title;
	if (iconName === "butterfly") {
		item.appendChild(butterfly(13, "menu-butterfly"));
	} else {
		item.appendChild(icon(iconName, 13));
	}
	item.appendChild(el("span", "", label));
	item.addEventListener("click", () => {
		menu.classList.remove("visible");
		action();
	});
	return item;
}
function menuSeparator(): HTMLElement {
	const sep = el("div", "menu-sep");
	sep.setAttribute("role", "separator");
	return sep;
}
menu.append(
	menuItem("Compact context", "compact", () => post({ type: "compact" }), "Runs automatically when the context window fills up; run it now"),
	menuItem("Export chat…", "export", () => post({ type: "exportChat" })),
	menuItem("Restart agent process", "refresh", () => {
		transcript.renderSnapshot([]);
		post({ type: "restart" });
	}),
	menuSeparator(),
	menuItem("Visit Prime Intellect", "butterfly", () => post({ type: "openExternal", url: "https://app.primeintellect.ai" }), "Prime Intellect dashboard — app.primeintellect.ai"),
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

// Subagents strip: collapsible panel floating on top of the composer.
const subagentsStrip = el("div", "subagents-strip") as HTMLElement;
let subagentsExpanded = false;
let browsingChild = false;
let sessionChildren: import("../src/protocol.js").SessionChild[] = [];

function renderSubagentsStrip(): void {
	subagentsStrip.textContent = "";
	if (!browsingChild && sessionChildren.length === 0) {
		subagentsStrip.classList.remove("visible");
		return;
	}
	subagentsStrip.classList.add("visible");
	const header = el("button", "subagents-header") as HTMLButtonElement;
	const parts: Array<HTMLElement | string> = [];
	if (browsingChild) {
		const back = el("span", "subagents-back", "‹ parent");
		header.append(back, el("span", "subagents-sep"));
		if (sessionChildren.length > 0) {
			header.append(`${sessionChildren.length} subagent${sessionChildren.length === 1 ? "" : "s"}`);
		}
		header.addEventListener("click", () => post({ type: "backToParent" }));
		header.title = "Return to the parent agent";
	} else {
		header.append(
			el("span", "subagents-caret", subagentsExpanded ? "▾" : "▸"),
			`Subagents (${sessionChildren.length})`,
		);
		header.title = "Subagents spawned by this session — click to expand, browse one to look inside";
		header.addEventListener("click", () => {
			subagentsExpanded = !subagentsExpanded;
			renderSubagentsStrip();
		});
	}
	subagentsStrip.appendChild(header);
	if ((!browsingChild && subagentsExpanded) || browsingChild) {
		const list = el("div", "subagents-list");
		for (const child of sessionChildren) {
			const row = el("button", "subagent-row") as HTMLButtonElement;
			row.title = `${child.runtimeKind === "subagent" ? `subagent${child.rlmDepth ? ` · depth ${child.rlmDepth}` : ""}` : (child.runtimeKind ?? "session")}${child.attachedClients ? ` · ${child.attachedClients} attached client(s)` : ""}`;
			const dot = el("span", `subagent-dot${child.isStreaming ? " active" : ""}`);
			dot.title = child.isStreaming ? "active" : "idle";
			const name = el("span", "subagent-name", child.name ?? child.id);
			const badge = child.isStreaming ? el("span", "subagent-badge", "active") : "";
			const suffix = el("span", "subagent-go", "view ›");
			const viewing = currentStatus?.sessionId === child.activeSessionId;
			if (viewing) {
				row.classList.add("viewing");
				row.title = "Currently viewing — this transcript shows this subagent";
			}
			row.append(dot, name, badge, suffix);
			row.addEventListener("click", (event) => {
				event.stopPropagation();
				post({ type: "browseChild", activeSessionId: child.activeSessionId, parentSessionId: child.id });
				browsingChild = true;
				renderSubagentsStrip();
			});
			list.appendChild(row);
		}
		subagentsStrip.appendChild(list);
	}
}

app.append(topbar, menu, notices, observeBanner, chatView, historyView.root, subagentsStrip, composer.root, statusStrip);
historyView.root.style.display = "none";

function showView(view: "chat" | "history"): void {
	chatView.style.display = view === "chat" ? "" : "none";
	composer.root.style.display = view === "chat" ? "" : "none";
	historyView.root.style.display = view === "history" ? "" : "none";
	if (view === "history") historyView.showLoading();
}

newChatBtn.addEventListener("click", () => {
	showView("chat");
	browsingChild = false;
	subagentsExpanded = false;
	renderSubagentsStrip();
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

// Boot splash: until the FIRST live connection, hide the composer and show the
// breathing Prime Agent mark. Disconnections after that only touch the status strip.
let everConnected = false;
const bootSplash = el("div", "boot-splash");
bootSplash.appendChild(el("div", "boot-splash-mark")).appendChild(butterfly(44));
bootSplash.appendChild(el("div", "boot-splash-name", "Prime Agent"));
bootSplash.appendChild(el("div", "boot-splash-sub", "connecting…"));
app.appendChild(bootSplash);

function applyStatus(status: StatusSnapshot): void {
	if (!everConnected && status.connected) {
		everConnected = true;
		bootSplash.classList.add("gone");
		setTimeout(() => bootSplash.remove(), 700);
	}
	if (currentStatus?.sessionId !== status.sessionId) {
		renderSubagentsStrip();
	}
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
	composer.setThinking(status.thinkingLevel, status.availableThinkingLevels ?? null);
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
		const d = messageEvent.data as { type?: string; error?: string; status?: { streaming?: boolean } } | undefined;
		const t = d?.type;
		let entry = t ?? "?";
		if (t === "promptRejected" && typeof d?.error === "string") entry = `promptRejected:${d.error.slice(0, 80)}`;
		else if (t === "notice" && typeof (d as { text?: string }).text === "string") entry = `notice:${((d as { text: string }).text).slice(0, 80)}`;
		if (rxRing.push(entry) > 30) rxRing.shift();
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
		case "sessionChildren":
			sessionChildren = message.children ?? [];
			renderSubagentsStrip();
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

// ---------------------------------------------------------------------------
// Per-thread diff panel (appended wiring only)
// ---------------------------------------------------------------------------

import { ThreadDiffsPanel } from "./thread-diffs.js";

const threadDiffsPanel = new ThreadDiffsPanel({
	onOpenFile: (path) => post({ type: "openFile", path }),
});
// Sibling of the subagents strip, floating directly above the composer.
subagentsStrip.after(threadDiffsPanel.root);

// Handled outside dispatchHostMessage so this wiring stays append-only; the
// panel is driven purely by the host's cumulative `threadDiffs` pushes.
window.addEventListener("message", (messageEvent) => {
	try {
		const data = messageEvent.data as { type?: unknown; files?: unknown } | undefined;
		if (data && data.type === "threadDiffs") {
			threadDiffsPanel.setFiles(data.files);
		}
	} catch { /* panel must never break sibling handlers */ }
});
