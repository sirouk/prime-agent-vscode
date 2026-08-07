/**
 * Minimal `vscode` module stub for headless host tests.
 * Installing this module hijacks require("vscode") until replace() is called.
 */
const Module = require("node:module");
const originalLoad = Module._load;

const quickPickBehavior = { pick: undefined };

const vscodeStub = {
	window: {
		createOutputChannel: () => ({ append: () => {}, appendLine: () => {}, dispose: () => {} }),
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async (items) => (Array.isArray(items) ? items[0] : undefined),
		showInputBox: async () => undefined,
		showOpenDialog: async () => undefined,
		showSaveDialog: async () => undefined,
		showTextDocument: async () => ({}),
		activeTextEditor: undefined,
	},
	workspace: {
		getConfiguration: () => ({ get: (_key, fallback) => fallback }),
		workspaceFolders: [{ uri: { fsPath: process.env.HOST_E2E_CWD ?? process.cwd(), scheme: "file" }, name: "e2e", index: 0 }],
		createFileSystemWatcher: () => ({
			onDidCreate: () => ({ dispose: () => {} }),
			onDidChange: () => ({ dispose: () => {} }),
			onDidDelete: () => ({ dispose: () => {} }),
			dispose: () => {},
		}),
		findFiles: async () => [],
		asRelativePath: (uri) => (typeof uri === "string" ? uri : uri.fsPath),
		fs: { readFile: async () => new Uint8Array() },
		openTextDocument: async () => ({}),
	},
	commands: { executeCommand: async () => undefined },
	env: { openExternal: async () => true },
	Uri: {
		file: (fsPath) => ({ fsPath, scheme: "file" }),
		joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].filter(Boolean).join("/"), scheme: "file" }),
		parse: (value) => ({ fsPath: value, scheme: "https" }),
	},
	Disposable: class {
		constructor(fn) { this.fn = fn; }
		dispose() { this.fn?.(); }
	},
	Position: class {
		constructor(line, character) { this.line = line; this.character = character; }
	},
	Range: class {
		constructor(start, end) { this.start = start; this.end = end; }
	},
	Selection: class {
		constructor(start, end) { this.start = start; this.end = end; }
	},
	TextEditorRevealType: { InCenter: 1 },
	ViewColumn: { Active: 1 },
	ProgressLocation: { Notification: 15 },
};

Module._load = function (request, ...rest) {
	if (request === "vscode") return vscodeStub;
	return originalLoad.apply(this, [request, ...rest]);
};

module.exports = { vscodeStub };
