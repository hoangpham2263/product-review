# Batch pipeline: one product URL per line in urls.txt. Each run creates a timestamped batch.
# For every URL: load product, take the review photo the user attached, create one photo, write a review.
# URLs are processed in parallel (-ThrottleLimit); results are committed one by one in the main thread.
param(
    [Alias('UrlList')][string]$List = (Join-Path (Split-Path $PSScriptRoot -Parent) 'workspace/urls.txt'),
    [Alias('InputDir')][string]$SourceDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'workspace/source-photos'),
    [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'workspace/output'),
    # Ignored: one attached review photo per image. Kept so older callers still start.
    [Alias('ReferencePhotosPerImage')][int]$PhotosPerImage = 1,
    [ValidateRange(1, 4)][int]$ThrottleLimit = 2,
    [string]$Model = '',
    [string]$ReferenceMapFile = '',
    [switch]$LocalOnly,
    # Review-only run: no image step (no Codex/Flow image call, no Codex image warm-up, no upload to the results repo);
    # each item's review is written from its attached ORIGINAL review photo.
    [switch]$ReviewOnly,
    # codex: Codex CLI (Claude (Flow) runs through agent mode, not here).
    [ValidateSet('codex')][string]$ImageBackend = $(if ($env:PIB_IMAGE_BACKEND) { $env:PIB_IMAGE_BACKEND } else { 'codex' }),
    # Every text step (product, checks, review): codex: Codex CLI;
    # antigravity: the Antigravity CLI (agy), signed in with Google.
    # claude: the Claude Code CLI (claude -p), signed in with Claude; only reads the review photos.
    [ValidateSet('codex', 'antigravity')][string]$TextBackend = 'codex'
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $OutputEncoding
[Console]::OutputEncoding = $OutputEncoding
if ($ThrottleLimit -lt 1) { throw 'ThrottleLimit must be positive.' }
foreach ($variableName in @('List', 'SourceDir', 'OutDir')) {
    Set-Variable $variableName ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Get-Variable $variableName -ValueOnly)))
}

$ProjectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'bootstrap.ps1')
# Model AI from Cấu hình, unless -Model is given.
$ai = Get-AiSettings $ProjectRoot
if (-not $Model) { $Model = $ai.model }
$script:Config = New-WorkflowConfiguration $ProjectRoot $SourceDir $Model
$script:Config.ReasoningEffort = $ai.effort
$script:Config.ResultsRequired = -not ($LocalOnly -or $ReviewOnly)
if($LocalOnly -or $ReviewOnly){$script:Config.Results=$null}
$script:Config.ReviewOnly = [bool]$ReviewOnly
if($script:Config.ResultsRequired){
    try{Assert-ResultStoreReady}
    catch{Write-Warning ("Failed; "+$_.Exception.Message);throw}
}
$script:Config.ImageBackend = $ImageBackend
$script:Config.TextBackend = $TextBackend
if($ReferenceMapFile){$script:Config.ManualReferences=Read-ManualReferenceMap $ReferenceMapFile}
# What each step runs on; the Codex model only matters where Codex is used.
$name = { param($Id) if ($Id -eq 'codex') { "Codex ($(Get-AiModelSummary $ProjectRoot))" } else { (Get-HubAIProvider $Id).Name } }
$imageLabel = if ($ReviewOnly) { 'không (chỉ viết review, dùng ảnh review gốc)' } else { & $name $ImageBackend }
Write-Host "Viết review: $(& $name $TextBackend) | Tạo ảnh: $imageLabel"
try {
    Invoke-BatchWorkflow $ProjectRoot $List $OutDir $ThrottleLimit $script:WorkflowModuleFiles
} catch {
    throw
}
