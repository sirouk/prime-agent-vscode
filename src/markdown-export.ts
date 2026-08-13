/**
 * Client-side Markdown transcript export.
 *
 * Pure: it takes the messages and the session state and returns a string. It
 * touches no vscode API and no controller state, which is why it lives apart
 * from the controller that calls it — and why its harness can import it
 * directly instead of slicing it back out of a 4,000-line file.
 */

export interface ExportToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

export function buildMarkdownExport(
	messages: Array<Record<string, unknown>>,
	includeTools: boolean,
	state: { model?: { provider?: string; id?: string } | null; sessionName?: string } | null,
): string {
	const toolCalls = new Map<string, ExportToolCall>();
	const lines: string[] = [];
	const title = state?.sessionName ? `"${state.sessionName}"` : "session";
	const model = state?.model ? `${state.model.provider}/${state.model.id}` : "unknown model";
	lines.push(`# Prime Agent chat export — ${title}`);
	lines.push("");
	lines.push(`_Exported ${new Date().toLocaleString()} · model ${model}_`);
	lines.push("");
	let omittedTools = 0;

	const summarizeTool = (tool: ExportToolCall): string => {
		const args = tool.args ?? {};
		if (tool.name === "edit" && typeof args.path === "string") {
			const edits = Array.isArray(args.edits) ? (args.edits as Array<{ oldText?: string; newText?: string }>) : [];
			let removed = 0;
			let added = 0;
			for (const e of edits) {
				removed += e.oldText ? e.oldText.split("\n").length : 0;
				added += e.newText ? e.newText.split("\n").length : 0;
			}
			return `${args.path} (+${added}/−${removed}${edits.length > 1 ? `, ${edits.length} edits` : ""})`;
		}
		const candidate = args.code ?? args.command ?? args.path ?? args.prompt ?? args.query;
		const first = typeof candidate === "string" ? candidate.split("\n").find((l) => l.trim()) ?? "" : "";
		return first.length > 120 ? `${first.slice(0, 120)}…` : first;
	};

	for (const message of messages) {
		const role = message.role as string;
		const content = message.content;
		if (role === "user") {
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((p) => (p as { type?: string }).type === "text")
								.map((p) => (p as { text: string }).text)
								.join("\n")
						: "";
			const imageCount = Array.isArray(content) ? content.filter((p) => (p as { type?: string }).type === "image").length : 0;
			lines.push(`## You`);
			lines.push("");
			lines.push(text.trim());
			if (imageCount > 0) lines.push(`_${imageCount} image(s) attached_`);
			lines.push("");
		} else if (role === "assistant") {
			const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
			lines.push(`## Prime Agent`);
			lines.push("");
			for (const part of parts) {
				if (part.type === "text") {
					const text = (part.text as string) ?? "";
					if (text.trim()) {
						lines.push(text.trim());
						lines.push("");
					}
				} else if (part.type === "thinking") {
					const thinking = (part.thinking as string) ?? "";
					if (thinking.trim()) {
						lines.push("> **Thinking**");
						lines.push(">");
						for (const line of thinking.trim().split("\n")) lines.push(`> ${line}`);
						lines.push("");
					}
				} else if (part.type === "toolCall") {
					if (includeTools) {
						toolCalls.set(part.id as string, {
							id: part.id as string,
							name: part.name as string,
							args: (part.arguments as Record<string, unknown>) ?? {},
						});
					} else {
						omittedTools += 1;
					}
				}
			}
		} else if (role === "toolResult") {
			if (!includeTools) continue;
			const toolCallId = message.toolCallId as string;
			const tool = toolCalls.get(toolCallId);
			const text = Array.isArray(content)
				? (content as Array<Record<string, unknown>>)
						.filter((p) => p.type === "text")
						.map((p) => p.text as string)
						.join("\n")
				: "";
			const name = (message.toolName as string) ?? tool?.name ?? "tool";
			const summary = tool ? summarizeTool({ ...tool, result: text, isError: !!message.isError }) : "";
			lines.push(`- ⚙ **${name}** ${summary}${message.isError ? " — _(failed)_" : ""}`);
			lines.push("");
			if (toolCallId) toolCalls.delete(toolCallId);
		}
	}
	// Calls without a result (aborted runs) — summarize from arguments anyway.
	for (const orphan of toolCalls.values()) {
		lines.push(`- ⚙ **${orphan.name}** ${summarizeTool(orphan)} — _(no result)_`);
		lines.push("");
	}
	if (!includeTools && omittedTools > 0) {
		lines.push(`_${omittedTools} tool call(s) omitted_`);
		lines.push("");
	}
	return lines.join("\n");
}
