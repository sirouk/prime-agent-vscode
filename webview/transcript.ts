/**
 * Transcript: message rendering and the live agent-event state machine.
 */

import { butterfly, el, icon } from "./dom.js";
import { copyToClipboard, renderMarkdown } from "./markdown.js";
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
	private workingRow: HTMLElement | null = null;
	private workingStartedAt = 0;
	private workingTimer: number | undefined;
	private streaming = false;
	private hasContent = false;
	private welcome: HTMLElement | null = null;
	private changedFilesBar: HTMLElement;

	constructor(
		private readonly scroller: HTMLElement,
		changedFilesBar: HTMLElement,
		private readonly deps: TranscriptDeps,
	) {
		this.changedFilesBar = changedFilesBar;
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
				this.systemNote(`Retrying (${event.attempt}/${event.maxAttempts})${event.errorMessage ? `: ${event.errorMessage}` : ""}`);
				break;
			case "auto_retry_end":
				if (!event.success) {
					this.systemNote(`Retry failed${event.finalError ? `: ${event.finalError}` : ""}`, true);
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

	private renderMessage(message: AgentMessage, isPartial: boolean): void {
		const role = message.role;
		if (role === "user") {
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

	private buildUserRow(message: UserMessage): HTMLElement {
		const row = el("div", "row row-user");
		const plainText = this.userMessageText(message);
		const actions = el("div", "row-actions");
		actions.appendChild(this.makeCopyButton(plainText));
		row.appendChild(actions);
		const bubble = el("div", "bubble bubble-user");
		if (typeof message.content === "string") {
			bubble.appendChild(el("div", "bubble-text", message.content));
		} else if (Array.isArray(message.content)) {
			const textParts = message.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
			const images = message.content.filter((p) => p.type === "image");
			if (textParts.length > 0) {
				bubble.appendChild(el("div", "bubble-text", textParts.join("\n").trim()));
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
		return row;
	}

	private buildAssistantRow(message: AssistantMessage, isPartial: boolean): HTMLElement {
		const row = el("div", "row row-assistant");
		this.fillAssistantRow(row, message, isPartial);
		const actions = el("div", "row-actions");
		actions.appendChild(this.makeCopyButton(this.assistantAllText(message)));
		row.appendChild(actions);
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
		const existingActions = el("div", "row-actions");
		existingActions.appendChild(this.makeCopyButton(this.assistantAllText(message)));
		row.appendChild(existingActions);
		const avatar = el("div", "avatar");
		avatar.appendChild(butterfly(16));
		const body = el("div", "row-body");
		row.append(avatar, body);
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
			if (meta) body.appendChild(meta);
		}
	}

	private buildThinking(thinking: string, isPartial: boolean): HTMLElement {
		const details = el("details", "thinking") as HTMLDetailsElement;
		details.open = isPartial;
		const summary = el("summary", "", "Thought process");
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
		if (stop && stop !== "stop" && stop !== "toolUse") {
			parts.push(`stopped: ${stop}${message.errorMessage ? ` — ${message.errorMessage}` : ""}`);
		}
		if (parts.length === 0) return null;
		const line = el("div", "usage-line", parts.join(" · "));
		if (message.model) line.title = message.model;
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
		header.append(chevron, statusDot, nameEl, summary, pill);
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
		block.pill.textContent = state === "done" ? "done" : state;
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
		this.scroller.scrollTop = this.scroller.scrollHeight;
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
