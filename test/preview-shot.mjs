import { chromium } from "playwright";

// Renders headless screenshots of media/preview.html per ?mode= and, for the
// newer modes, runs DOM assertions against the live preview state.
// Usage: node test/preview-shot.mjs [mode]   (no arg = all modes)

const mk = (name, pass, detail = "") => ({ name, pass: !!pass, detail });

// ----------------------------------------------------------------
// Verifiers: return [{ name, pass, detail }]
// ----------------------------------------------------------------

async function verifyAttachmenu(page) {
	const rail = ".composer-rail";
	const dd = `${rail} .dropdown`;
	const out = [];

	const railBtns = await page.$$eval(`${rail} > .icon-btn`, (els) => els.map((e) => e.title));
	out.push(mk("composer rail shows a single + attach button", railBtns.length === 1 && railBtns[0].startsWith("Attach"), JSON.stringify(railBtns)));

	out.push(mk("attach dropdown opened", !!(await page.$(dd))));
	const items = await page.$$eval(`${dd} .dropdown-item`, (els) =>
		els.map((e) => ({
			label: e.querySelector(".dropdown-text")?.textContent ?? "",
			sub: e.querySelector(".dropdown-sub")?.textContent ?? "",
			disabled: e.classList.contains("disabled"),
		})),
	);
	out.push(
		mk(
			"items in spec order: Mention a file in chat / Active editor file / Editor selection / Image…",
			JSON.stringify(items.map((i) => i.label)) === JSON.stringify(["Mention a file in chat", "Active editor file", "Editor selection", "Image…"]),
			JSON.stringify(items),
		),
	);
	const img = items[3] ?? {};
	out.push(mk("Image… item is DISABLED (text-only model)", img.disabled === true, `disabled=${img.disabled} sub="${img.sub}"`));

	const before = await page.evaluate(() => postedMessages.length);
	await page.click(`${dd} .dropdown-item.disabled`);
	await page.waitForTimeout(120);
	const after = await page.evaluate(() => postedMessages.length);
	const stillOpen = !!(await page.$(dd));
	out.push(mk("clicking disabled Image… posts nothing and keeps menu open", before === after && stillOpen, `postedMessages ${before} -> ${after}, dropdown open=${stillOpen}`));

	await page.click(`${dd} .dropdown-item:not(.disabled)`);
	await page.waitForTimeout(120);
	const posts = await page.evaluate(() => postedMessages.map((m) => m.type));
	out.push(mk("'Mention a file in chat' click inserts @ into composer", (await page.$eval(".composer-card textarea", (e) => e.value)) === "@", `posts=${JSON.stringify(posts)}`));
	return out;
}

