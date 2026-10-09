/**
 * Transcript: message rendering and the live agent-event state machine.
 */

import { agentIdentityKey, applyAgentIdentity } from "./agent-identity.js";
import { parseIpythonBashCell, previewBashCommand, previewIpythonCode } from "./code-preview.js";
import { butterfly, el, icon } from "./dom.js";
import { copyToClipboard, renderMarkdown, type LinkHandlers } from "./markdown.js";

/**
 * How a tool call should be presented.
 *
 * The trap: prime-agent's default active toolset is `ipython` alone
 * (sdk.ts `initialActiveToolNames ?? ["ipython"]`, and the extension never
 * passes `--tools`), so a shell run arrives as an ipython cell whose first line
 * is `%%bash` — never as a tool literally named `bash`. Keying the terminal
 * chrome, the section label and the copy fence on the tool name meant every
 * real shell run rendered, and pasted, as Python.
 */
interface ToolView {
	/** Drives the chrome and the fence: "shell" | "python" | the tool's own name. */
	kind: string;
	/** Section header above the call. */
	label: string;
	/** Markdown fence language ("" = plain fence). */
	lang: string;
	/** The call itself, with the `%%bash` magic line stripped off a shell cell. */
	input: string;
}

/** A selection boundary as a child-index path from the transcript scroller. */
interface SelectionPoint {
	path: number[];
	offset: number;
}

function isExpanded(block: HTMLElement): boolean {
	return block instanceof HTMLDetailsElement ? block.open : block.classList.contains("open");
}

function lastTextNode(root: HTMLElement): Text | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	let node: Node | null;
	while ((node = walker.nextNode())) last = node as Text;
	return last;
}

/**
 * The collapsed tool row reads the word "ipython" on every python-fluent card,
 * and in a kernel-heavy thread that single word eats the row's breathing room
 * for zero information — the dot already carries running/done, the summary
 * carries what the cell did. So the ipython name in the COLLAPSED header is a
 * kind glyph: a snake for python, a terminal for a %%bash cell. Hover still
 * says "ipython", and the expanded body keeps the word spelled out. Any other
 * tool keeps its text name.
 */
function toolHeaderName(name: string, kind: string): HTMLSpanElement {
	if (name !== "ipython") return el("span", "tool-name", name);
	const span = el("span", "tool-glyph");
	span.title = name;
	span.setAttribute("aria-label", name);
	span.appendChild(icon(kind === "shell" ? "terminal" : "python", 12));
	return span;
}

function toolView(name: string, args: Record<string, unknown>): ToolView {
	const code = args?.code;
	if (name === "ipython" && typeof code === "string") {
		const cell = parseIpythonBashCell(code);
		if (cell) return { kind: "shell", label: "shell", lang: "bash", input: cell.body.replace(/\n+$/, "") };
		return { kind: "python", label: "python", lang: "python", input: code };
	}
	const command = args?.command;
	if (typeof command === "string") return { kind: "shell", label: "shell", lang: "bash", input: command };
	if (typeof code === "string") return { kind: name, label: "input", lang: "", input: code };
	return { kind: name, label: "input", lang: "", input: JSON.stringify(args, null, 2) };
}

function buildContent(
	text: string,
	images: Array<{ data: string; mimeType: string }>,
): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
	if (text) content.push({ type: "text", text });
	for (const img of images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
	return content;
}
import type {
	AgentEvent,
	AgentMessage,
	AssistantMessage,
	SessionChild,
	ToolResultMessage,
	UserMessage,
} from "../src/protocol.js";

export interface TranscriptDeps {
	onOpenLink: (href: string) => void;
	onOpenFile: (path: string, startLine?: number, endLine?: number) => void;
	/** A file link in prose was clicked; the host resolves it (absolute, relative, or an agent's sandbox path). */
	onOpenLinkedFile: (path: string, startLine?: number, endLine?: number) => void;
	onOpenDiff: (path: string) => void;
	onForkFromUser: (ordinal: number) => void;
	onSpawnedCardClick: (browseRef: string) => void;
	onNewSession: () => void;
	onShowHistory: () => void;
	onFocusComposer: () => void;
	onOptimisticConfirmed?: (clientRequestId: string) => void;
}

interface SpawnCardOptions {
	/** Current daemon target, for matching only. Never used as browse authority. */
	id: string;
	sessionId?: string;
	browseRef?: string;
	name?: string;
	created?: string | null;
}

interface SpawnCard {
	card: HTMLButtonElement;
	label: HTMLElement;
	view: HTMLElement;
	options: SpawnCardOptions;
}

/** prime-agent's compaction marker: the summary replaces everything before it. */
interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary?: string;
	tokensBefore?: number;
	retainedMessageCount?: number;
	timestamp?: number;
}

/** An agent-authored entry (agent messages, notes) that carries its own display flag. */
interface CustomDisplayMessage {
	role: "custom";
	customType?: string;
	content?: string;
	display?: boolean;
	details?: RefinementOutcomeDetails;
	timestamp?: number;
}

/** prime-agent 0.9.5's `customType: "refinement_outcome"` — the CLI's "◆ Harness refined" card data. */
interface RefinementEdit {
	action?: string;
	kind?: string;
	id?: string;
	applied?: boolean;
	error?: string;
	before?: { scope?: string };
	after?: { scope?: string };
}

interface RefinementOutcomeDetails {
	refinementId?: string;
	summary?: string;
	scope?: string;
	rollbackOf?: string;
	edits?: RefinementEdit[];
}

/** Rows built on open. Enough to fill several screens without paying for the tail. */
const INITIAL_RENDER = 150;
/** How many older messages one "load earlier" click brings in. */
const LOAD_BATCH = 100;
/** Ceiling on rendered rows in a long-running session, and the level trimming targets. */
const MAX_RENDERED_ROWS = 600;
/** How close to the top counts as "reading back", and pulls the next batch in. */
const LAZY_LOAD_MARGIN_PX = 400;
/** Chips drawn in the expanded changed-files strip before it says "+N more". */
const CHANGED_FILES_MAX = 40;
const PRUNE_TO = 400;

/** Fastest a streaming call's collapsed row may be rewritten. */
const SUMMARY_MIN_INTERVAL_MS = 300;

interface ToolBlock {
	root: HTMLElement;
	chevron: SVGSVGElement;
	/** Kind glyph in place of a text name (ipython cells), swapped when args change the kind. */
	glyph: HTMLSpanElement | null;
	summary: HTMLElement;
	pill: HTMLElement;
	body: HTMLElement;
	inputSection: HTMLElement;
	resultSection: HTMLElement | null;
	state: "running" | "done" | "error";
	/**
	 * Length of the call text currently painted. Tool arguments arrive in pieces,
	 * so the card is rebuilt whenever a longer version shows up — and never by a
	 * shorter one, which is how a late partial frame is stopped from blanking it.
	 */
	renderedInputLen: number;
	/** What the call card is currently structured as; a streamed update that keeps it can repaint in place. */
	inputSig: string;
	/** The collapsed-row text on screen, when it was last written, and a change waiting for its turn. */
	summaryText: string;
	summaryAt: number;
	summaryPending?: string;
	summaryTimer?: number;
	/** The call text now painted, read by the copy button at click time rather than captured at paint time. */
	inputText: string;
}

/** A locally rendered prompt which has not yet been confirmed by the agent. */
interface OptimisticUserRow {
	clientRequestId: string;
	text: string;
	/** File references distinguish same-companion queued sends; bodies never enter the DOM. */
	fileAppendix?: string;
	/** Exact ordered image identity prevents same-text queue rows swapping on delivery. */
	imageSignature: string;
	row: HTMLElement;
}

export class Transcript {
	private toolBlocks = new Map<string, ToolBlock>();
	private streamingBubble: HTMLElement | null = null;
	/** Replay events must update their existing row, never steal a settled tool card. */
	private assistantRows = new Map<string, HTMLElement>();
	private ambiguousAssistantKeys = new Set<string>();
	private assistantMessages = new WeakMap<HTMLElement, AssistantMessage>();
	private renderingKey: string | undefined;
	private anchorCounts = new Map<string, number>();
	private snapshotKeys = new WeakMap<object, string>();
	private rehydratingRows: Map<string, HTMLElement> | null = null;
	private snapshotTarget: HTMLElement[] | null = null;
	private rowMessages = new WeakMap<HTMLElement, AgentMessage>();
	private toolResultTimestamps = new Map<string, number>();
	private paneScrollTops = new WeakMap<HTMLElement, number>();
	private renderedMessage: AgentMessage | null = null;
	private compactionSignature: string | undefined;
	/** Pending optimistic rows, keyed by the webview request that created them. */
	private optimisticRows = new Map<string, OptimisticUserRow>();
	/** Ordinal of each durable user message within the complete session history. */
	private userOrdinals = new WeakMap<object, number>();
	private nextUserOrdinal = 0;
	private retryRow: HTMLElement | null = null;
	private workingRow: HTMLElement | null = null;
	private activitySlot: HTMLElement;
	private workingStartedAt = 0;
	private workingTimer: number | undefined;
	private streaming = false;
	private hasContent = false;
	/** Latest user footer still waiting for the reply that prices its turn. */
	private pendingUserFooter: HTMLElement | null = null;
	private welcome: HTMLElement | null = null;
	private changedFilesBar: HTMLElement;

	private stickToBottom = true;
	/** Collapsed until asked, and the choice survives every re-render of the strip. */
	private changedFilesExpanded = false;
	private spawnCards = new Map<string, SpawnCard>();
	/** Messages held as data, above the rendered window. */
	private olderMessages: AgentMessage[] = [];
	private earlierBar: HTMLElement | null = null;
	private prunedNotice: HTMLElement | null = null;
	private prunedCount = 0;
	/** When set, new rows go before this node instead of at the end. */
	private insertAnchor: Node | null = null;

	/**
	 * Insert a "subagent spawned" marker into the transcript, positioned by the
	 * subagent's created time so it lines up with where in the run it happened.
	 * Durable across resumes because it's re-derived from daemon state, not stored.
	 */
	clearSpawnCards(): void {
		this.spawnCards.clear();
		this.scroller.querySelectorAll(".spawned-card").forEach((n) => n.remove());
	}

	/** Refresh mounted cards from the current roster, never a captured old ref. */
	syncSpawnCards(children: readonly SessionChild[]): void {
		for (const [key, entry] of Array.from(this.spawnCards)) {
			const child = children.find((candidate) =>
				agentIdentityKey(candidate) === key ||
				(!entry.options.sessionId && candidate.activeSessionId === entry.options.id));
			this.updateSpawnCard(entry, child ? {
				id: child.activeSessionId,
				sessionId: child.sessionId ?? entry.options.sessionId,
				browseRef: child.browseRef,
				name: child.name,
				created: child.created ?? entry.options.created,
			} : { ...entry.options, browseRef: undefined });
			const nextKey = agentIdentityKey({ ...entry.options, activeSessionId: entry.options.id });
			if (nextKey !== key) {
				this.spawnCards.delete(key);
				this.spawnCards.set(nextKey, entry);
			}
		}
	}

	private updateSpawnCard(entry: SpawnCard, options: SpawnCardOptions): void {
		entry.options = options;
		applyAgentIdentity(entry.card, { ...options, activeSessionId: options.id });
		entry.label.textContent = `Subagent spawned${options.name ? ` — ${options.name}` : ""}`;
		entry.label.title = options.created ? `Started ${options.created}` : "Started";
		entry.card.disabled = !options.browseRef;
		entry.view.textContent = options.browseRef ? "view ›" : "unavailable";
		entry.card.title = options.browseRef
			? `Open ${options.name ?? "this subagent"} and expand its session branch`
			: "This subagent is not available in the current session roster";
		entry.card.setAttribute("aria-label", options.browseRef
			? `Open subagent ${options.name ?? options.sessionId ?? options.id}`
			: `Subagent ${options.name ?? options.sessionId ?? options.id} is unavailable`);
	}

	injectSpawnCard(options: SpawnCardOptions): void {
		const key = agentIdentityKey({ ...options, activeSessionId: options.id });
		if (!key) return;
		const existing = this.spawnCards.get(key) ?? [...this.spawnCards.values()].find((entry) =>
			!entry.options.sessionId && entry.options.id === options.id);
		if (existing) {
			this.updateSpawnCard(existing, { ...options, sessionId: options.sessionId ?? existing.options.sessionId });
			const nextKey = agentIdentityKey({ ...existing.options, activeSessionId: existing.options.id });
			for (const [priorKey, entry] of this.spawnCards) {
				if (entry === existing && priorKey !== nextKey) this.spawnCards.delete(priorKey);
			}
			this.spawnCards.set(nextKey, existing);
			return;
		}
		this.captureScrollFollow();
		const readingAnchor = this.readingAnchor();
		const card = el("button", "spawned-card") as HTMLButtonElement;
		card.type = "button";
		const dot = el("span", "spawned-dot");
		dot.setAttribute("aria-hidden", "true");
		const label = el("span", "spawned-label");
		const view = el("span", "spawned-view");
		card.append(dot, label, view);
		const entry: SpawnCard = { card, label, view, options };
		this.spawnCards.set(key, entry);
		this.updateSpawnCard(entry, options);
		card.addEventListener("click", () => {
			if (!card.disabled && entry.options.browseRef) this.deps.onSpawnedCardClick(entry.options.browseRef);
		});
		// Ordered insert: before the first existing row newer than created.
		const createdMs = options.created ? Date.parse(options.created) : NaN;
		let insertBefore: Element | null = null;
		if (Number.isFinite(createdMs)) {
			card.dataset.ts = String(createdMs);
			for (const row of Array.from(this.scroller.children)) {
				const t = Number((row as HTMLElement).dataset?.ts ?? "");
				if (Number.isFinite(t) && t > createdMs) {
					insertBefore = row;
					break;
				}
			}
		}
		if (insertBefore) this.scroller.insertBefore(card, insertBefore);
		else this.scroller.appendChild(card);
		this.hasContent = true;
		this.restoreReadingAnchor(readingAnchor);
		this.followScrollToBottom();
	}

	private stickToBottomFieldsPlaceholder = false;

