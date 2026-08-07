import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const shared = {
	logLevel: "info",
	sourcemap: !production,
	minify: production,
};

const extensionConfig = {
	...shared,
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: "dist/extension.js",
	external: ["vscode"],
};

const webviewConfig = {
	...shared,
	entryPoints: ["webview/main.ts"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	outfile: "media/main.js",
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
}