async function verifyModelmenu2(page) {
	const dd = ".rail-pill.model .dropdown";
	const out = [];
	out.push(mk("model dropdown opened via .rail-pill.model click", !!(await page.$(dd))));

	const search = await page.$(`${dd} input.dropdown-search`);
	out.push(mk("search box present with placeholder", (await search?.getAttribute("placeholder")) === "Search models…", `placeholder=${await search?.getAttribute("placeholder")}`));

	// Walk the list, tracking the section header above each item.
	const rows = await page.$$eval(`${dd} .dropdown-list > *`, (els) => {
		let section = null;
		return els.map((e) => {
			if (e.classList.contains("dropdown-section")) {
				section = e.textContent;
				return { kind: "section", name: section };
			}
			return {
				kind: "item",
				section,
				label: e.querySelector(".dropdown-text")?.textContent ?? "",
				sub: e.querySelector(".dropdown-sub")?.textContent ?? null,
				right: e.querySelector(".dropdown-right")?.textContent ?? null,
				current: e.classList.contains("current"),
				star: e.querySelector(".dropdown-star")?.classList.contains("active") ?? false,
			};
		});
	});
	const sections = rows.filter((r) => r.kind === "section").map((r) => r.name);
	out.push(
		mk(
			"sections in order: Favorites, All models (thinking moved to brain popout)",
			JSON.stringify(sections) === JSON.stringify(["Favorites", "All models"]),
			JSON.stringify(sections),
		),
	);

	const items = rows.filter((r) => r.kind === "item");
	const favs = items.filter((r) => r.section === "Favorites");
	out.push(
		mk(
			"Favorites section: 2 starred items, current model first",
			favs.length === 2 && favs.every((f) => f.star) && favs[0].label === "chutes/moonshotai/Kimi-K3-TEE" && favs[0].current,
			JSON.stringify(favs),
		),
	);
	const all = items.filter((r) => r.section === "All models");
	out.push(mk("All models section: 3 remaining models", all.length === 3, JSON.stringify(all.map((a) => a.label))));

	// Model rows carry NO brain accessory anymore — the brain lives on the rail as its own pill.
	const brains = await page.evaluate(() => document.querySelectorAll(".dropdown-item .dropdown-brain").length);
	out.push(mk("no per-row brain accessory (brain is a rail pill)", brains === 0, `${brains} brains in rows`));
	// Open the rail brain pill -> the levels the CURRENT model declares, nothing else.
	await page.evaluate(() => {
		document.querySelector(".rail-pill.brain")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	});
	const menuInfo = await page.evaluate(() => {
		const dd = document.querySelector(".dropdown");
		const header = dd?.querySelector(".dropdown-header")?.textContent ?? "";
		const levels = [...(dd?.querySelectorAll(".dropdown-item") ?? [])].map((r) => ({
			label: (r.querySelector(".dropdown-text")?.textContent ?? r.textContent ?? "").trim(),
			current: r.classList.contains("current"),
		}));
		return { header, levels };
	});
	out.push(mk("brain rail pill opens the thinking menu", menuInfo.header.startsWith("Thinking —"), menuInfo.header));
	const levelNames = menuInfo.levels.map((l) => l.label.split(" ")[0].split("\n")[0]);
	// Kimi K3 TEE really supports "max" and nothing else. Offering the old six
	// meant every other row was a level clampThinkingLevel would silently swap.
	out.push(mk("only the levels the model declares are offered", JSON.stringify(levelNames) === JSON.stringify(["max"]), JSON.stringify(levelNames)));
	out.push(
		mk(
			"current thinking level marked (max, not aliased to xhigh)",
			menuInfo.levels.filter((l) => l.current).length === 1 && menuInfo.levels.some((l) => l.current && l.label.startsWith("max")),
			JSON.stringify(menuInfo.levels.filter((l) => l.current)),
		),
	);
	await page.evaluate(() => {
		const dd = document.querySelector(".dropdown");
		const row = [...(dd?.querySelectorAll(".dropdown-item") ?? [])].find((r) => (r.querySelector(".dropdown-text")?.textContent ?? r.textContent ?? "").trim().startsWith("max"));
		row?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
	});
	const thinkPosts = await page.evaluate(() => postedMessages.filter((m) => m.type === "setThinkingLevel").map((m) => m.level));
	out.push(mk("selecting a level posts setThinkingLevel", thinkPosts.includes("max"), JSON.stringify(thinkPosts)));

	const withImg = rows
		.filter((r) => r.kind === "item" && (r.right ?? "").includes("img"))
		.map((r) => r.label);
	const expectImg = ["anthropic/claude-sonnet-4-5", "chutes/moonshotai/Kimi-K3-TEE", "openai/gpt-5.2-codex"];
	const textOnlyImgless = !withImg.some((l) => l.includes("GLM") || l.includes("DeepSeek"));
	out.push(mk("vision-capable models show 'img' badge, text-only models do not", JSON.stringify(withImg.sort()) === JSON.stringify(expectImg.sort()) && textOnlyImgless, `img badges on ${JSON.stringify(withImg)}`));
	return out;
}

// Click the hidden delete (x) of a history item: reveal via hover, then click.
async function armDelete(page, item) {
	await item.hover();
	await page.waitForTimeout(50);
	const armed = await item.evaluate((e) => e.classList.contains("confirming"));
	if (armed) return; // already armed — re-arming is a no-op
	const del = await item.evaluateHandle((e) =>
		[...e.querySelectorAll(".history-action")].find((b) => (b.title ?? "").startsWith("Delete")) ?? null,
	);
	const delEl = del.asElement();
	if (!delEl) {
		throw new Error("armDelete: no delete action found on this history item");
	}
	await delEl.click();
	await page.waitForTimeout(80);
}

