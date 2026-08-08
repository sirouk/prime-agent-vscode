/**
 * recent-sessions harness. Drives the REAL listRecentSessions over a fixture
 * sessions dir (the module takes a `sessionsDir` override for exactly this) so
 * the assertions can fail: an inline re-implementation of the tail reader always
 * agreed with itself.
 *
 * Covers the three things the on-disk fallback has to get right:
 *   - the workspace bucket is never starved by other folders,
 *   - a late rename wins over the first-prompt title,
 *   - drafts and archived sessions stay out, exactly as the CLI's roster does.
 */
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failed = 0;
let total = 0;
function check(name, condition, detail = "") {
	total += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-recent-"));
const bundled = esbuild.buildSync({
	entryPoints: ["src/recent-sessions.ts"],
	outfile: path.join(workdir, "recent-sessions.cjs"),
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node20",
	external: ["vscode"],
});
check("recent-sessions bundles", bundled.errors.length === 0);
const { listRecentSessions } = await import(path.join(workdir, "recent-sessions.cjs"));
check("listRecentSessions is exported", typeof listRecentSessions === "function");

const sessionsDir = path.join(workdir, "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pa-ws-")));
const OTHER = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pa-other-")));

let clock = Date.parse("2026-01-01T00:00:00.000Z");
function write(id, lines) {
	const file = path.join(sessionsDir, `${id}.jsonl`);
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
	clock += 60_000; // each file is "newer" than the last, so mtime order is deterministic
	fs.utimesSync(file, new Date(clock), new Date(clock));
	return file;
}
function header(cwd) {
	return { type: "session", id: "h", cwd, timestamp: new Date(clock).toISOString() };
}
function message(i, text) {
	return { type: "message", id: `m${i}`, timestamp: new Date(clock).toISOString(), message: { role: "user", content: text } };
}

// 30 chatty sessions in OTHER, all newer than the workspace ones below. Under a
// single global cap these alone would fill the list.
for (let i = 0; i < 30; i += 1) {
	write(`other-${String(i).padStart(2, "0")}`, [header(OTHER), message(0, `other work ${i}`)]);
}

// A workspace session renamed far past both the head cap and the tail window.
const bulk = [header(WS), message(0, "Study this ~/prime-agent system and how it operates")];
for (let i = 1; i < 400; i += 1) bulk.push(message(i, "x".repeat(600)));
bulk.push({ type: "session_info", id: "n1", parentId: "m399", timestamp: new Date(clock).toISOString(), name: "Prime Agent VS Code Extension" });
const renamedFile = write("ws-renamed", bulk);
check("fixture buries the rename past the 60-line head cap", fs.readFileSync(renamedFile, "utf8").split("\n").length > 400);

// A workspace draft (no message at all) and a workspace session archived at the end.
write("ws-draft", [
	header(WS),
	{ type: "model_change", id: "a", parentId: "h", timestamp: new Date(clock).toISOString(), model: "x" },
	{ type: "session_state", id: "b", parentId: "a", timestamp: new Date(clock).toISOString(), state: { status: "active" } },
]);
write("ws-archived", [
	header(WS),
	message(0, "finished experiment"),
	{ type: "session_state", id: "s", parentId: "m0", timestamp: new Date(clock).toISOString(), state: { status: "archived" } },
]);
write("ws-live", [header(WS), message(0, "still working here")]);

const rows = await listRecentSessions(WS, { sessionsDir, workspaceLimit: 60, otherLimit: 25 });
const ws = rows.filter((r) => r.inWorkspace);
const others = rows.filter((r) => !r.inWorkspace);

check("workspace bucket is not starved by newer other-folder sessions", ws.length === 2, `ws=${ws.map((r) => r.id).join(",")}`);
check("other folders still listed, under their own quota", others.length === 25, `n=${others.length}`);
check("workspace rows come first", rows.slice(0, ws.length).every((r) => r.inWorkspace));

const renamed = rows.find((r) => r.id === "ws-renamed");
check("late rename wins over the first-prompt title", renamed?.name === "Prime Agent VS Code Extension", `name=${String(renamed?.name)}`);

check("zero-message draft is hidden", !rows.some((r) => r.id === "ws-draft"));
check("archived session is hidden", !rows.some((r) => r.id === "ws-archived"));
check("live workspace session is shown", rows.some((r) => r.id === "ws-live"));

// Buckets are recent-descending within themselves (#58).
const wsTimes = ws.map((r) => r.modifiedMs);
check("workspace bucket sorted recent-descending", wsTimes.every((t, i) => i === 0 || wsTimes[i - 1] >= t), wsTimes.join(">"));
const otherTimes = others.map((r) => r.modifiedMs);
check("other bucket sorted recent-descending", otherTimes.every((t, i) => i === 0 || otherTimes[i - 1] >= t));

fs.rmSync(workdir, { recursive: true, force: true });
fs.rmSync(WS, { recursive: true, force: true });
fs.rmSync(OTHER, { recursive: true, force: true });
console.log(failed === 0 ? `\nPASS recent-sessions-tail (${total} checks)` : `\n${failed}/${total} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
