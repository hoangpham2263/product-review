# Context worker prompt (image run with Luồng above 1)

Used for the `ctx` worker runs of an image run split in phases (`src/mac/server.mjs` image job, `core/setup/agent-run.mjs` mode `ctx`). Each worker does steps 1-2 of `docs/agent-prompt.md` (context, sign wording, custom-logo flags) for its slice of the items, no browser. Placeholders: `{{RUN}}` = the image run id, `{{OPTIONS}}` = `items file: <path>; ...`, `{{TOOL}}`. The text of step 2 is copied from `docs/agent-prompt.md`: keep them in sync.

```text
TASK: Product Review — write the context of each product of an image run (no browser, no images) — agent: Claude Code
RUN: {{RUN}}
OPTIONS: {{OPTIONS}}
TOOL: {{TOOL}}
ITEMS: OPTIONS names an items file ("items file: <path>"): a JSON array of item ids. Read it first and work ONLY on those items, in that order. Other workers handle the other items of the run at the same time.
STEPS (follow RUNBOOK.md, in order, do not skip; every command prints one JSON line {ok,...}; CLI = powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 <command> -Run {{RUN}} [-Item <id>]):
1. Setup: cd {{TOOL}}; read AGENTS.md (sections 0, 1, 5, 8) + RUNBOOK.md; read the items file. Do NOT run prepare (the run already exists).
2. Context, per item (one at a time): look at the product photo(s) of the item; CLI context-brief -Item <id>; write the JSON it asks for (also `custom_logo` true + `logo_placeholder` when the product has a buyer-logo area with replaceable sample branding (STEP 3C, e.g. the chest mark of a custom polo): Flow replaces that sample logo with ONE small fictional symbol; `lettered` true + `sample_text` = EVERY line of words on the sign, fixed design words included (they are replaced too), " | " between lines, when the product photo shows sample customer lettering such as "Your Name" / "YOUR LOGO"); CLI context -Item <id> -File <json>. SIGN WORDING (lettered items only; YOU choose it, not Flow): CLI sign-brief -Item <id>; LOOK at its review_photo (the scene) and product_photo; choose the exact new wording by its `instruction` (fits the place/occasion of the scene, short correctly spelled English, same number of lines as the sample, max 3 words per line, no real brand/famous name, never the placeholder, different from the other items of this run); CLI set-sign-text -Item <id> -Text "<line 1 | line 2>" -Reason "<scene> -> <wording>" (ok:false = read the error, choose again).
3. Report: reply in Vietnamese with how many items got their context, and any item you could not do and why; then STOP.
STATUS LINES (the person reads them in the app while the run goes): one short Vietnamese sentence, item first, then the result, e.g. "Mục 035: xong ngữ cảnh", "Mục 013: bỏ qua, lỗi". No English, no internal jargon (no CLI names, no CAUSE codes) in these lines.
NEVER: write or run a script, loop or batch file for several items: do each item yourself, one at a time, with the CLI commands above. Run CLI commands one at a time (never two at once).
NEVER: run prepare, flow-brief, register-image, write a review or run finish; open a browser or any page; start background tasks or timers; press Giữ/Bỏ for me, export Loox, send anything anywhere.
```
