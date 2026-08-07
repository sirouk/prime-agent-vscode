/**
 * Generic dropdown menu for the composer rail: anchored, keyboard-navigable,
 * with optional search box, section labels, and custom row content.
 */

import { el } from "./dom.js";

export interface DropdownItem {
	/** Primary label */
	label: string;
	/** Secondary dimmed text */
	sub?: string;
	/** Section header rendered above this item when it starts a new group */
	section?: string;
	/** Text rendered at the right edge (e.g. context window size) */
	right?: string;
	/** Called when the item is chosen */
	onSelect: () => void;
	/** Render trailing widgets (star toggles, check marks) inside the row */
	accessory?: (row: HTMLElement) => void;
	disabled?: boolean;
	current?: boolean;
}

export interface DropdownOptions {
	placeholder?: string;
	/** Fixed header above the list */
	header?: string;
	/** Max list height in px */
	maxHeight?: number;
}

export class Dropdown {
	private root: HTMLElement;
	private list: HTMLElement = document.createElement("div");
	private input: HTMLInputElement | null = null;
	private items: DropdownItem[] = [];
	private filtered: DropdownItem[] = [];
	private selected = 0;
	private open = false;
	private outsideHandler: (event: MouseEvent) => void;
	private keyHandler: (event: KeyboardEvent) => void;

	constructor(private readonly anchor: HTMLElement, private readonly options: DropdownOptions = {}) {
		this.root = el("div", "dropdown");
		this.outsideHandler = (event) => {
			if (this.open && !this.root.contains(event.target as Node) && !this.anchor.contains(event.target as Node)) {
				this.hide();
			}
		};
		this.keyHandler = (event) => this.onKey(event);
	}

	isOpen(): boolean {
		return this.open;
	}

	toggle(items: DropdownItem[]): void {
		if (this.open) this.hide();
		else this.show(items);
	}

	show(items: DropdownItem[]): void {
		this.hide();
		this.items = items;
		this.root.textContent = "";
		this.list = el("div", "dropdown-list");
		if (this.options.maxHeight) this.list.style.maxHeight = `${this.options.maxHeight}px`;
		if (this.options.header) {
			this.root.appendChild(el("div", "dropdown-header", this.options.header));
		}
		if (this.options.placeholder !== undefined) {
			this.input = document.createElement("input");
			this.input.className = "dropdown-search";
			this.input.placeholder = this.options.placeholder;
			this.input.addEventListener("input", () => this.refilter());
			this.root.appendChild(this.input);
		} else {
			this.input = null;
		}
		this.root.appendChild(this.list);
		this.refilter();

		this.anchor.appendChild(this.root);
		this.open = true;
		document.addEventListener("mousedown", this.outsideHandler, true);
		document.addEventListener("keydown", this.keyHandler, true);
		if (this.input) this.input.focus();
	}

	hide(): void {
		if (!this.open) return;
		this.open = false;
		this.root.remove();
		document.removeEventListener("mousedown", this.outsideHandler, true);
		document.removeEventListener("keydown", this.keyHandler, true);
	}

	private refilter(): void {
		const q = (this.input?.value ?? "").trim().toLowerCase();
		this.filtered = q
			? this.items.filter((item) => `${item.label} ${item.sub ?? ""} ${item.section ?? ""}`.toLowerCase().includes(q))
			: [...this.items];
		this.selected = 0;
		// When filtering, suppress section headers
		this.renderList(q.length > 0);
	}

	private renderList(suppressSections: boolean): void {
		this.list.textContent = "";
		let lastSection: string | undefined;
		this.filtered.forEach((item, index) => {
			if (!suppressSections && item.section && item.section !== lastSection) {
				lastSection = item.section;
				this.list.appendChild(el("div", "dropdown-section", item.section));
			}
			const row = el("button", `dropdown-item${index === this.selected ? " selected" : ""}${item.current ? " current" : ""}${item.disabled ? " disabled" : ""}`);
			const main = el("span", "dropdown-label");
			main.appendChild(el("span", "dropdown-text", item.label));
			if (item.sub) main.appendChild(el("span", "dropdown-sub", item.sub));
			row.appendChild(main);
			if (item.right) row.appendChild(el("span", "dropdown-right", item.right));
			item.accessory?.(row);
			row.addEventListener("click", (event) => {
				event.stopPropagation();
				if (item.disabled) return;
				this.hide();
				item.onSelect();
			});
			row.addEventListener("mousemove", () => {
				if (this.selected !== index) {
					this.selected = index;
					this.renderList(suppressSections);
				}
			});
			this.list.appendChild(row);
		});
		if (this.filtered.length === 0) {
			this.list.appendChild(el("div", "dropdown-empty", "No matches"));
		}
	}

	private onKey(event: KeyboardEvent): void {
		if (!this.open) return;
		if (event.key === "Escape") {
			event.preventDefault();
			this.hide();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const delta = event.key === "ArrowDown" ? 1 : -1;
			const n = this.filtered.length;
			if (n === 0) return;
			let next = this.selected;
			for (let i = 0; i < n; i++) {
				next = (next + delta + n) % n;
				if (!this.filtered[next].disabled) break;
			}
			this.selected = next;
			this.renderList((this.input?.value ?? "").trim().length > 0);
			this.list.querySelector(".dropdown-item.selected")?.scrollIntoView({ block: "nearest" });
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const item = this.filtered[this.selected];
			if (item && !item.disabled) {
				this.hide();
				item.onSelect();
			}
		}
	}
}