async function verifyHistory2(page) {
	const out = [];
	const summary = await page.$$eval(".history-item", (els) =>
		els.map((e) => ({
			name: e.querySelector(".history-item-name")?.textContent ?? "",
			current: e.classList.contains("current"),
			confirming: e.classList.contains("confirming"),
			actionTitles: [...e.querySelectorAll(".history-actions .history-action")].map((b) => b.title),
		})),
	);
	out.push(mk("renders 4 history items", summary.length === 4, JSON.stringify(summary.map((s) => s.name))));

	const currents = summary.filter((s) => s.current);
	out.push(mk("exactly one current item (status sessionId match)", currents.length === 1, JSON.stringify(currents)));
	out.push(mk("current item: .history-actions present but NO delete button", currents.length === 1 && currents[0].actionTitles.length === 0, `actions=${JSON.stringify(currents[0]?.actionTitles)}`));

	const nonCur = summary.filter((s) => !s.current);
	// A confirming item legitimately swaps x for the inline confirm/cancel pair.
	const hasDeleteOrConfirm = (s) =>
		(!s.confirming && s.actionTitles.some((t) => t.startsWith("Delete"))) ||
		(s.confirming && s.actionTitles.length === 2 && s.actionTitles[0] === "Confirm delete" && s.actionTitles[1] === "Cancel");
	out.push(
		mk(
			"every non-current item has .history-actions with delete (x) button (or armed confirm pair)",
			nonCur.length === 3 && nonCur.every(hasDeleteOrConfirm),
			JSON.stringify(nonCur.map((s) => s.actionTitles)),
		),
	);
	const hiddenDisplay = await page.$eval(".history-item:not(.current):not(.confirming) .history-actions", (e) => getComputedStyle(e).display);
	out.push(mk("actions hidden without hover (CSS-only hover reveal)", hiddenDisplay === "none", `display=${hiddenDisplay}`));

	// Arm a fresh item (first non-current = "vscode-session") and inspect the confirm state.
	const items = await page.$$(".history-item:not(.current)");
	const target = items[0];
	const targetName = await target.$eval(".history-item-name", (e) => e.textContent);
	await armDelete(page, target);
	let state = await target.evaluate((e) => ({
		confirming: e.classList.contains("confirming"),
		buttons: [...e.querySelectorAll(".history-actions .history-action")].map((b) => ({ text: b.textContent.trim(), destructive: b.classList.contains("destructive"), title: b.title })),
	}));
	out.push(
		mk(
			"clicking x reveals inline confirm: destructive 'Delete' + cancel",
			state.confirming && state.buttons.length === 2 && state.buttons[0].destructive && state.buttons[0].text === "Delete" && !state.buttons[1].destructive,
			JSON.stringify(state),
		),
	);
	out.push(mk("arming alone posts no deleteSession", !(await page.evaluate(() => postedMessages.some((m) => m.type === "deleteSession")))));

	// Cancel restores the original item.
	const cancelBtn = await target.$(".history-actions .history-action:not(.destructive)");
	await cancelBtn.click();
	await page.waitForTimeout(80);
	let restored = await page.$$eval(".history-item:not(.current)", (els) =>
		els.map((e) => ({ name: e.querySelector(".history-item-name")?.textContent ?? "", confirming: e.classList.contains("confirming"), actions: e.querySelectorAll(".history-actions .history-action").length })),
	);
	const first = restored.find((r) => r.name === targetName);
	out.push(
		mk(
			"cancel restores original item (not confirming, pencil+x actions back, name intact)",
			!!first && !first.confirming && first.actions >= 2,
			JSON.stringify(first),
		),
	);
	out.push(mk("cancel posts nothing", !(await page.evaluate(() => postedMessages.some((m) => m.type === "deleteSession")))));

	// Re-arm, let the 6000ms disarm lapse: item must auto-restore.
	let items2 = await page.$$(".history-item:not(.current)");
	let subject = items2.find(async () => true) ?? items2[0];
	// pick by name to be deterministic
	for (const h of items2) {
		const n = await h.$eval(".history-item-name", (e) => e.textContent);
		if (n === targetName) { subject = h; break; }
	}
	await armDelete(page, subject);
	const armedNow = await page.$$eval(".history-item", (els) => els.filter((e) => e.classList.contains("confirming")).length);
	await page.waitForTimeout(6500);
	const stillArmed = await page.$$eval(".history-item", (els) => els.filter((e) => e.classList.contains("confirming")).length);
	out.push(mk("6000ms disarm auto-restores an untouched confirm", armedNow >= 1 && stillArmed === 0, `confirming ${armedNow} -> ${stillArmed} after 6.5s`));
	out.push(mk("auto-disarm posted nothing", !(await page.evaluate(() => postedMessages.some((m) => m.type === "deleteSession")))));

	// Confirm path posts deleteSession with the session path.
	// Re-sample and resolve the row by its NAME in-page — earlier $$ handles
	// are stale after the cancel rebuild cycle.
	const victimIndex = await page.evaluate(
		(name) =>
			[...document.querySelectorAll(".history-item:not(.current)")].findIndex(
				(r) => (r.querySelector(".history-item-name")?.textContent ?? "") === name,
			),
		targetName,
	);
	const items3 = await page.$$(".history-item:not(.current)");
	const victim = items3[victimIndex >= 0 ? victimIndex : 0];
	await armDelete(page, victim);
	const confirmBtn = await victim.$(".history-actions .history-action.destructive");
	await confirmBtn.click();
	await page.waitForTimeout(80);
	const delPosts = await page.evaluate(() => postedMessages.filter((m) => m.type === "deleteSession"));
	out.push(mk("confirming 'Delete' posts deleteSession for the session", delPosts.length === 1 && delPosts[0].path === "/a/2.jsonl", JSON.stringify(delPosts)));
	return out;
}

