/**
 * Where a file link in the agent's prose points on THIS machine.
 *
 * The agent writes targets like `sandbox:/mnt/data/report.md`, `/root/lab/x.pine`
 * or `docs/setup.md`. A click should land in the editor, but the target is only
 * ever a claim: the agent's sandbox is not this filesystem, a relative path is
 * relative to a workspace the agent may not share, and the same name can live
 * in several folders. This resolves the claim to one real file or says it
 * cannot, and never guesses between candidates silently.
 */

import * as path from "node:path";

export interface LinkedFileDeps {
	/** First workspace folder, the base for relative targets. */
	workspaceRoot?: string;
	homedir: string;
	/** Resolve to a real path, or reject when nothing is there. */
	realpath(file: string): Promise<string>;
	/** Workspace files whose name is `basename` (already excluding vendored trees). */
	findByBasename(basename: string): Promise<string[]>;
	/** Let the operator choose between several candidates; undefined = dismissed. */
	pick(candidates: string[]): Promise<string | undefined>;
}

export type LinkedFileResult =
	| { kind: "found"; file: string }
	| { kind: "missing"; tried: string }
	| { kind: "cancelled" };

const exists = async (deps: LinkedFileDeps, file: string): Promise<string | null> => {
	try {
		return await deps.realpath(file);
	} catch {
		return null;
	}
};

export async function resolveLinkedFile(raw: string, deps: LinkedFileDeps): Promise<LinkedFileResult> {
	let target = raw.trim();
	if (target === "~" || target.startsWith("~/")) target = path.join(deps.homedir, target.slice(1));
	const absolute = path.isAbsolute(target);
	const direct = absolute
		? target
		: deps.workspaceRoot
			? path.resolve(deps.workspaceRoot, target)
			: undefined;
	if (direct) {
		const found = await exists(deps, direct);
		if (found) return { kind: "found", file: found };
	}

	// The named location is not here (an agent's sandbox path, or a folder that
	// was moved): fall back to the file's name inside the workspace, preferring
	// candidates that also agree on as many trailing folders as the link named.
	const basename = path.basename(target);
	if (!basename || basename === "." || basename === "..") return { kind: "missing", tried: target };
	const candidates = [...new Set(await deps.findByBasename(basename))];
	if (candidates.length === 0) return { kind: "missing", tried: target };
	const wanted = target.split(/[\\/]+/).filter(Boolean);
	const agreement = (candidate: string): number => {
		const have = candidate.split(/[\\/]+/).filter(Boolean);
		let shared = 0;
		while (shared < wanted.length && shared < have.length && wanted[wanted.length - 1 - shared] === have[have.length - 1 - shared]) {
			shared += 1;
		}
		return shared;
	};
	const best = Math.max(...candidates.map(agreement));
	const closest = candidates.filter((candidate) => agreement(candidate) === best);
	if (closest.length === 1) return { kind: "found", file: closest[0] };
	const chosen = await deps.pick(closest);
	return chosen ? { kind: "found", file: chosen } : { kind: "cancelled" };
}
