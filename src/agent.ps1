# Agent mode: Claude Code drives Google Flow itself (Playwright MCP); these commands do only the mechanical parts.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 <command> [-Run r] [-Item id] [-File f] [-From f] [-Limit n]
# Every command prints exactly one JSON line: {"ok":true,...} or {"ok":false,"error":"...","cause":"..."} (exit 1).
# Commands: prepare, context-brief, context, sign-brief, set-sign-text, flow-brief, register-image; review-brief, write-review, finish (src/agent-review.ps1).
param(
    [Parameter(Position = 0)][string]$Command = '',
    [string]$Run = '', [string]$Item = '', [string]$File = '', [string]$From = '',
    [int]$Limit = 0, [string]$List = '',
    [string]$Text = '', [string]$Reason = '', [string]$SignRead = '', [switch]$Safe,
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

$OutRoot = if ($env:PR_AGENT_OUT) { $env:PR_AGENT_OUT } else { Join-Path (Get-SessionWorkspaceDir $ProjectRoot) 'output' }
$script:Utf8 = [Text.UTF8Encoding]::new($false)

# --- run state -------------------------------------------------------------------------------------------------
function New-AgentConfig {
    $config = New-WorkflowConfiguration $ProjectRoot (Join-Path $ProjectRoot 'workspace/source-photos') ''
    $config.Results = $null
    $config.ResultsRequired = $false
    $map = if ($env:PR_AGENT_REFERENCES) { $env:PR_AGENT_REFERENCES } else { Join-Path (Get-SessionWorkspaceDir $ProjectRoot) 'reference-inputs/references.json' }
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
# Run flags (agent-run.json), written by prepare when it creates the run's item list. sign_wording = 'exact': the agent chooses
# every lettered item's wording itself (set-sign-text) before flow-brief, and register-image checks what the sign reads.
# A run without the file (created before 2026-11-23) keeps the old behaviour: Flow picks the wording (prompts/sign-wording-auto.txt).
function Get-AgentRunFlagsPath { Join-Path $script:Batch.Dir 'agent-run.json' }
function Test-ExactSignRun {
    $path = Get-AgentRunFlagsPath
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    try { return ([string](Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json).sign_wording -eq 'exact') } catch { return $false }
}
function Get-AgentItemSignText($Entry) { if ($Entry -and $Entry.PSObject.Properties['sign_text'] -and $Entry.sign_text) { ([string]$Entry.sign_text).Trim() } else { '' } }
function Test-ContextLettered($Context) { [bool]($Context -and $Context.PSObject.Properties['lettered'] -and $Context.lettered -eq $true) }
function Get-AgentContextOrNull([string]$Id) { $path = Join-Path $script:Batch.Logs "$Id-context.json"; if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } }
# Writes one {ok:false,...} line with extra fields and ends the command (exit 1).
function Stop-AgentWith([Collections.Specialized.OrderedDictionary]$Value) { if (-not $Value.Contains('ok')) { $Value.Insert(0, 'ok', $false) }; Write-AgentJson $Value; exit 1 }

# Loads the saved context of an item (written by the context command).
function Get-AgentContext([string]$Id) {
    $path = Join-Path $script:Batch.Logs "$Id-context.json"
    if (-not (Test-Path -LiteralPath $path)) { throw "No context yet for $Id. Run: context -Run $($script:Batch.Id) -Item $Id -File <json>" }
    Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

# --- 1. prepare ------------------------------------------------------------------------------------------------
function Invoke-AgentPrepare {
    Open-AgentRun $Run
    $queuePath = if ($List) { $List } else { Join-Path (Get-SessionWorkspaceDir $ProjectRoot) 'urls.txt' }
    if (-not (Test-Path -LiteralPath $queuePath)) { throw "URL list not found: $queuePath" }
    $queue = Read-UrlQueue $queuePath
    $existing = @(Read-AgentItems)
    # A new run (no items yet) uses exact sign wording; a run that already has items keeps the mode it was created with.
    if (-not $existing.Count -and -not (Test-Path -LiteralPath (Get-AgentRunFlagsPath))) {
        [IO.File]::WriteAllText((Get-AgentRunFlagsPath), (ConvertTo-Json -InputObject ([ordered]@{ sign_wording = 'exact'; created = (Get-Date).ToString('s') })), $script:Utf8)
    }
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
            file_format = '{"product":"...","presentation":"worn|held|placed|vehicle","details":"numbered visible details","lettered":true|false (true = the product photo shows SAMPLE customer lettering such as Your Name / YOUR LOGO; false = fixed words or no text),"sample_text":"when lettered: that sample lettering exactly as shown, top to bottom, '' | '' between lines (e.g. Your Name | Est. 2024); else empty","custom_logo":true|false (STEP 3C: a buyer-supplied logo area with replaceable sample branding, e.g. the chest mark of a custom polo),"logo_placeholder":"when custom_logo: the replaceable sample branding words, '' | '' between lines; else empty","source_categories":["category-key"]} (an id is optional; a raw classification with category_key/existing_profile is accepted too)' })
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
    $raw = [ordered]@{ category_key = $category; existing_profile = $profile; product = $in.product; presentation = $in.presentation; details = $in.details; lettered = ($in.lettered -eq $true); sample_text = $(if ($in.sample_text -is [string]) { $in.sample_text } else { '' }); custom_logo = ($in.custom_logo -eq $true); logo_placeholder = $(if ($in.logo_placeholder -is [string]) { $in.logo_placeholder } else { '' }) }
    $context = ConvertFrom-ProductClassification ($raw | ConvertTo-Json -Depth 4)
    $cats = @($in.source_categories | ForEach-Object { [string]$_ } | Where-Object { $_ })
    if ($cats.Count) { $context | Add-Member source_categories $cats -Force }
    # Where the AI step keeps its reply (logs/<id>-context.txt), plus the resolved context for the next commands.
    [IO.File]::WriteAllText((Join-Path $script:Batch.Logs "$($entry.id)-context.txt"), ($raw | ConvertTo-Json -Depth 4), $script:Utf8)
    [IO.File]::WriteAllText((Join-Path $script:Batch.Logs "$($entry.id)-context.json"), ($context | ConvertTo-Json -Depth 8), $script:Utf8)
    $out = [ordered]@{ ok = $true; run = $script:Batch.Id; item = $entry.id; context = $context }
    if ((Test-ContextLettered $context) -and -not (Get-AgentItemSignText $entry) -and (Test-ExactSignRun)) { $out.next = "sign-brief -Run $($script:Batch.Id) -Item $($entry.id) (choose the sign wording before flow-brief)" }
    Write-AgentJson $out
}

