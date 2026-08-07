/**
 * Composer: textarea card with attachment chips, @ / slash autocomplete,
 * steering behavior picker, context meter, and Send/Stop controls.
 */

import { Dropdown, type DropdownItem } from "./dropdown.js";
import { el, icon, iconButton, svgIcon } from "./dom.js";
import type { ImageAttachment, ModelRef, RpcModel, RpcSlashCommand, SelectionAttachment } from "../src/protocol.js";

export interface ComposerDeps {
	onSend: (text: string, images: ImageAttachment[], selections: SelectionAttachment[]) => void;
	onStop: () => void;
	onSearchFiles: (query: string, requestId: number) => void;
	onPickImage: () => void;
	onAttachSelection: () => void;
	onAttachActiveFile: () => void;
	onSetModel: (provider: string, modelId: string) => void;
	onSetThinking: (level: string) => void;
	onToggleFavorite: (provider: string, modelId: string) => void;
	onOpenFile: (path: string, startLine?: number, endLine?: number) => void;
	onDraftChanged: (text: string) => void;
	onSetCompactThreshold: (percent: number | null) => void;
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
	private brainBtn: HTMLButtonElement;
	private availableThinkingLevels: string[] | null = null;
	private attachMenu: Dropdown | null = null;
	private autocompleteEl: HTMLElement;
	private textWrap: HTMLElement;
	private mirror: HTMLElement;
	private hintEl: HTMLElement | null = null;
	private hintTimer: number | undefined;

	private images: ImageAttachment[] = [];
	private selections: SelectionAttachment[] = [];
	private commands: RpcSlashCommand[] = [];
	private streaming = false;
	private behavior: "steer" | "followUp" = "steer";
	private models: RpcModel[] = [];
	private favorites: ModelRef[] = [];
	private currentModel: { provider?: string; modelId?: string } = {};
	private currentThinking = "off";
	private reasoning = true;
	private vision = false;
	private steerDefault: "steer" | "followUp" = "steer";
	private modelMenu: Dropdown | null = null;
	private thinkingMenu: Dropdown | null = null;

