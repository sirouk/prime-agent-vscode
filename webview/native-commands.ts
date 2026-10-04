/**
 * Prime Agent's native slash commands.
 *
 * The agent's `get_commands` lists only extension, prompt and skill commands:
 * the built-ins (/reload, /new, /model …) are executed by the terminal UI and
 * would reach the model as plain text over RPC. So the composer offers the ones
 * this panel can truly perform and routes each to the action the panel already
 * has for it. Anything not listed here is deliberately absent rather than
 * offered and then ignored.
 *
 * `agent` commands are different: the agent itself runs them when they arrive
 * as a prompt, so they only need to appear in the menu.
 */

export type NativeAction = "new" | "reload" | "compact" | "model" | "effort" | "export" | "name" | "resume";

export interface NativeCommand {
	name: string;
	description: string;
	/** Panel action to run. Absent: the agent executes it from an ordinary prompt. */
	action?: NativeAction;
	/** Hidden names that run the same command. */
	aliases?: readonly string[];
}

export const NATIVE_COMMANDS: readonly NativeCommand[] = [
	{ name: "new", description: "Start a new session", action: "new", aliases: ["clear"] },
	{ name: "reload", description: "Reload extensions, skills and prompts", action: "reload" },
	{ name: "compact", description: "Compact the session context; optional instructions focus the summary", action: "compact" },
	{ name: "model", description: "Select model", action: "model" },
	{ name: "effort", description: "Select reasoning/thinking level", action: "effort", aliases: ["thinking"] },
	{ name: "export", description: "Export this chat", action: "export" },
	{ name: "name", description: "Set the session display name", action: "name", aliases: ["rename"] },
	{ name: "resume", description: "Open session history", action: "resume" },
	{ name: "refine", description: "Refine continual harness prompt notes, skills, subagents, and memory" },
	{ name: "goal", description: "Set or view a persistent goal; supports pause, resume, and clear" },
	{ name: "autonomous", description: "Set or view autonomous mode" },
];

/**
 * Native commands the menu may offer. A command the agent's own catalog already
 * defines under the same name is the agent's to run, so it is not shadowed.
 */
export function visibleNativeCommands(catalogNames: ReadonlySet<string>): NativeCommand[] {
	return NATIVE_COMMANDS.filter((c) => !catalogNames.has(c.name));
}

/** Resolve typed text to a panel action, or null when it is an ordinary prompt. */
export function resolveNativeAction(
	text: string,
	catalogNames: ReadonlySet<string>,
): { action: NativeAction; args: string } | null {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return null;
	const typed = match[1].toLowerCase();
	// A catalog entry under the typed name (alias included) is the agent's own.
	if (catalogNames.has(match[1])) return null;
	const command = NATIVE_COMMANDS.find((c) => c.name === typed || c.aliases?.includes(typed));
	if (!command?.action) return null;
	return { action: command.action, args: (match[2] ?? "").trim() };
}