# --- 2b. sign-brief / set-sign-text (lettered products: the agent chooses the exact wording BEFORE the image) ------------
# The two photos of an item: the archived copies once flow-brief ran (refs/<id>/01-* scene, 02-* product), else the prepared ones.
function Get-AgentItemPhotos($Entry) {
    $folder = Join-Path $script:Batch.Refs $Entry.id
    if (Test-Path -LiteralPath (Join-Path $folder 'manifest.json')) {
        return [ordered]@{ review_photo = @(Get-ChildItem -LiteralPath $folder -Filter '01-*' | Select-Object -First 1)[0].FullName; product_photo = @(Get-ChildItem -LiteralPath $folder -Filter '02-*' | Select-Object -First 1)[0].FullName }
    }
    [ordered]@{ review_photo = [string]$Entry.review_photo; product_photo = [string]$Entry.product_image }
}

function Get-OtherSignTexts([string]$Id) { @(Read-AgentItems | Where-Object { $_.id -ne $Id } | ForEach-Object { Get-AgentItemSignText $_ } | Where-Object { $_ }) }

# What the agent needs to choose the wording: the photos to LOOK at, the sample lettering, the wording other items already use, the rule.
function Get-AgentSignBrief($Entry, $Context, $Photos) {
    $sample = Get-ContextSampleText $Context
    $sampleLines = @(Get-SignWordingLines $sample)
    $taken = @(Get-OtherSignTexts $Entry.id)
    $set = "powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 set-sign-text -Run $($script:Batch.Id) -Item $($Entry.id) -Text ""<line 1 | line 2>"" -Reason ""<scene> -> <wording>"""
    $template = Get-Content -LiteralPath (Join-Path $ProjectRoot 'prompts/sign-choice.txt') -Raw -Encoding UTF8
    $rule = $template.Replace('{{REVIEW_PHOTO}}', [string]$Photos.review_photo).Replace('{{PRODUCT_PHOTO}}', [string]$Photos.product_photo).Replace('{{SAMPLE}}', $(if ($sample) { '"' + $sample + '"' } else { 'see image 2' })).Replace('{{LINES}}', $(if ($sampleLines.Count) { [string]$sampleLines.Count } else { 'the same number of' })).Replace('{{TAKEN}}', $(if ($taken.Count) { ($taken | ForEach-Object { '"' + $_ + '"' }) -join ', ' } else { 'none' })).Replace('{{SET_COMMAND}}', $set)
    [ordered]@{ run = $script:Batch.Id; item = $Entry.id; review_photo = $Photos.review_photo; product_photo = $Photos.product_photo; sample_text = $sample; sample_lines = $(if ($sampleLines.Count) { $sampleLines.Count } else { $null }); taken = $taken; instruction = (($rule -split '\r?\n' | Where-Object { $_.Trim() }) -join "`n"); set_command = $set }
}

