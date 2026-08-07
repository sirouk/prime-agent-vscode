import { _electron as electron } from "playwright";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-probe2-"));
const PATH = `${os.homedir()}/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

const app = await electron.launch({
	executablePath: VSCODE,
	args: [
		os.homedir() + "/prime-agent-vs-ext",
		`--user-data-dir=${profile}`,
		`--extensions-dir=${path.join(os.homedir(), ".vscode/extensions")}`,
		"--disable-workspace-trust", "--skip-welcome", "--no-sandbox",
	],
	env: { ...process.env, PATH },
	timeout: 60_000,
});
const page = await app.firstWindow();
await page.waitForTimeout(9000);

// dump logs mentioning prime
const logRoot = path.join(profile, "logs");
let hits = "";
try {
	hits = execSync(`grep -ri "prime" "${logRoot}" 2>/dev/null | grep -v "primereact" | head -40`).toString();
} catch (e) {
	hits = "grep found nothing: " + e.status;
}
console.log(hits);
await app.close().catch(() => {});
fs.rmSync(profile, { recursive: true, force: true });
