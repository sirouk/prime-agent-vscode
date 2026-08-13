/**
 * Transcript: message rendering and the live agent-event state machine.
 */

import { parseIpythonBashCell, previewBashCommand, previewIpythonCode } from "./code-preview.js";
import { butterfly, el, icon } from "./dom.js";
import { copyToClipboard, renderMarkdown } from "./markdown.js";

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
	ToolResultMessage,
	UserMessage,
} from "../src/protocol.js";

export interface TranscriptDeps {
	onOpenLink: (href: string) => void;
	onOpenFile: (path: string, startLine?: number, endLine?: number) => void;
	onOpenDiff: (path: string) => void;
	onForkFromUser: (ordinal: number) => void;
	onSpawnedCardClick: (browseRef: string) => void;
	onNewSession: () => void;
	onShowHistory: () => void;
	onFocusComposer: () => void;
	onOptimisticConfirmed?: (clientRequestId: string) => void;
}

/** Rows built on open. Enough to fill several screens without paying for the tail. */
const INITIAL_RENDER = 150;
/** How many older messages one "load earlier" click brings in. */
const LOAD_BATCH = 100;
/** Ceiling on rendered rows in a long-running session, and the level trimming targets. */
const MAX_RENDERED_ROWS = 600;
const PRUNE_TO = 400;

interface ToolBlock {
	root: HTMLElement;
	chevron: SVGSVGElement;
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
}

/** A locally rendered prompt which has not yet been confirmed by the agent. */
interface OptimisticUserRow {
	clientRequestId: string;
	text: string;
	/** Exact ordered image identity prevents same-text queue rows swapping on delivery. */
	imageSignature: string;
	row: HTMLElement;
}

export class Transcript {
	private toolBlocks = new Map<string, ToolBlock>();
	private streamingBubble: HTMLElement | null = null;
	/** Pending optimistic rows, keyed by the webview request that created them. */
	private optimisticRows = new Map<string, OptimisticUserRow>();
	/** Ordinal of each durable user message within the complete session history. */
	private userOrdinals = new WeakMap<object, number>();
	private nextUserOrdinal = 0;
	private retryRow: HTMLElement | null = null;
	private workingRow: HTMLElement | null = null;
	private workingStartedAt = 0;
	private workingTimer: number | undefined;
	private streaming = false;
	private hasContent = false;
	/** Latest user footer still waiting for the reply that prices its turn. */
	private pendingUserFooter: HTMLElement | null = null;
	private welcome: HTMLElement | null = null;
	private changedFilesBar: HTMLElement;