function Invoke-AgentSignBrief {
    Open-AgentRun $Run
    $entry = Get-AgentItem $Item
    $context = Get-AgentContext $entry.id
    if (-not (Test-ContextLettered $context)) { Write-AgentJson ([ordered]@{ ok = $true; run = $script:Batch.Id; item = $entry.id; lettered = $false; note = 'Not a lettered product: no sign wording to choose.' }); return }
    $brief = Get-AgentSignBrief $entry $context (Get-AgentItemPhotos $entry)
    $brief.Insert(0, 'ok', $true)
    $brief.sign_text = Get-AgentItemSignText $entry
    Write-AgentJson $brief
}

function Invoke-AgentSetSignText {
    Open-AgentRun $Run
    $entry = Get-AgentItem $Item
    $context = Get-AgentContext $entry.id
    if (-not (Test-ContextLettered $context)) { throw "[CAUSE:NOT_LETTERED] Item $($entry.id) is not a lettered product (context lettered=false). Fix the context first if the product photo shows sample lettering." }
    if (Test-Path -LiteralPath (Join-Path $script:Batch.Images "$($entry.id).png")) { throw "[CAUSE:ALREADY_IMAGED] Item $($entry.id) already has an image; its wording can no longer change." }
    if (-not $Reason -or -not $Reason.Trim()) { throw '[CAUSE:BAD_SIGN_TEXT] -Reason is required: one line "scene -> wording", e.g. "home gym with racks -> gym name".' }
    $check = Test-SignTextChoice $Text (Get-ContextSampleText $context) @(Get-OtherSignTexts $entry.id)
    if (-not $check.ok) { throw "[CAUSE:$($check.cause)] $($check.error)" }
    $value = (@($check.lines) -join ' | ')
    $reasonLine = ($Reason -replace '\s+', ' ').Trim()
    $items = @(Read-AgentItems)
    foreach ($it in $items) {
        if ($it.id -ne $entry.id) { continue }
        $it | Add-Member sign_text $value -Force
        $it | Add-Member sign_reason $reasonLine -Force
        $it | Add-Member sign_source 'agent' -Force
    }
    Save-AgentItems $items
    $log = [ordered]@{ item = $entry.id; sign_text = $value; reason = $reasonLine; sample_text = (Get-ContextSampleText $context); at = (Get-Date).ToString('s') }
    [IO.File]::WriteAllText((Join-Path $script:Batch.Logs "$($entry.id)-sign-text.json"), ($log | ConvertTo-Json), $script:Utf8)
    Write-AgentJson ([ordered]@{ ok = $true; run = $script:Batch.Id; item = $entry.id; sign_text = $value; lines = @($check.lines); reason = $reasonLine; warnings = @($check.warnings) })
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
# Worn items (clothing): not a copy of the sample photo. Each item gets its own close framing and aspect, picked from the run+item id;
# about one in five may show a face, the rest are cropped so no face is visible (user 2026-11-23).
function Get-WornVariation([string]$Key) {
    $sum = 0; foreach ($c in $Key.ToCharArray()) { $sum = ($sum * 31 + [int]$c) % 100003 }
    $v = @(
        @{ aspect = '3:4'; face = $false; look = 'a close crop from the chin down to the waist, the garment filling most of the frame' },
        @{ aspect = '1:1'; face = $false; look = 'a tight close-up of the chest, collar and shoulders, the garment detail filling the frame' },
        @{ aspect = '4:3'; face = $false; look = 'a horizontal shot of the shoulders and torso from a slight side angle, cropped below the chin' },
        @{ aspect = '9:16'; face = $false; look = 'a tall vertical shot from the neck down to the hips, the garment hanging naturally' },
        @{ aspect = '3:4'; face = $true; look = 'a relaxed half-body shot, the face may be partly visible' }
    )
    $v[$sum % $v.Count]
}

function Get-CondensedFlowPrompt($Context, [string]$SignText = '', [bool]$SafeArt = $false, [string]$VariationKey = '') {
    # Custom-logo product (STEP 3C): the sample logo is replaced by one small fictional symbol; -Safe (a retry after Flow refused) stays neutral.
    $customLogo = $Context.PSObject.Properties['custom_logo'] -and $Context.custom_logo -eq $true
    $logoPh = if ($customLogo -and $Context.PSObject.Properties['logo_placeholder']) { [string]$Context.logo_placeholder } else { '' }
    $replaceLogo = $customLogo -and -not $SafeArt
    $details = ([string]$Context.details -replace '\s+', ' ').Trim()
    # Exact wording: the details must not quote the sample words ("Your Name") as something to copy.
    $exactSign = [bool]@(Get-SignWordingLines $SignText).Count
    $productName = [string]$Context.product
    if ($exactSign) { $details = Remove-SampleLettering $details $Context; $productName = Remove-SampleLettering $productName $Context }
    # -Safe (after Flow refused the item for "policy"): a human figure on the product is described as printed artwork, never as a person.
    if ($SafeArt) { foreach ($v in @('details', 'productName')) { $t = Get-Variable -Name $v -ValueOnly; $t = [regex]::Replace($t, "(?i)\b(?:a |an |the )?(?:young |pretty |beautiful |sexy )?(?:woman|women|man|men|girl|girls|boy|boys|lady|ladies|female|male|person|people|model)(?:'s)?\s+(?:face|head|portrait|profile)\b", 'an illustrated figure'); $t = [regex]::Replace($t, "(?i)\b(?:a |an |the )?(?:young |pretty |beautiful |sexy )?(?:woman|women|man|men|girl|girls|boy|boys|lady|ladies|female|male|person|people|model)(?:'s)?\b", 'an illustrated figure'); $t = [regex]::Replace($t, '(?i)\b(?:faces?|lips|bod(?:y|ies))\b', 'drawn portrait'); Set-Variable -Name $v -Value $t } }
    if ($details.Length -gt 600) {
        # Cut at a sentence boundary (never mid-word); no sentence end in the first 600 characters = the last whole word.
        $head = $details.Substring(0, 600)
        $ends = [regex]::Matches($head, '[.!?](?=\s|$)')
        if ($ends.Count -gt 0 -and $ends[$ends.Count - 1].Index -ge 200) { $details = $head.Substring(0, $ends[$ends.Count - 1].Index + 1) }
        else { $details = ($head -replace '\s+\S*$', '').TrimEnd(' ', ',', ';', ':') + '...' }
    }
    if ($replaceLogo -and $logoPh) { $logoCtx = [pscustomobject]@{ sample_text = $logoPh }; $details = Remove-SampleLettering $details $logoCtx 'the sample logo'; $productName = Remove-SampleLettering $productName $logoCtx 'the sample logo' }
    $worn = -not $Context.presentation -or $Context.presentation -eq 'worn'
    $first = if ($worn) {
        $wv = Get-WornVariation $VariationKey
        'Edit image 1 (the review photo) into ONE photorealistic customer photo of the garment from image 2 worn by a person of the same kind, in a similar room and light as image 1, but do NOT copy its framing, pose or crop: shoot it as ' + $wv.look + '. ' + $(if ($wv.face) { 'A face may show naturally.' } else { 'No face is visible: crop out or turn away the head.' }) + ' Replace the old garment completely with the product from image 2; keep unrelated objects as they are.'
    } else {
        'Edit image 1 (the base photo) into ONE photorealistic photo: keep its exact room or surroundings, camera, perspective, lighting and all unrelated objects unchanged, and place only the product from image 2 (replacing the old item, if any) at true relative scale.'
    }
    $style = 'Photo style: a quick casual snapshot taken with a phone camera, an everyday angle, available light only, natural color, a slight touch of image noise. Do not over-smooth or retouch; no studio lighting, no strong background blur, nothing that feels like an advertisement. Keep the original setting and the product design unchanged.'
    if ($exactSign) {
        # The exact wording comes right after the product line, before the details, so it wins over "copy every detail".
        $signRule = Get-SignWordingRule $SignText 2 'the product text, the key details and the no-text rule'
        return (@(
                $first
                "Image 2 is the ONLY source for the product's design: $productName. Copy its shape, proportions, colors, pattern, material and every visible detail exactly, EXCEPT the words of the lettering, which SIGN WORDING below replaces; its background and props are not part of the result."
                $signRule
                "Key details of image 2 (the picture wins if it differs, except the lettering): $details"
                $style
                'The only text in the image is the SIGN WORDING above; no brand name, logo, label or watermark. Do not add objects, people or props that image 1 does not have. One single frame: no collage, split screen or multiple views.'
            ) -join ' ')
    }
    # The wording rule is the shared template prompts/sign-wording.txt (src/domain/sign-wording.ps1), also used by the Codex path.
    $signRule = Get-ItemSignRule $SignText $Context 2 'the product text and the no-text rule'
    $lastRule = if ($signRule) {
        "$signRule Do not add objects, people or props that image 1 does not have. One single frame: no collage, split screen or multiple views."
    } elseif ($replaceLogo) {
        'LOGO: the logo area of image 2 shows replaceable sample branding' + $(if ($logoPh) { ' (' + $logoPh + ')' } else { '' }) + '. Replace the whole sample mark, tagline included, with ONE small plausible fictional symbol in the same logo or embroidery spot: an original simple non-letter shape, no readable words or initials, no real or famous brand, not an imitation of the sample mark. Keep the exact construction, colors, trim, material and every other artwork detail of image 2. Add no labels or watermarks. Do not add objects, people or props that image 1 does not have. One single frame: no collage, split screen or multiple views.'
    } else {
        'Show the product without any brand name or logo; add no text, labels or watermarks. Do not add objects, people or props that image 1 does not have. One single frame: no collage, split screen or multiple views.'
    }
    @(
        $first
        "Image 2 is the ONLY source for the product's design: $productName. Copy its shape, proportions, colors, pattern, material and every visible detail exactly; its background and props are not part of the result."
        "Key details of image 2 (the picture wins if it differs): $details"
        $(if ($SafeArt) { 'The figure on the product is a flat printed illustration that belongs to the sign artwork, not a real person: no real person is shown, added or edited; only the product is placed into image 1.' } else { '' })
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
    $signText = Get-AgentItemSignText $entry
    $needsSign = (Test-ContextLettered $context) -and -not $signText -and (Test-ExactSignRun)
    # The full prompt (prompt_file, same builder as Codex) carries the same exact wording.
    if ($signText -and $script:Config.ActiveScene) { $script:Config.ActiveScene | Add-Member sign_text $signText -Force }
    $folder = Join-Path $script:Batch.Refs $entry.id
    if (Test-Path -LiteralPath (Join-Path $folder 'manifest.json')) {
        # Already archived: use the archived copies (01 = review photo, 02 = product).
        $review = @(Get-ChildItem -LiteralPath $folder -Filter '01-*' | Select-Object -First 1)[0].FullName
        $product = @(Get-ChildItem -LiteralPath $folder -Filter '02-*' | Select-Object -First 1)[0].FullName
        $request = New-ProductImageRequest $product $entry.id $context $review 'flow'
        $request.Images = @($review, $product)
    } else {
        $reviewPhoto = Get-ReviewPhoto $entry.id $context
        $request = New-ProductImageRequest $entry.product_image $entry.id $context $reviewPhoto 'flow'
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
    if ($needsSign) {
        # Exact-wording run: no prompt until the agent has chosen this item's wording (never a silent fall-back to Flow's own wording).
        $brief = Get-AgentSignBrief $entry $context ([ordered]@{ review_photo = $request.Images[0]; product_photo = $request.Images[1] })
        $out = [ordered]@{ ok = $false; error = "Item $($entry.id) is a lettered product without sign_text: look at review_photo and product_photo, choose the wording, run set_command, then run flow-brief again."; cause = 'NEEDS_SIGN_TEXT'; needs_sign_text = $true }
        foreach ($k in $brief.Keys) { $out[$k] = $brief[$k] }
        Stop-AgentWith $out
    }
    $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 register-image -Run $($script:Batch.Id) -Item $($entry.id) -From <downloaded file>"
    if ($signText) { $cmd += ' -SignRead "<what the sign in the image reads, '' | '' between lines>"' }
    $out = [ordered]@{ ok = $true; run = $script:Batch.Id; item = $entry.id; prompt_file = $promptFile; condensed_prompt = (Get-CondensedFlowPrompt $context $signText ([bool]$Safe) "$($script:Batch.Id)-$($entry.id)"); safe = [bool]$Safe; logo_mode = $(if ($context.PSObject.Properties['custom_logo'] -and $context.custom_logo -eq $true) { if ($Safe) { 'neutral (after a refusal)' } else { 'replace with a fictional symbol' } } else { 'none' })
        aspect = $(if (-not $context.presentation -or $context.presentation -eq 'worn') { (Get-WornVariation "$($script:Batch.Id)-$($entry.id)").aspect } else { Get-FlowAspect $request.Images[0] }); uploads = $uploads; register_command = $cmd }
    if ($signText) { $out.sign_text = $signText }
    Write-AgentJson $out
}

# --- 4. register-image -----------------------------------------------------------------------------------------
function Invoke-AgentRegisterImage {
    Open-AgentRun $Run
    $entry = Get-AgentItem $Item
    if (-not $From -or -not (Test-Path -LiteralPath $From -PathType Leaf)) { throw "-From file not found: $From" }
    $id = $entry.id
    $output = Join-Path $script:Batch.Images "$id.png"
    $statusPath = Join-Path $script:Batch.Logs "$id-review-status.json"
    $signCheck = Test-AgentSignRead $entry
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
    $status = [ordered]@{ status = 'awaiting_user_review'; ai_image_qa_performed = $false; generation_attempt = $attempt; output = $output; engine = $(if ($env:PR_AGENT_ENGINE -eq 'antigravity' -or $From -match '[\\/]\.gemini[\\/]') { 'antigravity' } else { 'claude-flow' }) }
    if ($signCheck) { $status.sign_check = $signCheck }
    [IO.File]::WriteAllText($statusPath, ($status | ConvertTo-Json), $script:Utf8)
    $duplicates = @(Get-ChildItem -LiteralPath $script:Batch.Images -Filter '*.png' | Where-Object { $_.FullName -ne $output -and (Get-BytesHash ([IO.File]::ReadAllBytes($_.FullName))) -eq $hash } | ForEach-Object { $_.BaseName })
    $info = Get-ImageSize $bytes
    $out = [ordered]@{ ok = $true; run = $script:Batch.Id; item = $id; image = $output; size = [ordered]@{ width = $info.Width; height = $info.Height; bytes = $bytes.Length }; sparkle = $sparkle; sha256 = $hash }
    if ($duplicates.Count) { $out.warning = "Same image hash as: $($duplicates -join ', ')"; $out.duplicate_of = $duplicates }
    if ($signCheck) { $out.sign_check = $signCheck }
    Write-AgentJson $out
}

# SIGN CHECK before an image of a lettered item is registered: the agent LOOKS at the image and passes -SignRead (what the sign reads);
# it must equal sign_text (case / spacing / punctuation tolerant). A first mismatch is not registered: redo the image once;
# a second mismatch is registered anyway with sign_check.kept_anyway (the reviewer decides in Duyệt).
# Returns $null when there is nothing to check (no sign_text, or a run created before exact wording without -SignRead).
function Test-AgentSignRead($Entry) {
    $id = $Entry.id
    $expected = Get-AgentItemSignText $Entry
    $exact = Test-ExactSignRun
    if (-not $expected) {
        if ($exact -and (Test-ContextLettered (Get-AgentContextOrNull $id))) { throw "[CAUSE:NEEDS_SIGN_TEXT] Item $id is lettered but has no sign_text: choose it with set-sign-text, then flow-brief again (the image must come from that prompt)." }
        return $null
    }
    if (-not $SignRead) {
        if ($exact) { throw "[CAUSE:SIGN_READ_MISSING] Look at the image and pass -SignRead ""<what the sign reads, ' | ' between lines>"" (expected: $expected)." }
        return $null
    }
    $path = Join-Path $script:Batch.Logs "$id-sign-check.json"
    $state = if (Test-Path -LiteralPath $path) { try { Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } } else { $null }
    $misses = if ($state -and $state.misses) { [int]$state.misses } else { 0 }
    $tries = @(if ($state -and $state.tries) { $state.tries })
    $ok = (ConvertTo-SignCompareText $SignRead) -eq (ConvertTo-SignCompareText $expected)
    $tries += [pscustomobject]@{ read = $SignRead; ok = $ok; at = (Get-Date).ToString('s') }
    if (-not $ok) {
        $misses++
        if (Test-Path -LiteralPath $From) { Copy-Item -LiteralPath $From -Destination (Join-Path $script:Batch.Logs "$id-sign-miss-$misses$([IO.Path]::GetExtension($From))") -Force }
    }
    [IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject ([ordered]@{ expected = $expected; misses = $misses; tries = $tries }) -Depth 4), $script:Utf8)
    if ($ok) {
        # A match after an earlier final mismatch clears that error.
        $err = Join-Path $script:Batch.Logs "$id-agent-error.txt"
        if ((Test-Path -LiteralPath $err) -and (Get-Content -LiteralPath $err -Raw -Encoding UTF8) -match '^\[CAUSE:SIGN_TEXT\]') { Remove-Item -LiteralPath $err -Force }
        return [ordered]@{ expected = $expected; read = $SignRead; ok = $true; misses = $misses }
    }
    # User 2026-11-23: ONE redo; if the redo is still wrong, keep the image anyway (registered, flagged sign_mismatch so the
    # reviewer sees it in Duyệt) and go on. Never an error that drops the item.
    if ($misses -le 1) {
        Stop-AgentWith ([ordered]@{ ok = $false; error = "The sign reads '$SignRead' but sign_text is '$expected'. Not registered. Redo this item ONCE with the same condensed_prompt, then register-image again with -SignRead (if it is still wrong then, it is kept anyway)."; cause = 'SIGN_TEXT_MISMATCH'; item = $id; expected = $expected; read = $SignRead; redo = $true; redos_left = 1 })
    }
    return [ordered]@{ expected = $expected; read = $SignRead; ok = $false; misses = $misses; kept_anyway = $true; note = "sign_mismatch: reads '$SignRead' instead of '$expected' after $misses tries; kept for review" }
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
        'sign-brief' { Invoke-AgentSignBrief }
        'set-sign-text' { Invoke-AgentSetSignText }
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
        default { throw "Unknown command '$Command'. Use: prepare | context-brief | context | sign-brief | set-sign-text | flow-brief | register-image | review-brief | write-review | finish | run-summary" }
    }
} catch {
    Fail-Agent $_.Exception.Message
}
