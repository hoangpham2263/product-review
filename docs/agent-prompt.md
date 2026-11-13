# Agent prompt (Claude Code drives Google Flow and writes the reviews)

The only source of the prompt: the app ("Claude (Google Flow)" in Tạo ảnh: Bắt đầu runs it, Copy prompt copies it) and `GET /api/agent/prompt` read the `text` block below. Placeholders: `{{TOOL}}` = this tool's folder, `{{RUN}}` = the run id, `{{OPTIONS}}` = this run's options (or "defaults"). Fixed template: TASK, OPTIONS, TOOL, STEPS (numbered, 1:1 with RUNBOOK.md), STOP IF, NEVER. Details live in RUNBOOK.md; change a step there and keep its line here in sync.

```text
TASK: Product Review — create images in Google Flow and write the reviews — agent: Claude Code
RUN: {{RUN}}
OPTIONS: {{OPTIONS}}
TOOL: {{TOOL}}
STEPS (follow RUNBOOK.md, in order, do not skip; every command prints one JSON line {ok,...}; CLI = powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 <command> -Run {{RUN}} [-Item <id>]):
1. Setup: cd {{TOOL}}; read AGENTS.md (sections 0, 1, 5, 8) + RUNBOOK.md; CLI prepare (snapshots the queue into this run and lists the items).
2. Context, per item (one at a time): look at the product photo(s) of the item; CLI context-brief -Item <id>; write the JSON it asks for; CLI context -Item <id> -File <json>.
3. Images: CLI flow-brief -Item <id> for every item. Check the browser FIRST (browser_tabs: Playwright MCP connected to my signed-in Chrome; fail = STOP IF). ONE tab on https://flow.google.com, new project, choose Images (Hình ảnh), aspect = the item's aspect, x1. BATCH: for each item upload its 2 `uploads` files as references in that order (review photo first, product photo second), paste `condensed_prompt` into the BOTTOM prompt box (not the project-name field), submit; submit ALL items without waiting; then wait ONCE; then download each image as the original 1K size; CLI register-image -Item <id> -File <png> for each one.
4. Reviews, per item: CLI review-brief -Item <id> (prints prompt_file, rating, name, image); read prompt_file and write the review as a .txt file; CLI write-review -Item <id> -File <txt> (ok:false + problems on the 1st try: fix ONCE and rewrite; a 2nd failure is CAUSE:REVIEW_QUALITY, go on); CLI finish -Item <id> (uploads the result; CAUSE:RESULT_CONFIG or CAUSE:RESULT_UPLOAD = item NOT done, report it).
5. Report: CLI run-summary (items, awaiting_user_review, errors, unfinished); then STOP. Tell me in Vietnamese: image paths, how many items wait for my approval (Chờ duyệt), errors per item.
Browser rules: start every browser_run_code_unsafe with `await page.bringToFront();`; ONE tab; never use waitForFunction (use waitForLoadState('domcontentloaded') with a short timeout, or waitForTimeout); any single browser call over 30 s counts as stuck: stop using it, go on.
STOP IF: no Playwright MCP or Chrome not connected; login wall or captcha; Flow quota reached; Flow refuses a prompt. Then write the error of each affected item as `[CAUSE:<code>] <text>` (CAUSE:LOGIN, CAUSE:QUOTA, CAUSE:REFUSED, CAUSE:BROWSER), do NOT retry endlessly (at most 1 retry of a stuck step), still run step 5.
NEVER: press Giữ/Bỏ for me, export Loox, send anything anywhere, ask Flow to remove a watermark (Flow refuses), run an image again when the item already has one, sign in for me, run two agents on one browser.
```
