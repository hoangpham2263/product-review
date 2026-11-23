# Scan prompt (Claude Code scans a shop website for its menu, products and main images)

The only source of the scan prompt: the app ("Quét web" button: Bắt đầu quét; "Dự án" popup: Quét cập nhật) and `buildPrompt({ mode: "scan" })` in `core/setup/agent-run.mjs` read the `text` block below. Placeholders: `{{TOOL}}` = this tool's folder, `{{RUN}}` = the run id, `{{SITE}}` = the shop home page, `{{MAX}}` = most products per category, `{{OPTIONS}}` = this run's options (or "defaults"). Same fixed template as `docs/agent-prompt.md`: TASK, OPTIONS, TOOL, STEPS (numbered, 1:1 with the "Quét web" section of RUNBOOK.md), STOP IF, NEVER. Claude drives the page itself (the site's layout changes, so no fixed crawling script); only the files are written by `src/scan.ps1`.

```text
TASK: Product Review — scan a shop website: its menu, the products of each category and their main image — agent: Claude Code
RUN: {{RUN}}
SITE: {{SITE}}
MAX: {{MAX}} products per category
OPTIONS: {{OPTIONS}}
TOOL: {{TOOL}}
STEPS (follow RUNBOOK.md "Quét web", in order, do not skip; every command prints one JSON line {ok,...}; CLI = powershell -NoProfile -ExecutionPolicy Bypass -File src/scan.ps1 <command> -Project <id> ...):
1. Setup: cd {{TOOL}}; read AGENTS.md (sections 0 and 5, "Quét web") + RUNBOOK.md "Quét web"; CLI start -Site {{SITE}} -Max {{MAX}} -Run {{RUN}} (finds the shop's PROJECT or creates it and prints the project id; every later command takes -Project <id>); then CLI known (the links the project already has: skip them, so MAX counts NEW products only; a known project is only updated, nothing is deleted).
2. Browser FIRST: browser_tabs (the Playwright MCP runs the tool's OWN Chrome profile, no sign-in needed here); ONE tab; open {{SITE}}; dismiss a cookie banner with one click; a login wall, captcha or block page = STOP IF.
3. Menu: read the main menu (browser_snapshot, or browser_evaluate to list the links) and note the product categories with their links, submenus included; leave out About, Blog, Contact, policies, cart, account, gift cards and duplicates ("All", "Sale" repeating other categories).
4. Per category, one at a time: open it, scroll or page until {{MAX}} products or the end. For each product take: its page link, its title, its category name, and the URL of its MAIN image (the first product photo, the largest size the page gives; never a logo, banner, icon or placeholder). Write them to a JSON file with the Write tool, an array of {url, title, collection, collection_url, image_url}; CLI add-many -File <json>. Read the answer per product: added; duplicate and collection_full need nothing; failed with NEEDS_PNG = open the product page, take a screenshot of the main image element to a .png file (browser_take_screenshot, element, filename) and CLI add -Url <u> -Title <t> -Collection <c> -ImageFile <png>; retry any other failure ONCE.
5. Finish: CLI finish (rows, per category, missing_images, merge: added / already_known / not_seen_this_scan; new rows have used=F, known rows keep theirs), then STOP. Tell me in Vietnamese: the project and its products.csv path, how many NEW products per category, how many were already known, the products that failed and why.
Browser rules: start every browser_run_code_unsafe with `await page.bringToFront();`; ONE tab; never use waitForFunction (use waitForLoadState('domcontentloaded') with a short timeout, or waitForTimeout); any single browser call over 30 s counts as stuck: stop using it, go on.
STOP IF: no Playwright MCP or its own Chrome does not open; a login wall, captcha, age gate you cannot dismiss with one click, or a block page (403, "checking your browser"); no menu or no product link found on {{SITE}}. Then still run step 5 if the scan was started and tell me the reason; do NOT retry endlessly (at most 1 retry of a stuck step).
NEVER: sign in, buy, add to cart, fill or submit a form, post or change anything on a site; leave {{SITE}}'s domain; write products.csv or download images yourself (only src/scan.ps1 does), delete or change a product already in the project; write a crawling script that runs the pages for you; go past {{MAX}} per category; run two agents on one browser.
```
