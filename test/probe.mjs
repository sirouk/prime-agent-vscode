import { _electron as electron } from "playwright";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-probe-"));
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
await page.screenshot({ path: "test/e2e-shots/probe-window.png" });

// what's in the activity bar?
const labels = await page.locator(`#workbench\.parts\.activitybar [aria-label], .activitybar [aria-label]`).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))).catch((e) => ["ERR " + e]);
console.log("activitybar aria-labels:", JSON.stringify(labels));

// list ALL frames + urls
for (const frame of page.frames()) {
	console.log("frame:", frame.url().slice(0, 110));
}
await app.close().catch(() => {});
fs.rmSync(profile, { recursive: true, force: true });
