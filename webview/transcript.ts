/**
 * Transcript: message rendering and the live agent-event state machine.
 */

import { butterfly, el, icon } from "./dom.js";
import { copyToClipboard, renderMarkdown } from "./markdown.js";

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
	resultSection: HTMLElement | null;
	state: "running" | "done" | "error";
}

export class Transcript {
	private toolBlocks = new Map<string, ToolBlock>();
	private streamingBubble: HTMLElement | null = null;
	private optimisticText: string | null = null;
	private optimisticAt = 0;
	private retryRow: HTMLElement | null = null;
	private workingRow: HTMLElement | null = null;
	private workingStartedAt = 0;
	private workingTimer: number | undefined;
	private streaming = false;
	private hasContent = false;
	private welcome: HTMLElement | null = null;
	private changedFilesBar: HTMLElement;

	private stickToBottom = true;
	private jumpBtn: HTMLElement | null = null;
	/** Selections saved on collapse, key = the collapsible element (details / .tool root). */
	private savedSelections = new WeakMap<HTMLElement, string>();

	/**
	 * Capture the user's text selection inside a collapsible block before it is
	 * hidden, so expanding can restore it (and extend it to cover the content
	 * that was hidden while collapsed).
	 */
	private captureSelection(block: HTMLElement): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
		const range = sel.getRangeAt(0);
		if (!block.contains(range.commonAncestorContainer)) return;
		this.savedSelections.set(block, range.toString());
	}

	private restoreSelection(block: HTMLElement): void {
		const saved = this.savedSelections.get(block);
		if (!saved || !saved.trim()) return;
		this.savedSelections.delete(block);
		const anchor = saved.slice(0, 60).trimStart();
		const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
		let startNode: Text | null = null;
		let startOffset = 0;
		let endNode: Text | null = null;
		let endOffset = 0;
		let acc = "";
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			const content = node.data ?? "";
			if (!startNode) {
				const at = (acc + content).indexOf(anchor);
				if (at >= 0) {
					const local = Math.min(content.length, Math.max(0, at - acc.length));
					startNode = node;
					startOffset = local;
				}
			}
			endNode = node;
			endOffset = content.length;
			acc += content;
		}
		if (!startNode || !endNode) return;
		const range = document.createRange();
		range.setStart(startNode, startOffset);
		range.setEnd(endNode, endOffset);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		block.scrollIntoView({ block: "nearest" });
	}

	private wireSelectionPreserve(): void {
		// <details> thinking blocks
		this.scroller.addEventListener("toggle", (event) => {
			const d = event.target as HTMLDetailsElement;
			if (!(d instanceof HTMLDetailsElement)) return;
			if (d.open) this.restoreSelection(d);
			else this.captureSelection(d);
		}, true);
		// .tool cards (class-based toggle)
		this.scroller.addEventListener("click", (event) => {
			const header = (event.target as HTMLElement).closest(".tool-header");
			const root = header?.closest(".tool") as HTMLElement | null;
			if (!header || !root) return;
			if (root.classList.contains("open")) {
				this.captureSelection(root);
			} else {
				setTimeout(() => this.restoreSelection(root), 0);
			}
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
			this.jumpBtn = el("button", "jump-to-latest", "↓ latest");
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
		this.hasContent = messages.length > 0;
		for (const message of messages) {
			this.renderMessage(message, false);
		}
		if (!this.hasContent) this.showWelcome();
		this.scrollToBottom();
	}

	// ---------------------------------------------------------------
	// Live events
	// ---------------------------------------------------------------

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
				if (message.role === "assistant" && this.streamingBubble) {
					this.fillAssistantRow(this.streamingBubble, message, true);
				}
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message.role === "assistant" && this.streamingBubble) {
					this.fillAssistantRow(this.streamingBubble, message as AssistantMessage, false);
					this.streamingBubble = null;
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
		this.optimisticAt = Date.now();
		this.scrollToBottom();
	}

	private renderMessage(message: AgentMessage, isPartial: boolean): void {
		const role = message.role;
		if (role === "user") {
			const text = this.userMessageText(message as UserMessage);
			if (this.optimisticText !== null && text === this.optimisticText && Date.now() - this.optimisticAt < 20_000) {
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
		return row;
	}

	/** Footer under a user bubble: estimated token count, copy, and fork-from-here. */
	private buildUserFooter(row: HTMLElement, text: string): HTMLElement {
		const footer = el("div", "user-footer");
		const est = Math.max(1, Math.round(text.length / 4));
		const estLabel = est >= 1000 ? `~${(est / 1000).toFixed(1)}k tokens (est.)` : `~${est} tokens (est.)`;
		const tokensEl = el("span", "uf-tokens", estLabel);
		tokensEl.title = "Estimated from message length (~4 chars/token). Cost is tracked on assistant replies.";
		footer.appendChild(tokensEl);
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

	private buildAssistantRow(message: AssistantMessage, isPartial: boolean): HTMLElement {
		const row = el("div", "row row-assistant");
		this.fillAssistantRow(row, message, isPartial);
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

	private assistantAllText(message: AssistantMessage): string {
		return (message.content ?? [])
			.filter((p) => p.type === "text")
			.map((p) => (p as { text: string }).text)
			.join("\n\n")
			.trim();
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
			copyToClipboard(this.assistantAllText(message));
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
		for (const key of ["code", "command", "path", "file", "prompt", "query", "url"]) {
			const value = args?.[key];
			if (typeof value === "string" && value.trim()) {
				const firstLine = value.split("\n").find((l) => l.trim().length > 0) ?? "";
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

	private ensureToolBlock(id: string, name: string, args: Record<string, unknown>): ToolBlock {
		const existing = this.toolBlocks.get(id);
		if (existing) return existing;

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
		const codeish = (args?.code ?? args?.command) as string | undefined;
		const inputText = typeof codeish === "string" ? codeish : JSON.stringify(args, null, 2);
		const inputLabel = name === "ipython" ? "python" : name === "bash" ? "shell" : "input";
		const inputHead = el("div", "tool-section-head");
		inputHead.appendChild(el("span", "", inputLabel));
		inputHead.appendChild(this.makeCopyButton(inputText));
		inputSection.appendChild(inputHead);

		if (name === "edit" && Array.isArray(args?.edits)) {
			this.buildEditSections(args, inputHead, inputSection);
		} else {
			const pre = el("pre");
			if (name === "bash") {
				pre.className = "term";
				pre.textContent = "";
				for (const [index, line] of inputText.split("\n").entries()) {
					if (index > 0) pre.appendChild(document.createTextNode("\n"));
					const lineEl = el("span", "term-line", line);
					if (index === 0) {
						const prompt = el("span", "term-prompt", "$ ");
						pre.appendChild(prompt);
					}
					pre.appendChild(lineEl);
				}
			} else {
				pre.textContent = inputText;
			}
			inputSection.appendChild(pre);

			// Edit-tool convenience: jump to the target file.
			const maybePath = args?.path;
			if ((name === "edit" || name === "write" || name === "read") && typeof maybePath === "string" && maybePath.trim()) {
				const openBtn = el("button", "tool-open", `Open ${shortenPath(maybePath)}`);
				openBtn.title = "Open file in editor";
				openBtn.addEventListener("click", (event) => {
					event.stopPropagation();
					this.deps.onOpenFile(maybePath);
				});
				inputSection.appendChild(openBtn);
			}
		}
		body.appendChild(inputSection);

		const block: ToolBlock = {
			root,
			chevron,
			summary,
			pill,
			body,
			resultSection: null,
			state: "running",
		};
		root.dataset.toolName = name;
		this.toolBlocks.set(id, block);
		return block;
	}

	/** Full tool call + every captured output section, formatted for paste into chat/docs. */
	private buildToolCopy(id: string): string {
		const block = this.toolBlocks.get(id);
		if (!block) return "";
		const name = (block.root as HTMLElement & { dataset: DOMStringMap }).dataset.toolName ?? "tool";
		const parts: string[] = [`⚙ ${name}`];
		const inputPre = block.body.querySelector(".tool-section pre");
		if (inputPre?.textContent?.trim()) {
			const lang = name === "ipython" ? "python" : name === "bash" ? "shell" : "";
			parts.push(`\`\`\`${lang ? lang : ""}\n${inputPre.textContent.trim()}\n\`\`\``);
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
		if (block.root.dataset.toolName === "bash") pre.className = "term";
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
