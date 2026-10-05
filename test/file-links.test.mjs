/**
 * Where a clicked file link lands. The agent's targets are claims — a sandbox
 * path that does not exist here, a relative path, a name that lives in several
 * folders — and the resolver has to turn each into one real file or say it cannot.
 */
import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "prime-agent-file-links-"));
const bundle = join(dir, "file-links.cjs");
await esbuild.build({ entryPoints: [join(process.cwd(), "src/file-links.ts")], bundle: true, format: "cjs", platform: "node", target: "node18", outfile: bundle, logLevel: "silent" });
const { resolveLinkedFile } = require(bundle);

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const WS = "/work/lab";
function deps(files, extra = {}) {
	const picks = [];
	return {
		picks,
		workspaceRoot: WS,
		homedir: "/home/me",
		realpath: async (file) => {
			if (!files.includes(file)) throw new Error("ENOENT");
			return file;
		},
		findByBasename: async (basename) => files.filter((f) => f.startsWith(`${WS}/`) && f.endsWith(`/${basename}`)),
		pick: async (candidates) => {
			picks.push(candidates);
			return extra.choose ? extra.choose(candidates) : undefined;
		},
	};
}

try {
	let r = await resolveLinkedFile("/root/out/report.md", deps(["/root/out/report.md"]));
	check("an absolute path that exists opens as written", r.kind === "found" && r.file === "/root/out/report.md", JSON.stringify(r));

	r = await resolveLinkedFile("docs/setup.md", deps([`${WS}/docs/setup.md`]));
	check("a relative path resolves against the workspace", r.kind === "found" && r.file === `${WS}/docs/setup.md`, JSON.stringify(r));

	r = await resolveLinkedFile("~/notes/x.md", deps(["/home/me/notes/x.md"]));
	check("~ expands to the home directory", r.kind === "found" && r.file === "/home/me/notes/x.md", JSON.stringify(r));

	// The case from the screenshot: the agent's sandbox is not this machine.
	r = await resolveLinkedFile("/mnt/data/ETH_Lab_Best_SF07.pine", deps([`${WS}/out/ETH_Lab_Best_SF07.pine`]));
	check("a sandbox path missing here falls back to the one workspace file of that name", r.kind === "found" && r.file === `${WS}/out/ETH_Lab_Best_SF07.pine`, JSON.stringify(r));

	let d = deps([`${WS}/a/guide.md`, `${WS}/b/guide.md`]);
	r = await resolveLinkedFile("/mnt/data/guide.md", d);
	check("several same-named files ask the operator instead of guessing", r.kind === "cancelled" && d.picks.length === 1 && d.picks[0].length === 2, JSON.stringify({ r, picks: d.picks }));

	d = deps([`${WS}/a/guide.md`, `${WS}/b/guide.md`], { choose: (c) => c[1] });
	r = await resolveLinkedFile("/mnt/data/guide.md", d);
	check("the operator's pick is what opens", r.kind === "found" && r.file === `${WS}/b/guide.md`, JSON.stringify(r));

	d = deps([`${WS}/a/guide.md`, `${WS}/b/guide.md`]);
	r = await resolveLinkedFile("/mnt/b/guide.md", d);
	check("agreeing on more trailing folders narrows to one without asking", r.kind === "found" && r.file === `${WS}/b/guide.md` && d.picks.length === 0, JSON.stringify({ r, picks: d.picks }));

	r = await resolveLinkedFile("/mnt/data/nope.pine", deps([`${WS}/x.md`]));
	check("nothing anywhere is reported as missing, with what was tried", r.kind === "missing" && r.tried === "/mnt/data/nope.pine", JSON.stringify(r));

	r = await resolveLinkedFile("..", deps([]));
	check("a bare .. never reaches the search", r.kind === "missing", JSON.stringify(r));

	const noWorkspace = { ...deps(["/abs/x.md"]), workspaceRoot: undefined };
	r = await resolveLinkedFile("rel/x.md", noWorkspace);
	check("a relative path with no workspace is missing, not resolved against the process cwd", r.kind === "missing", JSON.stringify(r));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nPASS file-links" : `\nFAIL file-links (${failed})`);
process.exit(failed === 0 ? 0 : 1);
