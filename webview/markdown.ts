/**
 * Minimal, safe markdown renderer. Builds DOM nodes via textContent only — no
 * innerHTML anywhere — so agent output can't inject markup into the webview.
 */

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function copyToClipboard(text: string, onDone?: () => void): void {
	const fallback = () => {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		try {
			document.execCommand("copy");
		} catch {
			// ignore
		}
		ta.remove();
		onDone?.();
	};
	if (navigator.clipboard?.writeText) {
		navigator.clipboard.writeText(text).then(() => onDone?.(), fallback);
	} else {
		fallback();
	}
}

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function sanitizeHref(href: string): string {
	try {
		// Deliberately NO base URL. Resolving against one turned a relative or
		// protocol-relative target ("docs/x.md", "//evil.example") into an
		// "allowed" https link whose real destination the text never named — and
		// which the host then refuses anyway. Only an explicit, absolute,
		// allow-listed URL becomes a link; anything else stays inert.
		const url = new URL(href);
		if (ALLOWED_LINK_PROTOCOLS.has(url.protocol)) return url.href;
	} catch {
		// not an absolute URL
	}
	return "#";
}

/** Render inline markdown (code spans, bold, italic, links) into parent. */
function renderInline(text: string, parent: HTMLElement, onOpenLink: (href: string) => void): void {
	// Tokenize with a single pass regex; code spans win over emphasis.
	// Every alternative is newline-bounded AND length-bounded. With open-ended
	// classes an unmatched delimiter ("[", "**", a stray backtick) rescanned to
	// the end of the message from every position — quadratic per pass, and the
	// transcript re-runs this on every streaming delta, so one long reply
	// containing bare "[" froze the panel (measured: 1.9 s at 40k occurrences,
	// 7.4 s at 80k; now 20 ms / 64 ms). The caps are far above any real inline
	// span; anything longer simply renders as the literal text it already is.
	const pattern =
		/(`+)([^`\n]|`(?!`)){0,1000}?\1|\*\*([^*\n]{1,1000})\*\*|__([^_\n]{1,1000})__|\*([^*\n]{1,1000})\*|_([^_\n]{1,1000})_|\[([^\]\n]{1,500})\]\(([^)\s\n]{1,2000})\)/g;
	let last = 0;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > last) {
			parent.appendChild(document.createTextNode(text.slice(last, match.index)));
		}
		if (match[1]) {
			const code = el("code");
			// strip the wrapping backticks
			const inner = match[0].slice(match[1].length, -match[1].length);
			code.textContent = inner;
			parent.appendChild(code);
		} else if (match[3] || match[4]) {
			const strong = el("strong");
			strong.textContent = match[3] ?? match[4] ?? "";
			parent.appendChild(strong);
		} else if (match[5] || match[6]) {
			const em = el("em");
			em.textContent = match[5] ?? match[6] ?? "";
			parent.appendChild(em);
		} else if (match[7] && match[8]) {
			const label = match[7];
			const rawHref = match[8];
			const a = el("a") as HTMLAnchorElement;
			a.textContent = label;
			const href = sanitizeHref(rawHref);
			const openable = href !== "#";
			a.href = href;
			// Hand the HOST the sanitized absolute URL, never the raw text: the two
			// must agree on the destination, or a click opens something the link
			// never claimed (and a relative target only earns an error notice).
			a.title = openable ? rawHref : `${rawHref} — not an openable link`;
			if (!openable) a.className = "md-link-inert";
			a.addEventListener("click", (event) => {
				event.preventDefault();
				if (openable) onOpenLink(href);
			});
			// Middle-click and modifier-click bypass the click handler entirely, so
			// an inert target must not stay navigable through them either.
			a.addEventListener("auxclick", (event) => event.preventDefault());
			parent.appendChild(a);
		}
		last = match.index + match[0].length;
	}
	if (last < text.length) {
		parent.appendChild(document.createTextNode(text.slice(last)));
	}
}

interface ListLine {
	indent: number;
	ordered: boolean;
	text: string;
}

