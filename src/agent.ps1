# Agent mode: Claude Code drives Google Flow itself (Playwright MCP); these commands do only the mechanical parts.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 <command> [-Run r] [-Item id] [-File f] [-From f] [-Limit n]
# Every command prints exactly one JSON line: {"ok":true,...} or {"ok":false,"error":"...","cause":"..."} (exit 1).
# Commands: prepare, context-brief, context, flow-brief, register-image; review-brief, write-review, finish (src/agent-review.ps1).
param(
    [Parameter(Position = 0)][string]$Command = '',
    [string]$Run = '', [string]$Item = '', [string]$File = '', [string]$From = '',
    [int]$Limit = 0, [string]$List = '',
    [Parameter(ValueFromRemainingArguments = $true)]$Rest
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $OutputEncoding
[Console]::OutputEncoding = $OutputEncoding
$ProjectRoot = Split-Path $PSScriptRoot -Parent

# stdout carries one JSON line only: the workflow functions' progress text is dropped here.
function Write-Host { }
function Write-Warning { }

function Write-AgentJson($Value) {
    if ($Value -is [Collections.IDictionary] -and -not $Value.Contains('ok')) {
        if ($Value -is [Collections.Specialized.OrderedDictionary]) { $Value.Insert(0, 'ok', $true) } else { $Value['ok'] = $true }
    }
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 8
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

function Fail-Agent([string]$Message, [string]$Cause = '') {
    if (-not $Cause -and $Message -match '\[CAUSE:([A-Z_]+)\]') { $Cause = $Matches[1] }
    Write-AgentJson ([ordered]@{ ok = $false; error = ($Message -replace '\s*\[CAUSE:[A-Z_]+\]\s*', ' ').Trim(); cause = $Cause })
    exit 1
}

function Get-CauseOf([string]$Message) { if ($Message -match '\[CAUSE:([A-Z_]+)\]') { $Matches[1] } else { '' } }

try {
    . (Join-Path $PSScriptRoot 'bootstrap.ps1')
    $reviewModule = Join-Path $PSScriptRoot 'agent-review.ps1'
    if (Test-Path -LiteralPath $reviewModule) { . $reviewModule }
} catch { Fail-Agent "Cannot load the app modules. $($_.Exception.Message)" 'TOOL_ERROR' }

$OutRoot = if ($env:PR_AGENT_OUT) { $env:PR_AGENT_OUT } else { Join-Path $ProjectRoot 'workspace/output' }
$script:Utf8 = [Text.UTF8Encoding]::new($false)

# --- run state -------------------------------------------------------------------------------------------------
function New-AgentConfig {
    $config = New-WorkflowConfiguration $ProjectRoot (Join-Path $ProjectRoot 'workspace/source-photos') ''
    $config.Results = $null
    $config.ResultsRequired = $false
    $map = if ($env:PR_AGENT_REFERENCES) { $env:PR_AGENT_REFERENCES } else { Join-Path $ProjectRoot 'workspace/reference-inputs/references.json' }
    $config.ManualReferences = Read-ManualReferenceMap $map
    $config
}

# Same structure as New-Batch (Dir, Refs, Images, Logs, ...); '' creates a new run, a name opens an existing one.
function Open-AgentRun([string]$Name) {
    $script:Config = New-AgentConfig
    if (-not $Name) {
        $script:Batch = New-Batch $OutRoot
        Write-Lines $script:Batch.InputUrls @()
        Save-BatchResults @() $script:Batch.Dir
    } else {
        if ([IO.Path]::IsPathRooted($Name)) { $dir = $Name.TrimEnd('\','/'); $Name = Split-Path $dir -Leaf }
        else {
            if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid run name: $Name" }
            $dir = Join-Path $OutRoot $Name
        }
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Run not found: $Name" }
        $script:Batch = @{
            Id = $Name; Dir = $dir
            InputUrls = Join-Path $dir 'urls.input.txt'; CompletedUrls = Join-Path $dir 'urls.completed.txt'
            Images = Join-Path $dir 'images'; Logs = Join-Path $dir 'logs'; Refs = Join-Path $dir 'refs'
            Csv = Join-Path $dir 'loox_import.csv'
        }
        New-Item -ItemType Directory -Force $script:Batch.Images, $script:Batch.Logs, $script:Batch.Refs | Out-Null
    }
}

function Get-AgentItemsPath { Join-Path $script:Batch.Dir 'agent-items.json' }
function Read-AgentItems {
    $path = Get-AgentItemsPath
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    # Windows PowerShell returns a JSON array as one object; enumerate it explicitly.
    $data = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    @(foreach ($entry in $data) { $entry })
}
function Save-AgentItems($Items) {
    [IO.File]::WriteAllText((Get-AgentItemsPath), (ConvertTo-Json -InputObject @($Items) -Depth 6), $script:Utf8)
}
function Get-AgentItem([string]$Id) {
    if (-not $Id) { throw '-Item is required.' }
    $found = @(Read-AgentItems | Where-Object id -eq $Id)
    if (-not $found.Count) { throw "Item not found in run $($script:Batch.Id): $Id" }
    $found[0]
}
# Loads the saved context of an item (written by the context command).
function Get-AgentContext([string]$Id) {
    $path = Join-Path $script:Batch.Logs "$Id-context.json"
    if (-not (Test-Path -LiteralPath $path)) { throw "No context yet for $Id. Run: context -Run $($script:Batch.Id) -Item $Id -File <json>" }
    Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

# --- 1. prepare ------------------------------------------------------------------------------------------------
function Invoke-AgentPrepare {
    Open-AgentRun $Run
    $queuePath = if ($List) { $List } else { Join-Path $ProjectRoot 'workspace/urls.txt' }
    if (-not (Test-Path -LiteralPath $queuePath)) { throw "URL list not found: $queuePath" }
    $queue = Read-UrlQueue $queuePath
    $existing = @(Read-AgentItems)
    $jobs = @(Expand-SceneJobs @($queue.Items))
    $result = New-Object Collections.Generic.List[object]
    $all = New-Object Collections.Generic.List[object]
    foreach ($e in $existing) { $all.Add($e) }
    $taken = 0
    $number = $existing.Count
    foreach ($job in $jobs) {
        # A link with one pair comes without Product/Scene (Expand-SceneJobs keeps the plain item): take them from its entry.
        $entryOfJob = @($script:Config.ManualReferences.entries | Where-Object product_url -eq $job.Url)
        $product = if ($job.PSObject.Properties['Product']) { $job.Product } elseif ($entryOfJob.Count) { @(Get-ManualProducts $entryOfJob[0] | Where-Object file | Select-Object -First 1)[0] } else { $null }
        $productFile = if ($product) { [string]$product.file } else { '' }
        $productSha = if ($product) { [string]$product.sha256 } else { '' }
        $scene = if ($job.PSObject.Properties['Scene']) { $job.Scene } else {
            $entry = @($script:Config.ManualReferences.entries | Where-Object product_url -eq $job.Url)
            if ($entry.Count) { @(Get-ManualScenes $entry[0])[0] } else { $null }
        }
        $sceneFile = if ($scene) { [string]$scene.file } else { '' }
        $sceneSha = if ($scene) { [string]$scene.sha256 } else { '' }
        $key = "$($job.Url)|$productSha|$sceneSha"
        if (@($existing | Where-Object key -eq $key).Count) { continue }
        if ($Limit -gt 0 -and $taken -ge $Limit) { break }
        $taken++; $number++
        $id = '{0:D3}-{1}' -f $number, $job.Handle
        try {
            if (-not $productFile) { throw '[CAUSE:PRODUCT_INPUT] Sản phẩm chưa gắn ảnh sản phẩm gốc. Hãy gắn ảnh sản phẩm.' }
            if (-not (Test-Path -LiteralPath $productFile -PathType Leaf)) { throw '[CAUSE:PRODUCT_INPUT] Ảnh sản phẩm đã gắn bị thiếu. Hãy gắn lại ảnh.' }
            $pBytes = [IO.File]::ReadAllBytes($productFile)
            if ((Get-BytesHash $pBytes) -ine $productSha) { throw '[CAUSE:PRODUCT_INPUT] Ảnh sản phẩm đã gắn bị thay đổi. Hãy gắn lại ảnh.' }
            if (-not $sceneFile) { throw '[CAUSE:PRODUCT_INPUT] Ảnh gốc chưa gắn ảnh review. Hãy gắn ảnh review.' }
            if (-not (Test-Path -LiteralPath $sceneFile -PathType Leaf)) { throw '[CAUSE:PRODUCT_INPUT] Ảnh review đã gắn bị thiếu. Hãy gắn lại ảnh.' }
            $sBytes = [IO.File]::ReadAllBytes($sceneFile)
            if ((Get-BytesHash $sBytes) -ine $sceneSha) { throw '[CAUSE:PRODUCT_INPUT] Ảnh review đã gắn bị thay đổi. Hãy gắn lại ảnh.' }
            $productRef = Join-Path $script:Batch.Refs ($id + '-manual-product' + [IO.Path]::GetExtension($productFile))
            $sceneRef = Join-Path $script:Batch.Refs ($id + '-manual-review' + [IO.Path]::GetExtension($sceneFile))
            [IO.File]::WriteAllBytes($productRef, $pBytes)
            [IO.File]::WriteAllBytes($sceneRef, $sBytes)
            $all.Add([pscustomobject]@{ id = $id; key = $key; url = $job.Url; handle = $job.Handle; product_image = $productRef; review_photo = $sceneRef; product_sha256 = $productSha; review_sha256 = $sceneSha; sign_text = $(if ($scene -and $scene.PSObject.Properties['sign_text']) { [string]$scene.sign_text } else { '' }); status = 'prepared' })
            $result.Add([ordered]@{ id = $id; url = $job.Url; product_image = $productRef; review_photo = $sceneRef; handle = $job.Handle })
        } catch {
            $msg = $_.Exception.Message
            $result.Add([ordered]@{ id = $id; url = $job.Url; handle = $job.Handle; error = ($msg -replace '\s*\[CAUSE:[A-Z_]+\]\s*', ' ').Trim(); cause = (Get-CauseOf $msg) })
        }
    }
    Save-AgentItems $all.ToArray()
    if (@($queue.Items).Count -and -not (Test-Path -LiteralPath $script:Batch.InputUrls -PathType Leaf) -or (@($queue.Items).Count -and -not @(Get-Content -LiteralPath $script:Batch.InputUrls -ErrorAction SilentlyContinue).Count)) {
        Write-Lines $script:Batch.InputUrls $queue.Lines
    }
    Write-AgentJson ([ordered]@{ ok = $true; run = $script:Batch.Id; dir = $script:Batch.Dir; items = $result.ToArray() })
}

# --- 2. context-brief / context --------------------------------------------------------------------------------
function Invoke-AgentContextBrief {
    Open-AgentRun $Run
    $entry = Get-AgentItem $Item
    Write-AgentJson ([ordered]@{ ok = $true; run = $script:Batch.Id; item = $entry.id; product_image = $entry.product_image; prompt = (Get-ProductContextPrompt $entry.handle)
            file_format = '{"product":"...","presentation":"worn|held|placed|vehicle","details":"numbered visible details","lettered":true|false (true = the product photo shows SAMPLE customer lettering such as Your Name / YOUR LOGO; false = fixed words or no text),"source_categories":["category-key"]} (an id is optional; a raw classification with category_key/existing_profile is accepted too)' })
}

function Invoke-AgentContext {
    Open-AgentRun $Run
    $entry = Get-AgentItem $Item
    if (-not $File -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "-File not found: $File" }
    try { $in = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'The context file is not valid JSON.' }
    if ($in.error) { throw "Product could not be classified: $($in.error)" }
    # Reduce to the raw classification and validate it with the same code as the AI step.
    $category = if ($in.category_key) { [string]$in.category_key } elseif (@($in.source_categories).Count) { [string]@($in.source_categories)[0] } elseif ($in.id) { [string]$in.id } else { '' }
    $profile = if ($in.existing_profile) { [string]$in.existing_profile } else { [string]$in.id }
    $raw = [ordered]@{ category_key = $category; existing_profile = $profile; product = $in.product; presentation = $in.presentation; details = $in.details; lettered = ($in.lettered -eq $true) }
    $context = ConvertFrom-ProductClassification ($raw | ConvertTo-Json -Depth 4)
    $cats = @($in.source_categories | ForEach-Object { [string]$_ } | Where-Object { $_ })
    if ($cats.Count) { $context | Add-Member source_categories $cats -Force }
    # Where the AI step keeps its reply (logs/<id>-context.txt), plus the resolved context for the next commands.
    [IO.File]::WriteAllText((Join-Path $script:Batch.Logs "$($entry.id)-context.txt"), ($raw | ConvertTo-Json -Depth 4), $script:Utf8)
    [IO.File]::WriteAllText((Join-Path $script:Batch.Logs "$($entry.id)-context.json"), ($context | ConvertTo-Json -Depth 8), $script:Utf8)
    Write-AgentJson ([ordered]@{ ok = $true; run = $script:Batch.Id; item = $entry.id; context = $context })
}

# --- 3. flow-brief ---------------------------------------------------------------------------------------------
# The Flow aspect closest to the review photo's shape.
function Get-FlowAspect([string]$ImagePath) {
    $info = Get-ImageSize ([IO.File]::ReadAllBytes($ImagePath))
    if (-not $info -or -not $info.Height) { return '16:9' }
    $ratio = $info.Width / $info.Height
    $best = $null; $bestDelta = [double]::MaxValue
    foreach ($a in @(@('16:9', (16 / 9)), @('4:3', (4 / 3)), @('1:1', 1.0), @('3:4', (3 / 4)), @('9:16', (9 / 16)))) {
        $d = [Math]::Abs([Math]::Log($a[1] / $ratio))
        if ($d -lt $bestDelta) { $best = $a[0]; $bestDelta = $d }
    }
    $best
}

# $SignText: optional wording for a made-to-order lettered product (references.json scene.sign_text, " | " = line break).
# Same rule as the Codex path (02-create-image.ps1): the sample lettering of the product photo is replaced entirely.
function Get-CondensedFlowPrompt($Context, [string]$SignText = '') {
    $details = ([string]$Context.details -replace '\s+', ' ').Trim()
    if ($details.Length -gt 600) {
        # Cut at a sentence boundary (never mid-word); no sentence end in the first 600 characters = the last whole word.
        $head = $details.Substring(0, 600)
        $ends = [regex]::Matches($head, '[.!?](?=\s|$)')
        if ($ends.Count -gt 0 -and $ends[$ends.Count - 1].Index -ge 200) { $details = $head.Substring(0, $ends[$ends.Count - 1].Index + 1) }
        else { $details = ($head -replace '\s+\S*$', '').TrimEnd(' ', ',', ';', ':') + '...' }
    }
    $worn = -not $Context.presentation -or $Context.presentation -eq 'worn'
    $first = if ($worn) {
        'Edit image 1 (the review photo) into ONE photorealistic photo: keep its people, pose, framing, camera and background exactly as they are, and replace only the target garment with the product from image 2. If no person is shown, keep the existing folded or laid-out presentation; do not add a model.'
    } else {
        'Edit image 1 (the base photo) into ONE photorealistic photo: keep its exact room or surroundings, camera, perspective, lighting and all unrelated objects unchanged, and place only the product from image 2 (replacing the old item, if any) at true relative scale.'
    }
    # The wording rule is the shared template prompts/sign-wording.txt (src/domain/sign-wording.ps1), also used by the Codex path.
    $signRule = Get-ItemSignRule $SignText $Context 2 'the product text and the no-text rule'
    $lastRule = if ($signRule) {
        "$signRule Do not add objects, people or props that image 1 does not have. One single frame: no collage, split screen or multiple views."
    } else {
        'Show the product without any brand name or logo; add no text, labels or watermarks. Do not add objects, people or props that image 1 does not have. One single frame: no collage, split screen or multiple views.'
    }
    @(
        $first
        "Image 2 is the ONLY source for the product's design: $($Context.product). Copy its shape, proportions, colors, pattern, material and every visible detail exactly; its background and props are not part of the result."
        "Key details of image 2 (the picture wins if it differs): $details"
        'Photo style: a quick casual snapshot taken with a phone camera, an everyday angle, available light only, natural color, a slight touch of image noise. Do not over-smooth or retouch; no studio lighting, no strong background blur, nothing that feels like an advertisement. Keep the original setting and the product design unchanged.'
        $lastRule
    ) -join ' '
}

function Invoke-AgentFlowBrief {
    Open-AgentRun $Run
    $entry = Get-AgentItem $Item
    $context = Get-AgentContext $entry.id
    $script:Config.ActiveProductUrl = $entry.url
    # This item's OWN review photo (a link with 2 scenes = 2 items): with $null Get-ReviewPhoto falls back to the link's FIRST scene and both items get the same room.
    $script:Config.ActiveScene = if ($entry.review_photo) { [pscustomobject]@{ file = [string]$entry.review_photo; sha256 = [string]$entry.review_sha256 } } else { $null }
    $folder = Join-Path $script:Batch.Refs $entry.id
    if (Test-Path -LiteralPath (Join-Path $folder 'manifest.json')) {
        # Already archived: use the archived copies (01 = review photo, 02 = product).
        $review = @(Get-ChildItem -LiteralPath $folder -Filter '01-*' | Select-Object -First 1)[0].FullName
        $product = @(Get-ChildItem -LiteralPath $folder -Filter '02-*' | Select-Object -First 1)[0].FullName
        $request = New-ProductImageRequest $product $entry.id $context $review
        $request.Images = @($review, $product)
    } else {
        $reviewPhoto = Get-ReviewPhoto $entry.id $context
        $request = New-ProductImageRequest $entry.product_image $entry.id $context $reviewPhoto
        Save-ProductReferenceBundle ([pscustomobject]@{ Url = $entry.url; Handle = $entry.handle }) $entry.id $context $request | Out-Null
        foreach ($loose in @($entry.product_image, $entry.review_photo)) { if ($loose -and (Test-Path -LiteralPath $loose)) { Remove-Item -LiteralPath $loose -Force } }
    }
    $promptFile = Join-Path $script:Batch.Logs "$($entry.id)-image-prompt.txt"
    [IO.File]::WriteAllText($promptFile, $request.Prompt, $script:Utf8)
    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    New-Item -ItemType Directory -Force $downloads | Out-Null
    $uploads = @()
    for ($i = 0; $i -lt 2; $i++) {
        $src = $request.Images[$i]
        $dest = Join-Path $downloads ('pr-ref-{0}-{1}-{2}{3}' -f $script:Batch.Id, $entry.id, ($i + 1), [IO.Path]::GetExtension($src).ToLowerInvariant())
        Copy-Item -LiteralPath $src -Destination $dest -Force
        $uploads += $dest
    }
    $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 register-image -Run $($script:Batch.Id) -Item $($entry.id) -From <downloaded file>"
    Write-AgentJson ([ordered]@{ ok = $true; run = $script:Batch.Id; item = $entry.id; prompt_file = $promptFile; condensed_prompt = (Get-CondensedFlowPrompt $context $(if ($entry.PSObject.Properties['sign_text']) { [string]$entry.sign_text } else { '' }))
            aspect = (Get-FlowAspect $request.Images[0]); uploads = $uploads; register_command = $cmd })
}

# --- 4. register-image -----------------------------------------------------------------------------------------
function Invoke-AgentRegisterImage {
    Open-AgentRun $Run
    $entry = Get-AgentItem $Item
    if (-not $From -or -not (Test-Path -LiteralPath $From -PathType Leaf)) { throw "-From file not found: $From" }
    $id = $entry.id
    $output = Join-Path $script:Batch.Images "$id.png"
    $statusPath = Join-Path $script:Batch.Logs "$id-review-status.json"
    $attempt = 1
    if (Test-Path -LiteralPath $statusPath) { try { $attempt = [int](Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json).generation_attempt + 1 } catch { $attempt = 2 } }
    if (Test-Path -LiteralPath $output) {
        Copy-Item -LiteralPath $output -Destination (Join-Path $script:Batch.Logs "$id-attempt-$($attempt - 1)-generated.png") -Force
    }
    Copy-Item -LiteralPath $From -Destination $output -Force
    $sparkle = 'none'
    try {
        ConvertTo-PngFile $output
        Assert-GeneratedImage $output
        if (Remove-ReviewImageSparkle $output (Join-Path $script:Batch.Logs "$id-flow-original.png")) { $sparkle = 'removed' }
        Assert-GeneratedImage $output
    } catch {
        Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
        throw "[CAUSE:OUTPUT_INVALID] $($_.Exception.Message)"
    }
    $bytes = [IO.File]::ReadAllBytes($output)
    $hash = Get-BytesHash $bytes
    $status = [ordered]@{ status = 'awaiting_user_review'; ai_image_qa_performed = $false; generation_attempt = $attempt; output = $output; engine = 'claude-flow' }
    [IO.File]::WriteAllText($statusPath, ($status | ConvertTo-Json), $script:Utf8)
    $duplicates = @(Get-ChildItem -LiteralPath $script:Batch.Images -Filter '*.png' | Where-Object { $_.FullName -ne $output -and (Get-BytesHash ([IO.File]::ReadAllBytes($_.FullName))) -eq $hash } | ForEach-Object { $_.BaseName })
    $info = Get-ImageSize $bytes
    $out = [ordered]@{ ok = $true; run = $script:Batch.Id; item = $id; image = $output; size = [ordered]@{ width = $info.Width; height = $info.Height; bytes = $bytes.Length }; sparkle = $sparkle; sha256 = $hash }
    if ($duplicates.Count) { $out.warning = "Same image hash as: $($duplicates -join ', ')"; $out.duplicate_of = $duplicates }
    Write-AgentJson $out
}

# --- dispatcher ------------------------------------------------------------------------------------------------
# Extra "-Name value" arguments pass through to the review commands (src/agent-review.ps1).
function ConvertTo-ArgumentHash($Tokens) {
    $hash = @{}
    $list = @($Tokens)
    for ($i = 0; $i -lt $list.Count; $i++) {
        $token = [string]$list[$i]
        if ($token -match '^-+([A-Za-z]\w*)$') {
            $name = $Matches[1]
            if ($i + 1 -lt $list.Count -and ([string]$list[$i + 1]) -notmatch '^-[A-Za-z]') { $hash[$name] = $list[$i + 1]; $i++ } else { $hash[$name] = $true }
        }
    }
    $hash
}

try {
    switch ($Command) {
        'prepare' { Invoke-AgentPrepare }
        'context-brief' { Invoke-AgentContextBrief }
        'context' { Invoke-AgentContext }
        'flow-brief' { Invoke-AgentFlowBrief }
        'register-image' { Invoke-AgentRegisterImage }
        { $_ -in @('review-brief', 'write-review', 'finish', 'run-summary') } {
            $fn = @{ 'review-brief' = 'Invoke-AgentReviewBrief'; 'write-review' = 'Invoke-AgentWriteReview'; 'finish' = 'Invoke-AgentFinish'; 'run-summary' = 'Invoke-AgentRunSummary' }[$Command]
            if (-not (Get-Command $fn -ErrorAction SilentlyContinue)) { throw "Command $Command is not available (src/agent-review.ps1 missing)." }
            $splat = ConvertTo-ArgumentHash $Rest
            foreach ($pair in @{ Run = $Run; Item = $Item; File = $File; From = $From }.GetEnumerator()) { if ($pair.Value) { $splat[$pair.Key] = $pair.Value } }
            if ($Limit) { $splat['Limit'] = $Limit }
            & $fn @splat
        }
        default { throw "Unknown command '$Command'. Use: prepare | context-brief | context | flow-brief | register-image | review-brief | write-review | finish | run-summary" }
    }
} catch {
    Fail-Agent $_.Exception.Message
}
