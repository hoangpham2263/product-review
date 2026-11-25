# Review worker prompt (image run with Luồng above 1)

Used for the `rev` worker runs of an image run split in phases (mode `rev`). Each worker does step 4 of `docs/agent-prompt.md` (review text per item with its image) for its slice, without `finish` (the app runs finish one item at a time afterwards). The quality gate of write-review (reused eight-word phrases against the reference reviews and the reviews already written) runs inside the CLI under a lock, so parallel workers cannot race. Never drop an item for its review wording. The text of step 4 is copied from `docs/agent-prompt.md`: keep them in sync.

```text
TASK: Product Review — write the review of each item of an image run that already has its image (no browser) — agent: Claude Code
RUN: {{RUN}}
OPTIONS: {{OPTIONS}}
TOOL: {{TOOL}}
ITEMS: OPTIONS names an items file ("items file: <path>"): a JSON array of item ids. Read it first and work ONLY on those items, in that order. Other workers handle the other items of the run at the same time.
STEPS (follow RUNBOOK.md, in order, do not skip; every command prints one JSON line {ok,...}; CLI = powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 <command> -Run {{RUN}} [-Item <id>]):
1. Setup: cd {{TOOL}}; read AGENTS.md (sections 0, 1, 5, 8) + RUNBOOK.md; read the items file. Do NOT run prepare (the run already exists).
4. Reviews, per item: CLI review-brief -Item <id> (prints prompt_file, rating, name, image); read prompt_file and write the review as a .txt file; CLI write-review -Item <id> -File <txt> (ok:false + problems: fix exactly what it names (it quotes a reused phrase) and run write-review again, up to 3 repairs; the 4th draft is kept as it is, so an item is never dropped for its review wording);
3. Report: reply in Vietnamese with how many reviews you wrote, and any item you could not do and why; then STOP.
STATUS LINES (the person reads them in the app while the run goes): one short Vietnamese sentence, item first, then the result, e.g. "Mục 035: xong ngữ cảnh", "Mục 013: bỏ qua, lỗi". No English, no internal jargon (no CLI names, no CAUSE codes) in these lines.
NEVER: write or run a script, loop or batch file for several items: do each item yourself, one at a time, with the CLI commands above. Run CLI commands one at a time (never two at once).
NEVER: run prepare or finish, create or change an image; open a browser or any page; start background tasks or timers; press Giữ/Bỏ for me, export Loox, send anything anywhere.
```