async function verifyMarkdownnote(page) {
	const out = [];
	const chip = await page.$(".row-user .bubble-user .mention-chip");
	out.push(mk("@src/foo/bar.ts rendered as a .mention-chip", !!chip));
	if (chip) {
		out.push(mk("chip is a <button> with label @src/foo/bar.ts", (await chip.evaluate((e) => e.tagName)) === "BUTTON" && (await chip.textContent()) === "@src/foo/bar.ts", `tag=${await chip.evaluate((e) => e.tagName)} text=${await chip.textContent()}`));
		out.push(mk("chip title is 'Open src/foo/bar.ts'", (await chip.getAttribute("title")) === "Open src/foo/bar.ts", `title="${await chip.getAttribute("title")}"`));
		const bubbleText = await page.$eval(".row-user .bubble-user .bubble-text", (e) => e.textContent);
		out.push(mk("surrounding message text preserved around chip", bubbleText.includes("Please review") && bubbleText.includes("and tighten the retry backoff in it."), JSON.stringify(bubbleText)));
		await chip.click();
		await page.waitForTimeout(80);
		const openPosts = await page.evaluate(() => postedMessages.filter((m) => m.type === "openFile"));
		out.push(mk("chip click posts openFile for src/foo/bar.ts", openPosts.length === 1 && openPosts[0].path === "src/foo/bar.ts", JSON.stringify(openPosts)));
	}
	const assistant = await page.$eval(".row-assistant .bubble-text, .row-assistant", (e) => e.textContent).catch(() => "");
	out.push(mk("assistant reply rendered below", assistant.includes("exponential") || assistant.includes("backoff"), assistant.slice(0, 60)));
	return out;
}

async function verifyRetry(page) {
	const out = [];
	const row = await page.$(".retry-row");
	out.push(mk("retry row rendered in transcript", !!row && (await row.isVisible())));
	if (!row) return out;
	const text = await row.$eval(".retry-text", (e) => e.textContent);
	out.push(mk("retry text: attempt 2/5 with error 'timeout'", text === "Provider request failed — auto-retry 2/5 · timeout", JSON.stringify(text)));
	out.push(mk("warning icon ⚠ present", (await row.$eval(".retry-icon", (e) => e.textContent)) === "⚠"));
	const warnColor = await row.$eval(".retry-icon", (e) => getComputedStyle(e).color);
	out.push(mk("warning styling: icon uses --pa-warn color", warnColor === "rgb(243, 188, 86)", `color=${warnColor}`));
	// color-mix(60% transparent, 40% --pa-warn) may serialize as rgb() or color(srgb ...).
	const border = await row.evaluate((e) => getComputedStyle(e).borderTopColor);
	const warnTinted =
		border.includes("243, 188, 86") ||
		(() => {
			const m = border.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
			return !!m && [243, 188, 86].every((v, i) => Math.abs(parseFloat(m[i + 1]) * 255 - v) < 1.5);
		})();
	out.push(mk("warning styling: row border is warn-tinted", warnTinted, `border=${border}`));
	out.push(mk("not fatal styling", !(await row.evaluate((e) => e.classList.contains("fatal")))));
	const inMessages = await row.evaluate((e) => !!e.closest(".messages") && e.parentElement.lastElementChild === e);
	out.push(mk("row sits at the bottom of the .messages scroller", inMessages));
	const live = await page.$eval(".live-label", (e) => e.textContent).catch(() => "");
	out.push(mk("status strip shows retrying…", live === "retrying…", `live-label=${JSON.stringify(live)}`));
	return out;
}