	private acItems: Array<{ label: string; sub?: string; insert: string; dir?: boolean }> = [];
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
		const attachBtn = iconButton("plus", "Attach @file, selection, image…", 15);
		attachBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleAttachMenu(attachBtn);
		});

		this.modelBtn = document.createElement("button");
		this.modelBtn.className = "rail-pill model";
		this.modelBtn.title = "Choose model";
		this.modelBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleModelMenu();
		});
		this.brainBtn = document.createElement("button");
		this.brainBtn.className = "rail-pill brain";
		this.brainBtn.title = "Thinking level";
		this.brainBtn.appendChild(icon("brain", 13));
		this.brainBtn.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleThinkingMenu();
		});

		this.behaviorBtn = document.createElement("button");
		this.behaviorBtn.className = "rail-pill subtle behavior";
		this.behaviorBtn.style.display = "none";
		this.behaviorBtn.title = "How a message is delivered while the agent is working";
		this.behaviorBtn.addEventListener("click", () => this.toggleBehavior());

		this.contextWrap = el("div", "context-meter");
		this.contextWrap.title = "Context window usage — click to set the auto-compact threshold for this session";
		this.contextFill = el("div", "context-fill");
		this.contextLabel = el("span", "context-label", "");
		this.contextWrap.addEventListener("click", (event) => {
			event.stopPropagation();
			this.toggleThresholdFlyout();
		});
		this.contextWrap.append(this.contextFill, this.contextLabel);

		this.sendBtn = document.createElement("button");
		this.sendBtn.className = "send-btn muted";
		this.sendBtn.title = "Send (Enter)";
		this.sendBtn.appendChild(icon("send", 15));
		this.sendBtn.addEventListener("click", () => this.send());

		this.stopBtn = document.createElement("button");
		this.stopBtn.className = "send-btn stop";
		this.stopBtn.title = "Stop run (Esc)";
		this.stopBtn.appendChild(icon("stop", 13));
		this.stopBtn.style.display = "none";
		this.stopBtn.addEventListener("click", () => this.deps.onStop());

		rail.append(attachBtn, this.modelBtn, this.brainBtn, this.behaviorBtn, el("span", "spacer"), this.contextWrap, this.stopBtn, this.sendBtn);
		// Mentions render inline-styled via a mirrored layer behind a transparent textarea.
		this.textWrap = el("div", "composer-text-wrap");
		this.mirror = el("div", "composer-mirror");
		this.textWrap.append(this.mirror, this.textarea);
		card.append(this.textWrap, rail);
		this.root.append(this.chipsEl, card);

		this.autocompleteEl = el("div", "autocomplete");
		card.appendChild(this.autocompleteEl);

		this.textarea.addEventListener("keydown", (event) => this.onKeyDown(event));
		let draftDebounce: number | undefined;
		this.textarea.addEventListener("input", () => {
			this.autoGrow();
			this.updateAutocomplete();
			window.clearTimeout(draftDebounce);
			draftDebounce = window.setTimeout(() => this.deps.onDraftChanged(this.textarea.value), 300);
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

	setModels(models: RpcModel[]): void {
		this.models = models;
		this.updateReasoningState();
	}

	setFavorites(favorites: ModelRef[]): void {
		this.favorites = favorites;
	}

	setModel(label: string, provider?: string, modelId?: string): void {
		// Guard: dropdowns are children of this pill; rewriting identical text
		// would destroy an open menu mid-use (the churn you see while streaming).
		const unchanged =
			this.currentModel.provider === provider &&
			this.currentModel.modelId === modelId &&
			this.modelBtn.textContent === label;
		if (unchanged) return;
		this.currentModel = { provider, modelId };
		this.modelBtn.textContent = label;
		this.modelBtn.title = `Choose model (now ${label})`;
		this.updateReasoningState();
	}

	setThinking(level: string, availableLevels?: string[] | null): void {
		// Daemon may report "max" for the top level; the UI list uses "xhigh".
		this.currentThinking = level === "max" ? "xhigh" : level;
		if (Array.isArray(availableLevels) && availableLevels.length > 0) {
			this.availableThinkingLevels = availableLevels.map((l) => (l === "max" ? "xhigh" : l));
		}
		if (this.reasoning) this.brainBtn.title = `Thinking level: ${this.currentThinking}`;
	}

	setObserving(observing: boolean): void {
		this.textarea.disabled = observing;
		this.sendBtn.disabled = observing;
		this.sendBtn.style.opacity = observing ? "0.4" : "";
		this.textarea.placeholder = observing ? "Watching a live session — read-only" : "Message Prime Agent…";
	}

	setSteerDefault(behavior: "steer" | "followUp"): void {
		this.steerDefault = behavior;
		if (!this.streaming) this.behavior = behavior;
		this.updateBehaviorLabel();
	}

	private currentModelInfo(): RpcModel | undefined {
		return this.models.find((m) => m.provider === this.currentModel.provider && m.id === this.currentModel.modelId);
	}

	private updateReasoningState(): void {
		const model = this.currentModelInfo();
		this.reasoning = model?.reasoning ?? true;
		// Only block when the model is KNOWN to be text-only; undeclared input
		// fields mean "allow" so we don't silently eat pastes.
		this.vision = model?.input ? model.input.includes("image") : true;
		this.modelBtn.title = `Choose model${this.vision ? " (accepts images)" : " (text-only, image attach off)"}`;
		this.brainBtn.classList.toggle("disabled-pill", !this.reasoning);
		this.brainBtn.title = this.reasoning ? `Thinking level: ${this.currentThinking}` : "This model does not support thinking";
		this.brainBtn.disabled = !this.reasoning;
	}

	private showHint(text: string): void {
		if (!this.hintEl) {
			this.hintEl = el("div", "composer-hint");
			this.root.appendChild(this.hintEl);
		}
		this.hintEl.textContent = text;
		this.hintEl.classList.add("visible");
		window.clearTimeout(this.hintTimer);
		this.hintTimer = window.setTimeout(() => this.hintEl?.classList.remove("visible"), 3500);
	}

	private toggleAttachMenu(anchor: HTMLButtonElement): void {
		if (this.attachMenu?.isOpen()) {
			this.attachMenu.hide();
			return;
		}
		const items: DropdownItem[] = [
			{
				label: "Mention a file in chat",
				sub: "Type @ then search the workspace index",
				section: "Attach",
				onSelect: () => {
					this.insertTextAtCaret("@");
					this.updateAutocomplete();
				},
			},
			{ label: "Active editor file", sub: "Reference the file you're editing", onSelect: () => this.deps.onAttachActiveFile() },
			{ label: "Editor selection", sub: "Attach the selected lines as context", onSelect: () => this.deps.onAttachSelection() },
			{
				label: "Image…",
				sub: this.vision ? "Attach a png/jpg/webp screenshot or photo" : "Current model doesn't accept images",
				disabled: !this.vision,
				onSelect: () => this.deps.onPickImage(),
			},
		];
		this.modelMenu?.hide();
		this.thinkingMenu?.hide();
		this.attachMenu = new Dropdown(anchor, {});
		this.attachMenu.show(items);
	}

	private insertTextAtCaret(text: string): void {
		const caret = this.textarea.selectionStart ?? this.textarea.value.length;
		const before = this.textarea.value.slice(0, caret);
		this.textarea.value = `${before}${text}${this.textarea.value.slice(caret)}`;
		this.textarea.selectionStart = this.textarea.selectionEnd = before.length + text.length;
		this.autoGrow();
		this.textarea.focus();
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
		this.contextWrap.title = `Context window: ${percent}% used${this.compactThreshold != null ? ` · auto-compact at ${this.compactThreshold}%` : ""} — click to set the threshold`;
	}

	// ---- auto-compact threshold flyout ----

	private compactThreshold: number | null = null;
	private thresholdFlyout: HTMLElement | null = null;

	setCompactThreshold(percent: number | null): void {
		this.compactThreshold = percent;
		this.renderThresholdFlyout();
	}

	/** The flyout is built lazily; state renders into it. */
	private ensureThresholdFlyout(): HTMLElement {
		if (this.thresholdFlyout) return this.thresholdFlyout;
		const panel = el("div", "threshold-flyout");
		panel.innerHTML = "";
		const title = el("div", "threshold-title", "");
		title.title = "When the context window reaches this fill, Prime Agent compacts it automatically. Range: 20%–80%.";
		const row = el("div", "threshold-row");
		const slider = document.createElement("input");
		slider.type = "range";
		slider.min = "20";
		slider.max = "80";
		slider.step = "5";
		slider.className = "threshold-slider";
		const valueEl = el("span", "threshold-value", "");
		const offBtn = el("button", "threshold-reset") as HTMLButtonElement;
		offBtn.title = "Reset to the agent default compaction";
		offBtn.appendChild(icon("reset", 12));
		slider.addEventListener("input", () => {
			valueEl.textContent = `${slider.value}%`;
		});
		slider.addEventListener("change", () => {
			this.deps.onSetCompactThreshold(Number(slider.value));
		});
		offBtn.addEventListener("click", () => {
			this.deps.onSetCompactThreshold(null);
		});
		row.append(slider, valueEl, offBtn);
		panel.append(title, row);
		this.contextWrap.appendChild(panel);
		this.thresholdFlyout = panel;
		return panel;
	}

	private renderThresholdFlyout(): void {
		const panel = this.thresholdFlyout;
		if (!panel) return;
		const titleEl = panel.querySelector(".threshold-title");
		const slider = panel.querySelector(".threshold-slider") as HTMLInputElement | null;
		const valueEl = panel.querySelector(".threshold-value");
		if (this.compactThreshold != null) {
			if (titleEl) titleEl.textContent = `Force session auto-compact ≥ ${this.compactThreshold}%`;
			if (slider) slider.value = String(this.compactThreshold);
			if (valueEl) valueEl.textContent = `${this.compactThreshold}%`;
		} else {
			if (titleEl) titleEl.textContent = "Agent auto-compact on (default)";
			if (valueEl) valueEl.textContent = "off";
		}
		const offBtn = panel.querySelector(".threshold-reset");
		offBtn?.classList.toggle("active", this.compactThreshold === null);
	}

	private toggleThresholdFlyout(): void {
		const panel = this.ensureThresholdFlyout();
		if (panel.classList.contains("visible")) {
			panel.classList.remove("visible");
			return;
		}
		this.renderThresholdFlyout();
		panel.classList.add("visible");
		setTimeout(() => {
			const closeOnce = (event: MouseEvent) => {
				if (this.thresholdFlyout && !this.thresholdFlyout.contains(event.target as Node) && !this.contextWrap.contains(event.target as Node)) {
					this.thresholdFlyout.classList.remove("visible");
					document.removeEventListener("mousedown", closeOnce, true);
				}
			};
			document.addEventListener("mousedown", closeOnce, true);
		}, 0);
	}

	addSelection(selection: SelectionAttachment): void {
		this.selections.push(selection);
		this.renderChips();
		this.focus();
	}

	addImages(images: ImageAttachment[]): void {
		if (images.length === 0) return;
		if (!this.vision) {
			this.showHint("Current model is text-only — switch to a vision model to attach images.");
			return;
		}
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

	textIsEmpty(): boolean {
		return this.textarea.value.trim() === "";
	}

	setText(text: string): void {
		this.textarea.value = text;
		this.autoGrow();
		this.focus();
	}

	focus(): void {
		this.textarea.focus();
	}

	onFileSearchResults(requestId: number, files: Array<{ path: string; isDir: boolean }> | string[]): void {
		if (this.acKind !== "mention" || requestId !== this.acRequestId) return;
		this.acItems = files.slice(0, 12).map((f) => {
			const item = typeof f === "string" ? { path: f, isDir: f.endsWith("/") } : f;
			return item.isDir
				? { label: `${item.path}/`, sub: "folder", insert: `${item.path}/`, dir: true }
				: { label: item.path, insert: item.path };
		});
		this.acSelected = 0;
		this.renderAutocomplete();
	}

	// ---------------------------------------------------------------
	// Sending
	// ---------------------------------------------------------------

	send(): void {
		const text = this.textarea.value.trim();
		if (!text && this.images.length === 0 && this.selections.length === 0) return;
		if (this.images.length > 0 && !this.vision) {
			this.showHint("Dropped images: current model is text-only. Switch to a vision model or remove the chips.");
			this.images = [];
			this.renderChips();
		}
		this.deps.onSend(text, this.images, this.selections);
		this.textarea.value = "";
		this.images = [];
		this.selections = [];
		this.renderChips();
		this.autoGrow();
		this.closeAutocomplete();
		this.deps.onDraftChanged("");
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
		this.behaviorBtn.title =
			this.behavior === "steer"
				? "Steer: delivered after the current turn, mid-run"
				: "Queue: delivered when the run ends";
	}

	// ---------------------------------------------------------------
	// Model + thinking menus
	// ---------------------------------------------------------------

	private modelLabelFor(model: RpcModel): string {
		return `${model.provider}/${model.id}`;
	}

	private formatCtx(windowSize?: number): string | undefined {
		if (!windowSize) return undefined;
		if (windowSize >= 1_000_000) return `${(windowSize / 1_000_000).toFixed(1)}M ctx`;
		if (windowSize >= 1_000) return `${Math.round(windowSize / 1_000)}k ctx`;
		return `${windowSize}`;
	}

	private isFavorite(model: RpcModel): boolean {
		return this.favorites.some((f) => f.provider === model.provider && f.modelId === model.id);
	}

	private toggleThinkingMenu(): void {
		if (this.thinkingMenu?.isOpen()) {
			this.thinkingMenu.hide();
			return;
		}
		if (!this.reasoning) return;
		const allLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
		const levels = this.availableThinkingLevels?.length
			? allLevels.filter((l) => this.availableThinkingLevels!.includes(l))
			: allLevels;
		const model = this.currentModelInfo();
		const items: DropdownItem[] = levels.map((level) => ({
			label: level,
			sub: level === "xhigh" ? "deepest reasoning this model supports" : undefined,
			current: level === this.currentThinking,
			onSelect: () => this.deps.onSetThinking(level),
		}));
		this.modelMenu?.hide();
		this.thinkingMenu = new Dropdown(this.brainBtn, {
			header: model ? `Thinking — ${this.modelLabelFor(model)}` : "Thinking level",
		});
		this.thinkingMenu.show(items);
	}

	private starAccessory(model: RpcModel): (row: HTMLElement) => void {
		return (row) => {
			const star = el("button", `dropdown-star${this.isFavorite(model) ? " active" : ""}`);
			star.title = this.isFavorite(model) ? "Remove from favorites" : "Save as favorite";
			star.appendChild(svgIcon(["M12 3.8l2.6 5.3 5.8 1-4.2 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.2-4.2 5.8-1z"], 13));
			star.addEventListener("click", (event) => {
				event.stopPropagation();
				event.preventDefault();
				// Optimistic flip; the host confirms with a favorites broadcast.
				this.favorites = this.isFavorite(model)
					? this.favorites.filter((f) => !(f.provider === model.provider && f.modelId === model.id))
					: [...this.favorites, { provider: model.provider, modelId: model.id }];
				this.deps.onToggleFavorite(model.provider, model.id);
				// Rebuild the menu so the star + sections reorder immediately.
				this.modelMenu?.hide();
				this.modelMenu = null;
				this.toggleModelMenu();
			});
			star.addEventListener("mousedown", (event) => event.preventDefault());
			row.appendChild(star);
		};
	}

	private toggleModelMenu(): void {
		if (this.modelMenu?.isOpen()) {
			this.modelMenu.hide();
			return;
		}
		const favorites = this.models.filter((m) => this.isFavorite(m));
		const rest = this.models.filter((m) => !this.isFavorite(m));
		const imageBadge = (model: RpcModel): string | undefined => ((model.input ?? []).includes("image") ? "img" : undefined);
		const rightFor = (model: RpcModel): string | undefined => {
			const bits = [this.formatCtx(model.contextWindow), model.reasoning ? "T" : undefined, imageBadge(model)].filter(Boolean);
			return bits.length ? bits.join(" · ") : undefined;
		};
		const makeItem = (model: RpcModel, section: string): DropdownItem => ({
			label: this.modelLabelFor(model),
			sub: model.name && model.name !== model.id ? model.name : undefined,
			right: rightFor(model),
			section,
			current: model.provider === this.currentModel.provider && model.id === this.currentModel.modelId,
			accessory: this.starAccessory(model),
			onSelect: () => this.deps.onSetModel(model.provider, model.id),
		});
		const items: DropdownItem[] = [
			...favorites.map((m) => makeItem(m, "Favorites")),
			...rest.map((m) => makeItem(m, favorites.length > 0 ? "All models" : "Models")),
		];
		this.attachMenu?.hide();
		this.modelMenu = new Dropdown(this.modelBtn, { placeholder: "Search models…", maxHeight: 340 });
		this.modelMenu.show(items);
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

	/** Mirror the textarea with @path tokens wrapped in styled spans (HTML-escaped). */
	private syncMirror(): void {
		if (!this.mirror) return;
		const text = this.textarea.value;
		const mentionRe = /(^|[\s(`"'])@((?:[\w-]+\/)+(?:[\w./-]*\w|)|[\w-]+\.[\w]{1,8})(?=$|[\s),.;:'"`\/]|$)/g;
		const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		let html = "";
		let last = 0;
		let match: RegExpExecArray | null;
		while ((match = mentionRe.exec(text)) !== null) {
			const start = match.index + match[1].length;
			const path = match[2];
			if (start > last) html += esc(text.slice(last, start));
			html += `<span class="mm" title="${esc(path)}">@${esc(path)}</span>`;
			last = start + path.length + 1;
		}
		if (last < text.length) html += esc(text.slice(last));
		// A trailing newline collapses without this spacer — keep rows visible.
		if (text.endsWith("\n") || text.length === 0) html += " ";
		this.mirror.innerHTML = html;
		// static offset anchor (render size parity): textarea computes height = mirror height
		this.mirror.scrollTop = this.textarea.scrollTop;
	}

	private autoGrow(): void {
		this.syncMirror();
		this.textarea.style.height = "auto";
		this.textarea.style.height = `${Math.min(this.textarea.scrollHeight, 200)}px`;
		this.updateSendState();
	}

	private updateSendState(): void {
		const hasContent =
			this.textarea.value.trim().length > 0 ||
			this.images.length > 0 ||
			this.selections.length > 0;
		this.sendBtn.classList.toggle("muted", !hasContent);
	}

	private renderChips(): void {
		this.updateSendState();
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
		if (!this.vision) {
			this.showHint("Current model is text-only — switch to a vision model to attach images.");
			return;
		}
		this.readImageFiles(imageFiles);
	}

	private onDrop(event: DragEvent): void {
		event.preventDefault();
		const files = event.dataTransfer?.files;
		if (!files) return;
		if (!this.vision) {
			this.showHint("Current model is text-only — switch to a vision model to attach images.");
			return;
		}
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
		// start must include the "@" itself or accepting inserts a second one.
		return { start: caret - match[2].length - 1, query: match[2] };
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
			// No debounce: per-keystroke freshness, staleness is guarded by the request id.
			this.acRequestId = Date.now();
			this.deps.onSearchFiles(mention.query, this.acRequestId);
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
			const row = el("button", `ac-item${index === this.acSelected ? " selected" : ""}${item.dir ? " dir" : ""}`);
			const label = el("span", "ac-label", item.label);
			if (item.dir) {
				label.classList.add("dir");
				label.title = `folder: ${item.label}`;
			}
			row.appendChild(label);
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
			// Inline mention: the @token lives IN the text (styled via the mirror layer).
			const before = this.textarea.value.slice(0, this.acMentionStart);
			const after = this.textarea.value.slice(caret);
			const path = item.insert;
			const tail = after.replace(/^\s+/, "");
			this.textarea.value = `${before}@${path}${tail ? " " : ""}${tail}`;
			const pos = before.length + path.length + 2;
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
