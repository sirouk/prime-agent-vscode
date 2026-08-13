/**
 * Small file logger used for diagnosing host-side behavior from e2e runs when
 * PRIME_AGENT_VSCODE_LOG points at a file. No-op otherwise.
 */
import * as fs from "node:fs";

export class DebugFileLog {
	private stream: fs.WriteStream | null = null;

	constructor() {
		const target = process.env.PRIME_AGENT_VSCODE_LOG;
		if (target && target.trim().length > 0 && !this.stream) {
			try {
				const stream = fs.createWriteStream(target, { flags: "a" });
				stream.on("error", () => {
					if (this.stream === stream) this.stream = null;
				});
				this.stream = stream;
			} catch {
				this.stream = null;
			}
		}
	}

	append(text: string): void {
		try {
			this.stream?.write(text.endsWith("\n") ? text : `${text}\n`);
		} catch {
			// ignore
		}
	}

	dispose(): void {
		const stream = this.stream;
		this.stream = null;
		try {
			stream?.end();
		} catch {
			// Logging must never keep extension shutdown alive.
		}
	}
}
