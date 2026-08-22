/**
 * Prime Agent chat webview: layout, host message dispatch, view switching.
 */

import { Composer } from "./composer.js";
import { butterfly, el, icon, iconButton } from "./dom.js";
import { HistoryView } from "./history.js";
import { Transcript } from "./transcript.js";
import type {
	AgentEvent,
	AgentMessage,
	HostToWebview,
	ImageAttachment,
	RpcModel,
	SelectionAttachment,
	SessionChild,
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
const sessionTitleWrap = el("div", "session-title-wrap");
const sessionTitle = el("span", "session-title", "");
sessionTitleWrap.append(sessionTitle);
topbar.append(brand, sessionTitleWrap, el("span", "spacer"));

/**
 * Inline session-title editing: double-click the name, Enter or click away to
 * keep it, Escape to discard.
 *
 * Committing on blur is deliberate. An editor that throws away what you typed
 * because you clicked somewhere else is the clunky part of inline renaming, and
 * Escape already says "discard" unambiguously. Nothing is sent unless the text
 * actually changed, so a stray double-click costs nothing.
 */
let titleEditing: { finish: (commit: boolean) => void; sessionId?: string } | null = null;

function sizeTitleInput(input: HTMLInputElement): void {
	input.style.width = `${Math.min(340, Math.max(120, input.value.length * 8 + 24))}px`;
}

function startTitleEdit(): void {
	if (titleEditing || !sessionTitle.isConnected) return;
	const original = (sessionTitle.textContent ?? "").trim();
	const input = document.createElement("input");
	input.className = "session-title-input";
	input.value = original;
	input.spellcheck = false;
	input.setAttribute("aria-label", "Session name");
	input.title = "Enter to save · Escape to cancel";
	const finish = (commit: boolean): void => {
		if (!titleEditing) return;
		titleEditing = null;
		const next = input.value.trim();
		input.replaceWith(sessionTitle);
		// An emptied box means "leave it alone": the daemon has no way to clear a
		// name, so sending one would only bounce back as an error notice.
		if (commit && next && next !== original) post({ type: "renameSession", name: next });
	};
	titleEditing = { finish, sessionId: currentStatus?.sessionId };
	input.addEventListener("input", () => sizeTitleInput(input));
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			finish(true);
		} else if (event.key === "Escape") {
			event.preventDefault();
			finish(false);
		}
	});
	input.addEventListener("blur", () => finish(true));
	sessionTitle.replaceWith(input);
	sizeTitleInput(input);
	input.focus();
	input.select();
}

sessionTitle.addEventListener("dblclick", (event) => {
	// Without this the second click leaves the name text-selected under the input.
	event.preventDefault();
	startTitleEdit();
});

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
chatView.append(scroller);

// Scope IDs to this webview instance: a late rejection from a panel that was
// closed and reopened must never match a new panel's first `prompt-1` row.
const promptClientScope =
	typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let nextPromptClientRequestId = 0;
const pendingPrompts = new Map<string, { text: string; images: ImageAttachment[]; selections: SelectionAttachment[] }>();
// Native image pickers resolve later and the controller is shared by sidebar
// and editor panels, so replies need a per-document correlation id.
const imageRequestScope = Math.floor(Math.random() * 4_000_000_000);
let nextImageRequestId = 0;
const pendingImageRequests = new Set<number>();
const fileSearchRequestScope = Math.floor(Math.random() * 4_000_000_000);
let nextFileSearchRequestId = 0;
const pendingFileSearches = new Map<number, number>();
/** Last host-confirmed session identity displayed in this panel. */
let authoritativeSessionId: string | undefined;
const composerDeps = {
	onSend: (text: string, images: import("../src/protocol.js").ImageAttachment[], selections: import("../src/protocol.js").SelectionAttachment[]) => {
		const clientRequestId = `${promptClientScope}-${++nextPromptClientRequestId}`;
		pendingPrompts.set(clientRequestId, { text, images: [...images], selections: [...selections] });
		transcript.showOptimisticUserMessage(clientRequestId, text, images);
		post({
			type: "prompt",
			payload: { text, images, selections, streamingBehavior: composer.streamingBehavior, clientRequestId },
		});
	},
	onStop: () => post({ type: "abort" }),
	onSearchFiles: (query: string, requestId: number) => {
		const hostRequestId = fileSearchRequestScope * 1_000_000 + ++nextFileSearchRequestId;
		pendingFileSearches.set(hostRequestId, requestId);
		post({ type: "searchFiles", query, requestId: hostRequestId });
	},
	onDraftChanged: (text: string) => {
		if (authoritativeSessionId) post({ type: "draftChanged", text, sessionId: authoritativeSessionId });
	},
	onSetCompactThreshold: (percent: number | null) => post({ type: "setCompactThreshold", percent }),
	onPickImage: () => {
		const requestId = imageRequestScope * 1_000_000 + ++nextImageRequestId;
		pendingImageRequests.add(requestId);
		post({ type: "pickImage", requestId });
	},
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
	onSpawnedCardClick: (browseRef) => post({ type: "browseChild", browseRef }),
	onNewSession: () => post({ type: "newSession" }),
	onShowHistory: () => {
		showView("history");
		historyView.showLoading();
		post({ type: "requestHistory" });
	},
	onFocusComposer: () => composer.focus(),
	onOptimisticConfirmed: (clientRequestId) => pendingPrompts.delete(clientRequestId),
});

