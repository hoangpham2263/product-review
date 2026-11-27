. (Join-Path $PSScriptRoot 'helpers.ps1')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
function Assert($Value, [string]$Message) { if (-not $Value) { throw $Message } }
# Wrong-item guard (bug 2026-11-26: two items of a Claude (Flow) run registered a neighbour's picture): register-image refuses a picture that another item of the run
# already holds (current image, earlier attempt, Flow original, downloaded file), this item's own earlier picture as a "new" one, and a file collected for another item;
# download-collect keeps to the tile collect clicked; collect picks the tile of the item's own prompt. Fixtures only: a temp workspace (PR_WORKSPACE), never a real run.
$temp = Join-Path $TestWorkspaceRoot ('wrong-item-' + [Guid]::NewGuid().ToString('N'))
$saved = @{}; foreach ($k in 'PR_WORKSPACE', 'PR_AGENT_OUT', 'PR_AGENT_ENGINE', 'PR_FLOW_DOWNLOAD_LOCK', 'PR_DOWNLOADS_DIR') { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
try {
    $run = 'agent-guard-test'
    $dir = Join-Path $temp "output/$run"
    New-Item -ItemType Directory -Force -Path "$dir/images", "$dir/logs", "$dir/refs", "$temp/ws", "$temp/in", "$temp/dl", "$temp/flow-downloads" | Out-Null
    [IO.File]::WriteAllText("$dir/agent-items.json", '[{"id":"006-popcorn-neon-sign"},{"id":"007-heartbeat-neon-sign"}]', [Text.UTF8Encoding]::new($false))
    $env:PR_WORKSPACE = "$temp/ws"; $env:PR_AGENT_OUT = "$temp/output"; $env:PR_AGENT_ENGINE = 'antigravity'
    $agent = Join-Path $root 'src/agent.ps1'
    $reg = { param($Id, $From) $line = & powershell -NoProfile -ExecutionPolicy Bypass -File $agent register-image -Run $run -Item $Id -From $From 2>$null; ($line | Select-Object -Last 1) | ConvertFrom-Json }
    New-TestPng "$temp/in/a.png" 64 64 @(200, 40, 40); New-TestPng "$temp/in/b.png" 64 64 @(40, 200, 40); New-TestPng "$temp/in/c.png" 64 64 @(40, 40, 200)
    Copy-Item "$temp/in/a.png" "$temp/in/a-again.png"

    $r = & $reg '006-popcorn-neon-sign' "$temp/in/a.png"
    Assert $r.ok "006 must register its own picture: $($r.error)"
    $r = & $reg '007-heartbeat-neon-sign' "$temp/in/a-again.png"
    Assert (-not $r.ok -and $r.cause -eq 'WRONG_ITEM_IMAGE' -and $r.error -match '006-popcorn-neon-sign') "007 must refuse 006's picture: $($r | ConvertTo-Json -Compress)"
    Assert (-not (Test-Path "$dir/images/007-heartbeat-neon-sign.png")) 'A refused picture must not land in images.'
    Assert (-not (Test-Path "$dir/logs/007-heartbeat-neon-sign-sign-check.json")) 'A refused picture must not count as a sign-check try.'

    $r = & $reg '007-heartbeat-neon-sign' "$temp/in/b.png"
    Assert $r.ok "007 must register its own picture: $($r.error)"
    $st = Get-Content "$dir/logs/007-heartbeat-neon-sign-review-status.json" -Raw | ConvertFrom-Json
    Assert ($st.source_file -eq 'b.png' -and $st.source_sha256 -eq (Get-FileHash "$temp/in/b.png").Hash.ToLowerInvariant()) 'The source file and its hash must be recorded.'
    $r = & $reg '007-heartbeat-neon-sign' "$temp/in/b.png"
    Assert (-not $r.ok -and $r.cause -eq 'WRONG_ITEM_IMAGE' -and $r.error -match 'its own') 'Re-registering the same picture as new must be refused.'
    $r = & $reg '007-heartbeat-neon-sign' "$temp/in/c.png"
    Assert ($r.ok -and (Test-Path "$dir/logs/007-heartbeat-neon-sign-attempt-1-generated.png")) 'A really new picture must register and keep the earlier one as attempt 1.'
    $r = & $reg '006-popcorn-neon-sign' "$temp/in/b.png"
    Assert (-not $r.ok -and $r.cause -eq 'WRONG_ITEM_IMAGE' -and $r.error -match 'earlier attempt of item 007') "006 must refuse 007's earlier attempt: $($r.error)"
    Assert ((Get-FileHash "$dir/images/006-popcorn-neon-sign.png").Hash -eq (Get-FileHash "$temp/in/a.png").Hash) 'A refused picture must leave the current image untouched.'

    # a file collected for another item (by its name or by download-collect's note) is refused; this item's own note is recorded
    New-TestPng "$temp/flow-downloads/006-popcorn-neon-sign.png" 64 64 @(90, 90, 10)
    $r = & $reg '007-heartbeat-neon-sign' "$temp/flow-downloads/006-popcorn-neon-sign.png"
    Assert (-not $r.ok -and $r.cause -eq 'WRONG_ITEM_IMAGE') 'The download named after another item must be refused.'
    New-TestPng "$temp/flow-downloads/x.png" 64 64 @(10, 90, 90)
    '{"tag":"006-popcorn-neon-sign","from":"Edit_popcorn_image_1.png"}' | Set-Content "$temp/flow-downloads/x.download.json" -Encoding ASCII
    $r = & $reg '007-heartbeat-neon-sign' "$temp/flow-downloads/x.png"
    Assert (-not $r.ok -and $r.cause -eq 'WRONG_ITEM_IMAGE') 'A file collected for another item must be refused.'
    $r = & $reg '006-popcorn-neon-sign' "$temp/flow-downloads/x.png"
    Assert ($r.ok -and $r.source_download -eq 'Edit_popcorn_image_1.png') "The Flow download name must be recorded: $($r | ConvertTo-Json -Compress)"

    # download-collect: only the file named like the clicked tile; two unnamed fresh files = ambiguous, nothing taken
    $png = { param($p) New-TestPng $p 40 40 @(1, 2, 3); $b = [IO.File]::ReadAllBytes($p); [IO.File]::WriteAllBytes($p, [byte[]]($b + [byte[]]::new(3000))) }
    & $png "$temp/dl/Edit_popcorn_neon_sign_image_aa.png"; & $png "$temp/dl/Edit_heartbeat_neon_sign_image_bb.png"
    $env:PR_DOWNLOADS_DIR = "$temp/dl"; $env:PR_FLOW_DOWNLOAD_LOCK = "$temp/dl.lock"
    $pace = Join-Path $root 'core/flow-pace.mjs'
    $d = (& node $pace download-collect --tag 007-heartbeat-neon-sign --dest "$temp/flow-downloads" --wait-s 3 --expect 'Edit_heartbeat_neon_sign_image' --tile 'Edit heartbeat neon sign image') | ConvertFrom-Json
    Assert ($d.ok -and $d.from -eq 'Edit_heartbeat_neon_sign_image_bb.png' -and $d.name_match) "download-collect must take the file of the clicked tile: $($d | ConvertTo-Json -Compress)"
    Assert ((Get-Content "$temp/flow-downloads/007-heartbeat-neon-sign.download.json" -Raw | ConvertFrom-Json).from -eq 'Edit_heartbeat_neon_sign_image_bb.png') 'download-collect must leave its note.'
    & $png "$temp/dl/Edit_karaoke_image_cc.png"
    $d = (& node $pace download-collect --tag 013-karaoke --dest "$temp/flow-downloads" --wait-s 3 --expect 'Edit_wedding_image') | ConvertFrom-Json
    Assert (-not $d.ok -and $d.cause -eq 'AMBIGUOUS_DOWNLOAD') "Two fresh files that do not match the tile must not be taken: $($d | ConvertTo-Json -Compress)"

    # collect/ready pick the tile of the item's own prompt (fake page: the snippet's own decision code, no Flow)
    $js = Join-Path $temp 'pick.mjs'
    $snip = ([Uri](Join-Path $root 'core/flow-snippets.mjs')).AbsoluteUri
    @"
import { buildFlowSnippets, itemWords } from '$snip';
const f2 = 'pr-ref-r-007-heartbeat-neon-sign-2.png', f6 = 'pr-ref-r-006-popcorn-neon-sign-2.png';
const s = buildFlowSnippets({ uploads: ['x/pr-ref-r-007-heartbeat-neon-sign-1.jpg', 'x/' + f2], prompt: 'p', words: itemWords('heartbeat-neon-sign') });
for (const c of Object.values(s)) if (typeof new Function('return (' + c + ')')() !== 'function') throw new Error('snippet does not compile');
const ready = new Function('return (' + s.ready + ')')();
const page = (state) => ({ bringToFront: async () => {}, url: () => 'https://flow.google.com/project/x', waitForTimeout: async () => {}, evaluate: async () => state });
const log = [{ f2: f6, words: ['popcorn'], at: 1 }, { f2, words: ['heartbeat'], at: 2 }];
const popcorn = { i: 0, label: 'Edit popcorn neon sign image', key: 'k6', busy: false };
let r = await ready(page({ own: 1, tiles: [popcorn], rec: { before: [], at: 2 }, log, claimed: {} }));
if (r.item_ready) throw new Error('the neighbour popcorn tile next to 007 references must not be 007s: ' + JSON.stringify(r));
r = await ready(page({ own: 2, tiles: [popcorn, { i: 1, label: 'Edit heartbeat sign image', key: 'k7', busy: false }], rec: { before: [], at: 2 }, log, claimed: {} }));
if (!r.item_ready || r.info.label !== 'Edit heartbeat sign image') throw new Error('007 must pick its own tile: ' + JSON.stringify(r));
r = await ready(page({ own: 1, tiles: [{ ...popcorn, label: 'Edit image' }], rec: { before: [], at: 2 }, log, claimed: {} }));
if (r.item_ready) throw new Error('an unnamed tile while 006 is uncollected must stay ambiguous: ' + JSON.stringify(r));
r = await ready(page({ own: 1, tiles: [{ ...popcorn, label: 'Edit image' }], rec: { before: ['k6'], at: 2 }, log, claimed: {} }));
if (r.item_ready) throw new Error('a tile that existed before the submit must not be picked');
console.log('ok');
"@ | Set-Content -LiteralPath $js -Encoding UTF8
    $p = & node $js 2>&1
    Assert ($LASTEXITCODE -eq 0 -and "$p" -match 'ok') "collect pick: $p"
    'wrong-item-guard OK'
} finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
