/**
 * Export-markdown harness: exercises buildMarkdownExport from
 * src/session-controller.ts against representative AgentMessage arrays.
 *
 * The function is module-private in the source. Instead of changing src
 * (adding an `export`), this harness extracts the function tail textually,
 * strips types with esbuild, and imports the generated ESM from a temp file.
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

const srcPath = new URL("../src/session-controller.ts", import.meta.url);
const src = fs.readFileSync(srcPath, "utf8");
const marker = "function buildMarkdownExport";
const start = src.indexOf("interface ExportToolCall") >= 0 ? src.indexOf("interface ExportToolCall") : src.indexOf(marker);
check("buildMarkdownExport found at file tail", start >= 0 && src.indexOf(marker) >= start);
const slice = `${src.slice(start)}\nexport { buildMarkdownExport };\n`;
const { code } = esbuild.transformSync(slice, { loader: "ts", format: "esm", target: "node18" });

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
// Null state + empty transcript robustness
// ------------------------------------------------------------------
const minimal = buildMarkdownExport([], true, null);
check("null state does not throw", minimal.includes("unknown model") && minimal.includes("chat export"));

console.log(failed === 0 ? "\nPASS export-md harness" : `\n${failed} export-md checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
