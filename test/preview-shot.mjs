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

/**
 * Scroll behaviour under a live stream. Runs in real Chromium because this is
 * pure layout: happy-dom reports every scroll metric as 0, so a DOM-only version
 * of these checks could never fail.
 */
async function verifyScrollFollow(page, out = []) {
	const metrics = () => page.$eval(".messages", (e) => ({
		top: e.scrollTop,
		max: e.scrollHeight - e.clientHeight,
		overflowing: e.scrollHeight > e.clientHeight + 20,
	}));
	const frame = async (n) => {
		await page.evaluate((i) => window.__streamFrame(i), n);
		await page.waitForTimeout(60);
	};

	out.push(mk("transcript actually overflows (otherwise nothing here is meaningful)", (await metrics()).overflowing));

	// 1. Parked at the bottom: the stream must follow.
	await page.$eval(".messages", (e) => { e.scrollTop = e.scrollHeight; });
	await page.waitForTimeout(60);
	for (let i = 1; i <= 3; i++) await frame(i);
	let m = await metrics();
	out.push(mk("follows the stream while parked at the bottom", m.max - m.top <= 12, `gap=${m.max - m.top}`));

	// 2. A wheel flick upward releases the lock — the gesture the old code lost.
	await page.hover(".messages");
	await page.mouse.wheel(0, -260);
	await page.waitForTimeout(60);
	const afterFlick = await metrics();
	out.push(mk("wheeling up scrolls away from the bottom", afterFlick.max - afterFlick.top > 12, `gap=${afterFlick.max - afterFlick.top}`));

	// 3. Frames keep arriving. The reader must not be dragged back down.
	for (let i = 4; i <= 9; i++) await frame(i);
	const afterStream = await metrics();
	out.push(mk(
		"streaming does NOT yank the reader back to the bottom",
		afterStream.max - afterStream.top > 12 && Math.abs(afterStream.top - afterFlick.top) <= 4,
		`top ${afterFlick.top} -> ${afterStream.top}, gap=${afterStream.max - afterStream.top}`,
	));
	// The behaviour every other agentic chat has: you hold your spot, and the new
	// output piles up below you unseen until you choose to go get it.
	out.push(mk(
		"new output accumulates BELOW the held position instead of moving it",
		afterStream.max > afterFlick.max && afterStream.top === afterFlick.top,
		`scrollable ${afterFlick.max} -> ${afterStream.max}, position held at ${afterStream.top}`,
	));
	out.push(mk("jump-to-bottom pill is offered while detached", await page.$eval(".jump-to-latest", (e) => e.classList.contains("visible")).catch(() => false)));

	// 3b. A SMALL nudge has to count too. The old lock only released past a 48px
	//     deadzone, so a short scroll left the view "stuck" and the next frame
	//     dragged it straight back — the version of this that felt unescapable.
	await page.$eval(".messages", (e) => { e.scrollTop = e.scrollHeight; });
	await page.waitForTimeout(60);
	await page.hover(".messages");
	await page.mouse.wheel(0, -40);
	await page.waitForTimeout(60);
	const afterNudge = await metrics();
	for (let i = 13; i <= 15; i++) await frame(i);
	const afterNudgeStream = await metrics();
	out.push(mk(
		"a small scroll up is respected, not swallowed by a deadzone",
		afterNudgeStream.max - afterNudgeStream.top > 12 && Math.abs(afterNudgeStream.top - afterNudge.top) <= 4,
		`top ${afterNudge.top} -> ${afterNudgeStream.top}, gap=${afterNudgeStream.max - afterNudgeStream.top}`,
	));

	// 4. An expanded thinking block must survive the frames that follow.
	const details = await page.$("details.thinking");
	if (details) {
		await details.evaluate((e) => { e.open = true; });
		await frame(10);
		out.push(mk("expanded thinking stays open across streaming frames", await details.evaluate((e) => e.open)));

		// And the other direction: a block the reader CLOSED must stay closed.
		// Rebuilding forced `open` back on every frame, so collapsing it mid-reply
		// sprang straight back open — the "closes the elements you were just in".
		// The reported bug: reading inside an expanded thinking block while the reply
		// streams threw the inner scrollbar back to the top on every frame, because
		// the body's textContent is rewritten each time.
		await details.evaluate((e) => { e.open = true; });
		await frame(20);
		const think = await page.$("details.thinking .thinking-body");
		const thinkScrolls = think ? await think.evaluate((e) => e.scrollHeight > e.clientHeight + 20) : false;
		out.push(mk("thinking body actually overflows (guards the next check)", thinkScrolls));
		if (think && thinkScrolls) {
			// Park mid-pane, not at the bottom: a reader sitting at the tail is
			// SUPPOSED to keep following it, so only a middle position tests holding.
			await think.evaluate((e) => { e.scrollTop = Math.floor((e.scrollHeight - e.clientHeight) / 2); });
			const before = await think.evaluate((e) => e.scrollTop);
			await frame(21);
			await frame(22);
			const after = await think.evaluate((e) => e.scrollTop);
			out.push(mk("thinking block keeps its place while the reply streams", before > 4 && Math.abs(after - before) <= 4, `${before} -> ${after}`));

			// And a reader parked at the tail should still be carried along.
			await think.evaluate((e) => { e.scrollTop = e.scrollHeight; });
			await frame(23);
			const tail = await think.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight);
			out.push(mk("thinking block still follows the tail when parked at the bottom", tail <= 6, `gap=${tail}`));
		}

		await details.evaluate((e) => { e.open = false; });
		await frame(11);
		out.push(mk("collapsed thinking stays collapsed across streaming frames", !(await details.evaluate((e) => e.open))));
	}

	// 5. An expanded tool card's own scroller (.tool-body — the <pre> never
	//    overflows) must keep its place while the reply keeps streaming. This is
	//    the check that catches a rebuild detaching and re-attaching the card.
	const toolHeader = await page.$(".tool .tool-header");
	if (toolHeader) {
		await toolHeader.click();
		await page.waitForTimeout(60);
		// The <pre> is the element that caps and scrolls, not .tool-body — verified
		// in the browser rather than assumed from the stylesheet.
		const body = await page.$(".tool.open .tool-result pre");
		const scrollable = body ? await body.evaluate((e) => e.scrollHeight > e.clientHeight + 20) : false;
		out.push(mk("tool output pane actually overflows (guards the next check)", scrollable));
		if (body && scrollable) {
			await body.evaluate((e) => { e.scrollTop = 120; });
			const before = await body.evaluate((e) => e.scrollTop);
			await frame(11);
			const after = await body.evaluate((e) => e.scrollTop);
			out.push(mk("tool output pane keeps its scroll position across frames", before > 0 && Math.abs(after - before) <= 4, `${before} -> ${after}`));
			out.push(mk("expanded tool card stays open across frames", await page.$eval(".tool", (e) => e.classList.contains("open"))));
		}
	}

	// 5c. Poking around mid-reply. Expanding and collapsing cards changes layout,
	//     and the stream keeps arriving throughout — none of it may re-capture the
	//     view. Clicks go through evaluate() because Playwright's own click
	//     scrolls the target into view, which would move the scroller itself.
	await page.hover(".messages");
	await page.mouse.wheel(0, -200);
	await page.waitForTimeout(60);
	const toggle = () => page.evaluate(() => {
		document.querySelector(".tool .tool-header")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await toggle();
	await frame(30);
	await toggle();
	await frame(31);
	const poked = await metrics();
	out.push(mk(
		"poking around mid-stream never re-captures the view",
		poked.max - poked.top > 12,
		`gap=${poked.max - poked.top}`,
	));
	out.push(mk(
		"jump-to-bottom stays available the whole time",
		await page.$eval(".jump-to-latest", (e) => e.classList.contains("visible")).catch(() => false),
	));

	// 6. The pill returns control, and following resumes from there.
	//    Detach again first: clicking the tool header above made Playwright scroll
	//    it into view, which legitimately re-parked the reader at the bottom.
	await page.hover(".messages");
	await page.mouse.wheel(0, -300);
	await page.waitForTimeout(80);
	out.push(mk("pill reappears after detaching again", await page.$eval(".jump-to-latest", (e) => e.classList.contains("visible")).catch(() => false)));
	await page.click(".jump-to-latest");
	await page.waitForTimeout(80);
	m = await metrics();
	out.push(mk("jump-to-bottom returns to the latest", m.max - m.top <= 12, `gap=${m.max - m.top}`));
	await frame(12);
	m = await metrics();
	out.push(mk("following resumes after jumping back", m.max - m.top <= 12, `gap=${m.max - m.top}`));

	// 7. Finishing the turn repaints the row with isPartial=false — the moment a
	//    rebuild slammed every thinking block shut. Runs last on purpose: further
	//    frames after this would re-introduce the same tool id into a fresh turn,
	//    which the real agent never does.
	if (details) {
		await page.evaluate(() => window.__endTurn());
		await page.waitForTimeout(80);
		out.push(mk("thinking stays as the reader left it when the turn finishes", !(await details.evaluate((e) => e.open))));
		out.push(mk("tool card is still open after the turn finishes", await page.$eval(".tool", (e) => e.classList.contains("open"))));
	}
	return out;
}

/**
 * Long-thread windowing: open cheap, walk backwards on demand, and stay bounded
 * on a session that runs for hours. Real Chromium again — this is all layout and
 * DOM cost, which happy-dom cannot report.
 */
async function verifyLongThread(page, out = []) {
	const rows = () => page.$$eval(".messages > *", (els) => els.length);
	const total = await page.evaluate(() => window.__totalMessages);

	const initial = await rows();
	out.push(mk("a 1000-message thread renders only its tail", initial > 0 && initial <= 160, `${initial} rows for ${total} messages`));
	out.push(mk(
		"the untendered remainder is stated, not hidden",
		(await page.$eval(".earlier-bar .earlier-count", (e) => e.textContent).catch(() => "")).includes("earlier"),
		await page.$eval(".earlier-bar .earlier-count", (e) => e.textContent).catch(() => "<none>"),
	));
	out.push(mk("opens at the newest message", await page.$eval(".messages", (e) => e.scrollHeight - e.scrollTop - e.clientHeight <= 12)));

	// Walk backwards: the rows already on screen must not move under the reader.
	await page.$eval(".messages", (e) => { e.scrollTop = 0; });
	await page.waitForTimeout(60);
	const anchorText = await page.$eval(".messages > .row:not(.earlier-bar)", (e) => e.textContent.slice(0, 40)).catch(() => "");
	// Offset of that row within the viewport BEFORE the load — the bar sits above
	// it, so the correct outcome is "unchanged", not "zero".
	const offsetOf = (t) => page.evaluate((text) => {
		const el = [...document.querySelectorAll(".messages > .row")].find((r) => r.textContent.slice(0, 40) === text);
		if (!el) return null;
		return Math.round(el.getBoundingClientRect().top - document.querySelector(".messages").getBoundingClientRect().top);
	}, t);
	const offsetBefore = await offsetOf(anchorText);
	await page.click(".earlier-load");
	await page.waitForTimeout(120);
	const after = await rows();
	out.push(mk("load earlier brings in the previous batch", after > initial, `${initial} -> ${after} rows`));
	const offsetAfter = await offsetOf(anchorText);
	out.push(mk("the row you were reading stays put while earlier ones load above it",
		offsetBefore !== null && offsetAfter !== null && Math.abs(offsetAfter - offsetBefore) <= 8,
		`offset ${offsetBefore} -> ${offsetAfter}`));

	// A long-running session trims from the top, but only while parked at the tail.
	await page.$eval(".messages", (e) => { e.scrollTop = e.scrollHeight; });
	await page.waitForTimeout(60);
	const beforeGrow = await rows();
	await page.evaluate(async () => { for (let i = 0; i < 400; i++) window.__addTurn(i); });
	await page.waitForTimeout(200);
	const grown = await rows();
	out.push(mk("a long-running session stays bounded instead of growing forever",
		grown <= 700 && grown < beforeGrow + 400, `${beforeGrow} -> ${grown} rows after 400 appended turns`));
	out.push(mk("trimming is disclosed to the operator",
		(await page.$eval(".messages > .earlier-bar", (e) => e.textContent).catch(() => "")).length > 0));

	// Reading above must never be interrupted by trimming.
	await page.$eval(".messages", (e) => { e.scrollTop = 200; });
	await page.waitForTimeout(60);
	const heldTop = await page.$eval(".messages", (e) => e.scrollTop);
	const heldRows = await rows();
	await page.evaluate(() => { for (let i = 0; i < 200; i++) window.__addTurn(1000 + i); });
	await page.waitForTimeout(200);
	out.push(mk("nothing is trimmed while the reader is scrolled up",
		(await rows()) >= heldRows, `${heldRows} -> ${await rows()} rows`));
	out.push(mk("and their position is untouched",
		Math.abs((await page.$eval(".messages", (e) => e.scrollTop)) - heldTop) <= 4,
		`${heldTop} -> ${await page.$eval(".messages", (e) => e.scrollTop)}`));
	return out;
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
	scrollfollow: { file: "preview-scrollfollow.png", height: 520, verify: verifyScrollFollow },
	longthread: { file: "preview-longthread.png", height: 560, verify: verifyLongThread },
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
		// Collect into an array the verifier owns, so a throw part-way through still
		// reports what it had already established. Losing every result to one
		// timeout hides which check actually broke.
		const collected = [];
		let thrown = null;
		try {
			// Verifiers may either fill the shared array (and return it) or build
			// their own; only merge when it is a different array.
			const returned = await cfg.verify(page, collected);
			if (Array.isArray(returned) && returned !== collected) collected.push(...returned);
		} catch (err) {
			thrown = err;
		}
		for (const r of collected) {
			if (!r.pass) failures++;
			console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
		}
		if (thrown) {
			failures++;
			console.log(`  FAIL  [${mode}] verifier threw after ${collected.length} checks — ${String(thrown).split("\n")[0]}`);
		}
	}
	await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
