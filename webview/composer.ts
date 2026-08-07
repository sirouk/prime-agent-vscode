/**
 * Composer: textarea card with attachment chips, @ / slash autocomplete,
 * steering behavior picker, context meter, and Send/Stop controls.
 */

import { el, icon, iconButton } from "./dom.js";
import type { ImageAttachment, RpcSlashCommand, SelectionAttachment } from "../src/protocol.js";

export interface ComposerDeps {
	onSend: (text: string, images: ImageAttachment[], selections: SelectionAttachment[]) => void;
	onStop: () => void;
	onSearchFiles: (query: string, requestId: number) => void;
	onPickImage: () => void;
	onAttachSelection: () => void;
	onAttachActiveFile: () => void;
	onPickModel: () => void;
	onPickThinking: () => void;
	onOpenFile: (path: string, startLine?: number, endLine?: number) => void;
}

export class Composer {
	readonly root: HTMLElement;
	private textarea: HTMLTextAreaElement;
	private chipsEl: HTMLElement;
	private sendBtn: HTMLButtonElement;
	private stopBtn: HTMLButtonElement;
	private behaviorBtn: HTMLButtonElement;
	private contextWrap: HTMLElement;
	private contextFill: HTMLElement;
	private contextLabel: HTMLElement;
	private modelBtn: HTMLButtonElement;
	private thinkingBtn: HTMLButtonElement;
	private autocompleteEl: HTMLElement;

	private images: ImageAttachment[] = [];
	private selections: SelectionAttachment[] = [];
	private commands: RpcSlashCommand[] = [];
	private streaming = false;
	private behavior: "steer" | "followUp" = "steer";

	private acItems: Array<{ label: string; sub?: string; insert: string }> = [];
	private acSelected = 0;
	private acKind: "slash" | "mention" | null = null;
	private acMentionStart = 0;
	private acRequestId = 0;
	private mentionDebounce: number | undefined;

	constructor(private readonly deps: ComposerDeps) {
		this.root = el("div", "composer-dock");
		this.chipsEl = el("div", "composer-chips");

		const card = el("div", "composer-card");
		this.textarea = document.createElement("textarea");
		this.textarea.rows = 1;
		this.textarea.placeholder = "Message Prime Agent…";

		const rail = el("div", "composer-rail");
		const fileBtn = iconButton("file", "Attach active file", 15);
		const selBtn = iconButton("selection", "Attach selection (current editor)", 15);
		const imgBtn = iconButton("image", "Attach image", 15);
		fileBtn.addEventListener("click", () => this.deps.onAttachActiveFile());
		selBtn.addEventListener("click", () => this.deps.onAttachSelection());
		imgBtn.addEventListener("click", () => this.deps.onPickImage());

		this.modelBtn = document.createElement("button");
		this.modelBtn.className = "rail-pill";
		this.modelBtn.title = "Select model";
		this.thinkingBtn = document.createElement("button");
		this.thinkingBtn.className = "rail-pill subtle";
		this.thinkingBtn.title = "Select thinking level";
		this.modelBtn.addEventListener("click", () => this.deps.onPickModel());
		this.thinkingBtn.addEventListener("click", () => this.deps.onPickThinking());

		this.behaviorBtn = document.createElement("button");
		this.behaviorBtn.className = "rail-pill subtle behavior";
		this.behaviorBtn.title = "How a message is delivered while the agent is working";
		this.behaviorBtn.addEventListener("click", () => this.toggleBehavior());

		this.contextWrap = el("div", "context-meter");
		this.contextFill = el("div", "context-fill");
		this.contextLabel = el("span", "context-label", "");
		this.contextWrap.append(this.contextFill, this.contextLabel);

		this.sendBtn = document.createElement("button");
		this.sendBtn.className = "send-btn";
		this.sendBtn.title = "Send (Enter)";
		this.sendBtn.appendChild(icon("send", 15));
		this.sendBtn.addEventListener("click", () => this.send());

		this.stopBtn = document.createElement("button");
		this.stopBtn.className = "send-btn stop";
		this.stopBtn.title = "Stop the run";
		this.stopBtn.appendChild(icon("stop", 13));
		this.stopBtn.style.display = "none";
		this.stopBtn.addEventListener("click", () => this.deps.onStop());

		rail.append(fileBtn, selBtn, imgBtn, el("span", "rail-sep"), this.modelBtn, this.thinkingBtn, this.behaviorBtn, el("span", "spacer"), this.contextWrap, this.stopBtn, this.sendBtn);
		card.append(this.textarea, rail);
		this.root.append(this.chipsEl, card);

		this.autocompleteEl = el("div", "autocomplete");
		card.appendChild(this.autocompleteEl);

		this.textarea.addEventListener("keydown", (event) => this.onKeyDown(event));
		this.textarea.addEventListener("input", () => {
			this.autoGrow();
			this.updateAutocomplete();
		});
		this.textarea.addEventListener("paste", (event) => this.onPaste(event));
		this.textarea.addEventListener("drop", (event) => this.onDrop(event));
		this.textarea.addEventListener("dragover", (event) => event.preventDefault());
		this.autoGrow();
		this.updateBehaviorLabel();
	}

