import { _electron as electron } from "playwright";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pa-probe-msg-"));
const PATH = `${os.homedir()}/.hermes/node/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const app = await electron.launch({
	executablePath: VSCODE,
	args: [
		os.homedir() + "/prime-agent-vs-ext",
		`--user-data-dir=${profile}`,
		`--extensions-dir=${path.join(os.homedir(), ".vscode/extensions")}`,
		`--extensionDevelopmentPath=${path.resolve("test/probe-ext")}`,
		"--disable-workspace-trust", "--skip-welcome", "--no-sandbox",
	],
	env: { ...process.env, PATH },
	timeout: 60_000,
});
const page = await app.firstWindow();
const lines = [];
page.on("console", (m) => {
	if (m.text().includes("[probe]")) lines.push(`${m.type()}: ${m.text().slice(0, 90)}`);
});
await page.waitForTimeout(9000);
await page.keyboard.press("Meta+Shift+P");
await page.waitForTimeout(700);
await page.keyboard.type("View: Show PA Probe");
await page.waitForTimeout(700);
await page.keyboard.press("Enter");
await page.waitForTimeout(6000);
console.log(JSON.stringify(lines.slice(0, 24), null, 1));
await app.close().catch(() => {});
fs.rmSync(profile, { recursive: true, force: true });
