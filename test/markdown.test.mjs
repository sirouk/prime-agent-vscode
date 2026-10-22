/**
 * The webview's markdown renderer, driven directly (happy-dom for the DOM).
 * Agent output is full of identifiers, paths and indented code under list items;
 * each case here is something it used to mangle.
 */
import { Window } from "happy-dom";
import { bundle } from "./bundle.mjs";

const window = new Window({ url: "https://webview.local/" });
Object.assign(globalThis, {
	window,
	document: window.document,
	HTMLElement: window.HTMLElement,
	HTMLOListElement: window.HTMLOListElement,
	Node: window.Node,
});

let failed = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!condition) failed += 1;
}

const { mod, dispose } = bundle("webview/markdown.ts");
const { renderMarkdown, parseFileLink } = mod;
const links = { external: () => {}, file: () => {} };
function render(markdown) {
	const root = window.document.createElement("div");
	renderMarkdown(markdown, root, links);
	return root;
}
const html = (markdown) => render(markdown).innerHTML;

// ---- inline: identifiers are not emphasis -------------------------------------------------
check("underscores inside a path stay literal", html("see tests/test_foo_bar.py now") === "<p style=\"white-space: pre-wrap;\">see tests/test_foo_bar.py now</p>", html("see tests/test_foo_bar.py now"));
check("an UPPER_SNAKE constant stays literal", !html("set MAX_RETRY_COUNT to 3").includes("<em>"));
check("a glob stays literal", !html("matches src/**/*.ts files").includes("<em>") && !html("matches src/**/*.ts files").includes("<strong>"), html("matches src/**/*.ts files"));
check("multiplication stays literal", !html("2*3*4 is 24").includes("<em>"));
check("real _emphasis_ still works", html("this is _really_ it").includes("<em>really</em>"));
check("real *emphasis* still works", html("this is *really* it").includes("<em>really</em>"));
check("real **bold** still works", html("this is **very** it").includes("<strong>very</strong>"));
check("emphasis around a link still works", html("**[Download](https://example.com/x)**").includes("<strong><a"), html("**[Download](https://example.com/x)**"));
check("code spans win over emphasis", html("use `a_b_c` here").includes("<code>a_b_c</code>"));
check("emphasis never opens on whitespace", !html("a * b * c").includes("<em>"));

// ---- fences ---------------------------------------------------------------------------------
{
	const root = render("1. Install:\n   ```bash\n   npm i\n   npm test\n   ```\n2. Run it");
	const code = root.querySelector("pre code");
	check("a fence indented under a list item is a code block", !!code, root.innerHTML.slice(0, 200));
	check("its body loses the fence's indent", code?.textContent === "npm i\nnpm test", JSON.stringify(code?.textContent));
	const lists = [...root.querySelectorAll("ol")];
	check("the list resumes after it, still counting", lists.length === 2 && lists[1].getAttribute("start") === "2" && lists[1].textContent.trim() === "Run it", lists.map((l) => l.getAttribute("start")).join(","));
	check("no stray backticks are left in the text", !root.textContent.includes("```"));
}

// ---- lists ------------------------------------------------------------------------------------
{
	const root = render("1. A\n\n2. B\n\n3. C");
	check("blank lines between items do not split the list", root.querySelectorAll("ol").length === 1 && root.querySelectorAll("li").length === 3, root.innerHTML);
	const resumed = render("3. third\n4. fourth");
	check("an ordered list that begins at 3 says so", resumed.querySelector("ol")?.getAttribute("start") === "3");
	check("one that begins at 1 sets nothing", render("1. a\n2. b").querySelector("ol")?.getAttribute("start") === null);
	check("two blank lines still end a list", render("- a\n\n\n- b").querySelectorAll("ul").length === 2);
}

// ---- file links ----------------------------------------------------------------------------------
check("path:line", JSON.stringify(parseFileLink("src/a.ts:12")) === JSON.stringify({ path: "src/a.ts", startLine: 12 }));
check("path:line:col keeps the path whole", JSON.stringify(parseFileLink("src/a.ts:12:5")) === JSON.stringify({ path: "src/a.ts", startLine: 12 }), JSON.stringify(parseFileLink("src/a.ts:12:5")));
check("path:start-end", JSON.stringify(parseFileLink("src/a.ts:10-20")) === JSON.stringify({ path: "src/a.ts", startLine: 10, endLine: 20 }));
check("#L10-L20", JSON.stringify(parseFileLink("src/a.ts#L10-L20")) === JSON.stringify({ path: "src/a.ts", startLine: 10, endLine: 20 }));
check("a heading anchor is not part of the path", parseFileLink("docs/setup.md#install")?.path === "docs/setup.md", JSON.stringify(parseFileLink("docs/setup.md#install")));
check("sandbox: and file: schemes reduce to a path", parseFileLink("sandbox:/mnt/data/x.py")?.path === "/mnt/data/x.py" && parseFileLink("file:///root/x.py")?.path === "/root/x.py");
check("a Windows drive path is a path", parseFileLink("C:\\work\\x.py")?.path === "C:\\work\\x.py");
check("protocol-relative and UNC targets are not workspace files", parseFileLink("//evil.example/x") === null && parseFileLink("\\\\host\\share\\x.txt") === null);
check("other schemes stay inert", parseFileLink("javascript:alert(1)") === null && parseFileLink("https://example.com/x") === null);

dispose();
console.log(failed === 0 ? "\nPASS markdown" : `\n${failed} markdown checks FAILED`);
process.exit(failed === 0 ? 0 : 1);
