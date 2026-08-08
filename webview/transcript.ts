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
	onSpawnedCardClick: (activeSessionId: string) => void;
	onNewSession: () => void;
	onShowHistory: () => void;
	onFocusComposer: () => void;
}

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

export class Transcript {
	private toolBlocks = new Map<string, ToolBlock>();
	private streamingBubble: HTMLElement | null = null;
	private optimisticText: string | null = null;
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

	/**
	 * Insert a "subagent spawned" marker into the transcript, positioned by the
	 * subagent's created time so it lines up with where in the run it happened.
	 * Durable across resumes because it's re-derived from daemon state, not stored.
	 */
	clearSpawnCards(): void {
		this.spawnCardIds.clear();
		this.scroller.querySelectorAll(".spawned-card").forEach((n) => n.remove());
	}

	injectSpawnCard(options: { id: string; name?: string; created?: string | null }): void {
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
			this.deps.onSpawnedCardClick(options.id);
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
			const toggler = target?.closest(".tool-header, details.thinking > summary") as HTMLElement | null;
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
			if (!(event.target as HTMLElement | null)?.closest(".tool-header")) return;
			setTimeout(() => this.restoreSelection(), 0);
		}, true);
	}

	constructor(
		private readonly scroller: HTMLElement,
		changedFilesBar: HTMLElement,
		private readonly deps: TranscriptDeps,
	) {
		this.changedFilesBar = changedFilesBar;
		// Scroll-lock: only auto-follow the stream while the reader is already
		// at (or very near) the bottom. Scrolling up during a reply must never
		// be overridden by updates. A "latest" jump pill appears while un-stuck.
		this.wireSelectionPreserve();
		this.scroller.addEventListener("scroll", () => {
			const nearBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 48;
			this.stickToBottom = nearBottom;
			this.updateJumpButton();
		}, { passive: true });
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

		this.scroller.appendChild(root);
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
		this.optimisticText = null;
		// The jump pill lived inside the scroller we just emptied; keeping the
		// detached node would leave the operator with no way back to the bottom
		// for the rest of the session.
		this.jumpBtn = null;
		this.hasContent = messages.length > 0;
		for (const message of messages) {
			this.renderMessage(message, false);
		}
		if (!this.hasContent) this.showWelcome();
		// A freshly opened session always lands on the latest message, whatever
		// the scroll position was in the session we came from.
		this.forceScrollToBottom();
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
		this.scroller.appendChild(this.streamingBubble);
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
					this.scroller.appendChild(this.streamingBubble);
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
					this.scroller.appendChild(block.root);
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
		this.scroller.appendChild(row);
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
		this.scroller.appendChild(row);
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

	/** Render the user's message immediately on send; deduped when the real
	 * message_start event for it arrives shortly after. */
	showOptimisticUserMessage(text: string, images: Array<{ data: string; mimeType: string }>): void {
		if (!text && images.length === 0) return;
		this.dismissWelcome();
		const content = images.length > 0 ? buildContent(text, images) : text;
		this.scroller.appendChild(this.buildUserRow({ role: "user", content } as UserMessage));
		this.hasContent = true;
		this.optimisticText = text;
		// The operator just hit send — that is an explicit intent to follow along.
		this.forceScrollToBottom();
		this.updateJumpButton();
	}

	/** Forget the pending optimistic echo (rejected prompt, session change). */
	clearOptimistic(): void {
		this.optimisticText = null;
	}

	/**
	 * Does this delivered user message echo the bubble we already drew?
	 *
	 * No wall clock: a steered or queued message is only injected at the next turn
	 * boundary, which on a long tool call is minutes away — any timeout here shows
	 * the operator their own message twice. The echo is consumed on the first
	 * match instead.
	 */
	private matchesOptimistic(delivered: string): boolean {
		const typed = this.optimisticText;
		if (typed === null) return false;
		if (delivered === typed) return true;
		// The host appends editor selections to the prompt (composeMessageText:
		// `<attachment …>` blocks, or a ` (path lines a-b)` reference), so the
		// delivered text is never byte-identical — but the typed text stays its prefix.
		if (typed.length === 0 || !delivered.startsWith(typed)) return false;
		const appended = delivered.slice(typed.length);
		return appended.startsWith("\n\n<attachment ") || appended.startsWith(" (");
	}

	private renderMessage(message: AgentMessage, isPartial: boolean): void {
		const role = message.role;
		if (role === "user") {
			const text = this.userMessageText(message as UserMessage);
			if (this.matchesOptimistic(text)) {
				this.optimisticText = null;
				return; // already rendered optimistically
			}
			this.scroller.appendChild(this.buildUserRow(message as UserMessage));
		} else if (role === "assistant") {
			this.scroller.appendChild(this.buildAssistantRow(message as AssistantMessage, isPartial));
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

	private buildUserRow(message: UserMessage): HTMLElement {
		const row = el("div", "row row-user");
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
		// The price lands when the reply that consumed this message arrives.
		this.pendingUserFooter = footer;
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
			const users = Array.from(this.scroller.querySelectorAll(".row-user"));
			const ordinal = users.indexOf(row);
			if (ordinal >= 0) this.deps.onForkFromUser(ordinal);
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

	private fillAssistantRow(row: HTMLElement, message: AssistantMessage, isPartial: boolean): void {
		row.textContent = "";
		const body = el("div", "row-body");
		row.append(body);
		for (const part of (message as AssistantMessage).content ?? []) {
			if (part.type === "text") {
				if (!part.text.trim()) continue;
				const md = el("div", "md");
				renderMarkdown(part.text, md, this.deps.onOpenLink);
				body.appendChild(md);
			} else if (part.type === "thinking") {
				body.appendChild(this.buildThinking(part.thinking, isPartial));
			} else if (part.type === "toolCall") {
				const block = this.ensureToolBlock(part.id, part.name, part.arguments ?? {});
				body.appendChild(block.root);
			}
		}
		if (!isPartial) {
			this.priceUserTurn(message.usage);
			const meta = this.usageLine(message as AssistantMessage);
			if (meta) {
				body.appendChild(meta);
			} else if (body.childElementCount === 0) {
				body.appendChild(el("div", "usage-line", "(no response)"));
			}
		}
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
			copyToClipboard(thinking);
		});
		summary.appendChild(copyBtn);
		const body = el("div", "thinking-body");
		body.textContent = thinking;
		details.append(summary, body);
		return details;
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
		this.scroller.appendChild(el("div", `system-note${isError ? " error" : ""}`, text));
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
		this.renderToolInput(block, name, args);
	}

	private ensureToolBlock(id: string, name: string, args: Record<string, unknown>): ToolBlock {
		const existing = this.toolBlocks.get(id);
		if (existing) {
			this.refreshToolArgs(existing, name, args);
			return existing;
		}

		const root = el("div", "tool");
		const header = el("button", "tool-header");
		header.title = "Expand tool details";
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
		header.append(chevron, statusDot, nameEl, summary, pill, copyAllBtn);
		const body = el("div", "tool-body");
		root.append(header, body);
		header.addEventListener("click", () => {
			root.classList.toggle("open");
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

	private attachToolResultText(id: string, text: string, isError: boolean): void {
		const block = this.toolBlocks.get(id);
		if (!block) return;
		const section = this.ensureResultSection(block, isError ? "error" : "output", isError);
		const pre = section.querySelector("pre");
		if (pre) pre.textContent = text || (isError ? "(error)" : "");
		this.setToolState(id, isError ? "error" : "done");
	}

	private updateToolPartial(id: string, partial: unknown): void {
		const block = this.toolBlocks.get(id);
		if (!block || block.state !== "running") return;
		const text = extractPartialText(partial);
		if (!text) return;
		const section = this.ensureResultSection(block, "output", false);
		const pre = section.querySelector("pre");
		if (pre) pre.textContent = text;
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
		this.scroller.appendChild(orphan.root);
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