	// ---------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------

	setCommands(commands: RpcSlashCommand[]): void {
		this.commands = commands;
	}

	setModel(label: string): void {
		this.modelBtn.textContent = label;
	}

	setThinking(level: string): void {
		this.thinkingBtn.textContent = level === "off" ? "thinking off" : `thinking ${level}`;
	}

	setStreaming(streaming: boolean): void {
		this.streaming = streaming;
		this.stopBtn.style.display = streaming ? "" : "none";
		this.behaviorBtn.style.display = streaming ? "" : "none";
		if (!streaming) this.behavior = "steer";
		this.updateBehaviorLabel();
	}

	setContext(percent: number | null | undefined, tokens: number | null | undefined, window: number | undefined): void {
		if (percent == null || window == null) {
			this.contextWrap.style.display = "none";
			return;
		}
		this.contextWrap.style.display = "";
		this.contextFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
		this.contextFill.className = `context-fill${percent > 85 ? " hot" : percent > 65 ? " warm" : ""}`;
		const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}k` : String(n));
		this.contextLabel.textContent = tokens != null ? `${compact(tokens)}/${compact(window)}` : `${percent}%`;
		this.contextWrap.title = `Context window: ${percent}% used`;
	}

	addSelection(selection: SelectionAttachment): void {
		this.selections.push(selection);
		this.renderChips();
		this.focus();
	}

	addImages(images: ImageAttachment[]): void {
		this.images.push(...images);
		this.renderChips();
	}

	insertMention(path: string): void {
		const caret = this.textarea.selectionStart ?? this.textarea.value.length;
		const before = this.textarea.value.slice(0, caret);
		const after = this.textarea.value.slice(caret);
		const sep = before && !before.endsWith("\n") && !before.endsWith(" ") ? " " : "";
		this.textarea.value = `${before}${sep}@${path} ${after}`;
		const pos = before.length + sep.length + path.length + 2;
		this.textarea.selectionStart = this.textarea.selectionEnd = pos;
		this.autoGrow();
		this.focus();
	}

	setText(text: string): void {
		this.textarea.value = text;
		this.autoGrow();
		this.focus();
	}

	focus(): void {
		this.textarea.focus();
	}

	onFileSearchResults(requestId: number, files: string[]): void {
		if (this.acKind !== "mention" || requestId !== this.acRequestId) return;
		this.acItems = files.slice(0, 12).map((f) => ({ label: f, insert: f }));
		this.acSelected = 0;
		this.renderAutocomplete();
	}

	// ---------------------------------------------------------------
	// Sending
	// ---------------------------------------------------------------

	send(): void {
		const text = this.textarea.value.trim();
		if (!text && this.images.length === 0 && this.selections.length === 0) return;
		this.deps.onSend(text, this.images, this.selections);
		this.textarea.value = "";
		this.images = [];
		this.selections = [];
		this.renderChips();
		this.autoGrow();
		this.closeAutocomplete();
	}

	get streamingBehavior(): "steer" | "followUp" {
		return this.behavior;
	}

	private toggleBehavior(): void {
		this.behavior = this.behavior === "steer" ? "followUp" : "steer";
		this.updateBehaviorLabel();
	}

	private updateBehaviorLabel(): void {
		this.behaviorBtn.textContent = this.behavior === "steer" ? "steer" : "queue";
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (this.acKind) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				this.moveAutocomplete(1);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				this.moveAutocomplete(-1);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				this.applyAutocomplete();
				return;
			}
			if (event.key === "Escape") {
				this.closeAutocomplete();
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			this.send();
			return;
		}
		// Escape stops a run when the composer is empty
		if (event.key === "Escape" && this.streaming && !this.textarea.value) {
			this.deps.onStop();
		}
	}

	private autoGrow(): void {
		this.textarea.style.height = "auto";
		this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 200)}px`;
	}

	private renderChips(): void {
		this.chipsEl.textContent = "";
		for (const sel of this.selections) {
			const chip = el("div", "compose-chip");
			chip.title = `${sel.path} lines ${sel.startLine}-${sel.endLine}`;
			chip.appendChild(icon("selection", 12));
			chip.appendChild(el("span", "chip-label", `${sel.path}:${sel.startLine}-${sel.endLine}`));
			const remove = el("button", "chip-remove");
			remove.appendChild(icon("close", 11));
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				this.selections = this.selections.filter((s) => s !== sel);
				this.renderChips();
			});
			chip.appendChild(remove);
			chip.addEventListener("click", () => this.deps.onOpenFile(sel.path, sel.startLine, sel.endLine));
			this.chipsEl.appendChild(chip);
		}
		for (const img of this.images) {
			const chip = el("div", "compose-chip image");
			const thumb = document.createElement("img");
			thumb.src = `data:${img.mimeType};base64,${img.data}`;
			chip.appendChild(thumb);
			if (img.name) chip.appendChild(el("span", "chip-label", img.name));
			const remove = el("button", "chip-remove");
			remove.appendChild(icon("close", 11));
			remove.addEventListener("click", (event) => {
				event.stopPropagation();
				this.images = this.images.filter((i) => i !== img);
				this.renderChips();
			});
			chip.appendChild(remove);
			this.chipsEl.appendChild(chip);
		}
	}

	private onPaste(event: ClipboardEvent): void {
		const files = event.clipboardData?.files;
		if (!files || files.length === 0) return;
		const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
		if (imageFiles.length === 0) return;
		event.preventDefault();
		this.readImageFiles(imageFiles);
	}

	private onDrop(event: DragEvent): void {
		event.preventDefault();
		const files = event.dataTransfer?.files;
		if (!files) return;
		this.readImageFiles(Array.from(files).filter((f) => f.type.startsWith("image/")));
	}

	private readImageFiles(files: File[]): void {
		for (const file of files) {
			const reader = new FileReader();
			reader.onload = () => {
				const dataUrl = reader.result as string;
				const [header, data] = dataUrl.split(",");
				this.images.push({ data, mimeType: header.replace("data:", "").replace(";base64", ""), name: file.name || "image" });
				this.renderChips();
			};
			reader.readAsDataURL(file);
		}
	}

	// ---------------------------------------------------------------
	// Autocomplete
	// ---------------------------------------------------------------

	private currentSlashQuery(): string | null {
		const caret = this.textarea.selectionStart ?? 0;
		const value = this.textarea.value;
		if (!value.startsWith("/")) return null;
		const firstSpace = value.indexOf(" ");
		if (firstSpace >= 0 && caret > firstSpace) return null;
		return value.slice(1, caret);
	}

	private currentMentionQuery(): { start: number; query: string } | null {
		const caret = this.textarea.selectionStart ?? 0;
		const before = this.textarea.value.slice(0, caret);
		const match = before.match(/(^|[\s])@([\w./-]*)$/);
		if (!match) return null;
		return { start: caret - match[2].length, query: match[2] };
	}

	private updateAutocomplete(): void {
		const slashQuery = this.currentSlashQuery();
		if (slashQuery !== null && slashQuery.length <= 30 && !slashQuery.includes("\n")) {
			const q = slashQuery.toLowerCase();
			const items = this.commands
				.filter((c) => c.name.toLowerCase().includes(q))
				.slice(0, 12)
				.map((c) => ({ label: `/${c.name}`, sub: c.description, insert: `/${c.name} ` }));
			if (items.length > 0) {
				this.acKind = "slash";
				this.acItems = items;
				this.acSelected = 0;
				this.renderAutocomplete();
				return;
			}
		}
		const mention = this.currentMentionQuery();
		if (mention) {
			this.acKind = "mention";
			this.acMentionStart = mention.start;
			window.clearTimeout(this.mentionDebounce);
			this.mentionDebounce = window.setTimeout(() => {
				this.acRequestId = Date.now();
				this.deps.onSearchFiles(mention.query, this.acRequestId);
			}, 120);
			return;
		}
		this.closeAutocomplete();
	}

	private renderAutocomplete(): void {
		this.autocompleteEl.textContent = "";
		if (!this.acKind || this.acItems.length === 0) {
			this.autocompleteEl.classList.remove("visible");
			return;
		}
		this.acItems.forEach((item, index) => {
			const row = el("button", `ac-item${index === this.acSelected ? " selected" : ""}`);
			row.appendChild(el("span", "ac-label", item.label));
			if (item.sub) row.appendChild(el("span", "ac-sub", item.sub.slice(0, 80)));
			row.addEventListener("mousedown", (event) => {
				event.preventDefault();
				this.acSelected = index;
				this.applyAutocomplete();
			});
			this.autocompleteEl.appendChild(row);
		});
		this.autocompleteEl.classList.add("visible");
	}

	private moveAutocomplete(delta: number): void {
		if (this.acItems.length === 0) return;
		this.acSelected = (this.acSelected + delta + this.acItems.length) % this.acItems.length;
		this.renderAutocomplete();
	}

	private applyAutocomplete(): void {
		const item = this.acItems[this.acSelected];
		if (!item) return;
		const caret = this.textarea.selectionStart ?? this.textarea.value.length;
		if (this.acKind === "slash") {
			this.textarea.value = item.insert;
			this.textarea.selectionStart = this.textarea.selectionEnd = item.insert.length;
		} else {
			const before = this.textarea.value.slice(0, this.acMentionStart);
			const after = this.textarea.value.slice(caret);
			this.textarea.value = `${before}@${item.insert} ${after}`;
			const pos = before.length + item.insert.length + 2;
			this.textarea.selectionStart = this.textarea.selectionEnd = pos;
		}
		this.closeAutocomplete();
		this.autoGrow();
		this.textarea.focus();
	}

	private closeAutocomplete(): void {
		this.acKind = null;
		this.acItems = [];
		this.autocompleteEl.classList.remove("visible");
	}
}
