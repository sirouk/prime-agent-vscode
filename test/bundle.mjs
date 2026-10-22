/**
 * Bundle a TypeScript source module from `src/` for a headless test.
 *
 * Built from source on every call, never read from `dist/`: a stale bundle must
 * not be able to hide a regression in the module under test.
 */

import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const require = createRequire(import.meta.url);

export function bundle(entry) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-bundle-"));
	const outfile = path.join(dir, `${path.basename(entry, ".ts")}.cjs`);
	esbuild.buildSync({
		entryPoints: [entry],
		bundle: true,
		format: "cjs",
		platform: "node",
		target: "node20",
		outfile,
		external: ["vscode"],
		logLevel: "silent",
	});
	const mod = require(outfile);
	return { mod, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
