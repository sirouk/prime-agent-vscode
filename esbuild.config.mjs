import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const shared = {
	logLevel: "info",
	sourcemap: !production,
	minify: production,
};

function sourceRevision() {
	try {
		const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return revision || "nogit";
	} catch {
		return "nogit";
	}
}

// BUILD_REV takes precedence for release builds. SOURCE_DATE_EPOCH makes a
// source build reproducible, while a normal local build still changes its
// webview cache key after a rebuild.
const buildTimestamp = process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000).toString();
const buildRev = process.env.BUILD_REV ?? `${sourceRevision()}-${buildTimestamp}`;

const extensionConfig = {
	...shared,
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/extension.js",
	external: ["vscode"],
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify(buildRev) },
};

const webviewConfig = {
	...shared,
	entryPoints: ["webview/main.ts"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	outfile: "media/main.js",
	define: { PRIME_AGENT_BUILD_REV: JSON.stringify(buildRev) },
};

const controllerConfig = {
	...shared,
	entryPoints: ["src/session-controller.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/controller.cjs",
	external: ["vscode"],
};

// test/attach-lifecycle.test.mjs drives the lease helpers directly; like the
// sidecar bundle below it is gitignored, so a clean checkout must build it.
const sessionActionsConfig = {
	...shared,
	entryPoints: ["src/session-actions.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/session-actions.cjs",
	external: ["vscode"],
};

// test/host-e2e.mjs requires this bundle directly. It is gitignored with the
// rest of dist/, so a clean checkout has to build it or that gate cannot run.
const daemonSidecarConfig = {
	...shared,
	entryPoints: ["src/daemon-sidecar.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/daemon-sidecar.cjs",
	external: ["vscode"],
};

// test/agent-jobs.test.mjs drives the host-side index of extension-reported jobs.
const agentJobsConfig = {
	...shared,
	entryPoints: ["src/agent-jobs.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/agent-jobs.cjs",
	external: ["vscode"],
};

// test/background-jobs.test.mjs drives the Prime Agent extension's job manager.
// Bundled rather than run from source because the extension is TypeScript that
// ships to `~/.prime/agent/extensions/`, where Prime Agent compiles it itself.
const backgroundJobsConfig = {
	...shared,
	entryPoints: ["agent-extension/background-jobs/jobs.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/background-jobs.cjs",
};

// test/background-task-tracker.test.mjs drives the skill-receipt adapter.
const backgroundTaskTrackerConfig = {
	...shared,
	entryPoints: ["src/background-task-tracker.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/background-task-tracker.cjs",
	external: ["vscode"],
};

// test/processes.test.mjs drives the background-process tracker directly, the
// same way the sidecar and session-action bundles are built for their gates.
const processTrackerConfig = {
	...shared,
	entryPoints: ["src/process-tracker.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/process-tracker.cjs",
	external: ["vscode"],
};

const smokeConfig = {
	...shared,
	entryPoints: ["test/smoke.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node18",
	outfile: "test/smoke.mjs",
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
};

if (watch) {
	const ext = await esbuild.context(extensionConfig);
	const web = await esbuild.context(webviewConfig);
	await Promise.all([ext.watch(), web.watch()]);
} else {
	await esbuild.build(extensionConfig);
	await esbuild.build(webviewConfig);
	await esbuild.build(smokeConfig);
	await esbuild.build(controllerConfig);
	await esbuild.build(daemonSidecarConfig);
	await esbuild.build(sessionActionsConfig);
	await esbuild.build(processTrackerConfig);
	await esbuild.build(backgroundTaskTrackerConfig);
	await esbuild.build(backgroundJobsConfig);
	await esbuild.build(agentJobsConfig);
}