export function renderMarkdown(markdown: string, container: HTMLElement, onOpenLink: (href: string) => void): void {
	container.classList.add("md");
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		// fenced code block
		const fence = line.match(/^```([^`]*)$/);
		if (fence) {
			const lang = fence[1].trim();
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			i++; // skip closing fence
			const pre = el("pre");
			const code = el("code");
			if (lang) code.className = `language-${lang}`;
			const codeText = body.join("\n");
			code.textContent = codeText;
			pre.appendChild(code);
			const wrapper = el("div", "codeblock");
			const head = el("div", "codeblock-head");
			head.appendChild(el("span", "codeblock-lang", lang || "code"));
			const copyBtn = el("button", "codeblock-copy", "Copy");
			copyBtn.addEventListener("click", (event) => {
				event.stopPropagation();
				copyToClipboard(codeText, () => {
					copyBtn.textContent = "Copied";
					setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
				});
			});
			head.appendChild(copyBtn);
			wrapper.append(head, pre);
			container.appendChild(wrapper);
			continue;
		}

		// table
		if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("---")) {
			const headerCells = splitTableRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].trim().startsWith("|")) {
				rows.push(splitTableRow(lines[i]));
				i++;
			}
			const table = el("table");
			const thead = el("thead");
			const tr = el("tr");
			for (const cell of headerCells) {
				const th = el("th");
				renderInline(cell, th, onOpenLink);
				tr.appendChild(th);
			}
			thead.appendChild(tr);
			table.appendChild(thead);
			const tbody = el("tbody");
			for (const row of rows) {
				const trBody = el("tr");
				for (const cell of row) {
					const td = el("td");
					renderInline(cell, td, onOpenLink);
					trBody.appendChild(td);
				}
				tbody.appendChild(trBody);
			}
			table.appendChild(tbody);
			container.appendChild(table);
			continue;
		}

		// heading
		const heading = line.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			const h = el(`h${heading[1].length}`);
			renderInline(heading[2], h, onOpenLink);
			container.appendChild(h);
			i++;
			continue;
		}

		// horizontal rule
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			container.appendChild(el("hr"));
			i++;
			continue;
		}

		// blockquote
		if (/^\s*>/.test(line)) {
			const quote = el("blockquote");
			const quoteLines: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) {
				quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
				i++;
			}
			renderMarkdown(quoteLines.join("\n"), quote, onOpenLink);
			quote.classList.remove("md");
			container.appendChild(quote);
			continue;
		}

		// list (flat with indent support)
		const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
		if (listMatch) {
			const items: ListLine[] = [];
			while (i < lines.length) {
				const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
				if (!m) break;
				items.push({ indent: m[1].length, ordered: /^\d/.test(m[2]), text: m[3] });
				i++;
			}
			container.appendChild(buildList(items, onOpenLink));
			continue;
		}

		// blank line
		if (line.trim() === "") {
			i++;
			continue;
		}

		// paragraph: consume until a block boundary
		const paraLines: string[] = [line];
		i++;
		while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines, i)) {
			paraLines.push(lines[i]);
			i++;
		}
		const p = el("p");
		renderInline(paraLines.join("\n"), p, onOpenLink);
		p.style.whiteSpace = "pre-wrap";
		container.appendChild(p);
	}
}

function isBlockStart(lines: string[], i: number): boolean {
	const line = lines[i];
	return (
		/^```/.test(line) ||
		/^#{1,4}\s/.test(line) ||
		/^\s*>/.test(line) ||
		/^(\s*)([-*+]|\d+[.)])\s+/.test(line) ||
		/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
		(line.trim().startsWith("|") && i + 1 < lines.length && lines[i + 1].includes("---"))
	);
}

function splitTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((cell) => cell.trim());
}

function buildList(items: ListLine[], onOpenLink: (href: string) => void): HTMLElement {
	const rootIsOrdered = items[0]?.ordered ?? false;
	const root = el(rootIsOrdered ? "ol" : "ul");
	let currentList = root;
	const stack: HTMLElement[] = [root];
	for (const item of items) {
		const depth = 1 + Math.floor(item.indent / 2);
		while (stack.length > depth) stack.pop();
		while (stack.length < depth) {
			const nested = el(item.ordered ? "ol" : "ul");
			const lastLi = currentList.lastElementChild ?? currentList.appendChild(el("li"));
			lastLi.appendChild(nested);
			stack.push(nested);
		}
		currentList = stack[stack.length - 1];
		const li = el("li");
		renderInline(item.text, li, onOpenLink);
		currentList.appendChild(li);
	}
	return root;
}
