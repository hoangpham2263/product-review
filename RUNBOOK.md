# RUNBOOK: agent mode (Claude Code + Google Flow)

The prompt is `docs/agent-prompt.md`. One run at a time, one browser = one agent. CLI: `powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 <command> -Run <run> [-Item <id>] [-File <path>]`; every command prints one JSON line `{ok,...}`; `ok:false` carries `error` (read it, do not guess).

1. `prepare`: snapshots the queue (URLs, product photos, review photos) into the run; lists the items.
2. Per item: look at the product photo(s) yourself; `context-brief` shows what to write; write the JSON; `context -File <json>`. No web access for the product (AGENTS.md section 1-2).
3. Images in Google Flow (Playwright MCP, my signed-in Chrome):
   1. `flow-brief` for every item: gives `aspect`, `uploads` (review photo first, product photo second) and `condensed_prompt`.
   2. `browser_tabs`: connected? One tab. Open https://flow.google.com, new project, Images (Hình ảnh), aspect from `aspect`, x1.
   3. BATCH: per item upload the 2 `uploads` in that order as references, paste `condensed_prompt` in the BOTTOM prompt box (not the project name), submit. Submit all items, do not wait between them.
   4. Wait ONCE for all results, then download each original 1K image.
   5. `register-image -Item <id> -File <png>` per image. An item that already has an image is never run again.
4. Per item: `review-brief` (prints `prompt_file`, rating, name, image) → read `prompt_file`, write the review to a .txt file → `write-review -File <txt>` (1st failure returns `{ok:false,problems,final:false}`: fix once; 2nd failure = `REVIEW_QUALITY`, exit 1) → `finish` (uploads to the results store, adds stars/name/date; `RESULT_CONFIG` or `RESULT_UPLOAD` = item NOT done; success = status `awaiting_user_review`). The agent never touches review.json.
5. `run-summary` (prints `{ok,run,items:[{id,url,status,image,cause?}],awaiting_user_review,errors,unfinished}`), then STOP and report in Vietnamese: image paths, items waiting for approval, errors. The person approves in the app (Duyệt & xuất file).

Browser rules: `await page.bringToFront();` first in every browser_run_code_unsafe; one tab; no waitForFunction; a call over 30 s is stuck.
Errors: `[CAUSE:LOGIN|QUOTA|REFUSED|BROWSER] text` per item; no endless retry.
Never: Giữ/Bỏ, Loox export, sending anything, watermark removal via Flow, rerunning an item that has an image, signing in for the person.
