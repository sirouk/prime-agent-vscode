/**
 * Prime Agent chat webview: transcript rendering, composer, autocomplete.
 */

import { renderMarkdown } from "./markdown.js";
import type {
	AgentEvent,
	AgentMessage,
	AssistantMessage,
	HostToWebview,
	ImageAttachment,
	RpcModel,
	RpcSlashCommand,
	SelectionAttachment,
	StatusSnapshot,
	ToolResultMessage,
	UserMessage,
	WebviewToHost,
} from "../src/protocol.js";

const vscode = acquireVsCodeApi();

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function post(message: WebviewToHost): void {
	vscode.postMessage(message);
}

// ---------------------------------------------------------------------------
// Layout scaffolding
// ---------------------------------------------------------------------------

const app = document.getElementById("app") as HTMLDivElement;

const toolbar = el("div", "toolbar");
const connDot = el("span", "conn-dot") as HTMLSpanElement;
const modelBtn = document.createElement("button");
modelBtn.className = "model-label";
modelBtn.textContent = "no model";
modelBtn.title = "Select model";
const thinkingBtn = document.createElement("button");
thinkingBtn.className = "thinking-label";
thinkingBtn.textContent = "thinking: off";
thinkingBtn.title = "Select thinking level";
toolbar.append(
	connDot,
	modelBtn,
	thinkingBtn,
	el("span", "spacer"),
);
const newSessionBtn = document.createElement("button");
newSessionBtn.textContent = "New";
newSessionBtn.title = "New session";
const historyBtn = document.createElement("button");
historyBtn.textContent = "History";
historyBtn.title = "Resume recent session";
const compactBtn = document.createElement("button");
compactBtn.textContent = "Compact";
compactBtn.title = "Compact conversation context";
const exportBtn = document.createElement("button");
exportBtn.textContent = "Export";
exportBtn.title = "Export chat as HTML";
const restartBtn = document.createElement("button");
restartBtn.textContent = "Restart";
restartBtn.title = "Restart agent process";
toolbar.append(newSessionBtn, historyBtn, compactBtn, exportBtn, restartBtn);

const notices = el("div", "notices");
const messagesEl = el("div", "messages");

const changedFilesBar = el("div", "changed-files");

const composer = el("div", "composer");
const chipsEl = el("div", "chips");
const textarea = document.createElement("textarea");
textarea.placeholder = "Message Prime Agent…  (@ mentions files, / runs commands)";
textarea.rows = 1;

const composerBar = el("div", "composer-bar");
const attachFileBtn = document.createElement("button");
attachFileBtn.textContent = "@";
attachFileBtn.title = "Mention a file";
const attachSelBtn = document.createElement("button");
attachSelBtn.textContent = "Sel";
attachSelBtn.title = "Attach current editor selection";
const attachImgBtn = document.createElement("button");
attachImgBtn.textContent = "Img";
attachImgBtn.title = "Attach image";
const behaviorSelect = document.createElement("select");
const optSteer = document.createElement("option");
optSteer.value = "steer";
optSteer.textContent = "Steer";
const optFollow = document.createElement("option");
optFollow.value = "followUp";
optFollow.textContent = "Queue";
behaviorSelect.append(optSteer, optFollow);
behaviorSelect.title = "Delivery while the agent is working";
const queuedBadge = el("span", "queued-badge", "0 queued");
queuedBadge.style.display = "none";
const stopBtn = document.createElement("button");
stopBtn.textContent = "Stop";
stopBtn.title = "Abort the current run";
stopBtn.style.display = "none";
const sendBtn = document.createElement("button");
sendBtn.className = "primary";
sendBtn.textContent = "Send";
composerBar.append(attachFileBtn, attachSelBtn, attachImgBtn, el("span", "spacer"), queuedBadge, behaviorSelect, stopBtn, sendBtn);
composer.append(chipsEl, textarea, composerBar);

const statusbar = el("div", "statusbar");
const statusLeft = el("span", "", "");
const statusRight = el("span");
statusbar.append(statusLeft, el("span", "spacer"), statusRight);

const autocompleteEl = el("div", "autocomplete");

app.append(toolbar, notices, messagesEl, changedFilesBar, composer, statusbar, autocompleteEl);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ToolBlock {
	root: HTMLElement;
	header: HTMLElement;
	summary: HTMLElement;
	statusDot: HTMLElement;
	body: HTMLElement;
	resultSection: HTMLElement | null;
	state: "running" | "done" | "error";
}