const historyView = new HistoryView({
	onResume: (path, sessionId) => {
		// Before the switch, or the last 300ms of typing lands under the INCOMING
		// session id and overwrites the draft the operator saved there.
		composer.flushDraft();
		showView("chat");
		post({ type: "switchSession", path, sessionId });
	},
	onDelete: (path, sessionId) => {
		post({ type: "deleteSession", path, sessionId });
	},
	onArchive: (path, sessionId) => {
		post({ type: "archiveSession", path, sessionId });
	},
	onRename: (path, sessionId, name) => {
		post({ type: "renameHistorySession", path, sessionId, name });
	},
	onStop: (path, sessionId) => {
		post({ type: "stopSession", path, sessionId });
	},
	onSearch: (query) => {
		post({ type: "searchHistory", query });
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
let sessionChildren: SessionChild[] = [];

/**
 * Auto-expanding the strip when a subagent starts, without becoming a nuisance.
 *
 * The whole value is the moment work begins: a subagent that spawned into a
 * collapsed strip is invisible until the operator goes looking. Everything else
 * here exists to make sure that never fights them:
 *
 * - Only ever expands. Nothing auto-collapses, so it cannot close a list being
 *   read — including the historical group, which keeps its own state.
 * - Never while they are inside a subagent view. There the strip is how they get
 *   back out, and opening it under them moves the row they were aiming for.
 * - A collapse by hand is an instruction. It is respected until they open the
 *   strip by hand again, so a busy thread cannot keep reopening a panel they
 *   deliberately shut.
 * - Nothing on the first roster of a session. Resuming a thread with live
 *   subagents is not something that just started, and forcing the panel open on
 *   every resume is exactly the noise being avoided.
 * - Never takes the scroll: expanding shrinks the transcript viewport, so a
 *   reader parked mid-history keeps their place and only a reader who was
 *   already following the tail is re-pinned to it.
 */
let subagentsAutoExpandSuppressed = false;
/** Ids seen live on the previous roster, to spot one starting rather than staying. */
let liveChildIds = new Set<string>();

/** False until this session's first roster, so a resume is not read as activity. */
let subagentRosterSeen = false;

/**
 * Forget which subagents were live, so the next roster seeds instead of reading
 * as a burst of activity. Deliberately does NOT clear the operator's collapse:
 * `subagentsExpanded` already survives a session change on purpose, and the
 * instruction that produced it has to survive with it, or browsing into a child
 * and back would quietly re-arm a panel they shut.
 */
function resetSubagentActivityBaseline(): void {
	liveChildIds = new Set();
	subagentRosterSeen = false;
}

const childKey = (child: { activeSessionId?: string; id?: string }): string => child.activeSessionId || child.id || "";

/**
 * Subagents that STARTED since the last roster: freshly spawned, or an existing
 * one that went from idle/finished back to running. Seeds silently on the first
 * roster of a session — resuming a busy thread is not something starting now.
 */
function takeStartedSubagents(spawned: readonly { activeSessionId: string }[]): string[] {
	const liveNow = new Set(sessionChildren.filter((child) => childStatus(child) === "running").map(childKey));
	const seeding = !subagentRosterSeen;
	subagentRosterSeen = true;
	const started = seeding
		? []
		: [...spawned.map((entry) => entry.activeSessionId).filter(Boolean), ...[...liveNow].filter((id) => !liveChildIds.has(id))];
	liveChildIds = liveNow;
	return [...new Set(started)].filter(Boolean);
}

/** Open the strip for work that just began. Returns whether it actually opened. */
function maybeAutoExpandSubagents(started: readonly string[]): boolean {
	if (started.length === 0 || subagentsExpanded || subagentsAutoExpandSuppressed) return false;
	// Inside a subagent the strip is the way back out; opening it under the
	// operator moves the row they were reaching for.
	if (sessionParent || sessionViewedId) return false;
	subagentsExpanded = true;
	return true;
}

/**
 * Roster status of a row. Hosts before the status field only sent `isStreaming`,
 * which cannot tell a finished subagent from one waiting between turns — fall
 * back to it rather than inventing a liveness we don't have.
 */
function childStatus(child: SessionChild): "running" | "idle" | "inactive" {
	return child.status ?? (child.isStreaming ? "running" : "idle");
}

function renderSubagentsStrip(): void {
	subagentsStrip.textContent = "";
	const parent = sessionParent;
	const viewedId = sessionViewedId;
	const siblings = sessionSiblings;
	const nothingToShow = !parent && sessionChildren.length === 0 && siblings.length === 0;
	if (nothingToShow) {
		subagentsStrip.classList.remove("visible");
		return;
	}
	subagentsStrip.classList.add("visible");

	// Finished subagents keep their own collapsed group: they are real work the
	// operator can go back and read, but counting them as live is the drift that
	// made the strip disagree with what is actually running.
	const live = (child: SessionChild): boolean => childStatus(child) !== "inactive";
	const liveChildren = sessionChildren.filter(live);
	const liveSiblings = siblings.filter(live);
	const historical = [...sessionChildren, ...siblings].filter((child) => !live(child));
	const liveCount = liveChildren.length + liveSiblings.length;

	// Back row (separate, never part of the toggle) — always reliable.
	if (parent) {
		const back = el("button", "subagents-back-row") as HTMLButtonElement;
		back.append(el("span", "subagents-back", "‹ parent"), el("span", "subagents-back-name", parent.name ?? parent.id));
		back.title = "Return to the parent agent";
		back.addEventListener("click", () => post({ type: "backToParent" }));
		subagentsStrip.appendChild(back);
	}

	// Collapsible header (always a toggle). It reports the SAME three states the
	// rows below it use — the daemon's roster has exactly running, idle and
	// inactive (classifySessionRosterStatus), so folding running and idle into one
	// "live" number made the header disagree with the dots it was summarising.
	// Zero buckets are dropped rather than printed, so a quiet strip stays quiet.
	const header = el("button", "subagents-header") as HTMLButtonElement;
	const tally = { running: 0, idle: 0, inactive: 0 };
	for (const child of [...sessionChildren, ...siblings]) tally[childStatus(child)] += 1;
	const countParts: string[] = [];
	if (tally.running > 0) countParts.push(`${tally.running} running`);
	if (tally.idle > 0) countParts.push(`${tally.idle} idle`);
	if (tally.inactive > 0) countParts.push(`${tally.inactive} finished`);
	const countLabel = countParts.join(" · ") || "0";
	header.append(el("span", "subagents-caret", subagentsExpanded ? "▾" : "▸"), `Subagents (${countLabel})`);
	header.title =
		`${tally.running} running · ${tally.idle} idle · ${tally.inactive} finished — ` +
		"click to expand, browse one to look inside";
	header.addEventListener("click", () => {
		subagentsExpanded = !subagentsExpanded;
		// Collapsing by hand means "keep it shut"; opening by hand takes it back.
		subagentsAutoExpandSuppressed = !subagentsExpanded;
		renderSubagentsStrip();
	});
	subagentsStrip.appendChild(header);

	if (!subagentsExpanded) return;

	const buildRow = (child: SessionChild, isSibling: boolean): HTMLElement => {
		const row = el("button", `subagent-row${isSibling ? " sibling" : ""}`) as HTMLButtonElement;
		const viewing = viewedId === child.activeSessionId;
		const status = childStatus(child);
		// One vocabulary for the whole strip: the header counts "running · idle ·
		// finished", so a row must not call the same state something else. The dot
		// keeps its existing class names, which the stylesheet is written against.
		const dotClass = status === "running" ? "active" : status === "idle" ? "idle" : "done";
		const dot = el("span", `subagent-dot ${dotClass}`);
		dot.title =
			status === "running"
				? child.isStreaming
					? "running (responding)"
					: "running (working)"
				: status === "idle"
					? "idle — resident, waiting for work"
					: "finished — no worker behind it";
		const name = el("span", "subagent-name", child.name ?? child.id);
		const badge =
			status === "running"
				? el("span", "subagent-badge", "running")
				: el("span", "subagent-badge idle", status === "idle" ? "idle" : "finished");
		const suffix = el("span", "subagent-go", viewing ? "" : "view ›");
		row.title = `${child.runtimeKind === "subagent" ? `subagent${child.rlmDepth ? ` · depth ${child.rlmDepth}` : ""}` : (child.runtimeKind ?? "session")}${child.attachedClients ? ` · ${child.attachedClients} attached client(s)` : ""}`;
		if (viewing) {
			row.classList.add("viewing");
			row.title = "Currently viewing — this transcript shows this subagent";
		}
		row.append(dot, name, badge, suffix);
		row.addEventListener("click", (event) => {
			event.stopPropagation();
			if (!viewing && child.browseRef) post({ type: "browseChild", browseRef: child.browseRef });
		});
		return row;
	};

	if (liveChildren.length > 0) {
		const list = el("div", "subagents-list");
		for (const child of liveChildren) list.appendChild(buildRow(child, false));
		subagentsStrip.appendChild(list);
	}
	if (liveSiblings.length > 0) {
		// The viewed subagent rides in this group too, so name it after the parent
		// it hangs off rather than calling a session its own sibling.
		const siblingHeader = el("div", "subagents-sibling-header", parent ? `Under ${parent.name ?? parent.id}` : "Siblings");
		const list = el("div", "subagents-list siblings");
		for (const sib of liveSiblings) list.appendChild(buildRow(sib, true));
		subagentsStrip.append(siblingHeader, list);
	}
	if (historical.length > 0) {
		const histHeader = el("button", "subagents-subhead") as HTMLButtonElement;
		histHeader.append(
			el("span", "subagents-caret", historicalExpanded ? "▾" : "▸"),
			`Historical (${historical.length})`,
		);
		histHeader.title = "Subagents that already finished — open one to read what it did";
		histHeader.addEventListener("click", (event) => {
			event.stopPropagation();
			historicalExpanded = !historicalExpanded;
			renderSubagentsStrip();
		});
		subagentsStrip.appendChild(histHeader);
		if (historicalExpanded) {
			const list = el("div", "subagents-list historical");
			for (const child of historical) list.appendChild(buildRow(child, false));
			subagentsStrip.appendChild(list);
		}
	}
}

let sessionParent: SessionChild | null = null;
let historicalExpanded = false;
let spawnSeenBaseline = false;
let sessionViewedId: string | null = null;
let sessionSiblings: SessionChild[] = [];

// Install prompt banner: one persistent, dismissible card when prime-agent can't run.
const installBanner = el("div", "install-banner");
let installPromptShown = false;
function renderInstallBanner(url: string, reason: string): void {
	if (installPromptShown) return;
	installPromptShown = true;
	installBanner.textContent = "";
	const card = el("div", "install-card");
	card.appendChild(el("div", "install-title", "Prime Agent CLI not detected"));
	card.appendChild(el("div", "install-body", `We couldn't reach prime-agent — ${reason}. Install it (takes a minute), then click Retry below.`));
	// The one-liner itself, copyable, so the common case needs no round trip to a
	// browser at all.
	const command = el("code", "install-cmd", "curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh");
	command.title = "Click to copy";
	command.addEventListener("click", () => {
		// Only claim the copy happened if it did: clipboard access can be refused
		// when the document is not focused, and a false confirmation sends the
		// operator to paste nothing.
		const copied = navigator.clipboard?.writeText(command.textContent ?? "");
		if (copied) copied.then(() => addNotice("info", "Install command copied."), () => addNotice("warning", "Could not copy — select the command and copy it manually."));
		else addNotice("warning", "Could not copy — select the command and copy it manually.");
	});
	card.appendChild(command);
	const actions = el("div", "install-actions");
	const guide = document.createElement("button");
	guide.className = "install-cta";
	guide.textContent = "View the install guide";
	guide.addEventListener("click", () => post({ type: "openExternal", url }));
	// The card promised a retry; this is it. Without it the only reconnect control
	// is a kebab item named something else entirely.
	const retry = document.createElement("button");
	retry.className = "install-cta";
	retry.textContent = "Retry";
	retry.title = "Try starting prime-agent again";
	retry.addEventListener("click", () => {
		installPromptShown = false;
		installBanner.classList.remove("visible");
		post({ type: "restart" });
	});
	const dismiss = document.createElement("button");
	dismiss.className = "install-dismiss";
	dismiss.title = "Dismiss";
	dismiss.appendChild(icon("close", 12));
	dismiss.addEventListener("click", () => {
		installBanner.classList.remove("visible");
		post({ type: "dismissInstallPrompt" });
	});
	actions.append(retry, guide);
	card.append(actions);
	card.appendChild(dismiss);
	installBanner.appendChild(card);
	installBanner.classList.add("visible");
}
app.append(topbar, menu, notices, installBanner, observeBanner, chatView, historyView.root, subagentsStrip, composer.root, statusStrip);
historyView.root.style.display = "none";

function showView(view: "chat" | "history"): void {
	chatView.style.display = view === "chat" ? "" : "none";
	composer.root.style.display = view === "chat" ? "" : "none";
	historyView.root.style.display = view === "history" ? "" : "none";
	// The strip and the Changes panel are siblings of both views and gate purely
	// on content, so without this they hang over the history list with no
	// composer under them. "" hands display back to their own .visible class.
	subagentsStrip.style.display = view === "chat" ? "" : "none";
	changedFilesBar.style.display = view === "chat" ? "" : "none";
	threadDiffsPanel.root.style.display = view === "chat" ? "" : "none";
	if (view === "history") historyView.showLoading();
}

newChatBtn.addEventListener("click", () => {
	showView("chat");
	subagentsExpanded = false;
	// A new thread starts with no instruction from the operator about this strip.
	subagentsAutoExpandSuppressed = false;
	spawnSeenBaseline = false;
	resetSubagentActivityBaseline();
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
/** Agent-provided titles survive ordinary status refreshes, but never a session change. */
let extensionTitle: { sessionId?: string; title: string; provisional: boolean } | null = null;

/**
 * A status/snapshot only establishes a boundary when it names a session. An
 * offline or restoring status without an id is not evidence that the operator
 * changed threads, so it must not discard their in-progress draft.
 */
function adoptAuthoritativeSession(sessionId: string | undefined): boolean {
	if (!sessionId || sessionId === authoritativeSessionId) return false;
	authoritativeSessionId = sessionId;
	pendingPrompts.clear();
	pendingImageRequests.clear();
	pendingFileSearches.clear();
	composer.resetForSessionBoundary();
	menu.classList.remove("visible");
	// resetForSessionBoundary() drops the slash catalog with the rest of the
	// composer's per-session state, and the host only ever sends it in answer to
	// `ready` — i.e. once per webview. Whoever discards it has to ask again, or
	// the "/" menu is empty for every thread after the first one opened here.
	post({ type: "requestCommands" });
	return true;
}

// Boot splash: until the FIRST live connection, hide the composer and show the
// breathing Prime Agent mark. Disconnections after that only touch the status strip.
let everConnected = false;
let bootSplashRetired = false;
const bootSplash = el("div", "boot-splash");
bootSplash.appendChild(el("div", "boot-splash-mark")).appendChild(butterfly(44));
bootSplash.appendChild(el("div", "boot-splash-name", "Prime Agent"));
const bootSplashSub = el("div", "boot-splash-sub", "connecting…");
bootSplash.appendChild(bootSplashSub);
app.appendChild(bootSplash);

/** Take the splash down for good. The overlay covers the whole view, so anything
 *  the operator needs to act on (the install banner above all) must retire it. */
function retireBootSplash(): void {
	if (bootSplashRetired) return;
	bootSplashRetired = true;
	bootSplash.classList.add("gone");
	setTimeout(() => bootSplash.remove(), 700);
}

// Never leave "connecting…" standing as the whole story: if the first connection
// hasn't landed in 12s, say so honestly instead of breathing forever.
setTimeout(() => {
	if (!everConnected && !bootSplashRetired) {
		bootSplashSub.textContent = "still connecting — checking for the prime-agent CLI…";
	}
}, 12_000);
// Hard ceiling. The splash is opaque and covers the notices, the install card and
// the kebab's "Restart agent process" — the operator's only escape hatches — so it
// can never be their final state. The strip's honest "offline" carries the story
// from here, and the composer stays disabled until a status says otherwise.
setTimeout(retireBootSplash, 18_000);

function applyStatus(incomingStatus: StatusSnapshot): void {
	adoptAuthoritativeSession(incomingStatus.sessionId);
	const previousSessionId = currentStatus?.sessionId;
	// A title can arrive before the first snapshot. It is useful to paint then,
	// but the snapshot's own non-empty title is the first authoritative session
	// identity and must replace that provisional display.
	if (!currentStatus && extensionTitle?.provisional) {
		if (incomingStatus.sessionName) {
			extensionTitle = null;
		} else {
			extensionTitle = { ...extensionTitle, sessionId: incomingStatus.sessionId, provisional: false };
		}
	}
	if (previousSessionId !== incomingStatus.sessionId && extensionTitle?.sessionId !== undefined && extensionTitle.sessionId !== incomingStatus.sessionId) {
		extensionTitle = null;
	}
	const pendingTitle = extensionTitle;
	if (pendingTitle && pendingTitle.sessionId === undefined && incomingStatus.sessionId) {
		pendingTitle.sessionId = incomingStatus.sessionId;
	}
	const status = extensionTitle && extensionTitle.sessionId === incomingStatus.sessionId
		? { ...incomingStatus, sessionName: extensionTitle.title }
		: incomingStatus;
	if (!everConnected && status.connected) {
		everConnected = true;
		retireBootSplash();
	}
	if (currentStatus?.sessionId !== status.sessionId) {
		// A rename in flight belongs to the session that was on screen when it
		// started. Discard it rather than let Enter land on whatever replaced it.
		if (titleEditing && titleEditing.sessionId !== status.sessionId) titleEditing.finish(false);
		// Drop the previous session's tree before repainting — otherwise the old
		// subagent rows linger as a stuck artifact until the next children push.
		// `subagentsExpanded` deliberately survives: browsing into a subagent is a
		// session change, and collapsing the strip under the operator mid-navigation
		// is exactly the freeze that made siblings unreachable.
		sessionChildren = [];
		sessionParent = null;
		sessionSiblings = [];
		sessionViewedId = null;
		spawnSeenBaseline = false;
		resetSubagentActivityBaseline();
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

	if (!titleEditing) {
		if (status.sessionName) {
			sessionTitle.textContent = status.sessionName;
			sessionTitleWrap.style.display = "";
			sessionTitle.title = `${status.sessionName} — double-click to rename`;
		} else {
			sessionTitle.textContent = status.sessionId ? `session ${status.sessionId.slice(0, 8)}` : "";
			sessionTitleWrap.style.display = status.sessionId ? "" : "none";
			sessionTitle.title = "Unnamed session — double-click to name it";
		}
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
	// The strip says "offline"; the composer has to mean it, or the operator's
	// prompt disappears into a 120s timeout with a green dot above it.
	composer.setEnabled(status.connected && !status.restoring);
	composer.setContext(status.contextPercent, status.contextTokens, status.contextWindow);
	// Unconditional: skipping this on a status that carries no override left the
	// previous session's tick painted on the bar of the session now on screen.
	composer.setCompactThreshold(status.compactThresholdPercent ?? null, status.compactDefaultPercent ?? null);
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

function addNotice(level: "info" | "warning" | "error", text: string, action?: { id: string; label: string }): void {
	const note = el("div", `notice ${level}`);
	note.appendChild(el("span", "", text));
	if (action) {
		// The id is the host's own capability token; the webview only hands it back.
		const run = el("button", "notice-action") as HTMLButtonElement;
		run.textContent = action.label;
		run.title = action.label;
		run.addEventListener("click", () => {
			run.disabled = true;
			post({ type: "noticeAction", id: action.id });
			retireNotice(note);
		});
		note.appendChild(run);
	}
	const dismiss = el("button", "notice-dismiss");
	dismiss.title = "Dismiss";
	dismiss.setAttribute("aria-label", "Dismiss this notice");
	dismiss.appendChild(icon("close", 11));
	dismiss.addEventListener("click", () => retireNotice(note));
	note.appendChild(dismiss);
	notices.appendChild(note);
	// The stack is a sibling ABOVE the transcript, so every notice that arrives or
	// leaves resizes the scroller. Re-pin for the same reason the subagents strip
	// does: this only moves a reader who was already following the tail, and is a
	// no-op for one parked mid-history.
	transcript.scrollToBottom();
	if (level === "info") setTimeout(() => retireNotice(note), 9000);
}

/** Remove a notice and give the tail back to whoever was following it. */
function retireNotice(note: HTMLElement): void {
	if (!note.isConnected) return;
	note.remove();
	transcript.scrollToBottom();
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
			adoptAuthoritativeSession(message.status.sessionId);
			pendingPrompts.clear();
			transcript.clearSpawnCards?.();
			spawnSeenBaseline = false;
			resetSubagentActivityBaseline();
			transcript.renderSnapshot(message.messages ?? []);
			// Up/Down recall has to survive a reload or a resume, so it is seeded
			// from the thread itself rather than only from what this panel sent.
			composer.setPromptHistory(userPromptsOf(message.messages ?? []));
			// applyStatus already sets the streaming state from the union of the
			// transcript and the host status; re-setting it from the transcript
			// alone would drop a run that started before we attached.
			applyStatus(message.status);
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
			// Authoritative for the thread now on screen: an empty payload means
			// "no draft here", and must clear the previous thread's unsent text
			// rather than let it follow the operator into someone else's session.
			composer.setDraft(message.text ?? "");
			break;
		case "compactThreshold":
			// The host sends the agent default alongside the override; reading it off
			// the last status instead lost it entirely before the first snapshot.
			composer.setCompactThreshold(message.percent, message.defaultPercent ?? currentStatus?.compactDefaultPercent ?? null);
			break;
		case "sessionChildren": {
			sessionChildren = message.children ?? [];
			sessionParent = message.parent ?? null;
			sessionViewedId = message.viewedActiveSessionId ?? null;
			sessionSiblings = message.siblings ?? [];
			const spawnedList = message.spawned ?? [];
			for (const spawn of spawnedList) {
				transcript.injectSpawnCard({ id: spawn.activeSessionId, browseRef: spawn.browseRef, name: spawn.name, created: spawn.created });
			}
			const startedSubagents = takeStartedSubagents(spawnedList);
			// Seed cards ONLY for currently-running children; finished and idle ones
			// stay in the collapsible strip. Spams nothing on resume. `status` is what
			// makes this honest: a subagent whose own turn ended but whose children
			// are still working is running, and isStreaming alone calls it idle.
			if (!spawnSeenBaseline && sessionChildren.length > 0) {
				spawnSeenBaseline = true;
				for (const child of sessionChildren) {
					if (childStatus(child) === "running" && child.created) {
						transcript.injectSpawnCard({ id: child.activeSessionId, browseRef: child.browseRef, name: child.name, created: child.created });
					}
				}
			}
			const opened = maybeAutoExpandSubagents(startedSubagents);
			renderSubagentsStrip();
			// Expanding shrinks the transcript viewport. This only moves a reader who
			// was already following the tail; one parked mid-history keeps their place.
			if (opened) transcript.scrollToBottom();
			break;
		}
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
			adoptAuthoritativeSession(message.sessionId);
			setObserving(true);
			// Same session boundary as a snapshot: without clearing these, the
			// spawn-card dedupe keeps suppressing every id seen before the observed
			// transcript, and "Subagent spawned" never appears again for them.
			pendingPrompts.clear();
			transcript.clearSpawnCards?.();
			spawnSeenBaseline = false;
			resetSubagentActivityBaseline();
			transcript.renderSnapshot(message.messages);
			showView("chat");
			break;
		case "observedEvent":
			transcript.handleEvent(message.event);
			break;
		case "observedClosed":
			// The host sends a status after it has repainted our own session. Keep the
			// composer read-only until then so the visible transcript and target match.
			addNotice("info", "Stopped watching the live session.");
			break;
		case "notice":
			// A failure the operator has to read is painted underneath the splash.
			if (message.level !== "info") retireBootSplash();
			addNotice(message.level, message.text, message.action);
			break;
		case "installPrompt":
			// The splash sits on top of everything — drop it or the operator can
			// never reach the install guide we just told them to open.
			retireBootSplash();
			renderInstallBanner(message.url, message.reason);
			break;
		case "uiState":
			if (message.title !== undefined) {
				extensionTitle = { sessionId: currentStatus?.sessionId, title: message.title, provisional: !currentStatus };
			}
			if (currentStatus && (message.statusText !== undefined || message.title !== undefined)) {
				applyStatus({
					...currentStatus,
					...(message.statusText !== undefined ? { statusText: message.statusText } : {}),
				});
			} else if (!currentStatus) {
				// An agent can set its title before the first state snapshot arrives.
				// Paint that useful state now instead of silently dropping it.
				if (message.statusText !== undefined) liveLabel.textContent = message.statusText;
				if (message.title !== undefined && !titleEditing) {
					sessionTitle.textContent = message.title;
					sessionTitleWrap.style.display = message.title ? "" : "none";
					sessionTitle.title = message.title
						? `${message.title} — double-click to rename`
						: "Unnamed session — double-click to name it";
				}
			}
			break;
		case "fileSearchResults":
			const composerRequestId = pendingFileSearches.get(message.requestId);
			if (composerRequestId === undefined) break;
			pendingFileSearches.delete(message.requestId);
			composer.onFileSearchResults(composerRequestId, message.files);
			break;
		case "imagePicked":
			if (!pendingImageRequests.delete(message.requestId)) break;
			if (message.images.length > 0) composer.addImages(message.images);
			break;
		case "insertSelection":
			composer.addSelection(message.selection);
			break;
		case "insertMention":
			composer.insertMention(message.path);
			showView("chat");
			break;
		case "promptAccepted":
			// Prompts WITH an echo are released by onOptimisticConfirmed when the
			// agent echoes them. One without an echo (selection-only) never gets
			// that callback, so its retained payload — images included — would sit
			// in memory until the next session boundary.
			for (const [id, entry] of pendingPrompts) {
				if (entry.text.length === 0 && entry.images.length === 0) pendingPrompts.delete(id);
			}
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
			// The echo we drew will never be confirmed by an event. Use the host's
			// correlation id so rejecting one queued send cannot erase another one.
			const rejected = message.clientRequestId ? pendingPrompts.get(message.clientRequestId) : undefined;
			const removed = transcript.rejectOptimistic(message.clientRequestId);
			if (message.clientRequestId) pendingPrompts.delete(message.clientRequestId);
			// A selection-only prompt draws no local echo, so `removed` is false for
			// it — gating the restore on `removed` alone silently ate the operator's
			// attachments when the host refused the send.
			const hadEcho = Boolean(rejected && (rejected.text.length > 0 || rejected.images.length > 0));
			if (rejected && (removed || !hadEcho)) composer.restoreRejectedPayload(rejected.text, rejected.images, rejected.selections);
			addNotice("error", `Prompt rejected: ${message.error}`);
			break;
	}
}

/**
 * The thread's own user prompts, oldest first, for Up/Down recall.
 *
 * Text parts only: an image or a selection attachment cannot be typed back into
 * the box, and the host composes the attachment envelope itself, so recalling
 * anything but the words would put text in the composer that never matches the
 * message it came from.
 */
function userPromptsOf(messages: AgentMessage[]): string[] {
	const prompts: string[] = [];
	for (const message of messages) {
		if (!message || (message as { role?: unknown }).role !== "user") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			if (content.trim()) prompts.push(content);
		} else if (Array.isArray(content)) {
			const text = content
				.filter((part) => part && (part as { type?: unknown }).type === "text")
				.map((part) => (part as { text?: string }).text ?? "")
				.join("\n")
				.trim();
			if (text) prompts.push(text);
		}
	}
	return prompts;
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
// Bottom stack, in the order the operator reads it: who is working (subagents),
// then what changed outside this thread, then what the agent itself changed —
// closest to the composer because it is the one tied to the reply being written.
// `changedFilesBar` used to live inside the transcript view, which put outside
// edits above the subagent strip and buried the agent's own changes under them.
subagentsStrip.after(changedFilesBar);
changedFilesBar.after(threadDiffsPanel.root);

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