	private stickToBottom = true;
	private spawnCardIds = new Set<string>();
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
		this.spawnCardIds.clear();
		this.scroller.querySelectorAll(".spawned-card").forEach((n) => n.remove());
	}

	injectSpawnCard(options: { id: string; browseRef?: string; name?: string; created?: string | null }): void {
		const card = el("div", "spawned-card");
		if (this.spawnCardIds.has(options.id)) return;
		this.spawnCardIds.add(options.id);
		const dot = el("span", "spawned-dot");
		card.appendChild(dot);
		const label = el("span", "spawned-label");
		label.textContent = `Subagent spawned${options.name ? ` — ${options.name}` : ""}`;
		label.title = options.created ? `Started ${options.created}` : "Started";
		card.appendChild(label);
		const view = el("button", "spawned-view", "view ›") as HTMLButtonElement;
		view.title = "Look inside this subagent";
		view.disabled = !options.browseRef;
		card.appendChild(view);
		// Ordered insert: before the first existing row newer than created.
		const createdMs = options.created ? Date.parse(options.created) : NaN;
		let insertBefore: Element | null = null;
		if (Number.isFinite(createdMs)) {
			for (const existing of Array.from(this.scroller.children)) {
				const t = Number((existing as HTMLElement).dataset?.ts ?? "");
				if (Number.isFinite(t) && t > createdMs) {
					insertBefore = existing;
					break;
				}
			}
		}
		if (insertBefore) this.scroller.insertBefore(card, insertBefore);
		else this.scroller.appendChild(card);
		this.hasContent = true;
		view.addEventListener("click", (event) => {
			event.stopPropagation();
			if (options.browseRef) this.deps.onSpawnedCardClick(options.browseRef);
		});
		this.scrollToBottom();
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

	constructor(
		private readonly scroller: HTMLElement,
		changedFilesBar: HTMLElement,
		private readonly deps: TranscriptDeps,
	) {
		this.changedFilesBar = changedFilesBar;
		// Scroll-lock: auto-follow only while the reader is already at the bottom.
		//
		// Intent is read from the input events, not from the scroll position. A
		// scroll event lands a frame after the gesture, so on a fast stream an
		// auto-follow could fire in between and drag the reader back down before
		// their flick was ever noticed — the fight this used to lose. wheel and
		// touchmove unstick synchronously, so the very next frame already knows.
		this.wireSelectionPreserve();
		this.scroller.addEventListener("wheel", (event) => {
			if ((event as WheelEvent).deltaY < 0) this.setStick(false);
		}, { passive: true });
		this.scroller.addEventListener("touchmove", () => {
			if (!this.atBottom()) this.setStick(false);
		}, { passive: true });
		this.scroller.addEventListener("scroll", () => {
			// Our own snaps land exactly at the bottom, so this re-sticks correctly
			// and needs no suppression: scrollToBottom only runs while already stuck.
			this.setStick(this.atBottom());
		}, { passive: true });
	}

	/**
	 * Within a hair of the bottom. Deliberately tight: the old 48px deadzone meant
	 * a short scroll up left the view "stuck", so the next frame yanked it back
	 * down and the reader could never get out during a fast reply.
	 */
	private atBottom(): boolean {
		return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight <= 12;
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
			this.jumpBtn.setAttribute("aria-label", "Jump to bottom");
			this.jumpBtn.appendChild(icon("chevron", 12));
			this.jumpBtn.classList.add("down");
			this.jumpBtn.addEventListener("click", () => {
				this.stickToBottom = true;
				this.scrollToBottom();
				this.updateJumpButton();
			});
			this.scroller.appendChild(this.jumpBtn);
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

	renderSnapshot(messages: AgentMessage[]): void {
		this.scroller.textContent = "";
		this.toolBlocks.clear();
		this.streamingBubble = null;
		this.welcome = null;
		// Both point at nodes in the scroller we just emptied.
		this.pendingUserFooter = null;
		this.pendingSelection = null;
		// Run state belongs to the session we just left. Inheriting it paints a
		// brand-new session as "running" with a Stop button no agent_end can clear,
		// and stopWorking() also kills the 1s timer whose row we just deleted.
		this.streaming = false;
		this.stopWorking();
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
		// The jump pill lived inside the scroller we just emptied; keeping the
		// detached node would leave the operator with no way back to the bottom
		// for the rest of the session.
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
		this.olderMessages = messages.length > INITIAL_RENDER ? messages.slice(0, messages.length - INITIAL_RENDER) : [];
		for (const message of messages.slice(Math.max(0, messages.length - INITIAL_RENDER))) {
			this.renderMessage(message, false);
		}
		this.renderEarlierBar();
		if (!this.hasContent) this.showWelcome();
		// A freshly opened session always lands on the latest message, whatever
		// the scroll position was in the session we came from.
		this.forceScrollToBottom();
	}

	/**
	 * The "N earlier messages" affordance. Always states the true remaining count:
	 * a transcript that silently starts part-way through is the kind of thing that
	 * makes an operator distrust everything else on screen.
	 */
	private renderEarlierBar(): void {
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
		button.textContent = `Load ${Math.min(LOAD_BATCH, remaining)} earlier message${Math.min(LOAD_BATCH, remaining) === 1 ? "" : "s"}`;
		button.title = `${remaining} earlier message${remaining === 1 ? "" : "s"} in this thread are not rendered yet`;
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			this.loadEarlier();
		});
		bar.append(button, el("span", "earlier-count", `${remaining} earlier`));
		this.earlierBar = bar;
		// Always the topmost row, which keeps it above the trimmed-gap marker: the
		// messages this button loads are older than the rows that were trimmed.
		this.scroller.insertBefore(bar, this.scroller.firstChild);
		this.renderPrunedNotice();
	}

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
	}

	/**
	 * Place a freshly built row. Everything that adds to the transcript goes
	 * through here so `loadEarlier` can redirect a batch above the existing rows
	 * without every call site knowing about it.
	 */
	private place(node: Node): void {
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
				if (node.contains(block.root)) this.toolBlocks.delete(id);
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

	/** Create the live bubble for a turn whose message_start we never received. */
	private adoptStreamingBubble(message: AssistantMessage): void {
		if (this.streamingBubble) return;
		this.dismissWelcome();
		this.stopWorking();
		this.streamingBubble = this.buildAssistantRow(message, true);
		this.place(this.streamingBubble);
		this.hasContent = true;
	}

	handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.dismissWelcome();
				this.streaming = true;
				this.stopWorking();
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
					this.stopWorking();
					this.streamingBubble = this.buildAssistantRow(message as AssistantMessage, true);
					this.place(this.streamingBubble);
					this.hasContent = true;
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
				// An update with no bubble means we joined the turn after its
				// message_start (attach mid-flight, or a catch-up after a resync).
				// Dropping it froze the transcript for the rest of the turn.
				this.adoptStreamingBubble(message);
				if (this.streamingBubble) this.fillAssistantRow(this.streamingBubble, message, true);
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message.role === "assistant") {
					this.adoptStreamingBubble(message as AssistantMessage);
					if (this.streamingBubble) {
						this.fillAssistantRow(this.streamingBubble, message as AssistantMessage, false);
						this.streamingBubble = null;
					}
				}
				if (this.streaming) this.startWorking();
				break;
			}
			case "tool_execution_start": {
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
		this.pruneOldRows();
		this.scrollToBottom();
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
		if (this.workingRow) return;
		this.workingStartedAt = Date.now();
		const row = el("div", "working-row");
		const mark = butterfly(15, "working-mark");
		row.appendChild(mark);
		row.appendChild(el("span", "working-label", "Working"));
		this.place(row);
		this.workingRow = row;
		const label = row.querySelector(".working-label");
		window.clearInterval(this.workingTimer);
		this.workingTimer = window.setInterval(() => {
			if (!this.workingRow) return;
			const seconds = Math.max(1, Math.round((Date.now() - this.workingStartedAt) / 1000));
			if (label) label.textContent = `Working · ${seconds}s`;
		}, 1000);
	}

	private stopWorking(): void {
		window.clearInterval(this.workingTimer);
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
	): void {
		if (!text && images.length === 0) return;
		this.dismissWelcome();
		const content = images.length > 0 ? buildContent(text, images) : text;
		// This ordinal is temporary: the durable ordinal is applied when the agent
		// echoes the message. It still makes a just-sent row fork sensibly before
		// that echo arrives.
		const row = this.buildUserRow({ role: "user", content } as UserMessage, this.nextUserOrdinal + this.optimisticRows.size);
		this.place(row);
		this.hasContent = true;
		this.optimisticRows.set(clientRequestId, { clientRequestId, text, imageSignature: this.imageSignature(images), row });
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
			if (delivered === pending.text) return pending;
			// The host appends editor selections to the prompt (composeMessageText:
			// `<attachment …>` blocks, or a ` (path lines a-b)` reference), so the
			// delivered text is not byte-identical — but the typed text stays its prefix.
			if (pending.text.length === 0 || !delivered.startsWith(pending.text)) continue;
			const appended = delivered.slice(pending.text.length);
			if (appended.startsWith("\n\n<attachment ") || appended.startsWith(" (")) return pending;
		}
		return undefined;
	}

	private renderMessage(message: AgentMessage, isPartial: boolean): void {
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
					return; // already rendered optimistically
				}
			}
			this.place(this.buildUserRow(userMessage, ordinal));
		} else if (role === "assistant") {
			this.place(this.buildAssistantRow(message as AssistantMessage, isPartial));
		} else if (role === "toolResult") {
			this.renderToolResult(message as ToolResultMessage);
		} else if (role === ("bashExecution" as string)) {
			const m = message as unknown as { command?: string };
			this.systemNote(`! ${m.command ?? "bash command"}`);
		}
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

	private buildAssistantRow(message: AssistantMessage, isPartial: boolean): HTMLElement {
		const row = el("div", "row row-assistant");
		this.fillAssistantRow(row, message, isPartial);
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
					renderMarkdown(part.text, md, this.deps.onOpenLink);
					md.dataset.src = part.text;
				}
				desired.push(md);
			} else if (part.type === "thinking") {
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
				const block = this.ensureToolBlock(part.id, part.name, part.arguments ?? {});
				block.root.dataset.part = `tool-${part.id}`;
				desired.push(block.root);
			}
		}
		if (!isPartial) {
			this.priceUserTurn(message.usage);
			const meta = this.usageLine(message as AssistantMessage);
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
		const wasAtBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 4;
		const previousTop = pane.scrollTop;
		mutate();
		pane.scrollTop = wasAtBottom ? pane.scrollHeight : previousTop;
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
		for (const [index, node] of desired.entries()) {
			if (parent.childNodes[index] !== node) {
				parent.insertBefore(node, parent.childNodes[index] ?? null);
			}
		}
		while (parent.childNodes.length > desired.length) {
			parent.removeChild(parent.childNodes[parent.childNodes.length - 1]);
		}
	}

	private usageLine(message: AssistantMessage): HTMLElement | null {
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
		const line = el("div", `usage-line${isError ? " error" : ""}`, parts.join(" · "));
		if (message.model) line.title = message.model;
		const copyBtn = el("button", "uf-icon usage-copy") as HTMLButtonElement;
		copyBtn.title = "Copy the full reply (text + thinking)";
		copyBtn.appendChild(icon("copy", 11));
		copyBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			copyToClipboard(this.assistantCopyMarkdown(message) || this.assistantAllText(message));
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
		inputHead.appendChild(this.makeCopyButton(view.input));
		section.appendChild(inputHead);

		if (name === "edit" && Array.isArray(args?.edits)) {
			this.buildEditSections(args, inputHead, section);
			return;
		}
		const pre = el("pre");
		if (view.kind === "shell") {
			pre.className = "term";
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

	/**
	 * Tool arguments stream in. The first `message_update` carrying a toolCall has
	 * `arguments: {}` — the code lands over the updates that follow, and only then
	 * does tool_execution_start repeat it. The card is created on that first empty
	 * sighting, so without re-rendering here the collapsed summary stays blank and
	 * the expanded call shows nothing for the life of the card.
	 */
	private refreshToolArgs(block: ToolBlock, name: string, args: Record<string, unknown>): void {
		const view = toolView(name, args);
		if (view.input.length <= block.renderedInputLen) return;
		block.renderedInputLen = view.input.length;
		block.summary.textContent = this.toolSummary(name, args);
		block.root.dataset.toolKind = view.kind;
		block.root.dataset.toolLang = view.lang;
		// Repainting the call replaces the <pre>; if the card is open and someone is
		// reading it, that would jump them to the top mid-stream.
		this.preservingScroll(block.inputSection, "tool", () => {
			this.renderToolInput(block, name, args);
		});
	}

	private ensureToolBlock(id: string, name: string, args: Record<string, unknown>): ToolBlock {
		const existing = this.toolBlocks.get(id);
		if (existing) {
			this.refreshToolArgs(existing, name, args);
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
		const nameEl = el("span", "tool-name", name);
		const summary = el("span", "tool-summary", this.toolSummary(name, args));
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
			const open = root.classList.toggle("open");
			toggle.setAttribute("aria-expanded", String(open));
		});

		const inputSection = el("div", "tool-section");
		const view = toolView(name, args);
		body.appendChild(inputSection);

		const block: ToolBlock = {
			root,
			chevron,
			summary,
			pill,
			body,
			inputSection,
			resultSection: null,
			state: "running",
			renderedInputLen: view.input.length,
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

	private makeCopyButton(text: string): HTMLButtonElement {
		const btn = el("button", "tool-copy", "Copy") as HTMLButtonElement;
		btn.title = "Copy to clipboard";
		btn.addEventListener("click", (event) => {
			event.stopPropagation();
			copyToClipboard(text, () => {
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

	private attachToolResultText(id: string, text: string, isError: boolean): void {
		const block = this.toolBlocks.get(id);
		if (!block) return;
		const section = this.ensureResultSection(block, isError ? "error" : "output", isError);
		const pre = section.querySelector("pre");
		if (pre) this.setPaneText(pre as HTMLElement, text || (isError ? "(error)" : ""));
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
		this.scrollToBottom();
	}

	private renderToolResult(message: ToolResultMessage): void {
		const text = (message.content ?? [])
			.filter((p) => p.type === "text")
			.map((p) => (p as { text: string }).text)
			.join("\n");
		const block = this.toolBlocks.get(message.toolCallId);
		if (block) {
			this.attachToolResultText(message.toolCallId, text, message.isError ?? false);
			return;
		}
		const orphan = this.ensureToolBlock(message.toolCallId, message.toolName ?? "tool", {});
		this.place(orphan.root);
		this.attachToolResultText(message.toolCallId, text, message.isError ?? false);
	}

	// ---------------------------------------------------------------
	// Changed files strip
	// ---------------------------------------------------------------

	renderChangedFiles(files: string[]): void {
		const bar = this.changedFilesBar;
		bar.textContent = "";
		bar.classList.toggle("visible", files.length > 0);
		if (files.length === 0) return;
		const label = el("span", "cf-label", `${files.length} file${files.length === 1 ? "" : "s"} changed`);
		bar.appendChild(label);
		for (const file of files.slice(0, 10)) {
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
			bar.appendChild(chip);
		}
		if (files.length > 10) {
			bar.appendChild(el("span", "cf-more", `+${files.length - 10} more`));
		}
	}

	// ---------------------------------------------------------------

	scrollToBottom(): void {
		if (!this.stickToBottom) return;
		this.scroller.scrollTop = this.scroller.scrollHeight;
	}

	/** Unconditional snap — own sends or explicit user jumps. */
	forceScrollToBottom(): void {
		this.stickToBottom = true;
		this.scroller.scrollTop = this.scroller.scrollHeight;
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