const toolBlocks = new Map<string, ToolBlock>();
let streamingBubble: HTMLElement | null = null;
let streamingThinkingBody: Map<number, HTMLElement> | null = null;
let workingRow: HTMLElement | null = null;

let connected = false;
let streaming = false;
let images: ImageAttachment[] = [];
let selections: SelectionAttachment[] = [];
let commands: RpcSlashCommand[] = [];
let models: RpcModel[] = [];
let emptyStateEl: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

function clearTranscript(): void {
	messagesEl.textContent = "";
	toolBlocks.clear();
	streamingBubble = null;
	streamingThinkingBody = null;
	emptyStateEl = null;
}

function ensureNoEmptyState(): void {
	if (emptyStateEl) {
		emptyStateEl.remove();
		emptyStateEl = null;
	}
}

function showEmptyState(): void {
	if (emptyStateEl || messagesEl.childElementCount > 0) return;
	emptyStateEl = el("div", "empty-state");
	emptyStateEl.textContent = connected
		? "Send a message to start. Use @ to mention files, / for skills and commands."
		: "Starting Prime Agent…";
	messagesEl.appendChild(emptyStateEl);
}

function scrollToBottom(): void {
	messagesEl.scrollTop = messagesEl.scrollHeight;
}

function openLink(href: string): void {
	post({ type: "openExternal", url: href });
}

function renderUserMessage(message: UserMessage): HTMLElement {
	ensureNoEmptyState();
	const bubble = el("div", "msg msg-user");
	const text = typeof message.content === "string" ? message.content : "";
	if (typeof message.content === "string") {
		bubble.appendChild(el("div", "msg-text", message.content));
	} else if (Array.isArray(message.content)) {
		const textParts: string[] = [];
		const imgs: ImageAttachment[] = [];
		for (const part of message.content) {
			if (part.type === "text") textParts.push(part.text);
			if (part.type === "image") imgs.push(part);
		}
		if (textParts.length > 0) bubble.appendChild(el("div", "msg-text", textParts.join("\n").trim()));
		if (imgs.length > 0) {
			const row = el("div", "msg-attachments");
			for (const img of imgs) {
				const image = document.createElement("img");
				image.src = `data:${img.mimeType};base64,${img.data}`;
				row.appendChild(image);
			}
			bubble.appendChild(row);
		}
	} else if (text) {
		bubble.appendChild(el("div", "msg-text", text));
	}
	messagesEl.appendChild(bubble);
	return bubble;
}

