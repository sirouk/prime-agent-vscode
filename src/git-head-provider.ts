/**
 * Readonly documents for `git show HEAD:<path>` so the diff view can compare the
 * pre-run file with the agent-modified working tree without the git extension.
 *
 * Self-contained by construction: it holds no session state and talks only to
 * git and the editor.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export class GitHeadContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const fsPath = uri.with({ scheme: "file" }).fsPath;
		const cwd = path.dirname(fsPath);
		const exec = { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 } as const;
		let relPath: string;
		try {
			// NUL-terminated (-z): by default git C-quotes any path with a non-ASCII
			// byte ("caf\303\251.txt" in literal quotes), which `git show` then cannot
			// resolve, and a name's trailing space would not survive a trim.
			const { stdout: rel } = await execFileAsync("git", ["-C", cwd, "ls-files", "-z", "--full-name", "--", fsPath], exec);
			// One path per record; take the first rather than concatenating them.
			relPath = rel.split("\0")[0] ?? "";
		} catch {
			// No git, or not a repository: there genuinely is no HEAD side, and an
			// empty left pane ("everything is new") is the honest rendering.
			return "";
		}
		if (!relPath) return "";
		try {
			const { stdout: rootOut } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], exec);
			const { stdout } = await execFileAsync("git", ["-C", rootOut.trim(), "show", `HEAD:${relPath}`], exec);
			return stdout;
		} catch (err) {
			// The file IS tracked, so "" here would be a lie that reads as "the whole
			// file was just added" (buffer cap, timeout, unborn HEAD, ...). Say why.
			const detail = err instanceof Error ? err.message : String(err);
			return `Prime Agent could not read the HEAD revision of ${relPath}:\n${detail}\n`;
		}
	}
}