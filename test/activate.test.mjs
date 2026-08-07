/**
 * Activation harness: loads the bundled extension with a stub `vscode` module
 * and runs activate() to catch import-time and registration-time errors.
 */

import { createRequire } from "node:module";

const require = createRequire(process.cwd() + "/");

const disposables = [];
const registeredCommands = [];
const registeredViews = [];
const registeredSchemes = [];

const vscodeStub = {
	window: {
		createOutputChannel: () => ({ append: () => {}, appendLine: () => {}, dispose: () => {} }),
		registerWebviewViewProvider: (id) => {
			registeredViews.push(id);
			return { dispose: () => {} };
		},
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		showOpenDialog: async () => undefined,
		showSaveDialog: async () => undefined,
		showTextDocument: async () => ({}),
		createWebviewPanel: () => {
			throw new Error("not implemented in stub");
		},
		activeTextEditor: undefined,
	},
	workspace: {
		getConfiguration: () => ({ get: (_key, fallback) => fallback }),
		workspaceFolders: [{ uri: { fsPath: process.cwd(), scheme: "file" }, name: "stub", index: 0 }],
		createFileSystemWatcher: () => ({
			onDidCreate: () => ({ dispose: () => {} }),
			onDidChange: () => ({ dispose: () => {} }),
			onDidDelete: () => ({ dispose: () => {} }),
			dispose: () => {},
		}),
		registerTextDocumentContentProvider: (scheme) => {
			registeredSchemes.push(scheme);
			return { dispose: () => {} };
		},
		findFiles: async () => [],
		asRelativePath: (uri) => (typeof uri === "string" ? uri : uri.fsPath),
		fs: { readFile: async () => new Uint8Array() },
	},
	commands: {
		registerCommand: (name) => {
			registeredCommands.push(name);
			return { dispose: () => {} };
		},
		executeCommand: async () => undefined,
	},
	env: { openExternal: async () => true },
	Uri: {
		file: (fsPath) => ({ fsPath, scheme: "file" }),
		joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/"), scheme: "file" }),
		parse: (value) => ({ fsPath: value, scheme: "https" }),
	},
	ViewColumn: { Active: 1 },
	ProgressLocation: { Notification: 15 },
	TextEditorRevealType: { InCenter: 1 },
	Disposable: class Disposable {
		constructor(fn) {
			this.fn = fn;
		}
		dispose() {
			this.fn?.();
		}
	},
	Position: class Position {
		constructor(line, character) {
			this.line = line;
			this.character = character;
		}
	},
	Range: class Range {
		constructor(start, end) {
			this.start = start;
			this.end = end;
		}
	},
	Selection: class Selection {
		constructor(start, end) {
			this.start = start;
			this.end = end;
		}
	},
};

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === "vscode") return vscodeStub;
	return originalLoad.apply(this, [request, ...rest]);
};

const extension = require("./dist/extension.js");

const expectedCommands = [
	"primeAgent.focusChat",
	"primeAgent.openChat",
	"primeAgent.newSession",
	"primeAgent.abort",
	"primeAgent.compact",
	"primeAgent.exportHtml",
	"primeAgent.restart",
	"primeAgent.history",
	"primeAgent.addSelectionToChat",
	"primeAgent.addActiveFileToChat",
];

const _mem = new Map();
const _state = { get: (k, d) => (_mem.has(k) ? _mem.get(k) : d), update: (k, v) => { if (v === undefined) _mem.delete(k); else _mem.set(k, v); return Promise.resolve(); } };
const context = {
	subscriptions: disposables,
	extensionUri: { fsPath: process.cwd(), scheme: "file" },
	globalState: _state,
	workspaceState: _state,
};

extension.activate(context);
console.log("activate() OK");
const missing = expectedCommands.filter((c) => !registeredCommands.includes(c));
if (missing.length > 0) {
	console.error("MISSING COMMANDS:", missing);
	process.exit(1);
}
if (!registeredViews.includes("primeAgent.chat")) {
	console.error("MISSING VIEW primeAgent.chat");
	process.exit(1);
}
if (!registeredSchemes.includes("prime-agent-git-head")) {
	console.error("MISSING content provider scheme");
	process.exit(1);
}
console.log(`commands registered: ${registeredCommands.length}/${expectedCommands.length}`);
extension.deactivate();
console.log("deactivate() OK");
console.log("PASS activation harness");