	private stickToBottomUnused = false;
	private jumpBtn: HTMLElement | null = null;
	/**
	 * The selection as it stood the instant before a collapsible was toggled.
	 *
	 * Captured on the way IN (mousedown, capture phase) — by the time the block
	 * has toggled the browser has already collapsed the live selection, and a
	 * block that starts collapsed never gets a capture at all if you only save
	 * on the way out. Stored as child-index paths relative to the scroller, not
	 * as text: the same range has to be rebuilt after the DOM state changes, and
	 * a text anchor cannot express a selection that starts outside the block.
	 */
	private pendingSelection:
		| { start: SelectionPoint; end: SelectionPoint; block: HTMLElement; wasExpanded: boolean }
		| null = null;

	/** Child-index path from the scroller down to a node, plus the offset in it. */
	private capturePoint(node: Node, offset: number): SelectionPoint | null {
		const path: number[] = [];
		let current: Node | null = node;
		while (current && current !== this.scroller) {
			const parent: Node | null = current.parentNode;
			if (!parent) return null;
			path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
			current = parent;
		}
		return current === this.scroller ? { path, offset } : null;
	}

	private resolvePoint(point: SelectionPoint): { node: Node; offset: number } | null {
		let node: Node = this.scroller;
		for (const index of point.path) {
			const next = node.childNodes[index];
			if (!next) return null;
			node = next;
		}
		return { node, offset: Math.min(point.offset, node.nodeType === Node.TEXT_NODE ? (node as Text).data.length : node.childNodes.length) };
	}

	private captureSelection(block: HTMLElement): void {
		this.pendingSelection = null;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
		const range = sel.getRangeAt(0);
		// No `block.contains` guard: the selection #22 describes is dragged
		// across the collapsed block AND the prose around it, so its common
		// ancestor is the transcript, not the block.
		const start = this.capturePoint(range.startContainer, range.startOffset);
		const end = this.capturePoint(range.endContainer, range.endOffset);
		if (!start || !end) return;
		this.pendingSelection = { start, end, block, wasExpanded: isExpanded(block) };
	}

	/**
	 * Put the selection back over the toggled block. Expanding never removes
	 * nodes (details keeps its children, .tool-body is only display:none), so
	 * the captured paths still resolve and the revealed text falls inside a
	 * range that already spanned the block. When the selection ended *inside*
	 * the block, sweep the end forward over what was just revealed — that is
	 * the "include it so they don't have to select again" half of the ask.
	 */
	private restoreSelection(): void {
		const pending = this.pendingSelection;
		this.pendingSelection = null;
		if (!pending) return;
		const start = this.resolvePoint(pending.start);
		let end = this.resolvePoint(pending.end);
		if (!start || !end) return;
		// Only on an actual expand — a click that toggled nothing (the card's own
		// copy button) must not silently grow what the operator had selected.
		if (pending.block.contains(end.node) && isExpanded(pending.block) && !pending.wasExpanded) {
			const last = lastTextNode(pending.block);
			if (last) end = { node: last, offset: last.data.length };
		}
		const range = document.createRange();
		try {
			range.setStart(start.node, start.offset);
			range.setEnd(end.node, end.offset);
		} catch {
			return; // stale paths (re-render between capture and toggle)
		}
		if (range.collapsed) return;
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}

	private wireSelectionPreserve(): void {
		// Snapshot before the browser's default mousedown handling collapses it.
		this.scroller.addEventListener("mousedown", (event) => {
			const target = event.target as HTMLElement | null;
			const toggler = target?.closest(".tool-toggle, details.thinking > summary") as HTMLElement | null;
			if (!toggler) {
				this.pendingSelection = null; // a click elsewhere is a new selection, not a restore
				return;
			}
			const block = (toggler.closest(".tool") ?? toggler.closest("details.thinking")) as HTMLElement | null;
			if (block) this.captureSelection(block);
		}, true);
		// <details> thinking blocks toggle asynchronously.
		this.scroller.addEventListener("toggle", () => this.restoreSelection(), true);
		// .tool cards toggle a class in their own click handler; run after it.
		this.scroller.addEventListener("click", (event) => {
			if (!(event.target as HTMLElement | null)?.closest(".tool-toggle")) return;
			setTimeout(() => this.restoreSelection(), 0);
		}, true);
	}

	private readonly links: LinkHandlers;

	constructor(
		private readonly scroller: HTMLElement,
		changedFilesBar: HTMLElement,
		private readonly deps: TranscriptDeps,
	) {
		this.changedFilesBar = changedFilesBar;
		this.activitySlot = el("div", "chat-activity");
		this.activitySlot.setAttribute("aria-label", "Agent activity");
		this.scroller.parentElement?.appendChild(this.activitySlot);
		this.links = {
			external: (href) => deps.onOpenLink(href),
			file: (path, startLine, endLine) => deps.onOpenLinkedFile(path, startLine, endLine),
		};
		// Scroll-lock: auto-follow only while the reader is already at the bottom.
		//
		// Intent is read from the input events, not from the scroll position. A
		// scroll event lands a frame after the gesture, so on a fast stream an
		// auto-follow could fire in between and drag the reader back down before
		// their flick was ever noticed — the fight this used to lose. wheel and
		// touchmove unstick synchronously, so the very next frame already knows.
		this.wireSelectionPreserve();
		this.scroller.addEventListener("wheel", (event) => {
			// Ctrl-wheel also carries trackpad pinch. Leave platform zoom alone.
			if (event.ctrlKey) return;
			const delta = event.deltaY;
			if (!event.metaKey && !event.altKey && !event.shiftKey && Math.abs(delta) > Math.abs(event.deltaX)) {
				this.updateActivityDirection(delta);
			}
			this.snapshotScrollRemainder = 0;
			if (delta < 0) this.setStick(false);
			else if (delta > 0 && this.atBottom()) {
				// A downward wheel inside code/output is not an outer return to
				// latest, even when the transcript itself is still at the bottom.
				let target = event.target instanceof HTMLElement ? event.target : null;
				while (target && target !== this.scroller) {
					if (target.scrollHeight > target.clientHeight + 4 && /auto|scroll/.test(window.getComputedStyle(target).overflowY)) return;
					target = target.parentElement;
				}
				this.setStick(true);
			}
		}, { passive: true });
		// Only the jump button receives pointer input in the floating strip.
		// Forward wheels over it to the transcript instead of trapping scrolling.
		this.activitySlot.addEventListener("wheel", (event) => {
			// Never consume zoom, horizontal swipes, or modified platform gestures.
			if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
			this.updateActivityDirection(event.deltaY);
			this.snapshotScrollRemainder = 0;
			if (event.deltaY < 0) this.setStick(false);
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scroller.clientHeight : 1;
			this.scroller.scrollTop += event.deltaY * unit;
			if (event.deltaY > 0 && this.atBottom()) this.setStick(true);
			event.preventDefault();
		}, { passive: false });
		let touchY: number | undefined;
		this.scroller.addEventListener("touchstart", (event) => {
			touchY = event.touches[0]?.clientY;
		}, { passive: true });
		this.scroller.addEventListener("touchmove", (event) => {
			const nextY = event.touches[0]?.clientY;
			if (touchY !== undefined && nextY !== undefined) {
				const delta = touchY - nextY;
				this.updateActivityDirection(delta);
				if (delta < 0) this.setStick(false);
			}
			touchY = nextY;
			this.snapshotScrollRemainder = 0;
			if (!this.atBottom()) this.setStick(false);
		}, { passive: true });
		this.scroller.addEventListener("keydown", (event) => {
			// Selection and platform shortcuts are not vertical reading intent.
			if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey && event.key !== " ") return;
			if ((event.target as HTMLElement | null)?.closest("input, textarea, select, button, summary, [contenteditable]")) return;
			const delta = ["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey ? -1
				: ["ArrowDown", "PageDown", "End", " "].includes(event.key) ? 1 : 0;
			this.updateActivityDirection(delta);
			if (delta < 0) this.setStick(false);
		});
		this.scroller.addEventListener("scroll", () => {
			const top = this.scroller.scrollTop;
			if (Math.abs(top - this.lastScrollTop) > 1) this.snapshotScrollRemainder = 0;
			// A delayed event for our own snap may arrive after content grows.
			// Keep following only if the position is still the one WE wrote.
			// Growth must never hide a real scrollbar/keyboard/touch move.
			if (this.atBottom() && (this.stickToBottom || top > this.lastScrollTop + 1)) this.setStick(true);
			else if (Math.abs(top - this.lastScrollTop) > 1 || this.lastScrollHeight === 0 || this.scroller.scrollHeight <= this.lastScrollHeight) this.setStick(false);
			// While following, retain the geometry of our last snap. An ignored
			// growth event must not make the next pre-render check look off-tail.
			if (!this.stickToBottom || this.atBottom()) {
				this.lastScrollTop = top;
				this.lastScrollHeight = this.scroller.scrollHeight;
			}
			this.maybeLoadEarlier();
		}, { passive: true });
		// A viewport that SHRINKS moves the bottom without moving the reader.
		//
		// The scroller is a flex child, so the subagents strip appearing under it,
		// the composer growing, or the panel being resized all cut its height while
		// scrollTop stays put — and since scrollTop never changes, no scroll event
		// fires and nothing notices. The reader is left exactly that many pixels
		// above the newest output with the lock still claiming they are following,
		// so not even the jump pill is offered. Landing in a subagent is where it
		// bites: the strip gains a parent row and a sibling list in the same frame
		// the thread is painted, and the tail lands just under the fold.
		//
		// Re-pin, never force: scrollToBottom() is a no-op for a reader who chose
		// to scroll away, so a resize cannot drag anyone back down.
		if (typeof ResizeObserver !== "undefined") {
			this.viewportObserver = new ResizeObserver(() => this.scrollToBottom());
			this.viewportObserver.observe(this.scroller);
		}
	}

	private viewportObserver: ResizeObserver | null = null;
	private lastScrollTop = 0;
	private lastScrollHeight = 0;
	private snapshotScrollRemainder = 0;
	/** The reader's position is checked BEFORE a render grows the content. */
	private captureScrollFollow(): void {
		if (!this.stickToBottom) return;
		if (this.atBottom()) {
			// Accept a reader move within 50px before growth. The post-render
			// check must not reclassify it using the NEW content height.
			this.lastScrollTop = this.scroller.scrollTop;
			this.lastScrollHeight = this.scroller.scrollHeight;
			return;
		}
		// Asynchronous layout (an image/code pane) can grow between frames.
		// Only exempt growth when the reader has not moved from our last snap.
		const unchanged = Math.abs(this.scroller.scrollTop - this.lastScrollTop) <= 1;
		const grew = this.lastScrollHeight > 0 && this.scroller.scrollHeight > this.lastScrollHeight;
		if (!unchanged || !grew) this.setStick(false);
	}

