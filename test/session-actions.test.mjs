/** Offline session mutations must be bounded, preserve JSONL framing, and reject links. */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-session-actions-"));
const bundle = path.join(workdir, "session-actions.cjs");
esbuild.buildSync({ entryPoints: ["src/session-actions.ts"], outfile: bundle, bundle: true, format: "cjs", platform: "node", target: "node20" });
const { archiveSessionFile, renameSessionOffline } = await import(bundle);

const id = "tail-session";
const file = path.join(workdir, `${id}.jsonl`);
// Intentionally no final newline: appending must create a second valid record,
// rather than joining `}{` into an unreadable line.
fs.writeFileSync(file, JSON.stringify({ type: "message", id: "leaf", message: { role: "user", content: "hello" } }), "utf8");
const rename = await renameSessionOffline(file, id, "");
const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
check("offline blank rename succeeds", rename.ok, JSON.stringify(rename));
check("newline-less transcript stays parseable after append", lines.length === 2 && lines.every(Boolean), JSON.stringify(lines));
check("blank rename persists an explicit clear and parent", lines[1]?.name === "" && lines[1]?.parentId === "leaf", JSON.stringify(lines[1]));

// The parent lookup reads only a bounded tail. A multi-megabyte earlier history
// must not prevent archive from finding the final leaf and writing one record.
const largeId = "large-session";
const largeFile = path.join(workdir, `${largeId}.jsonl`);
fs.writeFileSync(largeFile, `${JSON.stringify({ type: "message", id: "old", text: "x".repeat(3 * 1024 * 1024) })}\n${JSON.stringify({ type: "message", id: "last" })}\n`);
const archive = await archiveSessionFile(largeFile, largeId);
const archivedTail = fs.readFileSync(largeFile, "utf8").trimEnd().split("\n").at(-1);
check("large transcript archive succeeds", archive.ok, JSON.stringify(archive));
check("archive chains from the final bounded-tail record", JSON.parse(archivedTail).parentId === "last", archivedTail);

const brokenId = "broken-session";
const brokenFile = path.join(workdir, `${brokenId}.jsonl`);
const brokenBefore = `${JSON.stringify({ type: "message", id: "good" })}\n{"type":"message"`;
fs.writeFileSync(brokenFile, brokenBefore);
const broken = await archiveSessionFile(brokenFile, brokenId);
check("truncated final JSONL record is rejected", !broken.ok && /incomplete/.test(broken.error ?? ""), JSON.stringify(broken));
check("truncated transcript is never further corrupted", fs.readFileSync(brokenFile, "utf8") === brokenBefore);

if (process.platform !== "win32") {
	const linkId = "link-session";
	const link = path.join(workdir, `${linkId}.jsonl`);
	fs.symlinkSync(file, link);
	const linked = await archiveSessionFile(link, linkId);
	check("offline mutation rejects a session symlink", !linked.ok && /regular/.test(linked.error ?? ""), JSON.stringify(linked));
}

fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed === 0 ? "\nPASS session-actions" : `\n${failed} session-actions checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