function toolSummary(name: string, args: Record<string, unknown>): string {
	const candidates = ["code", "command", "path", "file", "prompt", "query", "url"];
	for (const key of candidates) {
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

function renderToolCall(id: string, name: string, args: Record<string, unknown>): ToolBlock {
	let block = toolBlocks.get(id);
	if (block) return block;

	const root = el("div", "tool");
	const header = el("div", "tool-header");
	const statusDot = el("span", "tool-status running");
	const nameEl = el("span", "tool-name", name);
	const summary = el("span", "tool-summary", toolSummary(name, args ?? {}));
	const body = el("div", "tool-body");
	header.append(statusDot, nameEl, summary);
	root.append(header, body);
	header.addEventListener("click", () => root.classList.toggle("open"));

	const argsPre = el("pre");
	const argsSection = el("div");
	argsSection.appendChild(el("div", "tool-section-label", "input"));

	const codeish = (args?.code ?? args?.command) as string | undefined;
	argsPre.textContent = typeof codeish === "string" ? codeish : JSON.stringify(args, null, 2);
	argsSection.appendChild(argsPre);
	body.appendChild(argsSection);

	block = { root, header, summary, statusDot, body, resultSection: null, state: "running" };
	toolBlocks.set(id, block);
	return block;
}

function setToolState(id: string, state: "running" | "done" | "error"): void {
	const block = toolBlocks.get(id);
	if (!block) return;
	block.state = state;
	block.statusDot.className = `tool-status ${state}`;
}

function toolResultText(result: ToolResultMessage): string {
	const parts: string[] = [];
	for (const part of result.content ?? []) {
		if (part && part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function attachToolResult(id: string, text: string, isError: boolean): void {
	const block = toolBlocks.get(id);
	if (!block) return;
	if (!block.resultSection) {
		block.resultSection = el("div", isError ? "tool-error" : "");
		block.resultSection.appendChild(el("div", "tool-section-label", isError ? "error" : "result"));
		const pre = el("pre");
		block.resultSection.appendChild(pre);
		block.body.appendChild(block.resultSection);
	}
	const pre = block.resultSection.querySelector("pre");
	if (pre) pre.textContent = text || (isError ? "(error)" : "");
	setToolState(id, isError ? "error" : "done");
}

function updateToolPartial(id: string, partial: unknown): void {
	const block = toolBlocks.get(id);
	if (!block || block.state !== "running") return;
	const text = extractPartialText(partial);
	if (!text) return;
	if (!block.resultSection) {
		block.resultSection = el("div");
		block.resultSection.appendChild(el("div", "tool-section-label", "output"));
		block.resultSection.appendChild(el("pre"));
		block.body.appendChild(block.resultSection);
	}
	const pre = block.resultSection.querySelector("pre");
	if (pre) pre.textContent = text;
	scrollToBottom();
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

function renderAssistantMessage(message: AssistantMessage, opts: { isPartial: boolean }): HTMLElement {
	ensureNoEmptyState();
	const container = el("div", "msg msg-assistant");
	renderAssistantContentInto(container, message, opts);
	if (!opts.isPartial) {
		const usage = message.usage;
		if (usage) {
			const parts: string[] = [];
			if (usage.totalTokens != null) parts.push(`${formatNumber(usage.totalTokens)} tok`);
			if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
			const stop = message.stopReason;
			if (message.model) parts.push(message.model);
			if (stop && stop !== "stop" && stop !== "toolUse") parts.push(`(${stop}${message.errorMessage ? `: ${message.errorMessage}` : ""})`);
			if (parts.length > 0) container.appendChild(el("div", "msg-usage", parts.join(" · ")));
		}
	}
	if (!opts.isPartial || !streamingBubble) {
		messagesEl.appendChild(container);
	}
	return container;
}

function renderAssistantContentInto(container: HTMLElement, message: AssistantMessage, _opts: { isPartial: boolean }): void {
	container.textContent = "";
	const thinkingBodies = new Map<number, HTMLElement>();
	let contentIndex = 0;
	for (const part of message.content ?? []) {
		if (part.type === "text") {
			if (part.text.trim()) {
				const md = el("div", "md");
				renderMarkdown(part.text, md, openLink);
				container.appendChild(md);
			}
		} else if (part.type === "thinking") {
			const details = el("details", "thinking");
			const summary = el("summary", "", "Thinking");
			const body = el("div", "thinking-body");
			body.textContent = part.thinking;
			details.append(summary, body);
			container.appendChild(details);
			thinkingBodies.set(contentIndex, body);
		} else if (part.type === "toolCall") {
			const block = renderToolCall(part.id, part.name, part.arguments ?? {});
			container.appendChild(block.root);
		}
		contentIndex++;
	}
	if (streamingBubble === container) {
		streamingThinkingBody = thinkingBodies;
	}
}

function renderToolResultMessage(message: ToolResultMessage): void {
	ensureNoEmptyState();
	const existing = toolBlocks.get(message.toolCallId);
	const text = toolResultText(message);
	if (existing) {
		attachToolResult(message.toolCallId, text, message.isError ?? false);
		return;
	}
	// Orphan tool result (no matching block) — render as a standalone tool block.
	const block = renderToolCall(message.toolCallId, message.toolName ?? "tool", {});
	messagesEl.appendChild(block.root);
	attachToolResult(message.toolCallId, text, message.isError ?? false);
}

function renderSystemNote(text: string): void {
	ensureNoEmptyState();
	messagesEl.appendChild(el("div", "msg msg-system", text));
}

function renderMessage(message: AgentMessage, isPartial = false): void {
	const role = message.role;
	if (role === "user") {
		renderUserMessage(message as UserMessage);
	} else if (role === "assistant") {
		renderAssistantMessage(message as AssistantMessage, { isPartial });
	} else if (role === "toolResult") {
		renderToolResultMessage(message as ToolResultMessage);
	} else if (role === ("bashExecution" as string)) {
		const m = message as unknown as { command?: string; output?: string };
		renderSystemNote(`! ${m.command ?? "bash command"}`);
	} else {
		// Unknown/extension roles: subtle marker only if they carry visible text.
		const maybeText = (message as { content?: unknown }).content;
		if (typeof maybeText === "string" && maybeText.trim()) {
			renderSystemNote(maybeText.slice(0, 200));
		}
	}
}

function rebuildTranscript(messages: AgentMessage[]): void {
	clearTranscript();
	for (const message of messages) {
		renderMessage(message, false);
	}
	showEmptyState();
	scrollToBottom();
}

// ---------------------------------------------------------------------------
// Live event handling
// ---------------------------------------------------------------------------

function ensureWorkingRow(): void {
	if (workingRow) return;
	workingRow = el("div", "working-row");
	workingRow.append(el("span", "spinner"), el("span", "", "Working…"));
	messagesEl.appendChild(workingRow);
	scrollToBottom();
}

function removeWorkingRow(): void {
	workingRow?.remove();
	workingRow = null;
}

function handleEvent(event: AgentEvent): void {
	switch (event.type) {
		case "agent_start":
			streaming = true;
			removeWorkingRow();
			ensureWorkingRow();
			updateComposerMode();
			break;
		case "agent_end":
			streaming = false;
			removeWorkingRow();
			streamingBubble = null;
			updateComposerMode();
			break;
		case "turn_start":
			break;
		case "message_start": {
			const message = event.message;
			if (message.role === "assistant") {
				removeWorkingRow();
				streamingBubble = renderAssistantMessage(message as AssistantMessage, { isPartial: true });
				messagesEl.appendChild(streamingBubble);
			} else {
				renderMessage(message, false);
			}
			break;
		}
		case "message_update": {
			const message = event.message as AssistantMessage;
			if (message.role === "assistant" && streamingBubble) {
				renderAssistantContentInto(streamingBubble, message, { isPartial: true });
			}
			break;
		}
		case "message_end": {
			const message = event.message;
			if (message.role === "assistant" && streamingBubble) {
				// Re-render finalized message (includes usage footer) in place.
				const fresh = renderAssistantMessage(message as AssistantMessage, { isPartial: false });
				streamingBubble.replaceWith(fresh);
				streamingBubble = null;
			} else if (message.role !== "user" && message.role !== "toolResult") {
				renderMessage(message, false);
			}
			ensureWorkingRowIfAgentBusy();
			break;
		}
		case "tool_execution_start":
			removeWorkingRow();
			renderToolCall(event.toolCallId, event.toolName, event.args ?? {});
			// If we get here after the assistant bubble ended without a bubble
			// (rare), the block attaches on its own.
			setToolState(event.toolCallId, "running");
			ensureWorkingRow();
			break;
		case "tool_execution_update":
			updateToolPartial(event.toolCallId, event.partialResult);
			break;
		case "tool_execution_end": {
			const text = extractPartialText(event.result);
			if (text) attachToolResult(event.toolCallId, text, event.isError ?? false);
			else setToolState(event.toolCallId, event.isError ? "error" : "done");
			break;
		}
		case "compaction_start":
			renderSystemNote("Compacting context…");
			break;
		case "compaction_end":
			break;
		case "auto_retry_start":
			renderSystemNote(`Retrying (${event.attempt}/${event.maxAttempts})${event.errorMessage ? `: ${event.errorMessage}` : ""}`);
			break;
		case "auto_retry_end":
			if (!event.success) {
				renderSystemNote(`Retry failed${event.finalError ? `: ${event.finalError}` : ""}`);
				removeWorkingRow();
			}
			break;
		case "session_action_update": {
			const count = event.actions?.queuedCount ?? 0;
			queuedBadge.style.display = count > 0 ? "" : "none";
			queuedBadge.textContent = `${count} queued`;
			break;
		}
		case "turn_end":
			ensureWorkingRowIfAgentBusy();
			break;
		default:
			break;
	}
	scrollToBottom();
}

function ensureWorkingRowIfAgentBusy(): void {
	if (streaming) ensureWorkingRow();
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

function addNotice(level: "info" | "warning" | "error", text: string): void {
	const note = el("div", `notice ${level}`);
	note.appendChild(el("span", "", text));
	const dismiss = el("span", "dismiss", "✕");
	dismiss.addEventListener("click", () => note.remove());
	note.appendChild(dismiss);
	notices.appendChild(note);
	if (level === "info") {
		setTimeout(() => note.remove(), 8000);
	}
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function applyStatus(status: StatusSnapshot): void {
	connected = status.connected;
	streaming = status.streaming;
	connDot.className = `conn-dot ${status.connected ? (status.streaming ? "working" : "connected") : ""}`;
	modelBtn.textContent = status.modelLabel;
	thinkingBtn.textContent = `thinking: ${status.thinkingLevel}`;
	const titleBits = [status.sessionName, status.sessionFile].filter(Boolean).join("\n");
	toolbar.title = titleBits;
	const leftText = status.statusText ?? (status.connected ? "" : "agent not running");
	statusLeft.textContent = status.compacting ? "Compacting…" : status.retrying ? "Retrying…" : leftText;
	statusRight.textContent = status.statsText;
	updateComposerMode();
	if (!messagesEl.childElementCount) showEmptyState();
}

function updateComposerMode(): void {
	stopBtn.style.display = streaming ? "" : "none";
	behaviorSelect.disabled = !streaming;
	behaviorSelect.title = streaming
		? "Steer: deliver mid-run after the current turn. Queue: deliver when the run ends."
		: "Delivery mode while the agent is working";
	queuedBadge.style.display = streaming ? queuedBadge.style.display : "none";
	if (!streaming) behaviorSelect.value = "steer";
}

// ---------------------------------------------------------------------------
// Changed files bar
// ---------------------------------------------------------------------------

function renderChangedFiles(files: string[]): void {
	changedFilesBar.textContent = "";
	changedFilesBar.classList.toggle("visible", files.length > 0);
	if (files.length === 0) return;
	changedFilesBar.appendChild(el("span", "cf-label", `Changed (${files.length}):`));
	for (const file of files.slice(0, 12)) {
		const chip = el("button", "chip", file) as HTMLButtonElement;
		chip.title = `${file} — click to open`;
		chip.addEventListener("click", () => post({ type: "openFile", path: file }));
		changedFilesBar.appendChild(chip);
		const diffBtn = document.createElement("button");
		diffBtn.className = "chip";
		diffBtn.textContent = "diff";
		diffBtn.title = `Diff ${file} against git HEAD`;
		diffBtn.addEventListener("click", () => post({ type: "openDiff", path: file }));
		changedFilesBar.appendChild(diffBtn);
	}
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function autoGrow(): void {
	textarea.style.height = "auto";
	textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
}

function renderChips(): void {
	chipsEl.textContent = "";
	for (const sel of selections) {
		const chip = el("span", "chip");
		chip.appendChild(el("span", "", `${sel.path}:${sel.startLine}-${sel.endLine}`));
		const remove = el("span", "remove", "✕");
		remove.addEventListener("click", (event) => {
			event.stopPropagation();
			selections = selections.filter((s) => s !== sel);
			renderChips();
		});
		chip.appendChild(remove);
		chip.addEventListener("click", () => post({ type: "openFile", path: sel.path, startLine: sel.startLine, endLine: sel.endLine }));
		chipsEl.appendChild(chip);
	}
	for (const img of images) {
		const chip = el("span", "chip");
		const thumb = document.createElement("img");
		thumb.src = `data:${img.mimeType};base64,${img.data}`;
		chip.appendChild(thumb);
		const remove = el("span", "remove", "✕");
		remove.addEventListener("click", (event) => {
			event.stopPropagation();
			images = images.filter((i) => i !== img);
			renderChips();
		});
		chip.appendChild(remove);
		chipsEl.appendChild(chip);
	}
}

function sendCurrentMessage(): void {
	const text = textarea.value.trim();
	if (!text && images.length === 0 && selections.length === 0) return;
	post({
		type: "prompt",
		payload: {
			text,
			images,
			selections,
			streamingBehavior: behaviorSelect.value === "followUp" ? "followUp" : "steer",
		},
	});
	textarea.value = "";
	images = [];
	selections = [];
	renderChips();
	autoGrow();
	closeAutocomplete();
}

sendBtn.addEventListener("click", sendCurrentMessage);
stopBtn.addEventListener("click", () => post({ type: "abort" }));

textarea.addEventListener("keydown", (event) => {
	if (autocompleteEl.classList.contains("visible")) {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			moveAutocomplete(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			moveAutocomplete(-1);
			return;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			applyAutocompleteSelection();
			return;
		}
		if (event.key === "Escape") {
			closeAutocomplete();
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendCurrentMessage();
	}
});

textarea.addEventListener("input", () => {
	autoGrow();
	updateAutocomplete();
});

textarea.addEventListener("paste", (event) => {
	const files = event.clipboardData?.files;
	if (!files || files.length === 0) return;
	const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
	if (imageFiles.length === 0) return;
	event.preventDefault();
	for (const file of imageFiles) {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			const [header, data] = dataUrl.split(",");
			images.push({ data, mimeType: header.replace("data:", "").replace(";base64", ""), name: file.name || "pasted-image" });
			renderChips();
		};
		reader.readAsDataURL(file);
	}
});

textarea.addEventListener("drop", (event) => {
	event.preventDefault();
	const files = event.dataTransfer?.files;
	if (!files) return;
	for (const file of Array.from(files)) {
		if (!file.type.startsWith("image/")) continue;
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			const [header, data] = dataUrl.split(",");
			images.push({ data, mimeType: header.replace("data:", "").replace(";base64", ""), name: file.name });
			renderChips();
		};
		reader.readAsDataURL(file);
	}
});

textarea.addEventListener("dragover", (event) => event.preventDefault());

// ---------------------------------------------------------------------------
// Autocomplete (slash commands + @ file mentions)
// ---------------------------------------------------------------------------

interface AutocompleteState {
	kind: "slash" | "mention";
	items: Array<{ label: string; sub?: string; insert: string }>;
	selected: number;
	mentionStart: number;
	slashActive: boolean;
	searchRequestId: number;
}

let acState: AutocompleteState | null = null;
let mentionDebounce: number | undefined;

function currentMentionQuery(): { start: number; query: string } | null {
	const caret = textarea.selectionStart ?? 0;
	const before = textarea.value.slice(0, caret);
	const match = before.match(/(^|[\s])@([\w./-]*)$/);
	if (!match) return null;
	return { start: caret - match[2].length, query: match[2] };
}

function currentSlashQuery(): string | null {
	const caret = textarea.selectionStart ?? 0;
	const value = textarea.value;
	if (!value.startsWith("/")) return null;
	const firstSpace = value.indexOf(" ");
	if (firstSpace >= 0 && caret > firstSpace) return null;
	return value.slice(1, caret);
}

function updateAutocomplete(): void {
	const slashQuery = currentSlashQuery();
	if (slashQuery !== null && slashQuery.length <= 30 && !slashQuery.includes("\n")) {
		const q = slashQuery.toLowerCase();
		const items = commands
			.filter((c) => c.name.toLowerCase().includes(q))
			.slice(0, 12)
			.map((c) => ({ label: `/${c.name}`, sub: c.description, insert: `/${c.name} ` }));
		if (items.length > 0) {
			acState = { kind: "slash", items, selected: 0, mentionStart: 0, slashActive: true, searchRequestId: 0 };
			renderAutocomplete();
			return;
		}
	}
	const mention = currentMentionQuery();
	if (mention && commands.length >= 0) {
		window.clearTimeout(mentionDebounce);
		mentionDebounce = window.setTimeout(() => {
			const requestId = Date.now();
			acState = { kind: "mention", items: [], selected: 0, mentionStart: mention.start, slashActive: false, searchRequestId: requestId };
			post({ type: "searchFiles", query: mention.query, requestId });
		}, 120);
		return;
	}
	closeAutocomplete();
}

function renderAutocomplete(): void {
	autocompleteEl.textContent = "";
	if (!acState || acState.items.length === 0) {
		autocompleteEl.classList.remove("visible");
		return;
	}
	acState.items.forEach((item, index) => {
		const row = el("div", `item${index === acState!.selected ? " selected" : ""}`);
		row.appendChild(el("span", "", item.label));
		if (item.sub) row.appendChild(el("span", "sub", item.sub.slice(0, 90)));
		row.addEventListener("mousedown", (event) => {
			event.preventDefault();
			acState!.selected = index;
			applyAutocompleteSelection();
		});
		autocompleteEl.appendChild(row);
	});
	autocompleteEl.classList.add("visible");
}

function moveAutocomplete(delta: number): void {
	if (!acState || acState.items.length === 0) return;
	acState.selected = (acState.selected + delta + acState.items.length) % acState.items.length;
	renderAutocomplete();
}

function applyAutocompleteSelection(): void {
	if (!acState) return;
	const item = acState.items[acState.selected];
	if (!item) return;
	const caret = textarea.selectionStart ?? textarea.value.length;
	if (acState.kind === "slash") {
		const value = textarea.value;
		const firstSpace = value.indexOf(" ");
		const end = firstSpace >= 0 && caret > firstSpace ? firstSpace : caret;
		textarea.value = item.insert + value.slice(end);
		textarea.selectionStart = textarea.selectionEnd = item.insert.length;
	} else {
		const before = textarea.value.slice(0, acState.mentionStart);
		const after = textarea.value.slice(caret);
		textarea.value = `${before}@${item.insert} ${after}`;
		const pos = before.length + item.insert.length + 2;
		textarea.selectionStart = textarea.selectionEnd = pos;
	}
	closeAutocomplete();
	autoGrow();
	textarea.focus();
}

function closeAutocomplete(): void {
	acState = null;
	autocompleteEl.classList.remove("visible");
}

function onFileSearchResults(requestId: number, files: string[]): void {
	if (!acState || acState.kind !== "mention" || acState.searchRequestId !== requestId) return;
	acState.items = files.slice(0, 12).map((f) => ({ label: f, insert: f }));
	acState.selected = 0;
	renderAutocomplete();
}

// ---------------------------------------------------------------------------
// Toolbar actions
// ---------------------------------------------------------------------------

modelBtn.addEventListener("click", () => post({ type: "pickModel" }));
thinkingBtn.addEventListener("click", () => post({ type: "pickThinkingLevel" }));
newSessionBtn.addEventListener("click", () => post({ type: "newSession" }));
historyBtn.addEventListener("click", () => post({ type: "requestHistory" }));
compactBtn.addEventListener("click", () => post({ type: "compact" }));
exportBtn.addEventListener("click", () => post({ type: "exportHtml" }));
restartBtn.addEventListener("click", () => {
	clearTranscript();
	showEmptyState();
	post({ type: "restart" });
});
attachFileBtn.addEventListener("click", () => post({ type: "attachActiveFile" }));
attachSelBtn.addEventListener("click", () => post({ type: "attachSelection" }));
attachImgBtn.addEventListener("click", () => post({ type: "pickImage", requestId: Date.now() }));

// ---------------------------------------------------------------------------
// Host message entry point
// ---------------------------------------------------------------------------

window.addEventListener("message", (messageEvent) => {
	const message = messageEvent.data as HostToWebview;
	switch (message.type) {
		case "snapshot":
			rebuildTranscript(message.messages ?? []);
			applyStatus(message.status);
			break;
		case "event":
			handleEvent(message.event);
			break;
		case "status":
			applyStatus(message.status);
			break;
		case "models":
			models = message.models;
			break;
		case "commands":
			commands = message.commands;
			break;
		case "notice":
			addNotice(message.level, message.text);
			break;
		case "uiState":
			if (message.statusText !== undefined) statusLeft.textContent = message.statusText;
			break;
		case "fileSearchResults":
			onFileSearchResults(message.requestId, message.files);
			break;
		case "imagePicked":
			if (message.images.length > 0) {
				images.push(...message.images);
				renderChips();
			}
			break;
		case "insertSelection":
			selections.push(message.selection);
			renderChips();
			textarea.focus();
			break;
		case "insertMention": {
			const caret = textarea.selectionStart ?? textarea.value.length;
			const before = textarea.value.slice(0, caret);
			const after = textarea.value.slice(caret);
			const sep = before && !before.endsWith("\n") && !before.endsWith(" ") ? " " : "";
			textarea.value = `${before}${sep}@${message.path} ${after}`;
			const pos = before.length + sep.length + message.path.length + 2;
			textarea.selectionStart = textarea.selectionEnd = pos;
			autoGrow();
			textarea.focus();
			break;
		}
		case "changedFiles":
			renderChangedFiles(message.files);
			break;
		case "editorText":
			textarea.value = message.text;
			autoGrow();
			textarea.focus();
			break;
		case "focusComposer":
			textarea.focus();
			break;
		case "promptRejected":
			addNotice("error", `Prompt rejected: ${message.error}`);
			break;
		case "history":
			// handled by host-side QuickPick; ignore here
			break;
	}
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function formatNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

showEmptyState();
autoGrow();
post({ type: "ready" });