	/** Capture the visible row before a live mutation while the reader is detached. */
	private readingAnchor(): { row: HTMLElement; offset: number } | null {
		if (this.stickToBottom) return null;
		const top = this.scroller.getBoundingClientRect().top;
		const row = Array.from(this.scroller.children).find((node) =>
			node !== this.earlierBar && node !== this.prunedNotice && node.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
		return row ? { row, offset: row.getBoundingClientRect().top - top } : null;
	}

	private restoreReadingAnchor(anchor: { row: HTMLElement; offset: number } | null): void {
		if (!anchor?.row.isConnected || this.stickToBottom) return;
		const delta = anchor.row.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - anchor.offset;
		if (Math.abs(delta) > 0.01) this.scroller.scrollTop += delta;
		this.lastScrollTop = this.scroller.scrollTop;
		this.lastScrollHeight = this.scroller.scrollHeight;
	}

	private atBottom(): boolean {
		return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight <= 50;
	}

	/** Reader direction is independent of follow intent and host-driven layout. */
	private updateActivityDirection(delta: number): void {
		if (delta !== 0) this.activitySlot.classList.toggle("reading-up", delta < 0);
	}

	private setStick(value: boolean): void {
		if (this.stickToBottom === value) return;
		this.stickToBottom = value;
		this.updateJumpButton();
	}

	private updateJumpButton(): void {
		if (this.stickToBottom) {
			this.jumpBtn?.classList.remove("visible");
			return;
		}
		if (!this.jumpBtn) {
			this.jumpBtn = el("button", "jump-to-latest");
			this.jumpBtn.title = "Jump to bottom";
			this.jumpBtn.setAttribute("aria-label", "New messages — jump to bottom");
			this.jumpBtn.appendChild(el("span", "", "New messages"));
			this.jumpBtn.appendChild(icon("chevron", 12));
			this.jumpBtn.classList.add("down");
			this.jumpBtn.addEventListener("click", () => {
				this.forceScrollToBottom();
			});
			// Share Working's floating strip, outside the scrolling content.
			// Showing the control must not resize the transcript.
			this.activitySlot.appendChild(this.jumpBtn);
		}
		this.jumpBtn.classList.add("visible");
	}

	// ---------------------------------------------------------------
	// Welcome / empty state
	// ---------------------------------------------------------------

	showWelcome(): void {
		if (this.hasContent || this.welcome) return;
		const root = el("div", "welcome");
		const mark = el("div", "welcome-mark");
		mark.appendChild(butterfly(52));
		root.appendChild(mark);
		root.appendChild(el("div", "welcome-title", "Prime Agent"));
		root.appendChild(el("div", "welcome-tag", "RLM agent with a persistent Python kernel,\nskills, subagents, and living sessions."));

		const quick = el("div", "welcome-actions");
		const newBtn = document.createElement("button");
		newBtn.className = "welcome-action";
		newBtn.appendChild(icon("plus", 14));
		newBtn.appendChild(el("span", "", "New chat"));
		newBtn.addEventListener("click", () => this.deps.onNewSession());
		const histBtn = document.createElement("button");
		histBtn.className = "welcome-action";
		histBtn.appendChild(icon("history", 14));
		histBtn.appendChild(el("span", "", "Resume session"));
		histBtn.addEventListener("click", () => this.deps.onShowHistory());
		quick.append(newBtn, histBtn);
		root.appendChild(quick);

		const hints = el("div", "welcome-hints");
		for (const [iconName, text] of [
			["message", "Ask anything — the agent sees your workspace"],
			["file", "@ mentions files · / runs skills and commands"],
			["selection", "Attach a selection with Cmd+Alt+K / Alt+K"],
			["layers", "Sessions stay live — close the view and come back"],
		] as Array<[keyof typeof import("./dom.js").icons, string]>) {
			const row = el("div", "welcome-hint");
			row.appendChild(icon(iconName, 13));
			row.appendChild(el("span", "", text));
			hints.appendChild(row);
		}
		root.appendChild(hints);

		this.place(root);
		this.welcome = root;
	}

	private dismissWelcome(): void {
		this.welcome?.remove();
		this.welcome = null;
	}

	// ---------------------------------------------------------------
	// Snapshot rebuild
	// ---------------------------------------------------------------

	renderSnapshot(messages: AgentMessage[], preserveScroll = false, streaming = false, durableMessages = false): void {
		if (preserveScroll) this.captureScrollFollow();
		const following = this.stickToBottom;
		const savedTop = this.scroller.scrollTop;
		const viewportTop = this.scroller.getBoundingClientRect().top;
		const anchor = preserveScroll && !following
			? Array.from(this.scroller.children).find((node) =>
				(node as HTMLElement).dataset.messageKey && node.getBoundingClientRect().bottom > viewportTop)
			: undefined;
		const anchorKey = (anchor as HTMLElement | undefined)?.dataset.messageKey;
		const anchorOffset = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0;
		// Keep history that the reader already loaded; a resync is not navigation.
		const renderStart = preserveScroll && (this.olderMessages.length > 0 || this.scroller.querySelectorAll(":scope > .row").length >= INITIAL_RENDER)
			? Math.min(this.olderMessages.length, Math.max(0, messages.length - INITIAL_RENDER))
			: Math.max(0, messages.length - INITIAL_RENDER);
		if (preserveScroll) {
			this.rehydrateSnapshot(messages, renderStart, streaming, durableMessages);
			if (following) {
				this.pruneOldRows();
				this.followScrollToBottom();
			} else {
				const restored = anchorKey ? Array.from(this.scroller.children).find((node) =>
					(node as HTMLElement).dataset.messageKey === anchorKey) : undefined;
				const target = restored
					? this.scroller.scrollTop + restored.getBoundingClientRect().top - viewportTop - anchorOffset + this.snapshotScrollRemainder
					: savedTop;
				this.scroller.scrollTop = target;
				const remainder = target - this.scroller.scrollTop;
				// Carry subpixel rounding only, never a clamped-away tail offset.
				this.snapshotScrollRemainder = restored && Math.abs(remainder) <= 1 ? remainder : 0;
				this.stickToBottom = false;
				this.lastScrollTop = this.scroller.scrollTop;
				this.lastScrollHeight = this.scroller.scrollHeight;
				this.updateJumpButton();
			}
			return;
		}
		this.scroller.textContent = "";
		this.snapshotScrollRemainder = 0;
		this.compactionSignature = this.snapshotCompactionSignature(messages);
		this.spawnCards.clear();
		this.assistantRows.clear();
		this.ambiguousAssistantKeys.clear();
		this.snapshotKeys = new WeakMap<object, string>();
		this.anchorCounts.clear();
		messages.forEach((message, index) => {
			const base = this.messageAnchorBase(message) ?? `index:${index}`;
			this.snapshotKeys.set(message, this.nextAnchorKey(base));
		});
		for (const block of this.toolBlocks.values()) window.clearTimeout(block.summaryTimer);
		this.toolBlocks.clear();
		this.toolResultTimestamps.clear();
		this.streamingBubble = null;
		this.welcome = null;
		// Both point at nodes in the scroller we just emptied.
		this.pendingUserFooter = null;
		this.pendingSelection = null;
		// Run state belongs to the session we just left. Inheriting it paints a
		// brand-new session as "running" with a Stop button no agent_end can clear,
		// and stopWorking() also kills the 1s timer whose row we just deleted.
		this.streaming = streaming;
		this.resetWorking();
		this.optimisticRows.clear();
		this.userOrdinals = new WeakMap<object, number>();
		this.nextUserOrdinal = 0;
		for (const message of messages) {
			if (message.role === "user") this.userOrdinals.set(message, this.nextUserOrdinal++);
		}
		// Changed-files state is scoped to the session on screen. A snapshot is the
		// boundary between sessions (and is also used by restart), so retaining the
		// previous thread's strip here would be a false claim about this thread.
		this.renderChangedFiles([]);
		this.jumpBtn?.remove();
		this.jumpBtn = null;
		// Windowing state belongs to the transcript we just discarded.
		this.prunedNotice = null;
		this.prunedCount = 0;
		this.insertAnchor = null;
		this.earlierBar = null;
		this.hasContent = messages.length > 0;
		// Long threads open at the bottom and only build what is near it. A
		// 3000-message session rendered whole costs ~330ms and ~100k DOM nodes
		// before the operator sees anything, and every reflow after that pays for
		// all of it. The rest stays in memory as data and renders on demand.
		this.olderMessages = messages.slice(0, renderStart);
		for (const message of messages.slice(renderStart)) {
			this.renderMessage(message, false, durableMessages);
		}
		this.renderEarlierBar();
		if (!this.hasContent) this.showWelcome();
		if (streaming) this.startWorking();
		// A freshly opened session always lands on the latest message, whatever
		// the scroll position was in the session we came from.
		if (!preserveScroll || following) {
			this.forceScrollToBottom();
		} else {
			const restored = anchorKey ? Array.from(this.scroller.children).find((node) =>
				(node as HTMLElement).dataset.messageKey === anchorKey) : undefined;
			this.scroller.scrollTop = restored
				? this.scroller.scrollTop + restored.getBoundingClientRect().top - viewportTop - anchorOffset
				: savedTop;
			this.stickToBottom = false;
			this.lastScrollTop = this.scroller.scrollTop;
			this.lastScrollHeight = this.scroller.scrollHeight;
			this.updateJumpButton();
		}
	}

	private snapshotCompactionSignature(messages: AgentMessage[]): string | undefined {
		const marker = messages.find((message) => message.role === "compactionSummary");
		return marker ? JSON.stringify(marker) : undefined;
	}

	/** Update an existing session without disconnecting its unchanged rows or tool cards. */
	private rehydrateSnapshot(messages: AgentMessage[], renderStart: number, streaming: boolean, durableMessages: boolean): void {
		this.streaming = streaming;
		this.renderChangedFiles([]);
		const existing = Array.from(this.scroller.children) as HTMLElement[];
		const rows = new Map(existing.filter((row) => row.dataset.messageKey).map((row) => [row.dataset.messageKey!, row]));
		const live = this.streamingBubble;
		const signature = this.snapshotCompactionSignature(messages);
		const compacted = signature !== this.compactionSignature;
		this.compactionSignature = signature;
		this.snapshotKeys = new WeakMap<object, string>();
		this.anchorCounts.clear();
		messages.forEach((message, index) => {
			this.snapshotKeys.set(message, this.nextAnchorKey(this.messageAnchorBase(message) ?? `index:${index}`));
		});
		if (this.prunedCount > 0 && !compacted) {
			const first = existing.find((row) => row.dataset.messageKey);
			const index = first ? messages.findIndex((message) => this.snapshotKeys.get(message) === first.dataset.messageKey) : -1;
			if (index >= 0) renderStart = Math.max(renderStart, index);
		}
		this.userOrdinals = new WeakMap<object, number>();
		this.nextUserOrdinal = 0;
		for (const message of messages) {
			if (message.role === "user") this.userOrdinals.set(message, this.nextUserOrdinal++);
		}
		this.olderMessages = messages.slice(0, this.prunedCount > 0 && !compacted ? this.olderMessages.length : renderStart);
		const pendingFooter = this.pendingUserFooter;
		this.pendingUserFooter = null;
		this.rehydratingRows = rows;
		this.snapshotTarget = [];
		let desired: HTMLElement[];
		try {
			for (const message of messages.slice(renderStart)) this.renderMessage(message, false, durableMessages);
			desired = this.snapshotTarget;
		} finally {
			this.rehydratingRows = null;
			this.snapshotTarget = null;
		}
		// Attach snapshots omit the in-flight reply. Keep its mounted slot until
		// the replay/deltas arrive; never erase it for a frame and then recreate it.
		if (streaming && !compacted && live && !desired.includes(live) && live.isConnected) desired.push(live);

		for (const pending of this.optimisticRows.values()) {
			if (pending.row.isConnected && !desired.includes(pending.row)) desired.push(pending.row);
		}
		// Historical paint must not steal an omitted optimistic prompt's price.
		// But a removed prompt, or one before a newer durable user, no longer owns it.
		if (pendingFooter && !pendingFooter.querySelector(".uf-cost")) {
			const priorIndex = desired.findIndex((row) => row.contains(pendingFooter));
			const nextIndex = this.pendingUserFooter
				? desired.findIndex((row) => row.contains(this.pendingUserFooter)) : -1;
			if (priorIndex >= 0 && priorIndex >= nextIndex) this.pendingUserFooter = pendingFooter;
		}
		// Keep chrome that is not part of the authoritative message list.
		for (const [index, row] of existing.entries()) {
			if (row === this.earlierBar || row === this.prunedNotice || row.classList.contains("spawned-card")) {
				if (!compacted && (messages.length > 0 || row === this.earlierBar || row === this.prunedNotice)) {
					const next = existing.slice(index + 1).find((node) => desired.includes(node));
					if (next) desired.splice(desired.indexOf(next), 0, row);
					else desired.push(row);
				}
			}
		}
		// Reconcile relative order, not absolute indexes: removing an obsolete row
		// first must not cause every surviving card to be detached and reinserted.
		const keep = new Set(desired);
		for (const row of existing) if (!keep.has(row)) row.remove();
		let cursor = this.scroller.firstElementChild;
		for (const row of desired) {
			if (row === this.earlierBar || row === this.prunedNotice) continue;
			while (cursor && (cursor === this.earlierBar || cursor === this.prunedNotice)) cursor = cursor.nextElementSibling;
			if (cursor === row) cursor = cursor.nextElementSibling;
			else this.scroller.insertBefore(row, cursor);
		}
		for (const [id, block] of this.toolBlocks) {
			if (!block.root.isConnected) {
				window.clearTimeout(block.summaryTimer);
				this.toolBlocks.delete(id);
				this.toolResultTimestamps.delete(id);
			}
		}
		for (const [key, row] of this.assistantRows) if (!row.isConnected && row !== live) this.assistantRows.delete(key);
		if (messages.length === 0 || compacted) this.spawnCards.clear();
		this.streaming = streaming;
		this.streamingBubble = live?.isConnected && live.dataset.settled !== "true" ? live : null;
		// Keep the message registered by the accepted snapshot. Re-registering
		// the pre-snapshot live message would lower the partial-update watermark.
		this.hasContent = desired.some((row) => this.rowMessages.has(row) || row.classList.contains("row"));
		if (this.hasContent) this.dismissWelcome();
		else this.showWelcome();
		this.renderEarlierBar();
		if (compacted) {
			this.prunedCount = 0;
			this.prunedNotice?.remove();
			this.prunedNotice = null;
		}
		if (streaming && !this.streamingBubble) this.startWorking();
		else this.stopWorking();
	}

	/**
	 * The "N earlier messages" affordance. Always states the true remaining count:
	 * a transcript that silently starts part-way through is the kind of thing that
	 * makes an operator distrust everything else on screen.
	 */
	private renderEarlierBar(): void {
		if (this.earlierBar?.isConnected && this.olderMessages.length > 0) {
			const remaining = this.olderMessages.length;
			const button = this.earlierBar.querySelector(".earlier-load") as HTMLElement;
			button.textContent = `${remaining} earlier message${remaining === 1 ? "" : "s"}`;
			button.title = `Keep scrolling up to load them, or click to bring in ${Math.min(LOAD_BATCH, remaining)} now`;
			this.renderPrunedNotice();
			return;
		}
		this.earlierBar?.remove();
		this.earlierBar = null;
		if (this.olderMessages.length === 0) {
			// The wording of the trimmed-gap marker depends on whether unrendered
			// history still sits above it.
			this.renderPrunedNotice();
			return;
		}
		const bar = el("div", "earlier-bar");
		const button = el("button", "earlier-load") as HTMLButtonElement;
		const remaining = this.olderMessages.length;
		// Scrolling up pulls these in on its own now, so the bar reads as a marker
		// of where the rendered window starts rather than a chore. It stays
		// clickable: a thread whose rows do not fill the viewport can never scroll.
		button.textContent = `${remaining} earlier message${remaining === 1 ? "" : "s"}`;
		button.title = `Keep scrolling up to load them, or click to bring in ${Math.min(LOAD_BATCH, remaining)} now`;
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			this.loadEarlier();
		});
		bar.append(button, el("span", "earlier-count", "scroll up to load"));
		this.earlierBar = bar;
		// Always the topmost row, which keeps it above the trimmed-gap marker: the
		// messages this button loads are older than the rows that were trimmed.
		this.scroller.insertBefore(bar, this.scroller.firstChild);
		this.renderPrunedNotice();
	}

	/**
	 * Pull in the next batch as the reader approaches the top, so scrolling back
	 * through a long thread just works instead of stopping at a button.
	 *
	 * Self-limiting by construction: loadEarlier restores the reading position by
	 * the exact height it just added, so scrollTop lands well clear of the margin
	 * and the next scroll event cannot re-trigger. The flag only guards the
	 * degenerate case of a batch that adds no height at all.
	 */
	private maybeLoadEarlier(): void {
		if (this.loadingEarlier || this.olderMessages.length === 0) return;
		if (this.scroller.scrollTop > LAZY_LOAD_MARGIN_PX) return;
		this.loadingEarlier = true;
		try {
			this.loadEarlier();
		} finally {
			this.loadingEarlier = false;
		}
	}

	private loadingEarlier = false;

	/** Render the next batch of older messages above the current view, in place. */
	loadEarlier(): void {
		if (this.olderMessages.length === 0) return;
		const batch = this.olderMessages.splice(Math.max(0, this.olderMessages.length - LOAD_BATCH), LOAD_BATCH);
		// Anchor on the first row that is already on screen: growing the transcript
		// upward must leave what the operator is reading exactly where it is.
		const heightBefore = this.scroller.scrollHeight;
		const topBefore = this.scroller.scrollTop;
		const anchor = this.earlierBar?.nextSibling ?? this.scroller.firstChild;
		this.insertAnchor = anchor;
		try {
			for (const message of batch) this.renderMessage(message, false);
		} finally {
			this.insertAnchor = null;
		}
		this.renderEarlierBar();
		this.scroller.scrollTop = topBefore + (this.scroller.scrollHeight - heightBefore);
		this.lastScrollTop = this.scroller.scrollTop;
		this.lastScrollHeight = this.scroller.scrollHeight;
	}

	/**
	 * Place a freshly built row. Everything that adds to the transcript goes
	 * through here so `loadEarlier` can redirect a batch above the existing rows
	 * without every call site knowing about it.
	 */
	private place(node: Node): void {
		if (node instanceof HTMLElement) {
			if (this.renderingKey) node.dataset.messageKey = this.renderingKey;
			if (this.renderedMessage) this.rowMessages.set(node, this.renderedMessage);
			if (this.snapshotTarget) {
				if (!this.snapshotTarget.includes(node)) this.snapshotTarget.push(node);
				return;
			}
		}
		if (node.parentNode === this.scroller && !this.insertAnchor) return;
		if (this.insertAnchor) this.scroller.insertBefore(node, this.insertAnchor);
		else this.scroller.appendChild(node);
	}

	/**
	 * Keep the rendered window bounded on a session that runs for hours. Only ever
	 * trims while the reader is parked at the bottom — dropping rows above someone
	 * who is reading would move the ground under them — and drops the tool blocks
	 * that went with them so the map does not outlive the DOM.
	 */
	private pruneOldRows(): void {
		if (!this.stickToBottom) return;
		const rows = this.scroller.children;
		// Chrome rows are not messages: counting (or deleting) them inflates the
		// trimmed count and drifts the effective window by a slot per cycle.
		const chrome =
			(this.earlierBar?.parentElement === this.scroller ? 1 : 0) +
			(this.jumpBtn?.parentElement === this.scroller ? 1 : 0) +
			(this.prunedNotice?.parentElement === this.scroller ? 1 : 0);
		const removable = rows.length - chrome;
		if (removable <= MAX_RENDERED_ROWS) return;
		let toRemove = removable - PRUNE_TO;
		for (const node of Array.from(rows)) {
			if (toRemove <= 0) break;
			if (node === this.earlierBar || node === this.jumpBtn || node === this.prunedNotice) continue;
			if (node.contains(this.streamingBubble) || node === this.streamingBubble) break;
			for (const [id, block] of this.toolBlocks) {
				if (node.contains(block.root)) {
					window.clearTimeout(block.summaryTimer);
					this.toolBlocks.delete(id);
					this.toolResultTimestamps.delete(id);
				}
			}
			for (const [key, row] of this.assistantRows) {
				if (row === node || node.contains(row)) this.assistantRows.delete(key);
			}
			node.remove();
			toRemove -= 1;
			this.prunedCount += 1;
		}
		if (this.prunedCount > 0) this.renderPrunedNotice();
	}

	/**
	 * Say plainly that part of the transcript is no longer rendered. This must be
	 * stated even when the "load earlier" bar is present: that bar counts only the
	 * messages never rendered (`olderMessages`) and knows nothing about rows that
	 * were rendered and later trimmed. Suppressing it left the two mechanisms
	 * meeting at an invisible seam — "Load earlier" spliced old rows straight onto
	 * a tail with hundreds of messages missing in between, reading as continuous.
	 */
	private renderPrunedNotice(): void {
		if (this.prunedCount === 0) return;
		if (!this.prunedNotice) {
			this.prunedNotice = el("div", "earlier-bar pruned-bar");
			this.prunedNotice.appendChild(el("span", "earlier-count", ""));
		}
		const label = this.prunedNotice.firstChild as HTMLElement;
		const plural = this.prunedCount === 1 ? "" : "s";
		label.textContent =
			this.olderMessages.length > 0
				? `gap: ${this.prunedCount} message${plural} between the rows above and below were trimmed from view — the session still has them`
				: `${this.prunedCount} earlier message${plural} trimmed from view — the session still has them`;
		// Placed once, directly under the "load earlier" bar, and never moved
		// afterwards: rows loaded later are inserted ABOVE it, so the marker keeps
		// standing exactly where the missing stretch is.
		if (this.prunedNotice.parentElement !== this.scroller) {
			const after = this.earlierBar?.parentElement === this.scroller ? this.earlierBar.nextSibling : this.scroller.firstChild;
			this.scroller.insertBefore(this.prunedNotice, after);
		}
	}

	// ---------------------------------------------------------------
	// Live events
	// ---------------------------------------------------------------

	private nextAnchorKey(base: string): string {
		const occurrence = this.anchorCounts.get(base) ?? 0;
		this.anchorCounts.set(base, occurrence + 1);
		return `${base}#${occurrence}`;
	}

	private messageAnchorBase(message: AgentMessage): string | undefined {
		if (message.role === "assistant") return this.assistantKeys(message as AssistantMessage)[0];
		if (message.role === "toolResult") return `result:${(message as ToolResultMessage).toolCallId}`;
		const timestamp = this.messageTimestamp(message);
		return timestamp != null ? `${message.role}:${timestamp}` : undefined;
	}

	private assistantKeys(message: AssistantMessage): string[] {
		const keys: string[] = [];
		const responseId = (message as AssistantMessage & { responseId?: string }).responseId;
		if (responseId) keys.push(`response:${responseId}`);
		for (const part of message.content ?? []) {
			if (part.type === "toolCall") keys.push(`tool:${part.id}`);
		}
		if (keys.length === 0 && message.timestamp != null) keys.push(`assistant:${message.timestamp}`);
		return keys;
	}

	private assistantRow(message: AssistantMessage): HTMLElement | undefined {
		for (const key of this.assistantKeys(message)) {
			if (this.ambiguousAssistantKeys.has(key)) continue;
			const row = this.assistantRows.get(key);
			if (row && (row.isConnected || row === this.streamingBubble) && this.compatibleAssistant(row, key, message)) return row;
		}
		return undefined;
	}

	private compatibleAssistant(row: HTMLElement, key: string, message: AssistantMessage): boolean {
		if (!key.startsWith("assistant:") || row.dataset.settled !== "true") return true;
		// Timestamp-only identities are weak. Distinct content with the same
		// millisecond is a new reply, not grounds to suppress it as replay.
		const previous = this.assistantMessages.get(row);
		return !previous || JSON.stringify(previous.content) === JSON.stringify(message.content);
	}

	private olderAssistantPartial(row: HTMLElement, message: AssistantMessage, completedIndex?: number): boolean {
		if (row.dataset.settled === "true") return true;
		const previous = this.assistantMessages.get(row);
		if (!previous) return false;
		// New parts can arrive before an existing tool slot. Match the prior
		// parts in order instead of requiring identical indexes, but never let
		// an older partial remove a known part or make its content shorter.
		let nextIndex = 0;
		for (const [index, part] of previous.content.entries()) {
			const completed = completedIndex === index ? message.content[index] : undefined;
			if (completed?.type === part.type && (part.type !== "toolCall" || completed.type === "toolCall" && completed.id === part.id)) {
				nextIndex = index + 1;
				continue;
			}
			let found = false;
			while (nextIndex < message.content.length) {
				const next = message.content[nextIndex++];
				if (part.type === "text" && next.type === "text" && next.text.length >= part.text.length
					|| part.type === "thinking" && next.type === "thinking" && next.thinking.length >= part.thinking.length
					|| part.type === "toolCall" && next.type === "toolCall" && part.id === next.id) {
					found = true;
					break;
				}
			}
			if (!found) return true;
		}
		return false;
	}

	private settledAssistantRow(message: AssistantMessage): HTMLElement | undefined {
		for (const key of this.assistantKeys(message)) {
			if (this.ambiguousAssistantKeys.has(key)) continue;
			const row = this.assistantRows.get(key);
			if (row?.isConnected && row.dataset.settled === "true" && this.compatibleAssistant(row, key, message)) return row;
		}
		return undefined;
	}

	private registerAssistant(row: HTMLElement, message: AssistantMessage, settled: boolean): void {
		const keys = this.assistantKeys(message);
		for (const key of keys) {
			const previous = this.assistantRows.get(key);
			if (key.startsWith("assistant:") && previous && previous !== row) this.ambiguousAssistantKeys.add(key);
			this.assistantRows.set(key, row);
		}
		if (keys[0] && !row.dataset.messageKey?.startsWith(`${keys[0]}#`)) {
			// A tool/response identity can arrive after an empty timestamp-only
			// start. Use the same durable base that a later snapshot will use.
			row.dataset.messageKey = this.renderingKey ?? this.nextAnchorKey(keys[0]);
		}
		this.assistantMessages.set(row, message);
		if (settled) row.dataset.settled = "true";
	}

	/** Empty message_start frames are not a row: wait for the first visible part. */
	private showStreamingBubble(): void {
		const row = this.streamingBubble;
		if (!row || !row.querySelector(":scope > .row-body")?.childNodes.length) return;
		this.stopWorking();
		if (!row.isConnected) this.place(row);
		this.hasContent = true;
	}

	/** Resolve this event's row without letting an older reply take over the live one. */
	private adoptStreamingBubble(message: AssistantMessage): HTMLElement | undefined {
		const existing = this.assistantRow(message);
		if (existing) {
			if (!this.streamingBubble) this.streamingBubble = existing;
			return existing;
		}
		if (this.streamingBubble) {
			const previous = this.assistantMessages.get(this.streamingBubble);
			const previousResponse = previous && this.assistantKeys(previous).find((key) => key.startsWith("response:"));
			const incomingResponse = this.assistantKeys(message).find((key) => key.startsWith("response:"));
			if (previousResponse && incomingResponse && previousResponse !== incomingResponse) return undefined;
			return this.streamingBubble;
		}
		this.dismissWelcome();
		this.streamingBubble = this.buildAssistantRow(message, true);
		this.showStreamingBubble();
		return this.streamingBubble;
	}

	handleEvent(event: AgentEvent): void {
		this.captureScrollFollow();
		const readingAnchor = this.readingAnchor();
		switch (event.type) {
			case "agent_start":
				this.dismissWelcome();
				this.streaming = true;
				this.startWorking();
				break;
			case "agent_end":
				this.streaming = false;
				this.stopWorking();
				this.streamingBubble = null;
				break;
			case "message_start": {
				const message = event.message;
				if (message.role === "assistant") {
					if (this.settledAssistantRow(message as AssistantMessage)) break;
					const existing = this.assistantRow(message as AssistantMessage);
					if (existing && this.streamingBubble && existing !== this.streamingBubble) break;
					this.streamingBubble = existing ?? this.buildAssistantRow(message as AssistantMessage, true);
					this.showStreamingBubble();
				} else {
					this.dismissWelcome();
					this.renderMessage(message, false);
					this.hasContent = true;
				}
				break;
			}
			case "message_update": {
				const message = event.message as AssistantMessage;
				if (message.role !== "assistant") break;
				if (this.settledAssistantRow(message)) break;
				// An update with no bubble means we joined the turn after its
				// message_start (attach mid-flight, or a catch-up after a resync).
				// Dropping it froze the transcript for the rest of the turn.
				const row = this.adoptStreamingBubble(message);
				if (row) {
					const blockEvent = event.assistantMessageEvent as { type?: string; contentIndex?: number } | undefined;
					const completedBlock = blockEvent?.type === "text_end" || blockEvent?.type === "thinking_end" || blockEvent?.type === "toolcall_end";
					const completedIndex = completedBlock ? blockEvent?.contentIndex : undefined;
					if (!this.olderAssistantPartial(row, message, completedIndex)) this.fillAssistantRow(row, message, true);
					this.showStreamingBubble();
				}
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message.role === "assistant") {
					const existing = this.settledAssistantRow(message as AssistantMessage);
					if (existing) {
						// Duplicate final frames cannot reparent tool nodes or overwrite
						// a different live reply. The settled receipt is already complete.
						break;
					}
					const row = this.adoptStreamingBubble(message as AssistantMessage);
					if (row) {
						this.fillAssistantRow(row, message as AssistantMessage, false);
						this.showStreamingBubble();
						if (row === this.streamingBubble) this.streamingBubble = null;
					}
				}
				if (this.streaming) this.startWorking();
				break;
			}
			case "tool_execution_start": {
				const completed = this.toolBlocks.get(event.toolCallId);
				if (completed && completed.state !== "running") break;
				this.stopWorking();
				const block = this.ensureToolBlock(event.toolCallId, event.toolName, event.args ?? {});
				if (!block.root.isConnected) {
					this.place(block.root);
				}
				this.setToolState(event.toolCallId, "running");
				if (this.streaming) this.startWorking();
				break;
			}
			case "tool_execution_update":
				this.updateToolPartial(event.toolCallId, event.partialResult);
				break;
			case "tool_execution_end": {
				const completed = this.toolBlocks.get(event.toolCallId);
				if (completed && completed.state !== "running") break;
				const text = extractPartialText(event.result);
				if (text) this.attachToolResultText(event.toolCallId, text, event.isError ?? false);
				else this.setToolState(event.toolCallId, event.isError ? "error" : "done");
				break;
			}
			case "compaction_start":
				this.systemNote("Compacting context…");
				break;
			case "auto_retry_start":
				this.showRetryRow(event.attempt, event.maxAttempts, event.errorMessage);
				break;
			case "auto_retry_end":
				if (event.success) {
					this.clearRetryRow();
				} else {
					this.failRetryRow(event.finalError);
					this.stopWorking();
				}
				break;
			case "turn_end":
				if (this.streaming) this.startWorking();
				break;
			default:
				break;
		}
		this.restoreReadingAnchor(readingAnchor);
		this.pruneOldRows();
		this.followScrollToBottom();
	}

	isStreaming(): boolean {
		return this.streaming;
	}

	private showRetryRow(attempt: number, maxAttempts: number, errorMessage?: string): void {
		this.clearRetryRow();
		const row = el("div", "retry-row");
		row.appendChild(el("span", "retry-icon", "⚠"));
		const label = el(
			"span",
			"retry-text",
			`Provider request failed — auto-retry ${attempt}/${maxAttempts}${errorMessage ? ` · ${errorMessage.slice(0, 90)}` : ""}`,
		);
		row.appendChild(label);
		this.place(row);
		this.retryRow = row;
		this.hasContent = true;
	}

	private clearRetryRow(): void {
		this.retryRow?.remove();
		this.retryRow = null;
	}

	private failRetryRow(finalError?: string): void {
		if (!this.retryRow) {
			this.systemNote(`Provider request failed${finalError ? `: ${finalError.slice(0, 120)}` : ""}`, true);
			return;
		}
		this.retryRow.classList.add("fatal");
		const label = this.retryRow.querySelector(".retry-text");
		if (label) label.textContent = `Provider request failed — giving up${finalError ? ` · ${finalError.slice(0, 120)}` : ""}`;
		this.retryRow = null; // leave the fatal row in the transcript
	}

	// ---------------------------------------------------------------
	// Working indicator
	// ---------------------------------------------------------------

	private startWorking(): void {
		if (!this.workingRow) {
			const row = el("div", "working-row");
			row.append(butterfly(13, "working-mark"), el("span", "working-label", "Working · 0s"));
			// A detached idle view can create the jump control before a run.
			// Always keep Working first so the control stays on the right.
			this.activitySlot.prepend(row);
			this.workingRow = row;
		}
		this.workingRow.classList.add("active");
		this.workingRow.setAttribute("aria-hidden", "false");
		if (this.workingTimer !== undefined) return;
		this.workingStartedAt = Date.now();
		const label = this.workingRow.querySelector(".working-label");
		if (label) label.textContent = "Working · 0s";
		this.workingTimer = window.setInterval(() => {
			const seconds = Math.max(0, Math.round((Date.now() - this.workingStartedAt) / 1000));
			const text = `Working · ${seconds}s`;
			if (label && label.textContent !== text) label.textContent = text;
		}, 1000);
	}

	private stopWorking(): void {
		// During a run the pill remains in its reserved slot, including streaming
		// text and tool transitions. Only the completed/aborted run retires it.
		if (this.streaming) return;
		window.clearInterval(this.workingTimer);
		this.workingTimer = undefined;
		this.workingRow?.classList.remove("active");
		this.workingRow?.setAttribute("aria-hidden", "true");
	}

	private resetWorking(): void {
		window.clearInterval(this.workingTimer);
		this.workingTimer = undefined;
		this.workingStartedAt = 0;
		this.workingRow?.remove();
		this.workingRow = null;
	}

	// ---------------------------------------------------------------
	// Message rendering
	// ---------------------------------------------------------------

	/** Render a prompt immediately and retain the exact row until the host settles it. */
	showOptimisticUserMessage(
		clientRequestId: string,
		text: string,
		images: Array<{ data: string; mimeType: string }>,
		fileAppendix?: string,
	): void {
		if (!text && images.length === 0 && !fileAppendix) return;
		this.dismissWelcome();
		const displayText = text + (fileAppendix ?? "");
		const content = images.length > 0 ? buildContent(displayText, images) : displayText;
		// This ordinal is temporary: the durable ordinal is applied when the agent
		// echoes the message. It still makes a just-sent row fork sensibly before
		// that echo arrives.
		const row = this.buildUserRow({ role: "user", content } as UserMessage, this.nextUserOrdinal + this.optimisticRows.size);
		this.place(row);
		this.hasContent = true;
		this.optimisticRows.set(clientRequestId, { clientRequestId, text, fileAppendix, imageSignature: this.imageSignature(images), row });
		// The operator just hit send — that is an explicit intent to follow along.
		this.forceScrollToBottom();
		this.updateJumpButton();
	}

	/** Remove the exact local echo for a rejected prompt without disturbing later sends. */
	rejectOptimistic(clientRequestId?: string): boolean {
		const pending = clientRequestId
			? this.optimisticRows.get(clientRequestId)
			: this.optimisticRows.size === 1
				? this.optimisticRows.values().next().value
				: undefined;
		if (!pending) return false;
		this.optimisticRows.delete(pending.clientRequestId);
		if (this.pendingUserFooter && pending.row.contains(this.pendingUserFooter)) this.pendingUserFooter = null;
		pending.row.remove();
		if (!this.scroller.querySelector(".row, .tool, .system-note, .working-row, .retry-row, .spawned-card")) {
			this.hasContent = false;
			this.showWelcome();
		}
		this.updateJumpButton();
		return true;
	}

	/**
	 * Find the optimistic echo for a durable user message. No wall clock: a steered
	 * or queued message can arrive minutes later, so confirmation is content-based.
	 */
	private matchingOptimistic(message: UserMessage): OptimisticUserRow | undefined {
		const delivered = this.userMessageText(message);
		const imageSignature = this.userMessageImageSignature(message);
		for (const pending of this.optimisticRows.values()) {
			if (pending.imageSignature !== imageSignature) continue;
			if (pending.fileAppendix && !delivered.endsWith(pending.fileAppendix)) continue;
			const promptText = pending.fileAppendix ? delivered.slice(0, -pending.fileAppendix.length) : delivered;
			if (promptText === pending.text) return pending;
			// The host appends editor selections to the prompt (composeMessageText:
			// `<attachment …>` blocks, or a ` (path lines a-b)` reference), so the
			// delivered text is not byte-identical — but the typed text stays its prefix.
			if ((!pending.text && !pending.fileAppendix) || !promptText.startsWith(pending.text)) continue;
			const appended = promptText.slice(pending.text.length);
			if (appended.startsWith("\n\n<attachment ") || appended.startsWith(" (")) return pending;
		}
		return undefined;
	}

	private renderMessage(message: AgentMessage, isPartial: boolean, authoritative = false): void {
		const previousKey = this.renderingKey;
		const previousMessage = this.renderedMessage;
		const base = this.messageAnchorBase(message);
		this.renderingKey = this.snapshotKeys.get(message) ?? (base ? this.nextAnchorKey(base) : undefined);
		this.renderedMessage = message;
		try {
			const existing = this.rehydratingRows
				? (this.renderingKey ? this.rehydratingRows.get(this.renderingKey) : undefined)
					?? (message.role === "assistant" ? this.assistantRow(message as AssistantMessage) : undefined)
				: undefined;
			if (existing && message.role === "assistant") {
				const assistant = message as AssistantMessage;
				const settled = Boolean(assistant.errorMessage)
					|| Boolean(assistant.stopReason && assistant.stopReason !== "stop")
					|| assistant.content.some((part) => {
						const block = part.type === "toolCall" ? this.toolBlocks.get(part.id) : undefined;
						return block != null && block.state !== "running";
					});
				const live = !authoritative && this.streaming && existing === this.streamingBubble && existing.dataset.settled !== "true" && !settled;
				const partial = !authoritative && (live || !assistant.stopReason && !assistant.errorMessage);
				const staleSettled = !authoritative && this.streaming && existing.dataset.settled === "true" && partial;
				// A known live snapshot shares the partial watermark. Idle/durable
				// snapshots are authoritative, including old records with no stopReason.
				if (!staleSettled && (!live || !this.olderAssistantPartial(existing, assistant))) this.fillAssistantRow(existing, assistant, partial);
				this.place(existing);
			} else if (existing && message.role === "user") {
				const previous = this.rowMessages.get(existing);
				const user = message as UserMessage;
				existing.dataset.userOrdinal = String(this.userMessageOrdinal(user));
				if (JSON.stringify(previous?.content) !== JSON.stringify(message.content)) {
					const fresh = this.buildUserRow(user, this.userMessageOrdinal(user));
					const bubble = existing.querySelector(".bubble-user");
					const next = fresh.querySelector(".bubble-user");
					if (bubble && next) bubble.replaceChildren(...Array.from(next.childNodes));
				}
				this.pendingUserFooter = existing.querySelector(".user-footer") as HTMLElement | null;
				this.place(existing);
			} else if (existing && JSON.stringify(this.rowMessages.get(existing)) === JSON.stringify(message)) {
				this.place(existing);
			} else if (existing?.classList.contains("custom-note") && message.role === "custom") {
				const body = existing.querySelector(".custom-note-body");
				if (body) body.textContent = (message as unknown as CustomDisplayMessage).content ?? "";
				this.place(existing);
			} else {
				this.renderMessageContent(message, isPartial, authoritative);
			}
		} finally {
			this.renderingKey = previousKey;
			this.renderedMessage = previousMessage;
		}
	}

	private renderMessageContent(message: AgentMessage, isPartial: boolean, authoritative = false): void {
		const role = message.role;
		if (role === "user") {
			const userMessage = message as UserMessage;
			const ordinal = this.userMessageOrdinal(userMessage);
			const pending = this.matchingOptimistic(userMessage);
			if (pending) {
				this.optimisticRows.delete(pending.clientRequestId);
				this.deps.onOptimisticConfirmed?.(pending.clientRequestId);
				if (pending.row.isConnected) {
					pending.row.dataset.userOrdinal = String(ordinal);
					this.markRowTimestamp(pending.row, this.messageTimestamp(userMessage));
					if (this.snapshotTarget) this.place(pending.row);
					return; // already rendered optimistically
				}
			}
			this.place(this.buildUserRow(userMessage, ordinal));
		} else if (role === "assistant") {
			this.place(this.buildAssistantRow(message as AssistantMessage, isPartial, authoritative));
		} else if (role === "toolResult") {
			this.renderToolResult(message as ToolResultMessage);
		} else if (role === ("bashExecution" as string)) {
			const m = message as unknown as { command?: string };
			this.systemNote(`! ${m.command ?? "bash command"}`);
		} else if (role === ("compactionSummary" as string)) {
			this.place(this.buildCompactionSummary(message as unknown as CompactionSummaryMessage));
			this.hasContent = true;
		} else if (role === ("custom" as string)) {
			const m = message as unknown as CustomDisplayMessage;
			// `display: false` is the agent asking for this to stay out of the view.
			if (m.display === false) return;
			if (m.customType === "refinement_outcome" && m.details) {
				this.place(this.buildRefinementCard(m));
				this.hasContent = true;
				return;
			}
			if (!m.content?.trim()) return;
			this.place(this.buildCustomNote(m));
			this.hasContent = true;
		}
	}

	/**
	 * The compaction boundary, rendered as the thread's own beginning.
	 *
	 * A compacted session's `get_messages` returns only what survived — 84 of
	 * 12,257 on a real thread — and the one record of everything before is this
	 * message. Dropping it (which is what "role we do not know" used to mean) left
	 * a long thread opening mid-conversation with nothing above it and no "load
	 * earlier" affordance, because there genuinely is nothing earlier to load: the
	 * rest lives in the session file, not in the agent's context.
	 */
	private buildCompactionSummary(message: CompactionSummaryMessage): HTMLElement {
		const details = el("details", "compaction-summary") as HTMLDetailsElement;
		const kept = message.retainedMessageCount;
		const before = message.tokensBefore;
		const bits = ["Context compacted"];
		if (before != null) bits.push(`${formatNumber(before)} tokens summarized`);
		if (kept != null) bits.push(`${formatNumber(kept)} message${kept === 1 ? "" : "s"} kept`);
		const summary = el("summary", "", bits.join(" · "));
		summary.title = "Everything before this point was replaced by this summary. The full transcript is still in the session file.";
		const body = el("div", "compaction-summary-body");
		renderMarkdown(message.summary ?? "", body, this.links);
		details.append(summary, body);
		return details;
	}

	/** An agent-authored note the agent asked to be shown — subagent replies land here. */
	private buildCustomNote(message: CustomDisplayMessage): HTMLElement {
		const note = el("div", "custom-note");
		const label = el("div", "custom-note-kind", (message.customType ?? "note").replace(/_/g, " "));
		const body = el("div", "custom-note-body");
		body.textContent = message.content ?? "";
		note.append(label, body);
		return note;
	}

	// ------------------------------------------------------------------
	// Harness refinement outcome — the webview's "Harness refined" card
	// ------------------------------------------------------------------
	// The CLI renders these entries (customType "refinement_outcome" on
	// 0.9.5, content "Refinement complete: …") as a styled card; the
	// generic custom-note path was showing the same message as a faint
	// one-liner with no edits and no summary. Headline and edit lines
	// mirror the CLI's wording where observable.

	private refinementHeadline(details: RefinementOutcomeDetails): string {
		const edits = details.edits ?? [];
		const applied = edits.filter((e) => e.applied);
		const rollback = details.rollbackOf !== undefined;
		if (edits.length === 0) {
			return rollback ? "Harness rollback unchanged · no edits applied" : "Harness unchanged · no edits applied";
		}
		if (applied.length === 0) {
			return `${rollback ? "Harness rollback" : "Harness refinement"} failed · 0/${edits.length} edits applied`;
		}
		if (applied.length < edits.length) {
			return `${rollback ? "Harness partially rolled back" : "Harness partially refined"} · ${applied.length}/${edits.length} edits applied`;
		}
		return ""; // all-applied is handled by refinementAllAppliedHeadline
	}

	private refinementAllAppliedHeadline(edits: RefinementEdit[], rollback: boolean): string {
		if (rollback) {
			return `Harness rollback completed · ${edits.length} edit${edits.length === 1 ? "" : "s"} applied`;
		}
		const first = edits[0];
		const kind = first?.kind ?? "";
		const sameKind = kind !== "" && edits.every((e) => e.kind === kind);
		if (sameKind) {
			const noun = kind === "memory" ? (edits.length === 1 ? "memory" : "memories") : `${kind}${edits.length === 1 ? "" : "s"}`;
			const allSameAction = kind !== "" && edits.every((e) => e.action === first?.action);
			const verb = allSameAction
				? (first?.action === "create" ? "created" : first?.action === "update" ? "updated" : first?.action === "delete" ? "deleted" : "changed")
				: "changed";
			return `Harness refined · ${edits.length} ${noun} ${verb}`;
		}
		return `Harness refined · ${edits.length} edits applied`;
	}

	private buildRefinementCard(message: CustomDisplayMessage): HTMLElement {
		const details = message.details ?? {};
		const edits = details.edits ?? [];
		const applied = edits.filter((e) => e.applied);
		const rollback = details.rollbackOf !== undefined;
		let headline: string;
		if (applied.length === edits.length && edits.length > 0) {
			headline = this.refinementAllAppliedHeadline(edits, rollback);
		} else {
			headline = this.refinementHeadline(details);
		}

		const tone = applied.length === 0 && edits.length > 0 ? "error" : applied.length < edits.length ? "partial" : "ok";

		const card = el("div", `refine-card${tone !== "ok" ? ` ${tone}` : ""}`);
		const head = el("div", "refine-card-head");
		head.appendChild(el("span", "refine-card-mark", "◆"));
		head.appendChild(el("span", "refine-card-title", headline));
		card.appendChild(head);

		if (details.summary?.trim()) {
			const summary = el("div", "refine-card-summary");
			summary.textContent = details.summary.trim();
			summary.title = details.refinementId ? `refinement ${details.refinementId}` : "";
			card.appendChild(summary);
		}

		if (edits.length > 0) {
			const list = el("div", "refine-card-edits");
			for (const edit of edits) {
				const scope = edit.after?.scope ?? edit.before?.scope ?? details.scope ?? "local";
				const kind = edit.kind ?? "edit";
				const id = edit.id ?? "?";
				const line = el("div", `refine-card-edit${edit.applied ? "" : " failed"}`);
				if (edit.applied) {
					const verb = edit.action === "create" ? "Created" : edit.action === "update" ? "Updated" : edit.action === "delete" ? "Deleted" : "Changed";
					line.textContent = `${verb} ${scope} ${kind} ${id}`;
				} else {
					line.textContent = `Failed to ${edit.action ?? "apply"} ${scope} ${kind} ${id}${edit.error ? `: ${edit.error}` : ""}`;
				}
				list.appendChild(line);
			}
			card.appendChild(list);
		}
		return card;
	}

	private renderUserTextWithMentions(text: string): HTMLElement {
		const container = el("div", "bubble-text");
		// Chip only path-like mentions: must contain a "/" or look like a
		// filename (single dotted extension, e.g. "src/a.ts", "README.md").
		// Avoids chipping decorators/usernames (@Override, @pytest.mark.x, @user)
		// and addresses (quotes pre-check keeps @corp.com out of "x"@example).
		const mentionRe = /(^|[\s(`"'])@((?:[\w-]+\/)+(?:[\w./-]*\w|)|[\w-]+\.[\w]{1,8})(?=$|[\s),.;:'"`\/]|$)/g;
		let last = 0;
		let match: RegExpExecArray | null;
		while ((match = mentionRe.exec(text)) !== null) {
			const start = match.index + match[1].length;
			const path = match[2];
			if (start > last) container.appendChild(document.createTextNode(text.slice(last, start)));
			const chip = el("button", "mention-chip", `@${path}`);
			chip.title = `Open ${path}`;
			chip.addEventListener("click", (event) => {
				event.stopPropagation();
				this.deps.onOpenFile(path);
			});
			container.appendChild(chip);
			last = start + path.length + 1;
		}
		if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
		if (last === 0) return container;
		return container;
	}

	/**
	 * Epoch ms for a message. The agent writes `timestamp: Date.now()` — a number,
	 * never an ISO string. Reading it as a string left every row untagged, which
	 * silently turned the spawn card's ordered insert into "append at the bottom".
	 */
	private messageTimestamp(message: AgentMessage): number | null {
		const ts = (message as unknown as { timestamp?: number | string }).timestamp;
		if (typeof ts === "number" && Number.isFinite(ts)) return ts;
		if (typeof ts === "string" && ts.length > 0) {
			const parsed = Date.parse(ts);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}

	private markRowTimestamp(row: HTMLElement, ts: number | null): void {
		if (ts != null) row.dataset.ts = String(ts);
	}

	private userMessageOrdinal(message: UserMessage): number {
		const existing = this.userOrdinals.get(message);
		if (existing !== undefined) return existing;
		const ordinal = this.nextUserOrdinal++;
		this.userOrdinals.set(message, ordinal);
		return ordinal;
	}

	private imageSignature(images: Array<{ data: string; mimeType: string }>): string {
		// JSON length-prefixing makes the sequence unambiguous without a lossy hash.
		return images.map((image) => `${image.mimeType.length}:${image.mimeType}${image.data.length}:${image.data}`).join("");
	}

	private userMessageImageSignature(message: UserMessage): string {
		if (!Array.isArray(message.content)) return "";
		return this.imageSignature(
			message.content
				.filter((part) => part.type === "image")
				.map((part) => ({ data: (part as { data: string }).data, mimeType: (part as { mimeType: string }).mimeType })),
		);
	}

	private buildUserRow(message: UserMessage, ordinal: number): HTMLElement {
		const row = el("div", "row row-user");
		row.dataset.userOrdinal = String(ordinal);
		const plainText = this.userMessageText(message);
		const bubble = el("div", "bubble bubble-user");
		if (typeof message.content === "string") {
			bubble.appendChild(this.renderUserTextWithMentions(message.content));
		} else if (Array.isArray(message.content)) {
			const textParts = message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
			const images = message.content.filter((p) => p.type === "image");
			if (textParts.length > 0) {
				bubble.appendChild(this.renderUserTextWithMentions(textParts.join("\n").trim()));
			}
			if (images.length > 0) {
				const strip = el("div", "bubble-images");
				for (const img of images) {
					const image = document.createElement("img");
					image.src = `data:${img.mimeType};base64,${img.data}`;
					strip.appendChild(image);
				}
				bubble.appendChild(strip);
			}
		}
		row.appendChild(bubble);
		if (plainText.trim().length > 0) {
			row.appendChild(this.buildUserFooter(row, plainText));
		}
		this.markRowTimestamp(row, this.messageTimestamp(message));
		return row;
	}

	/** Footer under a user bubble: token estimate, turn cost, copy, fork-from-here. */
	private buildUserFooter(row: HTMLElement, text: string): HTMLElement {
		const footer = el("div", "user-footer");
		const est = Math.max(1, Math.round(text.length / 4));
		const estLabel = est >= 1000 ? `~${(est / 1000).toFixed(1)}k tokens (est.)` : `~${est} tokens (est.)`;
		const tokensEl = el("span", "uf-tokens", estLabel);
		tokensEl.title = "Estimated from message length (~4 chars/token). Only replies are metered.";
		footer.appendChild(tokensEl);
		// The price lands when the reply that consumed this message arrives — so
		// only a row appended at the LIVE tail may claim it. Rows rebuilt above the
		// window by loadEarlier are ancient history; letting them take the slot put
		// the next reply's cost on a message from the top of the transcript.
		if (this.insertAnchor === null) this.pendingUserFooter = footer;
		const copyBtn = el("button", "uf-icon") as HTMLButtonElement;
		copyBtn.title = "Copy message";
		copyBtn.appendChild(icon("copy", 11));
		copyBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			copyToClipboard(text);
		});
		const forkBtn = el("button", "uf-icon") as HTMLButtonElement;
		forkBtn.title = "Fork the session starting from this message";
		forkBtn.appendChild(icon("fork", 11));
		forkBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			const ordinal = Number(row.dataset.userOrdinal);
			if (Number.isInteger(ordinal) && ordinal >= 0) this.deps.onForkFromUser(ordinal);
		});
		footer.append(copyBtn, forkBtn);
		return footer;
	}

	/**
	 * Price the user's turn — #23 asked for the cost of their own message.
	 *
	 * prime-agent meters per reply, never per message: `usage.input` is the whole
	 * context the reply was billed for, not the words the operator typed. So the
	 * footer states exactly that instead of pinning a whole-context figure on the
	 * bubble and letting it read as "your message cost this".
	 */
	private priceUserTurn(usage: AssistantMessage["usage"]): void {
		const footer = this.pendingUserFooter;
		const cost = usage?.cost?.input;
		if (!footer || cost == null || !usage) return;
		this.pendingUserFooter = null;
		if (footer.querySelector(".uf-cost")) return;
		const costEl = el("span", "uf-cost", `$${cost.toFixed(4)} input`);
		costEl.title = `Metered input cost of the reply this message opened: ${formatNumber(usage.input)} context tokens for $${cost.toFixed(4)}. prime-agent prices the whole context per reply, not each message.`;
		footer.querySelector(".uf-tokens")?.after(costEl);
	}

	private buildAssistantRow(message: AssistantMessage, isPartial: boolean, authoritative = false): HTMLElement {
		const row = el("div", "row row-assistant");
		const partial = !authoritative && (isPartial || !message.stopReason && !message.errorMessage);
		this.fillAssistantRow(row, message, partial);
		this.markRowTimestamp(row, this.messageTimestamp(message));
		return row;
	}

	private userMessageText(message: UserMessage): string {
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content
				.filter((p) => p.type === "text")
				.map((p) => (p as { text: string }).text)
				.join("\n")
				.trim();
		}
		return "";
	}

	/** Reply text only — what renders as prose in the bubble. */
	private assistantAllText(message: AssistantMessage): string {
		return (message.content ?? [])
			.filter((p) => p.type === "text")
			.map((p) => (p as { text: string }).text)
			.join("\n\n")
			.trim();
	}

	/**
	 * Everything the reply carried, in reading order, as markdown: thinking as a
	 * blockquote, prose as-is, tool calls as fenced blocks. The copy button says
	 * "text + thinking", so it has to actually carry both.
	 */
	private assistantCopyMarkdown(message: AssistantMessage): string {
		const parts: string[] = [];
		for (const part of message.content ?? []) {
			if (part.type === "text") {
				if (part.text.trim()) parts.push(part.text.trim());
			} else if (part.type === "thinking") {
				const thinking = (part as { thinking: string }).thinking?.trim();
				if (thinking) {
					parts.push(`> **Thought process**\n${thinking.split("\n").map((l) => `> ${l}`).join("\n")}`);
				}
			} else if (part.type === "toolCall") {
				const call = part as { name: string; arguments?: Record<string, unknown> };
				const view = toolView(call.name, call.arguments ?? {});
				parts.push(`⚙ **${call.name}**\n\`\`\`${view.lang || "json"}\n${view.input}\n\`\`\``);
			}
		}
		return parts.join("\n\n").trim();
	}

	/**
	 * Repaint an assistant row from the latest message. Called on EVERY streaming
	 * frame, so it reuses the nodes already on screen instead of clearing the row:
	 * a rebuild detached every tool card and rebuilt the thinking block on each
	 * frame, resetting their internal scroll (and any text selection) several
	 * times a second while the reply arrived.
	 */
	private fillAssistantRow(row: HTMLElement, message: AssistantMessage, isPartial: boolean): void {
		let body = row.querySelector(":scope > .row-body") as HTMLElement | null;
		if (!body) {
			row.textContent = "";
			body = el("div", "row-body");
			row.append(body);
		}
		const desired: HTMLElement[] = [];
		const keyed = (key: string): HTMLElement | null =>
			body.querySelector(`:scope > [data-part="${key}"]`) as HTMLElement | null;
		let textIndex = 0;
		let thinkIndex = 0;
		for (const part of (message as AssistantMessage).content ?? []) {
			if (part.type === "text") {
				if (!part.text.trim()) continue;
				const key = `text-${textIndex++}`;
				let md = keyed(key);
				if (!md) {
					md = el("div", "md");
					md.dataset.part = key;
				}
				// Markdown is re-rendered only when the text actually changed; an
				// unchanged tail frame must not blow away a selection inside it.
				if (md.dataset.src !== part.text) {
					md.textContent = "";
					renderMarkdown(part.text, md, this.links);
					md.dataset.src = part.text;
				}
				desired.push(md);
			} else if (part.type === "thinking") {
				// Same rule the text branch above already applies: a part with no
				// content yet is not a part to render. A reasoning model emits the
				// thinking slot before its first delta, which drew an empty
				// "Thought process" box that sat there until content arrived.
				// Skipping BEFORE the index advances is what makes this safe while
				// streaming — the key stays stable, so the block that appears with
				// the first delta is the same node that keeps growing, and it keeps
				// its open/closed state instead of being rebuilt.
				if (!part.thinking?.trim()) continue;
				const key = `think-${thinkIndex++}`;
				let node = keyed(key);
				if (!node) {
					node = this.buildThinking(part.thinking, isPartial);
					node.dataset.part = key;
				} else {
					this.updateThinking(node, part.thinking);
				}
				desired.push(node);
			} else if (part.type === "toolCall") {
				const block = this.ensureToolBlock(part.id, part.name, part.arguments ?? {}, !isPartial);
				block.root.dataset.part = `tool-${part.id}`;
				desired.push(block.root);
			}
		}
		// Providers initialize stopReason to "stop" even on live partials. Only
		// message_end or an authoritative durable snapshot can settle this row;
		// a partial/start must not freeze later deltas or show a final usage line.
		const settled = !isPartial;
		if (settled) {
			this.priceUserTurn(message.usage);
			const meta = this.usageLine(message as AssistantMessage, keyed("usage"));
			if (meta) {
				meta.dataset.part = "usage";
				desired.push(meta);
			} else if (desired.length === 0) {
				const empty = el("div", "usage-line", "(no response)");
				empty.dataset.part = "usage";
				desired.push(empty);
			}
		}
		this.reconcileChildren(body, desired);
		this.registerAssistant(row, message, settled);
	}

	private buildThinking(thinking: string, isPartial: boolean): HTMLElement {
		const details = el("details", "thinking") as HTMLDetailsElement;
		details.open = isPartial;
		const summary = el("summary", "", "Thought process");
		const copyBtn = el("button", "thinking-copy") as HTMLButtonElement;
		copyBtn.title = "Copy thinking";
		copyBtn.appendChild(icon("copy", 11));
		copyBtn.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			// Read the text off the node, not a closure: the block is reused across
			// streaming frames, so a captured string would copy the first chunk only.
			copyToClipboard((details.querySelector(".thinking-body") as HTMLElement | null)?.textContent ?? "");
		});
		summary.appendChild(copyBtn);
		const body = el("div", "thinking-body");
		body.textContent = thinking;
		this.trackTailFollow(body);
		details.append(summary, body);
		return details;
	}

	/**
	 * Find the element that really scrolls around `node` — the <pre> and its
	 * `.tool-body`, or a `.thinking-body`, all cap themselves in CSS, so which one
	 * overflows depends on the content. Walks out no further than `stopClass`.
	 */
	private scrollPaneFor(node: HTMLElement, stopClass: string): HTMLElement {
		for (let el: HTMLElement | null = node; el; el = el.parentElement) {
			if (el.scrollHeight > el.clientHeight + 4) return el;
			if (el.classList.contains(stopClass)) break;
		}
		return node;
	}

	/**
	 * Run `mutate` without throwing the reader to the top. Replacing textContent
	 * resets the scroll offset of whatever is scrolling, and these panes are
	 * rewritten on every streaming frame — so an operator reading an expanded
	 * thinking block or tool output gets slammed back to line one several times a
	 * second. Someone parked at the bottom keeps following the tail instead.
	 */
	private preservingScroll(anchor: HTMLElement, stopClass: string, mutate: () => void): void {
		const pane = this.scrollPaneFor(anchor, stopClass);
		const previousTop = pane.scrollTop;
		const previousRecordedTop = this.paneScrollTops.get(pane);
		const atBottom = pane.scrollHeight - previousTop - pane.clientHeight <= 4;
		if (atBottom && previousRecordedTop != null && previousTop > previousRecordedTop + 1) pane.dataset.follow = "on";
		const wasAtBottom = pane.dataset.follow !== "off" && atBottom;
		mutate();
		pane.scrollTop = wasAtBottom ? pane.scrollHeight : previousTop;
		this.paneScrollTops.set(pane, pane.scrollTop);
	}

	/** Grow an existing thinking block in place, leaving its open/closed state alone. */
	private updateThinking(details: HTMLElement, thinking: string): void {
		const body = details.querySelector(".thinking-body") as HTMLElement | null;
		if (!body || body.textContent === thinking) return;
		this.preservingScroll(body, "thinking", () => {
			body.textContent = thinking;
		});
	}

	/**
	 * Put `desired` in order inside `parent`, touching the DOM only where it is
	 * already wrong. The guard matters more than it looks: re-inserting a node
	 * that is already in position still detaches and re-attaches it, which resets
	 * the scroll offset of anything scrollable inside — the tool output and shell
	 * panes the operator is trying to read while the reply streams.
	 */
	private reconcileChildren(parent: HTMLElement, desired: HTMLElement[]): void {
		// Remove obsolete siblings before ordering survivors. Otherwise a card
		// gets reinserted just to step over prose that is about to disappear.
		const keep = new Set<Node>(desired);
		for (const node of Array.from(parent.childNodes)) if (!keep.has(node)) node.remove();
		for (const [index, node] of desired.entries()) {
			if (parent.childNodes[index] !== node) {
				parent.insertBefore(node, parent.childNodes[index] ?? null);
			}
		}
		while (parent.childNodes.length > desired.length) {
			parent.removeChild(parent.childNodes[parent.childNodes.length - 1]);
		}
	}

	private usageMessages = new WeakMap<HTMLElement, AssistantMessage>();

	private usageLine(message: AssistantMessage, existing: HTMLElement | null = null): HTMLElement | null {
		const parts: string[] = [];
		const usage = message.usage;
		if (usage?.totalTokens != null) parts.push(`${formatNumber(usage.totalTokens)} tokens`);
		if (usage?.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
		const stop = message.stopReason;
		const isError = stop === "error" || (message.errorMessage != null && message.errorMessage !== "");
		if (isError) {
			parts.push(message.errorMessage ? `request failed — ${message.errorMessage}` : "request failed");
		} else if (stop && stop !== "stop" && stop !== "toolUse") {
			parts.push(`stopped: ${stop}`);
		}
		if (parts.length === 0) return null;
		const line = existing ?? el("div", "usage-line");
		line.classList.toggle("error", isError);
		let label = line.querySelector(".usage-label") as HTMLElement | null;
		if (!label) {
			label = el("span", "usage-label");
			line.prepend(label);
		}
		const text = parts.join(" · ");
		if (label.textContent !== text) label.textContent = text;
		this.usageMessages.set(line, message);
		line.title = message.model ?? "";
		if (line.querySelector(".usage-copy")) return line;
		const copyBtn = el("button", "uf-icon usage-copy") as HTMLButtonElement;
		copyBtn.title = "Copy the full reply (text + thinking)";
		copyBtn.appendChild(icon("copy", 11));
		copyBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			const current = this.usageMessages.get(line) ?? message;
			copyToClipboard(this.assistantCopyMarkdown(current) || this.assistantAllText(current));
		});
		line.appendChild(copyBtn);
		return line;
	}

	private systemNote(text: string, isError = false): void {
		this.dismissWelcome();
		this.place(el("div", `system-note${isError ? " error" : ""}`, text));
		this.hasContent = true;
	}

	// ---------------------------------------------------------------
	// Tool blocks
	// ---------------------------------------------------------------

	private toolSummary(name: string, args: Record<string, unknown>): string {
		// Reuse prime-agent's own scorer so the collapsed card names the command
		// that actually ran. A first-non-magic-line pick reads the setup instead:
		// a `%%bash` + `cd …` + `npm run build` cell summarised as the `cd`.
		const preview =
			name === "ipython" && typeof args?.code === "string"
				? previewIpythonCode(args.code).text
				: name === "bash" && typeof args?.command === "string"
					? previewBashCommand(args.command).text
					: "";
		if (preview) return preview; // already ellipsised at 64 chars by the scorer
		for (const key of ["code", "command", "path", "file", "prompt", "query", "url"]) {
			const value = args?.[key];
			if (typeof value === "string" && value.trim()) {
				// Skip magic lines, shebangs and comments: pull the first meaningful line.
				const lines = value.split("\n");
				let firstLine = lines.find((l) => {
					const t = l.trim();
					if (!t) return false;
					if (t.startsWith("%%") || t.startsWith("#!") || t.startsWith("# ")) return false;
					return true;
				}) ?? "";
				if (!firstLine) {
					const buffer = (lines.find((l) => l.trim().trimStart().startsWith("%%")) ?? "").trim().replace(/^%%\s*/, "");
					firstLine = buffer ? `${buffer} cell` : lines[0] ?? "";
				}
				return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
			}
		}
		try {
			const json = JSON.stringify(args);
			if (!json || json === "{}") return "";
			return json.length > 140 ? `${json.slice(0, 140)}…` : json;
		} catch {
			return "";
		}
	}

	/**
	 * Paint the "input" half of a tool card: the call itself, its copy button and
	 * (for edits) the hunks. Split out of ensureToolBlock because it has to run
	 * again every time fuller arguments arrive.
	 */
	private renderToolInput(block: ToolBlock, name: string, args: Record<string, unknown>): void {
		const view = toolView(name, args);
		const section = block.inputSection;
		section.textContent = "";
		const inputHead = el("div", "tool-section-head");
		inputHead.appendChild(el("span", "", view.label));
		// The collapsed header advertises ipython as a glyph; the expanded body is
		// where the word itself belongs. First span stays view.label for the
		// semantic checks.
		if (name === "ipython" && view.label !== "ipython") {
			const realName = el("span", "tool-realname", name);
			realName.title = "The tool call is ipython";
			inputHead.appendChild(realName);
		}
		block.inputSig = this.toolInputSig(name, args, view);
		block.inputText = view.input;
		inputHead.appendChild(this.makeCopyButton(() => block.inputText));
		section.appendChild(inputHead);

		if (name === "edit" && Array.isArray(args?.edits)) {
			this.buildEditSections(args, inputHead, section);
			return;
		}
		const pre = el("pre");
		if (view.kind === "shell") pre.className = "term";
		this.fillInputPre(pre, view);
		this.trackTailFollow(pre);
		section.appendChild(pre);

		// Edit-tool convenience: jump to the target file.
		const maybePath = args?.path;
		if ((name === "edit" || name === "write" || name === "read") && typeof maybePath === "string" && maybePath.trim()) {
			const openBtn = el("button", "tool-open", `Open ${shortenPath(maybePath)}`);
			openBtn.title = "Open file in editor";
			openBtn.addEventListener("click", (event) => {
				event.stopPropagation();
				this.deps.onOpenFile(maybePath);
			});
			section.appendChild(openBtn);
		}
	}

	private fillInputPre(pre: HTMLElement, view: ToolView): void {
		if (view.kind === "shell") {
			pre.textContent = "";
			for (const [index, line] of view.input.split("\n").entries()) {
				if (index > 0) pre.appendChild(document.createTextNode("\n"));
				const lineEl = el("span", "term-line", line);
				if (index === 0) pre.appendChild(el("span", "term-prompt", "$ "));
				pre.appendChild(lineEl);
			}
		} else {
			pre.textContent = view.input;
		}
	}

	/** Everything a card's call section is built from except the streaming text itself. */
	private toolInputSig(name: string, args: Record<string, unknown>, view: ToolView): string {
		const path = typeof args?.path === "string" ? args.path : "";
		return `${name}|${view.kind}|${view.label}|${Array.isArray(args?.edits) ? "edits" : ""}|${path}`;
	}

	/**
	 * Remember whether the reader is following the tail of a pane that is
	 * repainted while it streams. Wheel-up lands before the next frame, so a
	 * flick away is never fought; "follow" is the default so a pane that was
	 * hidden (card collapsed) when its text arrived still pins once it is opened.
	 */
	private trackTailFollow(pane: HTMLElement): void {
		this.paneScrollTops.set(pane, pane.scrollTop);
		pane.addEventListener("wheel", (event) => {
			const delta = (event as WheelEvent).deltaY;
			if (delta < 0) pane.dataset.follow = "off";
			else if (delta > 0 && pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 4) pane.dataset.follow = "on";
			this.paneScrollTops.set(pane, pane.scrollTop);
		}, { passive: true });
		pane.addEventListener("scroll", () => {
			const top = pane.scrollTop;
			const atBottom = pane.scrollHeight - top - pane.clientHeight <= 4;
			const previous = this.paneScrollTops.get(pane) ?? top;
			if (!atBottom) pane.dataset.follow = "off";
			else if (pane.dataset.follow !== "off" || top > previous + 1) pane.dataset.follow = "on";
			this.paneScrollTops.set(pane, top);
		}, { passive: true });
	}

	/**
	 * The call as far as it is certain. The summary scorer picks the most telling
	 * line of the whole cell, so fed a half-typed line it announced `i`, then
	 * `O`, then `OUT = Path('/mnt/data'` — a header rewritten on every chunk.
	 * While a call streams, the line still being typed is left out; a call with
	 * no finished line yet is shown as it stands (a one-line command), except a
	 * Python cell, whose row waits for its first line.
	 */
	private completeLinesOnly(args: Record<string, unknown>): Record<string, unknown> {
		const out: Record<string, unknown> = { ...args };
		for (const key of ["code", "command"]) {
			const value = out[key];
			if (typeof value === "string" && value.includes("\n") && !value.endsWith("\n")) {
				out[key] = value.slice(0, value.lastIndexOf("\n"));
			}
		}
		return out;
	}

	/**
	 * The row's text for a call that is still arriving, or null to leave it as it
	 * is. A Python cell's first line is still being typed: a row reading
	 * `import os, jso` that is rewritten a moment later is worse than a row that
	 * waits (and an empty cell must not fall through to a JSON dump of its args).
	 */
	private streamingSummary(name: string, args: Record<string, unknown>): string | null {
		if (name === "ipython" && typeof args.code === "string" && !args.code.includes("\n")) return null;
		return this.toolSummary(name, this.completeLinesOnly(args));
	}

	/**
	 * Write the collapsed row's text. A settled call writes at once; a streaming
	 * one writes at most every SUMMARY_MIN_INTERVAL_MS, and only when the text is
	 * different, so the row changes a few times a second instead of on every chunk
	 * and never rewrites itself with what it already says.
	 */
	private paintSummary(block: ToolBlock, text: string, settled: boolean): void {
		const apply = (value: string): void => {
			window.clearTimeout(block.summaryTimer);
			block.summaryTimer = undefined;
			block.summaryPending = undefined;
			block.summaryAt = performance.now();
			if (value === block.summaryText) return;
			block.summary.textContent = value;
			block.summaryText = value;
		};
		if (settled) {
			apply(text);
			return;
		}
		if (text === block.summaryText) {
			block.summaryPending = undefined;
			return;
		}
		const wait = SUMMARY_MIN_INTERVAL_MS - (performance.now() - block.summaryAt);
		if (wait <= 0) {
			apply(text);
			return;
		}
		block.summaryPending = text;
		if (block.summaryTimer === undefined) {
			block.summaryTimer = window.setTimeout(() => {
				block.summaryTimer = undefined;
				if (block.summaryPending !== undefined) apply(block.summaryPending);
			}, wait);
		}
	}

	/**
	 * Tool arguments stream in. The first `message_update` carrying a toolCall has
	 * `arguments: {}` — the code lands over the updates that follow, and only then
	 * does tool_execution_start repeat it. The card is created on that first empty
	 * sighting, so without re-rendering here the collapsed summary stays blank and
	 * the expanded call shows nothing for the life of the card.
	 */
	private refreshToolArgs(block: ToolBlock, name: string, args: Record<string, unknown>, settled: boolean): void {
		const view = toolView(name, args);
		// A call that has finished arriving always gets its final summary, even when
		// no new text came with it: the frames before it were summarised from
		// complete lines only.
		if (settled) this.paintSummary(block, this.toolSummary(name, args), true);
		if (view.input === block.inputText || (!settled && view.input.length <= block.renderedInputLen)) return;
		block.renderedInputLen = view.input.length;
		if (!settled) {
			const calm = this.streamingSummary(name, args);
			if (calm !== null) this.paintSummary(block, calm, false);
		}
		if (block.glyph && block.root.dataset.toolKind !== view.kind) {
			// Args streamed in after the card was born as opaquely "ipython":
			// the kind icon must follow what the cell now provably is.
			block.glyph.textContent = "";
			block.glyph.appendChild(icon(view.kind === "shell" ? "terminal" : "python", 12));
		}
		block.root.dataset.toolKind = view.kind;
		block.root.dataset.toolLang = view.lang;
		// The code box is the thing that scrolls, and it is a child of the section:
		// rebuilding the section replaced it every frame, so a card that was open
		// showed the first screenful of the code while the rest streamed in out of
		// sight, and any scrolling inside it was thrown away. While the card's
		// structure is unchanged only the text is repainted, in the same <pre>,
		// following its tail unless the reader scrolled up inside it.
		const pre = block.inputSection.querySelector(":scope > pre") as HTMLElement | null;
		if (pre && block.inputSig === this.toolInputSig(name, args, view)) {
			const follow = pre.dataset.follow !== "off";
			const top = pre.scrollTop;
			this.fillInputPre(pre, view);
			block.inputText = view.input;
			pre.scrollTop = follow ? pre.scrollHeight : top;
			this.paneScrollTops.set(pre, pre.scrollTop);
			return;
		}
		this.preservingScroll(block.inputSection, "tool", () => {
			this.renderToolInput(block, name, args);
		});
	}

	private ensureToolBlock(id: string, name: string, args: Record<string, unknown>, settled = true): ToolBlock {
		const existing = this.toolBlocks.get(id);
		if (existing) {
			this.refreshToolArgs(existing, name, args, settled);
			return existing;
		}

		const root = el("div", "tool");
		const header = el("div", "tool-header");
		const toggle = el("button", "tool-toggle") as HTMLButtonElement;
		toggle.title = "Expand tool details";
		toggle.setAttribute("aria-expanded", "false");
		const chevron = icon("chevron", 13);
		chevron.classList.add("tool-chevron");
		const statusDot = el("span", "tool-dot running");
		const initialView = toolView(name, args);
		const nameEl = toolHeaderName(name, initialView.kind);
		const summary = el("span", "tool-summary", settled ? this.toolSummary(name, args) : (this.streamingSummary(name, args) ?? ""));
		const pill = el("span", "tool-pill", "running");
		const copyAllBtn = el("button", "uf-icon tool-copy-all") as HTMLButtonElement;
		copyAllBtn.title = "Copy full tool call and all output (markdown)";
		copyAllBtn.appendChild(icon("copy", 11));
		copyAllBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			copyToClipboard(this.buildToolCopy(id));
		});
		toggle.append(chevron, statusDot, nameEl, summary, pill);
		header.append(toggle, copyAllBtn);
		const body = el("div", "tool-body");
		root.append(header, body);
		toggle.addEventListener("click", () => {
			this.captureScrollFollow();
			const open = root.classList.toggle("open");
			toggle.setAttribute("aria-expanded", String(open));
			// Opening a card at the tail grows the page under a reader who is
			// following it; that is not a decision to stop following.
			this.followScrollToBottom();
		});

		const inputSection = el("div", "tool-section");
		const view = toolView(name, args);
		body.appendChild(inputSection);

		const block: ToolBlock = {
			root,
			chevron,
			glyph: nameEl.classList.contains("tool-glyph") ? nameEl : null,
			summary,
			pill,
			body,
			inputSection,
			resultSection: null,
			state: "running",
			renderedInputLen: view.input.length,
			inputSig: "",
			inputText: "",
			summaryText: summary.textContent ?? "",
			summaryAt: Number.NEGATIVE_INFINITY,
		};
		this.renderToolInput(block, name, args);
		root.dataset.toolName = name;
		// The chrome keys off the kind, not the name — see toolView.
		root.dataset.toolKind = view.kind;
		root.dataset.toolLang = view.lang;
		this.toolBlocks.set(id, block);
		return block;
	}

	/** Full tool call + every captured output section, formatted for paste into chat/docs. */
	private buildToolCopy(id: string): string {
		const block = this.toolBlocks.get(id);
		if (!block) return "";
		const name = (block.root as HTMLElement & { dataset: DOMStringMap }).dataset.toolName ?? "tool";
		const parts: string[] = [`⚙ ${name}`];
		const edits = block.body.querySelector(".tool-edits");
		if (edits) {
			// An edit card renders hunks, not a <pre>. Without this branch the
			// selector below found the *result* pre and pasted the output as the
			// call — the diff the operator was looking at never made the clipboard.
			const path = block.body.querySelector(".tool-path")?.textContent?.trim();
			const hunks = Array.from(edits.querySelectorAll(".diff-line"))
				.map((line) => `${line.querySelector(".diff-sign")?.textContent ?? ""}${line.querySelector(".diff-text")?.textContent ?? ""}`)
				.join("\n");
			if (path) parts.push(path);
			if (hunks.trim()) parts.push(`\`\`\`diff\n${hunks}\n\`\`\``);
		}
		// Scoped away from `.tool-result`: it also holds a <pre>, and an unscoped
		// selector matched it first on any card whose call is not a <pre>.
		const inputPre = block.body.querySelector(".tool-section:not(.tool-result) pre");
		if (inputPre) {
			// A terminal block carries a decorative "$ " prompt span; pasting that
			// into a shell breaks the command, so read the line spans instead.
			const lines = inputPre.querySelectorAll(".term-line");
			const text = (
				lines.length > 0 ? Array.from(lines).map((line) => line.textContent ?? "").join("\n") : (inputPre.textContent ?? "")
			).trim();
			if (text) parts.push(`\`\`\`${block.root.dataset.toolLang ?? ""}\n${text}\n\`\`\``);
		}
		block.body.querySelectorAll(".tool-result pre").forEach((pre) => {
			const t = (pre.textContent ?? "").trim();
			if (t) parts.push(`\`\`\`\n${t}\n\`\`\``);
		});
		return parts.join("\n\n");
	}

	private makeCopyButton(text: string | (() => string)): HTMLButtonElement {
		const btn = el("button", "tool-copy", "Copy") as HTMLButtonElement;
		btn.title = "Copy to clipboard";
		btn.addEventListener("click", (event) => {
			event.stopPropagation();
			copyToClipboard(typeof text === "function" ? text() : text, () => {
				btn.textContent = "Copied";
				setTimeout(() => (btn.textContent = "Copy"), 1000);
			});
		});
		return btn;
	}

	/** Render edit-tool args as per-edit red/green diff blocks. */
	private buildEditSections(args: Record<string, unknown>, inputHead: HTMLElement, inputSection: HTMLElement): void {
		const wrapper = el("div", "tool-edits");
		const path = typeof args.path === "string" ? args.path : "";
		if (path) {
			const pathRow = el("div", "tool-path-row");
			pathRow.appendChild(el("span", "tool-path", path));
			const openBtn = el("button", "tool-open", "Open");
			openBtn.title = "Open file in editor";
			openBtn.addEventListener("click", (event) => {
				event.stopPropagation();
				this.deps.onOpenFile(path);
			});
			pathRow.appendChild(openBtn);
			inputSection.insertBefore(pathRow, inputHead);
		}
		const edits = (Array.isArray(args.edits) ? args.edits : []) as Array<{ oldText?: string; newText?: string }>;
		for (const [index, edit] of edits.entries()) {
			const editBox = el("div", "edit-hunk");
			if (edits.length > 1) {
				editBox.appendChild(el("div", "edit-hunk-label", `edit ${index + 1}/${edits.length}`));
			}
			const oldLines = (edit.oldText ?? "").split("\n");
			const newLines = (edit.newText ?? "").split("\n");
			for (const line of oldLines) {
				const row = el("div", "diff-line del");
				row.appendChild(el("span", "diff-sign", "-"));
				row.appendChild(el("span", "diff-text", line));
				editBox.appendChild(row);
			}
			for (const line of newLines) {
				const row = el("div", "diff-line add");
				row.appendChild(el("span", "diff-sign", "+"));
				row.appendChild(el("span", "diff-text", line));
				editBox.appendChild(row);
			}
			wrapper.appendChild(editBox);
		}
		inputSection.appendChild(wrapper);
	}

	private setToolState(id: string, state: "running" | "done" | "error"): void {
		const block = this.toolBlocks.get(id);
		if (!block) return;
		block.state = state;
		const dot = block.root.querySelector(".tool-dot");
		if (dot) dot.className = `tool-dot ${state}`;
		// No busy "done" pill: running shows the pill, the dot (green=done/red=error)
		// is enough for finished states.
		block.pill.textContent = state === "running" ? "running" : "";
		block.pill.className = `tool-pill ${state}`;
	}

	private ensureResultSection(block: ToolBlock, label: string, isError: boolean): HTMLElement {
		if (block.resultSection) return block.resultSection;
		const section = el("div", `tool-section tool-result${isError ? " error" : ""}`);
		section.appendChild(el("div", "tool-section-label", label));
		const pre = el("pre");
		if (block.root.dataset.toolKind === "shell") pre.className = "term";
		this.trackTailFollow(pre);
		section.appendChild(pre);
		block.body.appendChild(section);
		block.resultSection = section;
		return section;
	}

	/**
	 * Replace a result pane's text while leaving the reader where they were.
	 * Tool output arrives in whole-buffer snapshots, so every partial rewrites the
	 * pane; without restoring scrollTop, anyone reading a long shell output gets
	 * thrown back to the top several times a second. A reader parked at the bottom
	 * keeps following the tail, which is what they want there.
	 */
	private setPaneText(pre: HTMLElement, text: string): void {
		if (pre.textContent === text) return;
		this.preservingScroll(pre, "tool", () => {
			pre.textContent = text;
		});
	}

	private attachToolResultText(id: string, text: string, isError: boolean, newerSnapshot = false): void {
		const block = this.toolBlocks.get(id);
		if (!block) return;
		const section = this.ensureResultSection(block, isError ? "error" : "output", isError);
		const pre = section.querySelector("pre");
		const olderSnapshot = this.snapshotTarget && !newerSnapshot && block.state !== "running" && pre && text.length < (pre.textContent?.length ?? 0);
		if (pre && !olderSnapshot) this.setPaneText(pre as HTMLElement, text || (isError ? "(error)" : ""));
		this.setToolState(id, isError ? "error" : "done");
	}

	private updateToolPartial(id: string, partial: unknown): void {
		const block = this.toolBlocks.get(id);
		if (!block || block.state !== "running") return;
		const text = extractPartialText(partial);
		if (!text) return;
		const section = this.ensureResultSection(block, "output", false);
		const pre = section.querySelector("pre");
		if (pre) this.setPaneText(pre as HTMLElement, text);
		// handleEvent applies the outer scroll guard once for the whole update.
	}

	private renderToolResult(message: ToolResultMessage): void {
		const timestamp = this.messageTimestamp(message);
		const previousTimestamp = this.toolResultTimestamps.get(message.toolCallId);
		const newer = timestamp != null && previousTimestamp != null && timestamp > previousTimestamp;
		if (timestamp != null && (previousTimestamp == null || timestamp > previousTimestamp)) this.toolResultTimestamps.set(message.toolCallId, timestamp);
		const text = (message.content ?? [])
			.filter((p) => p.type === "text")
			.map((p) => (p as { text: string }).text)
			.join("\n");
		const block = this.toolBlocks.get(message.toolCallId);
		if (block) {
			if (this.snapshotTarget && !this.snapshotTarget.some((row) => row.contains(block.root))) this.place(block.root);
			this.attachToolResultText(message.toolCallId, text, message.isError ?? false, newer);
			return;
		}
		const orphan = this.ensureToolBlock(message.toolCallId, message.toolName ?? "tool", {});
		this.place(orphan.root);
		this.attachToolResultText(message.toolCallId, text, message.isError ?? false, newer);
	}

	// ---------------------------------------------------------------
	// Changed files strip
	// ---------------------------------------------------------------

	/**
	 * Files that changed on disk without this session's edit tool behind them —
	 * your own saves, another thread, a build step. Collapsed by default and
	 * behind a header, exactly like the Changes panel: a run that touches thirty
	 * files used to push a thirty-chip wall between the transcript and the
	 * composer with no way to fold it away.
	 */
	renderChangedFiles(files: string[]): void {
		const bar = this.changedFilesBar;
		bar.textContent = "";
		bar.classList.toggle("visible", files.length > 0);
		if (files.length === 0) return;

		const header = el("button", "cf-header") as HTMLButtonElement;
		header.append(
			el("span", "cf-caret", this.changedFilesExpanded ? "▾" : "▸"),
			el("span", "cf-label", `${files.length} other file${files.length === 1 ? "" : "s"} changed`),
		);
		header.title =
			"Changed on disk without this session's edit tool behind them — your edits, another thread, a build step, " +
			"or a file the agent rewrote from a shell or Python cell. Click to expand.";
		header.setAttribute("aria-expanded", String(this.changedFilesExpanded));
		header.addEventListener("click", () => {
			this.changedFilesExpanded = !this.changedFilesExpanded;
			this.renderChangedFiles(files);
		});
		bar.appendChild(header);
		if (!this.changedFilesExpanded) return;

		const list = el("div", "cf-list");
		for (const file of files.slice(0, CHANGED_FILES_MAX)) {
			const chip = el("span", "cf-chip");
			const nameBtn = el("button", "cf-open", shortenPath(file));
			nameBtn.title = `Open ${file}`;
			nameBtn.addEventListener("click", () => this.deps.onOpenFile(file));
			const diffBtn = document.createElement("button");
			diffBtn.className = "cf-diff";
			diffBtn.title = "Diff against git HEAD";
			diffBtn.appendChild(icon("diff", 12));
			diffBtn.addEventListener("click", () => this.deps.onOpenDiff(file));
			chip.append(nameBtn, diffBtn);
			list.appendChild(chip);
		}
		if (files.length > CHANGED_FILES_MAX) {
			list.appendChild(el("span", "cf-more", `+${files.length - CHANGED_FILES_MAX} more`));
		}
		bar.appendChild(list);
	}

	// ---------------------------------------------------------------

	scrollToBottom(): void {
		// The user may have moved since the last render, before the browser
		// delivers "scroll". This also guards viewport/roster resize callbacks.
		if (Math.abs(this.scroller.scrollTop - this.lastScrollTop) > 1 && !this.atBottom()) this.setStick(false);
		this.followScrollToBottom();
	}

	/** After a guarded render, browser adjustments from pruning are not user input. */
	private followScrollToBottom(): void {
		if (!this.stickToBottom) return;
		const bottom = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
		if (Math.abs(this.scroller.scrollTop - bottom) > 1) this.scroller.scrollTop = this.scroller.scrollHeight;
		this.lastScrollTop = this.scroller.scrollTop;
		this.lastScrollHeight = this.scroller.scrollHeight;
	}

	/** Unconditional snap — own sends or explicit user jumps. */
	forceScrollToBottom(): void {
		this.updateActivityDirection(1);
		this.snapshotScrollRemainder = 0;
		this.stickToBottom = true;
		this.scroller.scrollTop = this.scroller.scrollHeight;
		this.lastScrollTop = this.scroller.scrollTop;
		this.lastScrollHeight = this.scroller.scrollHeight;
		this.jumpBtn?.classList.remove("visible");
	}
}

function extractPartialText(partial: unknown): string {
	if (typeof partial === "string") return partial;
	if (partial && typeof partial === "object") {
		const obj = partial as Record<string, unknown>;
		for (const key of ["output", "text", "content"]) {
			const value = obj[key];
			if (typeof value === "string") return value;
			if (Array.isArray(value)) {
				const parts = value
					.filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
					.map((p) => (p as { text: string }).text);
				if (parts.length) return parts.join("\n");
			}
		}
	}
	return "";
}

function shortenPath(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 3) return path;
	return `…/${parts.slice(-2).join("/")}`;
}

function formatNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}