/**
 * The composer draws its text twice: a transparent textarea that owns the caret
 * over a mirror div that owns the styling. Any property on `.mm` that changes
 * the advance width of the mention's characters — font-family, font-size,
 * padding — drifts the caret away from the word being typed, and the drift
 * compounds per mention. Real Chromium metrics, so this is measurable.
 */
async function verifyCaretParity(page) {
	const out = [];
	const metrics = await page.evaluate(() => {
		const mirror = document.querySelector(".composer-mirror");
		if (!mirror) return null;
		const probe = document.createElement("div");
		probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
		const sample = "@src/session-controller.ts";
		const plain = document.createElement("span");
		plain.textContent = sample;
		const styled = document.createElement("span");
		styled.className = "mm";
		styled.textContent = sample;
		probe.append(plain, styled);
		mirror.appendChild(probe);
		const plainBox = plain.getBoundingClientRect();
		const styledBox = styled.getBoundingClientRect();
		probe.remove();
		return { plain: plainBox.width, styled: styledBox.width, plainH: plainBox.height, styledH: styledBox.height };
	});
	out.push(mk("composer mirror found", !!metrics));
	if (!metrics) return out;
	out.push(
		mk(
			"mention span keeps the plain-text advance width (caret parity)",
			Math.abs(metrics.styled - metrics.plain) < 0.5,
			JSON.stringify(metrics),
		),
	);
	out.push(
		mk(
			"mention span keeps the plain-text line box height",
			Math.abs(metrics.styledH - metrics.plainH) < 0.5,
			JSON.stringify(metrics),
		),
	);
	return out;
}

// ----------------------------------------------------------------
// Mode registry
// ----------------------------------------------------------------

const MODES = {
	chat: { file: "preview-chat.png", height: 760, verify: verifyCaretParity },
	welcome: { file: "preview-welcome.png", height: 560 },
	modelmenu: { file: "preview-modelmenu.png", height: 560 },
	history: { file: "preview-history.png", height: 560 },
	attachmenu: { file: "preview-attachmenu.png", height: 480, verify: verifyAttachmenu },
	modelmenu2: { file: "preview-modelmenu2.png", height: 660, verify: verifyModelmenu2 },
	history2: { file: "preview-history2.png", height: 560, verify: verifyHistory2 },
	markdownnote: { file: "preview-markdownnote.png", height: 420, verify: verifyMarkdownnote },
	retry: { file: "preview-retry.png", height: 480, verify: verifyRetry },
};

const scenario = process.argv[2];
if (scenario && !MODES[scenario]) {
	console.error(`unknown mode "${scenario}". Known: ${Object.keys(MODES).join(", ")}`);
	process.exit(1);
}
const entries = scenario ? [[scenario, MODES[scenario]]] : Object.entries(MODES);

const browser = await chromium.launch();
let failures = 0;
for (const [mode, cfg] of entries) {
	const page = await browser.newPage({ viewport: { width: 420, height: cfg.height } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`file://${process.cwd()}/media/preview.html?mode=${mode}`);
	await page.waitForTimeout(700);
	await page.screenshot({ path: `test/${cfg.file}` });
	if (errors.length) {
		failures += errors.length;
		console.log(`[${mode}] PAGE ERRORS: ${errors.join("; ")}`);
	} else {
		console.log(`[${mode}] ok -> test/${cfg.file}`);
	}
	if (cfg.verify) {
		for (const r of await cfg.verify(page)) {
			if (!r.pass) failures++;
			console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
		}
	}
	await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
