/**
 * Export-markdown harness: exercises buildMarkdownExport from
 * src/markdown-export.ts against representative AgentMessage arrays.
 *
 * The exporter is pure and lives in its own module, so this harness just strips
 * the types with esbuild and imports it.
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

// The exporter is its own module now, so this harness imports it instead of
// slicing it back out of the controller by string offset — the old approach
// broke the moment anything moved below it in the file.
const srcPath = new URL("../src/markdown-export.ts", import.meta.url);
const src = fs.readFileSync(srcPath, "utf8");
check("buildMarkdownExport is an exported symbol", /export function buildMarkdownExport/.test(src));
const { code } = esbuild.transformSync(src, { loader: "ts", format: "esm", target: "node18" });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-md-"));
const tmpFile = path.join(tmpDir, "build-markdown-export.mjs");
fs.writeFileSync(tmpFile, code);
const { buildMarkdownExport } = await import(`file://${tmpFile}`);
check("harness exposes buildMarkdownExport", typeof buildMarkdownExport === "function");

const LEAK = "SECRET_TOOL_OUTPUT_MARKER";
const MINUS = "\u2212";

const messages = [
	{ role: "user", content: "Please fix the parser and keep it fast." },
	{
		role: "assistant",
		model: "kimi",
		content: [
			{ type: "thinking", thinking: "Let me look at the parser.\nIt splits tokens wrongly." },
			{ type: "text", text: "I will update the tokenizer." },
			{
				type: "toolCall",
				id: "tc1",
				name: "edit",
				arguments: {
					path: "src/parser.ts",
					edits: [
						{ oldText: "const a = 1;\nconst b = 2;", newText: "const a = 10;" }, // -2 / +1
						{ oldText: "tokenize(x);", newText: "tokenize(x);\nemit();" }, // -1 / +2
					],
				},
			},
			{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "npm test" } },
		],
	},
	{ role: "toolResult", toolCallId: "tc1", toolName: "edit", content: [{ type: "text", text: `${LEAK} applied 2 edits` }] },
	{ role: "toolResult", toolCallId: "tc2", toolName: "bash", content: [{ type: "text", text: `${LEAK} 42 tests passed` }] },
	{
		role: "user",
		content: [
			{ type: "text", text: "here is a screenshot of the error" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "image", data: "aGky", mimeType: "image/png" },
		],
	},
];

const state = { model: { provider: "chutes", id: "kimi" }, sessionName: "demo session" };

// ------------------------------------------------------------------
// includeTools = true
// ------------------------------------------------------------------
const md = buildMarkdownExport(messages, true, state);

check("header names the session", md.includes('"demo session"'), md.split("\n")[0]);
check("header names the model", md.includes("chutes/kimi"));
check("user text exported", md.includes("Please fix the parser and keep it fast."));
check("assistant text exported", md.includes("I will update the tokenizer."));
check(
	"thinking rendered as blockquote",
	md.includes("> **Thinking**") && md.includes("> Let me look at the parser.") && md.includes("> It splits tokens wrongly."),
);
check(
	"edit tool summarized with (+N/-M) hunk counts",
	md.includes(`**edit** src/parser.ts (+3/${MINUS}3, 2 edits)`),
	(md.match(/⚙.*edit.*/u) ?? ["<no edit line>"])[0],
);
check("bash tool summarized from command", md.includes("**bash** npm test"));
check("no full tool output leaked", !md.includes(LEAK));
check("image attachment noted, data not inlined", md.includes("_2 image(s) attached_") && !md.includes("aGk="));
const gearLines = md.split("\n").filter((l) => l.includes("⚙"));
check("exactly one gear line per tool result", gearLines.length === 2, `${gearLines.length} gear lines`);

// ------------------------------------------------------------------
// includeTools = false
// ------------------------------------------------------------------
const clean = buildMarkdownExport(messages, false, state);

check("omission note with count", clean.includes("_2 tool call(s) omitted_"));
check("zero gear lines without tools", !clean.includes("⚙"));
check("no tool output without tools", !clean.includes(LEAK));
check("no edit-summary leak without tools", !clean.includes("src/parser.ts"));
check("thinking still blockquoted without tools", clean.includes("> **Thinking**"));
check("assistant text kept without tools", clean.includes("I will update the tokenizer."));

// ------------------------------------------------------------------
// Roles beyond user/assistant/toolResult (Prime Agent 0.10 transcripts carry all of them)
// ------------------------------------------------------------------
const rich = [
	{ role: "compactionSummary", summary: "We fixed the parser and agreed to keep tokens lazy.", tokensBefore: 123456, timestamp: 1 },
	{ role: "branchSummary", summary: "Tried a regex approach; abandoned it.", fromId: "e1", timestamp: 2 },
	{ role: "bashExecution", command: "git status", output: "On branch main\nnothing to commit", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 },
	{ role: "custom", customType: "refinement_outcome", content: "Created 2 memories", display: true, timestamp: 4 },
	{ role: "custom", customType: "bookkeeping", content: "HIDDEN_BOOKKEEPING", display: false, timestamp: 5 },
];
const richMd = buildMarkdownExport(rich, true, state);
check("a compaction summary survives export", richMd.includes("Earlier context (compacted)") && richMd.includes("We fixed the parser and agreed to keep tokens lazy."));
check("the compaction size is stated", richMd.includes("123,456 tokens before compaction"));
check("a branch summary survives export", richMd.includes("Branch summary") && richMd.includes("Tried a regex approach; abandoned it."));
check("a !command is recorded with its status", richMd.includes("You ran a command (exit 0)") && richMd.includes("git status"));
check("its output follows with tools on", richMd.includes("nothing to commit"));
check("its output is withheld with tools off", !buildMarkdownExport(rich, false, state).includes("nothing to commit"));
check("a displayed custom message is exported", richMd.includes("refinement_outcome") && richMd.includes("Created 2 memories"));
check("a hidden custom message is not", !richMd.includes("HIDDEN_BOOKKEEPING"));

// ------------------------------------------------------------------
// Null state + empty transcript robustness
// ------------------------------------------------------------------
const minimal = buildMarkdownExport([], true, null);
check("null state does not throw", minimal.includes("unknown model") && minimal.includes("chat export"));

console.log(failed === 0 ? "\nPASS export-md harness" : `\n${failed} export-md checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
