/**
 * Session display labels. Shared by the host chrome and the history list.
 */

/** Longest derived label before it is cut on a word boundary. */
const MAX_DERIVED_LABEL_CHARS = 80;

/**
 * A readable label for a session that was never named. Same rules as the
 * history list: first non-empty prompt line, markdown ornament stripped,
 * cut on a word boundary.
 */
export function deriveSessionLabel(session: { name?: string; firstPrompt?: string }): string {
	const name = session.name?.trim();
	if (name) return name;
	const line = (session.firstPrompt ?? "")
		.split(/\r?\n/)
		.map((entry) => entry.replace(/^[\s>#*\-]+/, "").replace(/\s+/g, " ").trim())
		.find((entry) => entry.length > 0);
	if (!line) return "";
	if (line.length <= MAX_DERIVED_LABEL_CHARS) return line;
	const cut = line.slice(0, MAX_DERIVED_LABEL_CHARS);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > MAX_DERIVED_LABEL_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function firstUserPrompt(messages: ReadonlyArray<{ role?: string; content?: unknown }>): string | undefined {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string" && content.trim()) return content;
		if (Array.isArray(content)) {
			for (const part of content) {
				if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
					const text = (part as { text?: string }).text;
					if (text?.trim()) return text;
				}
			}
		}
	}
	return undefined;
}
