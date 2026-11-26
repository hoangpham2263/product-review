# Quét web: Claude finds the menu, the products and their main image on a shop website (Playwright MCP); these commands do only
# the mechanical parts: the scan folder, downloading and checking each image, and the products.csv that Nhập hàng loạt reads.
# A shop is a PROJECT (workspace/projects/<id>/, id = the site host, e.g. dreamyvows-com): scanned once, later scans only MERGE new
# products into it (nothing is deleted, `used` and the review numbers are kept).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File src/scan.ps1 <command> [-Site url] [-Max n] [-Run id] [-Project id]
#        [-Url u] [-Title t] [-Collection c] [-CollectionUrl u] [-ImageUrl u | -ImageFile f] [-File items.json]
#        [-Count n] [-Rating x] [-Source s] [-Used T|F] [-Limit n] [-Group g] [-Category c] [-SceneNames a.jpg,b.jpg] [-SceneCount n] [-UnusedOnly] [-AllowReuse] [-Prefetch]
# Every command prints exactly one JSON line: {"ok":true,...} or {"ok":false,"error":"...","cause":"..."} (exit 1).
# Scan: start (finds or creates the project), known, add, add-many, set-menu, status, finish. -Scan is the old name of -Project.
# Projects: projects, project, set-used. Review numbers: reviews-todo (links to read), set-reviews (stores the number Claude read on a
# page; nothing here reads or parses a page). Files and the `used` flag: src/application/scan-store.ps1.
# Thêm vào hàng chờ (docs/queue-prompt.md): queue-todo (products to queue), scenes (the photo library), scene-get (a library photo on disk),
# queue-add (link into urls.txt + product photo + 2 scene photos into references.json). Chuẩn bị trước (docs/prep-prompt.md): prep-todo, prep-add, prep-status store the scene
# picks of each product in workspace/projects/<id>/prepared.csv in advance (no queue write); queue-from-prepared takes ready rows into the queue instantly, no agent. Nothing here picks a scene: Claude does. The CLI only CHECKS and
# INFORMS with a perceptual hash (src/infrastructure/image-phash.ps1): scenes shows used_count / dup_of, queue-add rejects SCENE_DUPLICATE (two scenes of
# one product look the same) and SCENE_REUSED (a scene already used by another product in the queue or the last 5 runs; -AllowReuse overrides).
# Speed (few images per decision): scene-index-status | scene-index-todo | scene-index-add keep a tag index of the library (workspace/source-photos/scene-index.json,
# tags written by Claude once per photo from a contact sheet); scene-candidates lists unused, non-duplicate indexed scenes for a product type with
# numbered contact sheets; contact-sheet tiles any photos; prep-todo / queue-todo -Grouped [-Sheet] list products by kind with one product sheet per group.
param(
    [Parameter(Position = 0)][string]$Command = '',
    [string]$Site = '', [int]$Max = 20, [string]$Run = '', [string]$Scan = '', [string]$Project = '', [string]$Id = '',
    [string]$Url = '', [string]$Title = '', [string]$Collection = '', [string]$CollectionUrl = '', [string]$ImageUrl = '', [string]$ImageFile = '', [string]$File = '',
    [int]$Count = -1, [string]$Rating = '', [string]$Source = '', [string]$Used = '', [int]$Limit = 0,
    [string]$Group = '', [string]$Category = '', [string]$SceneNames = '', [int]$SceneCount = 0, [switch]$UnusedOnly, [switch]$AllowReuse, [switch]$Prefetch, [switch]$Skip, [string]$Reason = '', [switch]$TopUp, [switch]$RetrySkipped,
    [string]$Shard = '', [string]$OnlyFile = '', [switch]$DryRun, [string]$Fits = '', [string]$Seed = '', [string]$Mode = '', [int]$Draw = 1, [string]$Setting = '', [int]$Cols = 4, [string]$Out = '', [switch]$Grouped, [switch]$Sheet, [string]$Files = '', [string]$Names = '',
    [Parameter(ValueFromRemainingArguments = $true)]$Rest
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $OutputEncoding
[Console]::OutputEncoding = $OutputEncoding
$ProjectRoot = Split-Path $PSScriptRoot -Parent
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

function Write-ScanJson($Value) {
    if ($Value -is [Collections.IDictionary] -and -not $Value.Contains('ok')) {
        if ($Value -is [Collections.Specialized.OrderedDictionary]) { $Value.Insert(0, 'ok', $true) } else { $Value['ok'] = $true }
    }
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 8
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}
function Fail-Scan([string]$Message, [string]$Cause = '') {
    Write-ScanJson ([ordered]@{ ok = $false; error = $Message; cause = $Cause })
    exit 1
}

. (Join-Path $PSScriptRoot 'application/workspace.ps1')
. (Join-Path $PSScriptRoot 'application/scan-store.ps1')
$ScanRoot = if ($env:PR_SCAN_OUT) { $env:PR_SCAN_OUT } else { Get-ProjectsRoot $ProjectRoot }
$MaxImageBytes = 25MB
# The project every command works on: -Project, else the old -Scan, else -Id.
$ProjectId = if ($Project) { $Project } elseif ($Scan) { $Scan } else { $Id }

function Get-ScanDir([string]$Name) {
    $dir = Get-ProjectDir $ScanRoot $Name
    if (-not $dir) { Fail-Scan "Project not found: '$Name'. Use -Project <id> (start prints it; the projects command lists them)." 'BAD_PROJECT' }
    return $dir
}
function Get-SiteHost([string]$Value) { return (Get-ProjectSiteHost $Value) }

# The state of the current scan of a project (session.json): which links were seen or added, so a merge can report what is new.
function Read-ScanSession([string]$Dir) {
    $session = [ordered]@{ run = ''; started = ''; max = 20; added = [ordered]@{}; seen = (New-Object System.Collections.Generic.List[string]); duplicates = 0 }
    $saved = Read-ProjectJson (Join-Path $Dir 'session.json') $null
    if ($saved) {
        foreach ($name in 'run', 'started') { if ($saved.PSObject.Properties[$name]) { $session[$name] = [string]$saved.$name } }
        if ($saved.PSObject.Properties['max']) { $session.max = [int]$saved.max }
        if ($saved.PSObject.Properties['duplicates']) { $session.duplicates = [int]$saved.duplicates }
        if ($saved.PSObject.Properties['added'] -and $saved.added) { foreach ($p in $saved.added.PSObject.Properties) { $session.added[$p.Name] = [int]$p.Value } }
        if ($saved.PSObject.Properties['seen']) { foreach ($s in @($saved.seen)) { if ($s) { $session.seen.Add([string]$s) } } }
    }
    return $session
}
function Save-ScanSession([string]$Dir, $Session) { Write-ProjectJson (Join-Path $Dir 'session.json') $Session }
function Get-Slug([string]$Value, [int]$Length = 40) {
    $s = ([string]$Value).ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    $s = $s.Trim('-')
    if ($s.Length -gt $Length) { $s = $s.Substring(0, $Length).Trim('-') }
    if ($s) { $s } else { 'product' }
}

# 'jpg' / 'png', or '' for anything else (WebP, AVIF, HTML error page...).
function Get-ImageKind([byte[]]$Bytes) {
    if ($Bytes.Length -ge 4 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xD8 -and $Bytes[2] -eq 0xFF) { return 'jpg' }
    if ($Bytes.Length -ge 8 -and $Bytes[0] -eq 0x89 -and $Bytes[1] -eq 0x50 -and $Bytes[2] -eq 0x4E -and $Bytes[3] -eq 0x47 -and $Bytes[4] -eq 0x0D -and $Bytes[5] -eq 0x0A -and $Bytes[6] -eq 0x1A -and $Bytes[7] -eq 0x0A) { return 'png' }
    return ''
}

function Get-RemoteBytes([string]$Address, [string]$Referer) {
    $temp = [IO.Path]::GetTempFileName()
    try {
        $headers = @{ Accept = 'image/jpeg,image/png,image/*;q=0.8'; Referer = $Referer }
        Invoke-WebRequest -Uri $Address -OutFile $temp -UseBasicParsing -TimeoutSec 40 -Headers $headers -UserAgent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' | Out-Null
        return , ([IO.File]::ReadAllBytes($temp))
    } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}

# Other ways to ask the same server for a JPG when it hands out WebP/AVIF (Shopify and similar CDNs: format=jpg, a .jpg name).
function Get-JpgAlternatives([string]$Address) {
    $list = New-Object System.Collections.Generic.List[string]
    $uri = $null
    if (-not [Uri]::TryCreate($Address, [UriKind]::Absolute, [ref]$uri)) { return @() }
    $query = $uri.Query.TrimStart('?')
    $pairs = @(if ($query) { $query -split '&' | Where-Object { $_ -and $_ -notmatch '^(format|fm)=' } } else { @() })
    $withFormat = ($pairs + 'format=jpg') -join '&'
    $list.Add($uri.GetLeftPart([UriPartial]::Path) + '?' + $withFormat)
    if ($uri.AbsolutePath -match '\.(webp|avif)$') {
        $path = $uri.AbsolutePath -replace '\.(webp|avif)$', '.jpg'
        $list.Add($uri.GetLeftPart([UriPartial]::Authority) + $path + $(if ($query) { '?' + $query } else { '' }))
    }
    return $list.ToArray()
}

# Image bytes for a product: a file Claude saved, or a download (with the JPG alternatives when the first answer is not JPG/PNG).
function Get-ProductImage([string]$Address, [string]$LocalFile, [string]$Referer) {
    if ($LocalFile) {
        if (-not (Test-Path -LiteralPath $LocalFile -PathType Leaf)) { throw '[CAUSE:IMAGE_MISSING] Image file not found: ' + $LocalFile }
        $bytes = [IO.File]::ReadAllBytes($LocalFile)
        if ((Get-ImageKind $bytes) -eq '') { throw '[CAUSE:NEEDS_PNG] The file is not a JPG or PNG. Take a screenshot of the product image element to a .png file and pass it with -ImageFile.' }
        return , $bytes
    }
    if ($Address.StartsWith('//')) { $Address = 'https:' + $Address }
    $uri = $null
    if (-not [Uri]::TryCreate($Address, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https')) { throw '[CAUSE:IMAGE_URL] ImageUrl must be an absolute http(s) link.' }
    $tries = @($Address) + @(Get-JpgAlternatives $Address)
    $last = ''
    foreach ($try in $tries) {
        try {
            $bytes = Get-RemoteBytes $try $Referer
            if ($bytes.Length -gt $MaxImageBytes) { $last = 'larger than 25 MB'; continue }
            if ((Get-ImageKind $bytes) -ne '') { return , $bytes }
            $last = 'not a JPG or PNG (WebP/AVIF?)'
        } catch { $last = $_.Exception.Message }
    }
    throw "[CAUSE:NEEDS_PNG] Could not get a JPG/PNG from this link ($last). Take a screenshot of the product image element to a .png file and pass it with -ImageFile."
}

# Adds one product to the project; returns the result object (never exits, so add-many can go on after a failure).
# Merge rules: a link already in the table is `duplicate` (kept as it is: used and review numbers stay); `collection_full` counts only the
# products ADDED in this scan for that category ($Session.max), so a later scan can still reach the new ones behind the known ones.
function Add-ScanProduct([string]$Dir, $Info, $Session, [string]$ProductUrl, [string]$ProductTitle, [string]$ProductCollection, [string]$ProductCollectionUrl, [string]$Address, [string]$LocalFile) {
    $result = [ordered]@{ url = $ProductUrl; status = ''; collection = $ProductCollection }
    $productHost = Get-SiteHost $ProductUrl
    if (-not $productHost) { $result.status = 'failed'; $result.cause = 'BAD_URL'; $result.error = 'The product link must be an absolute http(s) link.'; return $result }
    if ($productHost -ne $Info.host -and -not $productHost.EndsWith('.' + $Info.host)) { $result.status = 'failed'; $result.cause = 'OTHER_SITE'; $result.error = "The link is not on $($Info.host)."; return $result }
    if (-not $ProductCollection) { $ProductCollection = 'Khác'; $result.collection = $ProductCollection }
    $csv = Join-Path $Dir 'products.csv'
    $rows = @(Read-ScanRows $csv)
    $key = Get-ScanUrlKey $ProductUrl
    if (-not $Session.seen.Contains($key)) { $Session.seen.Add($key) }
    Update-ProjectMenu $Dir $ProductCollection $ProductCollectionUrl
    if (@($rows | Where-Object { (Get-ScanUrlKey $_.product_url) -eq $key }).Count) { $Session.duplicates++; $result.status = 'duplicate'; return $result }
    $addedHere = if ($Session.added.Contains($ProductCollection)) { [int]$Session.added[$ProductCollection] } else { 0 }
    if ($addedHere -ge $Session.max) { $result.status = 'collection_full'; $result.added_in_collection = $addedHere; $result.max_per_collection = $Session.max; return $result }
    try { $bytes = Get-ProductImage $Address $LocalFile $Info.site } catch {
        $message = $_.Exception.Message
        $result.status = 'failed'; $result.cause = $(if ($message -match '\[CAUSE:([A-Z_]+)\]') { $Matches[1] } else { 'IMAGE_FAILED' })
        $result.error = ($message -replace '\s*\[CAUSE:[A-Z_]+\]\s*', ' ').Trim()
        return $result
    }
    # Write the row under the project lock on a FRESH read of the table (another session may have changed it while the image downloaded).
    $added = Use-ProjectLock $Dir {
        $fresh = @(Read-ScanRows $csv)
        if (@($fresh | Where-Object { (Get-ScanUrlKey $_.product_url) -eq $key }).Count) { return $null }
        $number = $fresh.Count + 1
        $slugSource = if ($ProductTitle) { $ProductTitle } else { ([Uri]$ProductUrl).Segments[-1] }
        $name = '{0:D3}-{1}.{2}' -f $number, (Get-Slug $slugSource), (Get-ImageKind $bytes)
        New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'images') | Out-Null
        Write-BytesAtomic (Join-Path (Join-Path $Dir 'images') $name) $bytes
        $row = [pscustomobject]@{ product_url = $ProductUrl.Trim(); product_image = $name; review_images = ''; sign_text = ''; title = $ProductTitle; collection = $ProductCollection; used = 'F'; reviews_count = ''; reviews_checked_at = '' }
        Write-ScanRows $csv (@($fresh) + @($row))
        return $name
    }
    if (-not $added) { $Session.duplicates++; $result.status = 'duplicate'; return $result }
    $name = $added
    $Session.added[$ProductCollection] = $addedHere + 1
    $result.status = 'added'; $result.image = $name; $result.added_in_collection = $addedHere + 1
    return $result
}

# Same shape as before (`scan` = the project id) plus the project fields and this scan's merge numbers.
function Get-ScanSummary([string]$Dir, $Info, $Session) {
    $summary = Get-ProjectSummary $Dir
    $rows = @(Read-ScanRows (Join-Path $Dir 'products.csv'))
    $missing = @($rows | Where-Object { -not (Test-Path -LiteralPath (Join-Path (Join-Path $Dir 'images') $_.product_image)) } | ForEach-Object { $_.product_url })
    $added = 0; foreach ($k in @($Session.added.Keys)) { $added += [int]$Session.added[$k] }
    $summary['scan'] = $summary.id
    $summary['rows'] = $summary.products
    $summary['missing_images'] = $missing
    $summary['merge'] = [ordered]@{
        added = $added; added_per_collection = $Session.added; already_known = [int]$Session.duplicates
        seen = $Session.seen.Count
        not_seen_this_scan = @($rows | Where-Object { $Session.seen -notcontains (Get-ScanUrlKey $_.product_url) }).Count
    }
    return $summary
}

# ---- Thêm vào hàng chờ: the run queue (workspace/urls.txt + workspace/reference-inputs/references.json) ----
$QueueMapPath = Join-Path (Get-SessionWorkspaceDir $ProjectRoot) 'reference-inputs/references.json'
$QueueUrlsPath = Join-Path (Get-SessionWorkspaceDir $ProjectRoot) 'urls.txt'
# The photo library cache is shared by every session (literal workspace/); PR_LIBRARY_DIR points a throwaway test at its own copy.
$LibraryDir = if ($env:PR_LIBRARY_DIR) { [IO.Path]::GetFullPath($env:PR_LIBRARY_DIR) } else { Join-Path $ProjectRoot 'workspace/source-photos' }
# Dot-sourcing inside a function defines the functions only in that function's scope (they vanish when it returns), so the libraries are
# loaded here, at script level, for the queue commands. Import-QueueLibs stays as a no-op for the existing callers.
if ($Command -in @('scenes', 'scene-get', 'queue-add', 'queue-direct', 'queue-todo', 'prep-todo', 'prep-add', 'prep-status', 'queue-from-prepared', 'scene-index-status', 'scene-index-todo', 'scene-index-add', 'scene-candidates', 'scene-apply', 'scene-auto', 'prep-add-many', 'queue-add-many', 'contact-sheet')) {
    . (Join-Path $PSScriptRoot 'application/image-feedback.ps1')
    . (Join-Path $PSScriptRoot 'infrastructure/source-catalog.ps1')
    . (Join-Path $PSScriptRoot 'infrastructure/source-sync.ps1')
    . (Join-Path $PSScriptRoot 'application/manual-references.ps1')
    . (Join-Path $PSScriptRoot 'infrastructure/image-phash.ps1')
}
if ($Command -in @('queue-todo', 'prep-todo', 'scene-index-todo', 'scene-candidates', 'contact-sheet')) { . (Join-Path $PSScriptRoot 'infrastructure/contact-sheet.ps1') }
function Import-QueueLibs { }
# The links already waiting (urls.txt) or already holding images (references.json), as url keys.
function Get-QueuedKeys {
    $keys = New-Object System.Collections.Generic.HashSet[string]
    if (Test-Path -LiteralPath $QueueUrlsPath) {
        foreach ($line in @(Get-Content -LiteralPath $QueueUrlsPath -Encoding UTF8)) { $t = $line.Trim().TrimStart([char]0xFEFF); if ($t -and -not $t.StartsWith('#')) { [void]$keys.Add((Get-ScanUrlKey $t)) } }
    }
    if (Test-Path -LiteralPath $QueueMapPath) {
        $saved = Get-Content -LiteralPath $QueueMapPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($entry in @($saved.entries)) { if ($entry.product_url) { [void]$keys.Add((Get-ScanUrlKey ([string]$entry.product_url))) } }
    }
    return , $keys
}
# PR_SCAN_TRACE=1: timing lines on stderr (where a slow command spends its time).
$script:TraceClock = [Diagnostics.Stopwatch]::StartNew()
function Write-ScanTrace([string]$Text) { if ($env:PR_SCAN_TRACE -eq '1') { [Console]::Error.WriteLine(('[trace] {0,7:N1}s   {1}' -f $script:TraceClock.Elapsed.TotalSeconds, $Text)) } }
# One library group's photos: { name, md5, category, kind, sha256, local } (category from catalog.json, fetched once into workspace/source-photos).
function Get-LibraryPhotos([string]$LibraryGroup) {
    Write-ScanTrace "Get-LibraryPhotos $LibraryGroup begins"
    Import-QueueLibs
    $catalogPath = Join-Path $LibraryDir 'catalog.json'
    if (-not (Test-Path -LiteralPath $catalogPath)) { Update-SourceCatalog $LibraryDir }
    $byFile = @{}
    if (Test-Path -LiteralPath $catalogPath) {
        $catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($photo in @($catalog.photos)) { $byFile[([string]$photo.file).Normalize([Text.NormalizationForm]::FormC)] = $photo }
    }
    $prefix = $LibraryGroup.Normalize([Text.NormalizationForm]::FormC)
    return @(Get-SourceGroupFiles $LibraryDir $LibraryGroup | ForEach-Object {
            $info = $byFile["$prefix/$($_.name)"]
            [pscustomobject]@{ name = $_.name; md5 = $_.md5; category = $(if ($info) { [string]$info.category } else { '' }); kind = $(if ($info -and $info.PSObject.Properties['source_kind']) { [string]$info.source_kind } else { '' }); sha256 = $(if ($info) { [string]$info.sha256 } else { '' }); local = $_.local }
        })
}
function Get-FileHashText([string]$Path, [string]$Algorithm) { return (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash.ToLowerInvariant() }
# A library photo on this machine (downloaded only when missing), md5 checked against the manifest.
function Get-LibraryPhotoFile([string]$LibraryGroup, $Photo) {
    if ($Photo.local -and (Test-Path -LiteralPath $Photo.local)) { return [string]$Photo.local }
    $paths = @(Save-SourceGroupFiles $LibraryDir $LibraryGroup @([pscustomobject]@{ name = $Photo.name; md5 = $Photo.md5 }))
    if (-not $paths.Count -or -not (Test-Path -LiteralPath $paths[0])) { throw "[CAUSE:SCENE_DOWNLOAD] Could not download $($Photo.name)." }
    if ((Get-FileHashText $paths[0] 'MD5') -ne ([string]$Photo.md5).ToLowerInvariant()) { throw "[CAUSE:SCENE_HASH] $($Photo.name) does not match the library manifest (md5)." }
    try { $Photo.local = [string]$paths[0] } catch { }  # cached photo objects learn the new local path
    return [string]$paths[0]
}

# ---- Scene checks (perceptual hash): the same picture re-saved / resized has a distance of 0-6 of 256 bits, different photos 99+ ----
$SceneSameDistance = 20
$OutputDir = Join-Path (Get-SessionWorkspaceDir $ProjectRoot) 'output'
# Hash of a library photo (cached by name + md5); '' when it is not on this machine yet.
function Get-LibraryPhotoHash([string]$LibraryGroup, $Photo) {
    if (-not $Photo.local -or -not (Test-Path -LiteralPath $Photo.local)) { return '' }
    return (Get-PHash ([string]$Photo.local) ("lib:$LibraryGroup/$($Photo.name):$($Photo.md5)"))
}
# Every scene already used: { hash, url, where } from the entries of the queue (references.json) and the refs of the last 5 output runs.
$script:UsedScenesCache = $null
function Get-UsedScenes {
    if ($null -ne $script:UsedScenesCache) { return $script:UsedScenesCache }
    Write-ScanTrace 'Get-UsedScenes begins'
    $used = New-Object Collections.Generic.List[object]
    if (Test-Path -LiteralPath $QueueMapPath) {
        $saved = Get-Content -LiteralPath $QueueMapPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($entry in @($saved.entries)) {
            foreach ($scene in @(Get-ManualScenes $entry)) {
                $hash = Get-PHash ([string]$scene.file)
                if ($hash) { $used.Add([pscustomobject]@{ hash = $hash; url = [string]$entry.product_url; where = 'queue' }) }
            }
        }
    }
    if (Test-Path -LiteralPath $OutputDir) {
        $runs = @(Get-ChildItem -LiteralPath $OutputDir -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'refs') } | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
        foreach ($run in $runs) {
            foreach ($bundle in @(Get-ChildItem -LiteralPath (Join-Path $run.FullName 'refs') -Directory)) {
                $manifestPath = Join-Path $bundle.FullName 'manifest.json'
                $sceneFile = @(Get-ChildItem -LiteralPath $bundle.FullName -File -Filter '01-*' | Select-Object -First 1)
                if (-not $sceneFile.Count -or -not (Test-Path -LiteralPath $manifestPath)) { continue }
                $bundleUrl = try { [string](Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).product_url } catch { '' }
                $hash = Get-PHash $sceneFile[0].FullName
                if ($hash) { $used.Add([pscustomobject]@{ hash = $hash; url = $bundleUrl; where = "run $($run.Name)" }) }
            }
        }
    }
    # Scenes already picked in advance (prepared.csv, status ready, every project): another product must not take them either.
    Write-ScanTrace ('used scenes from queue + last runs: ' + $used.Count)
    foreach ($pr in @(Get-PreparedUsedScenes)) { $used.Add($pr) }
    Write-ScanTrace ('used scenes incl. prepared of every project: ' + $used.Count)
    $script:UsedScenesCache = $used.ToArray()
    return $script:UsedScenesCache
}
# The used scenes that look like $Hash, optionally not counting the ones of product $ExceptUrl.
function Find-UsedScenes([string]$Hash, [string]$ExceptUrl = '') {
    if (-not $Hash) { return @() }
    $exceptKey = if ($ExceptUrl) { Get-ScanUrlKey $ExceptUrl } else { '' }
    return @(Get-UsedScenes | Where-Object { (-not $exceptKey -or -not $_.url -or (Get-ScanUrlKey $_.url) -ne $exceptKey) -and (Get-PHashDistance $Hash $_.hash) -le $SceneSameDistance })
}

# Writes the queue entry (references.json) and the urls.txt line of one product: its project photo plus $Picked scenes (may be none). Same code for
# queue-add (Claude's scenes) and queue-direct (no scenes). Never called for a link already queued.
function Add-QueueEntry([string]$Dir, $Row, $Picked) {
    $productFile = Join-Path (Join-Path $Dir 'images') $Row.product_image
    $productSha = Get-FileHashText $productFile 'SHA256'
    # references.json and urls.txt change together under the queue mutex, so a running batch (Remove-FromQueue) or the app can write meanwhile
    # without losing this entry.
    [void](Use-QueueMutex (Get-SessionWorkspaceDir $ProjectRoot) {
        $queueMap = Read-ManualReferenceMap $QueueMapPath
        $queueEntry = [pscustomobject]@{ product_url = $Row.product_url; origin = 'user_reference' }
        Set-ManualProducts $queueEntry @([pscustomobject]@{ file = $productFile; sha256 = $productSha; scenes = @($Picked) })
        Save-ManualMapEntry $QueueMapPath $queueMap $queueEntry
        $existingText = if (Test-Path -LiteralPath $QueueUrlsPath) { [IO.File]::ReadAllText($QueueUrlsPath) } else { '' }
        $lead = if ($existingText -and -not $existingText.EndsWith("`n")) { "`r`n" } else { '' }
        [IO.File]::AppendAllText($QueueUrlsPath, $lead + $Row.product_url + "`r`n", [Text.UTF8Encoding]::new($false))
        $true
    })
    return $productFile
}

# ---- Chuẩn bị trước: prepared.csv (workspace/projects/<id>/, shared by every session) ----
# product_url, group, scenes (names joined by |), scene_sha256 (joined by |), scene_count, prepared_at, status (ready | skipped:no-fit | consumed), consumed_at, consumed_by
$PreparedColumns = @('product_url', 'group', 'scenes', 'scene_sha256', 'scene_count', 'prepared_at', 'status', 'consumed_at', 'consumed_by')
function Get-PreparedFile([string]$Dir) { return (Join-Path $Dir 'prepared.csv') }
function Read-PreparedRows([string]$Dir) { return @(Read-ScanRows (Get-PreparedFile $Dir)) }
function Write-PreparedRows([string]$Dir, $Rows) {
    $path = Get-PreparedFile $Dir
    $out = New-Object System.Collections.Generic.List[string]
    $out.Add($PreparedColumns -join ',')
    foreach ($row in @($Rows)) { $out.Add((@($PreparedColumns | ForEach-Object { $p = $row.PSObject.Properties[$_]; ConvertTo-ScanCell $(if ($p) { [string]$p.Value } else { '' }) }) -join ',')) }
    Write-FileAtomic $path (($out -join "`r`n") + "`r`n") ([Text.UTF8Encoding]::new($true))
}
# Use-FileLock / Write-FileAtomic come from core/setup/atomic-file.ps1 (loaded by scan-store.ps1): prepared.csv is a read-modify-write under its own lock.
function Use-PreparedLock([string]$Dir, [scriptblock]$Body) { return (Use-FileLock ((Get-PreparedFile $Dir) + '.lock') $Body) }
# The scenes of the READY rows of every project, as { hash, url, where } like Get-UsedScenes: a prepared scene counts as used.
function Get-PreparedUsedScenes {
    $found = New-Object Collections.Generic.List[object]
    foreach ($projectDir in @(Get-ChildItem -LiteralPath $ScanRoot -Directory -ErrorAction SilentlyContinue)) {
        $file = Get-PreparedFile $projectDir.FullName
        if (-not (Test-Path -LiteralPath $file)) { continue }
        foreach ($row in @(Read-PreparedRows $projectDir.FullName | Where-Object { $_.status -eq 'ready' })) {
            foreach ($name in @(([string]$row.scenes) -split '\|' | Where-Object { $_ })) {
                $photo = @(Get-LibraryPhotoByName ([string]$row.group) $name)
                if (-not $photo.Count) { continue }
                $hash = Get-LibraryPhotoHash ([string]$row.group) $photo[0]
                if ($hash) { $found.Add([pscustomobject]@{ hash = $hash; url = [string]$row.product_url; where = "prepared ($($projectDir.Name))" }) }
            }
        }
    }
    return $found.ToArray()
}
# Checks the scene picks of one product like queue-add does (exists in the library, sha256, not two of the same picture, not used by another
# product) and returns { ok, error, cause, photos = @{ name, file, sha256, md5 } }. Nothing is copied or written.
function Test-SceneSet([string]$Url, [string]$LibraryGroup, [string[]]$Names, [string[]]$Sha256, [bool]$Reuse) {
    if (-not @(Get-LibraryPhotosCached $LibraryGroup).Count) { return [pscustomobject]@{ ok = $false; error = "No photos in group $LibraryGroup."; cause = 'UNKNOWN_GROUP' } }
    $photos = @(); $seen = @(); $i = 0
    foreach ($name in $Names) {
        $photo = @(Get-LibraryPhotoByName $LibraryGroup $name)
        if (-not $photo.Count) { return [pscustomobject]@{ ok = $false; error = "No photo '$name' in group $LibraryGroup (use the names from the scenes list)."; cause = 'UNKNOWN_SCENE' } }
        $file = Get-LibraryPhotoFile $LibraryGroup $photo[0]
        $sha = Get-FileHashText $file 'SHA256'
        if ($photo[0].sha256 -and $photo[0].sha256 -ne $sha) { return [pscustomobject]@{ ok = $false; error = "$name does not match the sha256 of the library catalog."; cause = 'SCENE_HASH' } }
        if ($Sha256 -and $Sha256.Count -gt $i -and $Sha256[$i] -and $Sha256[$i] -ne $sha) { return [pscustomobject]@{ ok = $false; error = "$name changed since it was prepared (sha256 differs)."; cause = 'SCENE_HASH' } }
        if (@($photos | Where-Object { $_.sha256 -eq $sha }).Count) { return [pscustomobject]@{ ok = $false; error = 'Two of the scenes are the same picture; pick different ones.'; cause = 'SAME_SCENE' } }
        $hash = Get-PHash $file ("lib:$LibraryGroup/$($photo[0].name):$($photo[0].md5)")
        foreach ($other in $seen) {
            $distance = Get-PHashDistance $hash $other.hash
            if ($distance -le $SceneSameDistance) { return [pscustomobject]@{ ok = $false; error = "[CAUSE:SCENE_DUPLICATE] $name and $($other.name) are visually the same picture (hash distance $distance of 256); pick a different scene for one of them."; cause = 'SCENE_DUPLICATE' } }
        }
        if (-not $Reuse) {
            $reused = @(Find-UsedScenes $hash $Url)
            if ($reused.Count) { return [pscustomobject]@{ ok = $false; error = "[CAUSE:SCENE_REUSED] $name is already used by another product ($($reused[0].where): $($reused[0].url)); pick a scene no product uses (scenes list: used_count 0), or pass -AllowReuse."; cause = 'SCENE_REUSED' } }
        }
        $seen += [pscustomobject]@{ name = $name; hash = $hash }
        $photos += [pscustomobject]@{ name = $name; file = $file; sha256 = $sha; md5 = [string]$photo[0].md5 }
        $i++
    }
    return [pscustomobject]@{ ok = $true; photos = $photos }
}
# The rows of products.csv a queue / prep command works on: -Collection, -UnusedOnly, with a project photo on disk, in table order.
function Get-ProjectCandidates([string]$Dir) {
    return @(Read-ScanRows (Join-Path $Dir 'products.csv') | Where-Object {
            (-not $Collection -or $_.collection -eq $Collection) -and (-not $UnusedOnly -or -not (Test-UsedFlag $_.used)) -and
            $_.product_image -and (Test-Path -LiteralPath (Join-Path (Join-Path $Dir 'images') $_.product_image))
        })
}

# ---- Scene index: workspace/source-photos/scene-index.json (shared by every project and session, written under scene-index.json.lock) ----
# One entry per library photo, keyed "<group>/<name>": category, md5, sha256, phash (computed here) and the tags CLAUDE wrote after looking at the
# photo once on a contact sheet: setting, people, light, wall_space, fits (product types it suits), note, usable. An entry whose md5 no longer matches
# the library manifest counts as not indexed (the photo changed). A photo visually identical to an indexed one is recorded as dup_of (no tags).
# The index only NARROWS what Claude looks at (scene-candidates); Claude still looks at every candidate sheet and picks the scenes itself.
$SceneIndexPath = Join-Path $LibraryDir 'scene-index.json'
$SceneLights = @('day', 'night', 'warm')
function Get-SceneIndexKey([string]$LibraryGroup, [string]$Name) { return ($LibraryGroup.Normalize([Text.NormalizationForm]::FormC) + '/' + $Name) }
function Read-SceneIndex {
    $map = @{}
    if (-not (Test-Path -LiteralPath $SceneIndexPath)) { return $map }
    $saved = (Read-TextRetry $SceneIndexPath).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($saved -and $saved.photos) { foreach ($p in $saved.photos.PSObject.Properties) { $map[$p.Name] = $p.Value } }
    return $map
}
# Merges $Entries (key -> entry) into the index under its lock (a fresh read: another session may have added photos meanwhile) and writes it atomically.
function Save-SceneIndexEntries([hashtable]$Entries) {
    return (Use-FileLock ($SceneIndexPath + '.lock') {
            $map = Read-SceneIndex
            foreach ($k in @($Entries.Keys)) { $map[$k] = $Entries[$k] }
            $photos = [ordered]@{}
            foreach ($k in @($map.Keys | Sort-Object)) { $photos[$k] = $map[$k] }
            Write-FileAtomic $SceneIndexPath (ConvertTo-Json -InputObject ([ordered]@{ schema = 1; updated = (Get-Stamp); photos = $photos }) -Depth 6) ([Text.UTF8Encoding]::new($false))
            $map.Count
        })
}
# The index entry of a library photo when it is still current (same md5), else $null.
function Get-SceneIndexEntry([hashtable]$Index, [string]$LibraryGroup, $Photo) {
    $entry = $Index[(Get-SceneIndexKey $LibraryGroup $Photo.name)]
    if ($entry -and [string]$entry.md5 -eq [string]$Photo.md5) { return $entry }
    return $null
}
function ConvertTo-SceneBool($Value, [string]$Field) {
    if ($Value -is [bool]) { return $Value }
    $t = ([string]$Value).Trim().ToLowerInvariant()
    if ($t -in @('yes', 'y', 'true', '1', 't')) { return $true }
    if ($t -in @('no', 'n', 'false', '0', 'f')) { return $false }
    throw "$Field must be yes or no."
}
# Library photos per group, read once per command (the manifest listing + local paths).
$script:LibraryByGroup = @{}
function Get-LibraryPhotosCached([string]$LibraryGroup) {
    $k = $LibraryGroup.Normalize([Text.NormalizationForm]::FormC)
    if (-not $script:LibraryByGroup.ContainsKey($k)) { $script:LibraryByGroup[$k] = @(Get-LibraryPhotos $k) }
    return $script:LibraryByGroup[$k]
}
# One photo of a group by name through a table built once per command (a PowerShell Where-Object over 4500 photos per lookup is what made queue-from-prepared take minutes).
$script:LibraryNameIndex = @{}
function Get-LibraryPhotoByName([string]$LibraryGroup, [string]$Name) {
    $k = $LibraryGroup.Normalize([Text.NormalizationForm]::FormC)
    if (-not $script:LibraryNameIndex.ContainsKey($k)) {
        $table = @{}
        foreach ($p in @(Get-LibraryPhotosCached $k)) { if (-not $table.ContainsKey([string]$p.name)) { $table[[string]$p.name] = $p } }
        $script:LibraryNameIndex[$k] = $table
    }
    $hit = $script:LibraryNameIndex[$k][$Name]
    if ($hit) { return $hit }
}
# Lower-case words of 3+ letters, without filler words and a plural s (for the tag ranking of scene-candidates).
function Get-TagWords([string]$Text) {
    $stop = @('the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'any', 'all')
    return @(([string]$Text).ToLowerInvariant() -split '[^a-z0-9]+' | Where-Object { $_.Length -ge 3 -and $stop -notcontains $_ } | ForEach-Object { if ($_.EndsWith('s') -and $_.Length -gt 3) { $_.Substring(0, $_.Length - 1) } else { $_ } } | Sort-Object -Unique)
}

# ---- Several light runs at once (Luồng in the Dự án popup): each run gets a DISJOINT slice of the work ----
# -OnlyFile <json array of product links>: keep only those products (queue-todo / prep-todo; the app makes the exact split, so no two runs share a product).
# -Shard k/n: keep the items whose stable hash (Test-InShard) falls in slice k of n (scene-index-todo, library photos).
function Select-OnlyFile($Rows, [scriptblock]$KeyOf) {
    if (-not $OnlyFile) { return @($Rows) }
    if (-not (Test-Path -LiteralPath $OnlyFile)) { Fail-Scan "-OnlyFile not found: $OnlyFile" 'BAD_ONLYFILE' }
    $keys = New-Object System.Collections.Generic.HashSet[string]
    $parsed = [IO.File]::ReadAllText($OnlyFile).TrimStart([char]0xFEFF) | ConvertFrom-Json
    foreach ($u in @(foreach ($one in $parsed) { $one })) { [void]$keys.Add((Get-ScanUrlKey ([string]$u))) }
    return @($Rows | Where-Object { $keys.Contains((Get-ScanUrlKey ([string](& $KeyOf $_)))) })
}
if ($Shard -and ($Shard -notmatch '^([1-4])/([1-4])$' -or [int]$Matches[1] -gt [int]$Matches[2])) { Fail-Scan '-Shard must look like 1/2 (slice k of n, n 1-4).' 'BAD_SHARD' }
function Test-InShard([string]$Key) {
    if (-not $Shard) { return $true }
    [void]($Shard -match '^([1-4])/([1-4])$')
    $k = [int]$Matches[1]; $n = [int]$Matches[2]
    $h = 0
    foreach ($c in $Key.ToCharArray()) { $h = ($h * 31 + [int]$c) % 1000003 }
    return (($h % $n) -eq ($k - 1))
}
# queue-add holds this lock from the first check to the queue write: two runs never queue the same link or take the same scene at the same moment.
function Enter-QueueAddLock {
    $path = Join-Path (Get-SessionWorkspaceDir $ProjectRoot) 'queue-add.lock'
    $deadline = (Get-Date).AddSeconds(90)
    while ($true) {
        try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] {
            if ((Get-Date) -gt $deadline) { Fail-Scan '[CAUSE:LOCK_BUSY] queue-add is busy (another run is adding); try again in a few seconds.' 'LOCK_BUSY' }
            Start-Sleep -Milliseconds (80 + (Get-Random -Maximum 120))
        }
    }
}

# ---- Scene pool + writers shared by scene-candidates (AI picks), scene-apply (batch) and scene-auto (code picks) ----
# ---- Used-scene ledger: workspace/source-photos/used-scenes.json = { photos: { "<group>/<photo name>": { url, at } } }, shared by every project, window and run ----
# A photo that was picked for a product is never offered or picked again for another one (any run, any window). Written under its own lock; kept for good.
$SceneLedgerPath = Join-Path $LibraryDir 'used-scenes.json'
function Read-SceneLedger {
    $map = @{}
    if (-not (Test-Path -LiteralPath $SceneLedgerPath)) { return $map }
    try { $saved = (Read-TextRetry $SceneLedgerPath).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { return $map }
    if ($saved -and $saved.photos) { foreach ($p in $saved.photos.PSObject.Properties) { $map[$p.Name] = [string]$p.Value.url } }
    return $map
}
# Claims $Names of $LibraryGroup for $Url under the lock; returns the names another product already holds (none claimed then) or @() when all are claimed.
function Add-SceneLedger([string]$LibraryGroup, [string[]]$Names, [string]$Url) {
    $g = $LibraryGroup.Normalize([Text.NormalizationForm]::FormC); $urlKey = Get-ScanUrlKey $Url
    return @(Use-FileLock ($SceneLedgerPath + '.lock') {
            $map = Read-SceneLedger
            $held = @($Names | Where-Object { $k = "$g/$_"; $map.ContainsKey($k) -and $map[$k] -and (Get-ScanUrlKey $map[$k]) -ne $urlKey })
            if ($held.Count) { return $held }
            $out = [ordered]@{}
            foreach ($k in @($map.Keys | Sort-Object)) { $out[$k] = [ordered]@{ url = $map[$k] } }
            foreach ($n in $Names) { $out["$g/$n"] = [ordered]@{ url = $Url; at = (Get-Stamp) } }
            Write-FileAtomic $SceneLedgerPath (ConvertTo-Json -InputObject ([ordered]@{ schema = 1; photos = $out }) -Depth 4) ([Text.UTF8Encoding]::new($false))
            return @()
        })
}
# The RANDOM pool of one library group, no tags involved: the group's photos minus the ones the ledger holds for another product, in a shuffle seeded by
# $SeedText (same seed = same order, another seed = other photos). Per-file filters (on disk, size, orientation, used by another product, copy of a chosen one)
# are applied by Get-SceneCandidate while walking the pool.
function Get-ScenePool([string]$LibraryGroup, [string]$CategoryText, [string]$SeedText, [string]$ForUrl) {
    $g = $LibraryGroup.Normalize([Text.NormalizationForm]::FormC)
    $ledger = Read-SceneLedger; $urlKey = if ($ForUrl) { Get-ScanUrlKey $ForUrl } else { '' }
    $md5 = [Security.Cryptography.MD5]::Create()
    $items = New-Object Collections.Generic.List[object]; $all = 0
    foreach ($photo in @(Get-LibraryPhotosCached $g)) {
        if ($CategoryText -and $photo.category -ne $CategoryText) { continue }
        $all++
        $held = $ledger["$g/$($photo.name)"]
        if ($held -and (-not $urlKey -or (Get-ScanUrlKey $held) -ne $urlKey)) { continue }
        $items.Add([pscustomobject]@{ group = $g; photo = $photo; key = [BitConverter]::ToString($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($SeedText + '|' + $g + '/' + [string]$photo.name))) })
    }
    return [pscustomobject]@{ items = @($items | Sort-Object key); photos = $all; free = $items.Count }
}
# One pool item through the per-file filters: { file, hash } or $null (missing / broken file, shorter side under 500 px, a shape the review photos cannot use
# (width / height outside 0.45 - 2.2), used by another product, copy of a photo in $ChosenHashes).
$script:SceneMinSide = 500
function Get-SceneCandidate($Item, [string]$ProductUrl, $ChosenHashes) {
    $file = if ($Item.photo.local) { [string]$Item.photo.local } else { try { [string](Get-LibraryPhotoFile $Item.group $Item.photo) } catch { '' } }
    if (-not $file -or -not (Test-Path -LiteralPath $file)) { return $null }
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
        $img = [Drawing.Image]::FromFile($file)
        try { $w = $img.Width; $h = $img.Height } finally { $img.Dispose() }
    } catch { return $null }
    if ([Math]::Min($w, $h) -lt $script:SceneMinSide -or ($w / [double]$h) -lt 0.45 -or ($w / [double]$h) -gt 2.2) { return $null }
    $hash = [string](Get-PHash $file ("lib:$($Item.group)/$($Item.photo.name):$($Item.photo.md5)"))
    if (-not $hash) { return $null }
    if (@(Find-UsedScenes $hash $ProductUrl).Count) { return $null }
    if (@($ChosenHashes | Where-Object { (Get-PHashDistance $hash $_) -le $SceneSameDistance }).Count) { return $null }
    return [pscustomobject]@{ file = $file; hash = $hash }
}
# Writes the result of one product: prep = a ready row; queue = scenes copied + queue entry (under the queue-add lock) + a consumed row. $null when the link is queued meanwhile.
function Save-SceneResult([string]$WriteMode, $Row, [string]$LibraryGroup, $Check, [string]$Dir) {
    $session = if ($env:PR_SESSION) { $env:PR_SESSION } else { 'default' }
    $record = [pscustomobject]@{ product_url = $Row.product_url; group = $LibraryGroup; scenes = (@($Check.photos | ForEach-Object { $_.name }) -join '|'); scene_sha256 = (@($Check.photos | ForEach-Object { $_.sha256 }) -join '|'); scene_count = [string]@($Check.photos).Count; prepared_at = (Get-Stamp); status = 'ready'; consumed_at = ''; consumed_by = '' }
    $heldBy = @(Add-SceneLedger $LibraryGroup @($Check.photos | ForEach-Object { $_.name }) ([string]$Row.product_url))
    if ($heldBy.Count) { throw "[CAUSE:SCENE_REUSED] $($heldBy -join ', ') was just taken by another product." }
    if ($WriteMode -eq 'queue') {
        $handle = Get-Slug (([Uri]$Row.product_url).Segments[-1].Trim('/')) 80
        $sceneDir = Join-Path (Get-SessionWorkspaceDir $ProjectRoot) "reference-inputs/$ProjectId-scenes"
        New-Item -ItemType Directory -Force -Path $sceneDir | Out-Null
        $picked = @(); $n = 0
        foreach ($ph in $Check.photos) { $n++; $target = Join-Path $sceneDir ("$handle-scene$n" + [IO.Path]::GetExtension($ph.file).ToLowerInvariant()); Copy-Item -LiteralPath $ph.file -Destination $target -Force; if ((Get-FileHashText $target 'SHA256') -ne $ph.sha256) { throw "Copy of $($ph.name) is damaged." }; $picked += [pscustomobject]@{ file = $target; sha256 = $ph.sha256 } }
        $lock = Enter-QueueAddLock
        try {
            if ((Get-QueuedKeys).Contains((Get-ScanUrlKey $Row.product_url))) { return $null }
            [void](Add-QueueEntry $Dir $Row $picked)
        } finally { $lock.Dispose() }
        $record.status = 'consumed'; $record.consumed_at = (Get-Stamp); $record.consumed_by = $session
    }
    return $record
}
# The new rows into prepared.csv in ONE lock. A ready / consumed row is only replaced by a queue write (it becomes consumed); skipped rows are replaced by any.
function Save-PreparedRecords([string]$WriteMode, [string]$Dir, $Records) {
    if (-not @($Records).Count) { return }
    [void](Use-PreparedLock $Dir {
        $rows = @(Read-PreparedRows $Dir)
        $mine = @{}; foreach ($r in @($Records)) { $mine[(Get-ScanUrlKey $r.product_url)] = $r }
        $keep = @($rows | Where-Object { $k = Get-ScanUrlKey $_.product_url; -not $mine.ContainsKey($k) -or ($WriteMode -eq 'prep' -and $_.status -in @('ready', 'consumed')) })
        $keptKeys = @{}; foreach ($r in $keep) { $keptKeys[(Get-ScanUrlKey $r.product_url)] = $true }
        Write-PreparedRows $Dir ($keep + @($Records | Where-Object { -not $keptKeys.ContainsKey((Get-ScanUrlKey $_.product_url)) }))
        $true
    })
}
function New-SkipRecord($Row, [string]$Why) {
    return [pscustomobject]@{ product_url = $Row.product_url; group = ('no-fit: ' + $Why); scenes = ''; scene_sha256 = ''; scene_count = ''; prepared_at = (Get-Stamp); status = 'skipped:no-fit'; consumed_at = ''; consumed_by = '' }
}

# ---- Grouped product lists (prep-todo / queue-todo -Grouped): products of one kind together, so Claude decides the type once per group ----
# The key is the product's collection (category of the shop); rows without one fall back to a type word of the title. Big groups are split in
# chunks of 20 (one product sheet each). This only GROUPS products: it never chooses a scene.
function Get-ProductTypeWord([string]$Title) {
    $t = ([string]$Title).ToLowerInvariant()
    foreach ($w in @('neon', 'sign', 'polo', 'hoodie', 'jersey', 'jacket', 'shirt', 'tee', 'dress', 'hat', 'cap', 'mug', 'tumbler', 'table', 'chair', 'sofa', 'bed', 'lamp', 'pillow', 'blanket', 'poster', 'canvas', 'frame', 'ornament')) { if ($t -match "\b$w") { return $w } }
    return 'other'
}
function Get-ProductGroups([object[]]$Rows, [string]$Dir, [bool]$MakeSheets, [int]$PerGroup = 20) {
    $order = New-Object Collections.Generic.List[string]
    $byKey = @{}
    foreach ($r in @($Rows)) {
        $key = if ($r.collection -and $r.collection -ne 'Khác') { [string]$r.collection } else { 'type: ' + (Get-ProductTypeWord $r.title) }
        if (-not $byKey.ContainsKey($key)) { $byKey[$key] = New-Object Collections.Generic.List[object]; $order.Add($key) }
        $byKey[$key].Add($r)
    }
    $groups = @(); $n = 0
    foreach ($key in $order) {
        $all = $byKey[$key].ToArray(); $chunks = [int][math]::Ceiling([double]$all.Count / $PerGroup)
        for ($c = 0; $c -lt $chunks; $c++) {
            $part = @($all | Select-Object -Skip ($c * $PerGroup) -First $PerGroup)
            $i = 0
            $products = @($part | ForEach-Object { $i++; [ordered]@{ n = $i; url = $_.product_url; title = $_.title; collection = $_.collection; image = (Join-Path (Join-Path $Dir 'images') $_.product_image) } })
            $g = [ordered]@{ key = $key; part = $(if ($chunks -gt 1) { "$($c + 1)/$chunks" } else { '' }); count = $products.Count; products = $products }
            if ($MakeSheets) {
                $n++
                $made = New-ContactSheet @($products | ForEach-Object { [pscustomobject]@{ number = $_.n; name = $_.url; path = $_.image } }) (Get-ContactSheetPath (Get-SessionWorkspaceDir $ProjectRoot) "products-$ProjectId-$n") $Cols
                $g['sheet'] = $made.sheet
            }
            $groups += $g
        }
    }
    return $groups
}

function Convert-ToUsedFlag([string]$Value) {
    if ($Value -match '^(t|true|1)$') { return $true }
    if ($Value -match '^(f|false|0)$') { return $false }
    Fail-Scan '-Used must be T or F.' 'BAD_USED'
}

try {
    if ($Command -eq 'prep-add-many') { $Mode = 'prep'; $Command = 'scene-apply' } elseif ($Command -eq 'queue-add-many') { $Mode = 'queue'; $Command = 'scene-apply' }
switch ($Command) {
        'start' {
            if (-not (Get-SiteHost $Site)) { Fail-Scan '-Site must be the shop home page link (http or https).' 'BAD_SITE' }
            if ($Max -lt 1) { $Max = 20 }
            # not named $project: that is the -Project parameter (a string, case-insensitive)
            $opened = Open-Project $ScanRoot $Site $Max
            $dir = $opened.Dir
            # A new scan of the project: its own session, the old table untouched.
            $session = [ordered]@{ run = $Run; started = (Get-Stamp); max = $Max; added = [ordered]@{}; seen = (New-Object System.Collections.Generic.List[string]); duplicates = 0 }
            Save-ScanSession $dir $session
            Set-ProjectField $dir 'max_per_collection' $Max
            $summary = Get-ProjectSummary $dir
            Write-ScanJson ([ordered]@{ scan = $summary.id; project = $summary.id; new_project = $opened.New; dir = $dir; csv = $summary.csv; site = $opened.Info.site; max_per_collection = $Max
                    known_products = $summary.products; known_collections = $summary.collections })
        }
        'known' {
            # The links already in the project: Claude skips them, so MAX counts only NEW products per category.
            $dir = Get-ScanDir $ProjectId
            $rows = @(Read-ScanRows (Join-Path $dir 'products.csv'))
            Write-ScanJson ([ordered]@{ project = $ProjectId; count = $rows.Count; urls = @($rows | ForEach-Object { $_.product_url }) })
        }
        'add' {
            $dir = Get-ScanDir $ProjectId; $info = Read-ProjectJson (Join-Path $dir 'project.json'); $session = Read-ScanSession $dir
            if (-not $Url) { Fail-Scan '-Url is required.' 'BAD_URL' }
            if (-not $ImageUrl -and -not $ImageFile) { Fail-Scan 'Pass -ImageUrl or -ImageFile.' 'IMAGE_URL' }
            $r = Add-ScanProduct $dir $info $session $Url $Title $Collection $CollectionUrl $ImageUrl $ImageFile
            Save-ScanSession $dir $session
            if ($r.status -eq 'failed') { Fail-Scan $r.error $r.cause }
            Write-ScanJson $r
        }
        'add-many' {
            # One call for a whole category: -File is a JSON array of {url, title, collection, collection_url, image_url | image_file}.
            $dir = Get-ScanDir $ProjectId; $info = Read-ProjectJson (Join-Path $dir 'project.json'); $session = Read-ScanSession $dir
            if (-not $File -or -not (Test-Path -LiteralPath $File)) { Fail-Scan '-File must be the JSON file of products.' 'BAD_FILE' }
            # Windows PowerShell returns a JSON array as one object; enumerate it explicitly.
            $data = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
            $items = @(foreach ($entry in $data) { $entry })
            $added = 0; $results = @()
            foreach ($item in $items) {
                $get = { param($n) $p = $item.PSObject.Properties[$n]; if ($p) { [string]$p.Value } else { '' } }
                $r = Add-ScanProduct $dir $info $session (& $get 'url') (& $get 'title') (& $get 'collection') (& $get 'collection_url') (& $get 'image_url') (& $get 'image_file')
                if ($r.status -eq 'added') { $added++ }
                $results += , $r
            }
            Save-ScanSession $dir $session
            Write-ScanJson ([ordered]@{ scan = $info.id; project = $info.id; added = $added; failed = @($results | Where-Object status -eq 'failed').Count; results = $results })
        }
        'set-menu' {
            # -File: a JSON array of {name, url} (the categories of the main menu), kept in menu.json next to the product counts.
            $dir = Get-ScanDir $ProjectId
            if (-not $File -or -not (Test-Path -LiteralPath $File)) { Fail-Scan '-File must be the JSON file of categories.' 'BAD_FILE' }
            $data = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($entry in $data) { $name = [string]$entry.name; $link = if ($entry.PSObject.Properties['url']) { [string]$entry.url } else { '' }; Update-ProjectMenu $dir $name $link }
            Write-ScanJson ([ordered]@{ project = $ProjectId; menu = @(Save-ProjectMenu $dir) })
        }
        'status' {
            $dir = Get-ScanDir $ProjectId
            Write-ScanJson (Get-ScanSummary $dir (Read-ProjectJson (Join-Path $dir 'project.json')) (Read-ScanSession $dir))
        }
        'finish' {
            $dir = Get-ScanDir $ProjectId; $info = Read-ProjectJson (Join-Path $dir 'project.json'); $session = Read-ScanSession $dir
            [void](Save-ProjectMenu $dir)
            Set-ProjectField $dir 'last_scan' (Get-Stamp)
            Write-ScanJson (Get-ScanSummary $dir $info $session)
        }
        'projects' {
            Write-ScanJson ([ordered]@{ projects = @(Get-ProjectList $ScanRoot) })
        }
        'project' {
            $dir = Get-ScanDir $ProjectId
            $summary = Get-ProjectSummary $dir
            $summary['menu'] = @(Read-ProjectJson (Join-Path $dir 'menu.json') @())
            Write-ScanJson $summary
        }
        'set-used' {
            $dir = Get-ScanDir $ProjectId
            if (-not $Url) { Fail-Scan '-Url is required.' 'BAD_URL' }
            $flag = Convert-ToUsedFlag $Used
            $rows = @(Read-ScanRows (Join-Path $dir 'products.csv'))
            $key = Get-ScanUrlKey $Url
            if (-not @($rows | Where-Object { (Get-ScanUrlKey $_.product_url) -eq $key }).Count) { Fail-Scan "The link is not in project $ProjectId." 'UNKNOWN_URL' }
            Write-ScanJson ([ordered]@{ project = $ProjectId; url = $Url; used = $(if ($flag) { 'T' } else { 'F' }); changed = (Set-ProjectUsed $dir $Url $flag) })
        }
        'reviews-todo' {
            # The links to read next (never checked first). Claude opens each one and reports the number it sees with set-reviews.
            $dir = Get-ScanDir $ProjectId
            $todo = @(Get-ReviewsTodo $dir $Limit)
            Write-ScanJson ([ordered]@{ project = $ProjectId; count = $todo.Count; never_checked = @($todo | Where-Object { -not $_.reviews_checked_at }).Count; links = $todo })
        }
        'set-reviews' {
            # Stores the review number Claude read on the product page (and, when it saw them, the rating and where it is shown). Nothing here
            # reads or checks a page: it only writes what is reported.
            $dir = Get-ScanDir $ProjectId
            if (-not $Url) { Fail-Scan '-Url is required.' 'BAD_URL' }
            if ($Count -lt 0) { Fail-Scan '-Count must be the number of reviews shown on the page (0 or more).' 'BAD_COUNT' }
            if (-not (Set-ProjectReviews $dir $Url $Count $Rating $Source)) { Fail-Scan "The link is not in project $ProjectId." 'UNKNOWN_URL' }
            Write-ScanJson ([ordered]@{ project = $ProjectId; url = $Url; reviews_count = $Count; checked_at = (Get-Stamp) })
        }
        'queue-todo' {
            # The products to queue: the project's own rows, in table order, not queued yet; -Collection (a category) and -UnusedOnly narrow it, -Limit caps it.
            # Products that already have a READY prepared row are left out (Thêm vào hàng chờ takes them from the stock); -TopUp -SceneCount S lists instead the
            # ready rows prepared with FEWER than S scenes, with their scenes: the queue run keeps those and picks only the missing ones (queue-add with all of them).
            $dir = Get-ScanDir $ProjectId
            $queued = Get-QueuedKeys
            $readyRows = @{}
            foreach ($pr in @(Read-PreparedRows $dir | Where-Object { $_.status -eq 'ready' })) { $readyRows[(Get-ScanUrlKey $pr.product_url)] = $pr }
            $todoRows = @(Read-ScanRows (Join-Path $dir 'products.csv') | Where-Object {
                    (-not $Collection -or $_.collection -eq $Collection) -and (-not $UnusedOnly -or -not (Test-UsedFlag $_.used)) -and -not $queued.Contains((Get-ScanUrlKey $_.product_url)) -and
                    $_.product_image -and (Test-Path -LiteralPath (Join-Path (Join-Path $dir 'images') $_.product_image))
                })
            if ($TopUp) { $todoRows = @($todoRows | Where-Object { $k = Get-ScanUrlKey $_.product_url; $readyRows.ContainsKey($k) -and ($SceneCount -le 0 -or [int]$readyRows[$k].scene_count -lt $SceneCount) }) }
            else { $todoRows = @($todoRows | Where-Object { -not $readyRows.ContainsKey((Get-ScanUrlKey $_.product_url)) }) }
            $todoRows = @(Select-OnlyFile $todoRows { param($r) $r.product_url })
            if ($Limit -gt 0) { $todoRows = @($todoRows | Select-Object -First $Limit) }
            $answer = ([ordered]@{ project = $ProjectId; top_up = [bool]$TopUp; count = $todoRows.Count; products = @($todoRows | ForEach-Object {
                        $item = [ordered]@{ url = $_.product_url; title = $_.title; collection = $_.collection; image = (Join-Path (Join-Path $dir 'images') $_.product_image) }
                        if ($TopUp) { $pr = $readyRows[(Get-ScanUrlKey $_.product_url)]; $have = @(([string]$pr.scenes) -split '\|' | Where-Object { $_ }); $item['group'] = [string]$pr.group; $item['scenes'] = $have; $item['missing'] = [Math]::Max(0, $SceneCount - $have.Count) }
                        $item
                    }) })
            # -Grouped: the same products by kind (collection / title type word), each group with a product sheet when -Sheet (one Read per group).
            if ($Grouped -and -not $TopUp) { $answer['groups'] = @(Get-ProductGroups $todoRows $dir ([bool]$Sheet)) }
            Write-ScanJson $answer
        }
        'queue-direct' {
            # No Claude, no scenes: the first -Limit products in table order (same filters as queue-todo: -Collection, -UnusedOnly, not queued yet) go into
            # the queue with only the link and the project product photo. `used` is not touched.
            Import-QueueLibs
            $dir = Get-ScanDir $ProjectId
            $queued = Get-QueuedKeys
            $directRows = @(Read-ScanRows (Join-Path $dir 'products.csv') | Where-Object {
                    (-not $Collection -or $_.collection -eq $Collection) -and (-not $UnusedOnly -or -not (Test-UsedFlag $_.used)) -and -not $queued.Contains((Get-ScanUrlKey $_.product_url)) -and
                    $_.product_image -and (Test-Path -LiteralPath (Join-Path (Join-Path $dir 'images') $_.product_image))
                })
            if ($Limit -gt 0) { $directRows = @($directRows | Select-Object -First $Limit) }
            $addedUrls = @()
            foreach ($directRow in $directRows) { [void](Add-QueueEntry $dir $directRow @()); $addedUrls += $directRow.product_url }
            Write-ScanJson ([ordered]@{ project = $ProjectId; added = $addedUrls.Count; urls = $addedUrls })
        }
        'scenes' {
            # No -Group: the library groups. With -Group: its photos (name, category, local path when already on disk); -Category and -Limit narrow it.
            Import-QueueLibs
            if (-not $Group) {
                $groups = @(@((Get-SourceManifest).groups) | Where-Object { $_.enabled -ne $false } | ForEach-Object { [ordered]@{ group = [string]$_.name; photos = @($_.files).Count } })
                Write-ScanJson ([ordered]@{ groups = $groups })
            } else {
                $all = @(Get-LibraryPhotos $Group)
                $photos = @($all | Where-Object { -not $Category -or $_.category -eq $Category })
                $categories = @($photos | Group-Object category | ForEach-Object { [ordered]@{ category = $_.Name; photos = $_.Count } })
                # -Prefetch downloads the photos of the selection that are not on disk yet, so every one can be hashed (dup_of / used_count).
                if ($Prefetch) { foreach ($missing in @($photos | Where-Object { -not $_.local })) { try { $missing.local = Get-LibraryPhotoFile $Group $missing } catch { } } }
                # Hash of every photo on disk (cached); dup_of = the first photo of the library that looks the same (so Claude can skip the copies).
                foreach ($photo in $all) { $photo | Add-Member NoteProperty phash (Get-LibraryPhotoHash $Group $photo) -Force }
                $firstOf = @{}
                $withHash = @($all | Where-Object { $_.phash })
                for ($i = 0; $i -lt $withHash.Count; $i++) {
                    $firstOf[$withHash[$i].name] = ''
                    for ($j = 0; $j -lt $i; $j++) { if ((Get-PHashDistance $withHash[$i].phash $withHash[$j].phash) -le $SceneSameDistance) { $firstOf[$withHash[$i].name] = $withHash[$j].name; break } }
                }
                foreach ($photo in $photos) {
                    $usedBy = @(if ($photo.phash) { Find-UsedScenes $photo.phash })
                    $photo | Add-Member NoteProperty used_count (@($usedBy | ForEach-Object { if ($_.url) { Get-ScanUrlKey $_.url } else { $_.where } } | Sort-Object -Unique).Count) -Force
                    $photo | Add-Member NoteProperty dup_of $(if ($firstOf.ContainsKey($photo.name)) { [string]$firstOf[$photo.name] } else { '' }) -Force
                }
                Save-PHashCache
                # Unused first, copies last, then a stable shuffle (md5 order, not the alphabetical one) so the first ones are not always taken.
                $photos = @($photos | Sort-Object @{ Expression = { [bool]$_.dup_of } }, @{ Expression = { $_.used_count } }, @{ Expression = { [string]$_.md5 } })
                if ($Limit -gt 0) { $photos = @($photos | Select-Object -First $Limit) }
                Write-ScanJson ([ordered]@{ group = $Group; categories = $categories; count = $photos.Count; hashed = @($photos | Where-Object { $_.phash }).Count; photos = @($photos | ForEach-Object { [ordered]@{ name = $_.name; category = $_.category; kind = $_.kind; local = $_.local; checked = [bool]$_.phash; used_count = $_.used_count; dup_of = $_.dup_of } }) })
            }
        }
        'scene-get' {
            # Makes sure one library photo is on this machine (downloads it when missing, md5 checked) and prints its path, so Claude can look at it.
            Import-QueueLibs
            if (-not $Group -or -not $SceneNames) { Fail-Scan 'Pass -Group <group> and -SceneNames <photo name> (the name from the scenes list).' 'BAD_SCENE' }
            $photo = @(Get-LibraryPhotos $Group | Where-Object { $_.name -eq $SceneNames.Trim() })
            if (-not $photo.Count) { Fail-Scan "No photo '$SceneNames' in group $Group." 'UNKNOWN_SCENE' }
            $sceneFile = Get-LibraryPhotoFile $Group $photo[0]
            $sceneHash = Get-PHash $sceneFile ("lib:$Group/$($photo[0].name):$($photo[0].md5)")
            $usedBy = @(Find-UsedScenes $sceneHash)
            Save-PHashCache
            Write-ScanJson ([ordered]@{ group = $Group; name = $SceneNames.Trim(); category = $photo[0].category; file = $sceneFile; used_count = $usedBy.Count; used_in = @($usedBy | ForEach-Object { $_.where } | Sort-Object -Unique) })
        }
        'queue-add' {
            # One product into the run queue: its link into urls.txt, its project photo as the product image and 1-4 DIFFERENT library photos
            # (-Group, -SceneNames a.jpg,b.jpg) as its scenes in references.json, in the format of the app's own entries. An existing entry or link is
            # never changed. Writes no review text and starts nothing; `used` is not touched (the run sets it when the link is done).
            Import-QueueLibs
            $dir = Get-ScanDir $ProjectId
            if (-not $Url) { Fail-Scan '-Url is required.' 'BAD_URL' }
            if (-not $Group) { Fail-Scan '-Group is required (the library group the scenes come from).' 'BAD_GROUP' }
            $key = Get-ScanUrlKey $Url
            $row = @(Read-ScanRows (Join-Path $dir 'products.csv') | Where-Object { (Get-ScanUrlKey $_.product_url) -eq $key })
            if (-not $row.Count) { Fail-Scan "The link is not in project $ProjectId." 'UNKNOWN_URL' }
            $productFile = Join-Path (Join-Path $dir 'images') $row[0].product_image
            if (-not $row[0].product_image -or -not (Test-Path -LiteralPath $productFile)) { Fail-Scan 'The project has no product photo for this link.' 'IMAGE_MISSING' }
            if ((Get-QueuedKeys).Contains($key)) { Fail-Scan 'This link is already in the queue (urls.txt or references.json); it was left as it is.' 'ALREADY_QUEUED' }
            $wanted = @($SceneNames -split '[,|]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            if ($wanted.Count -lt 1 -or $wanted.Count -gt 4 -or @($wanted | Sort-Object -Unique).Count -ne $wanted.Count) { Fail-Scan 'Pass 1 to 4 different photos: -SceneNames a.jpg,b.jpg.' 'BAD_SCENES' }
            if ($SceneCount -gt 0 -and $SceneCount -ne $wanted.Count) { Fail-Scan "Pass exactly $SceneCount photos in -SceneNames (got $($wanted.Count))." 'BAD_SCENES' }
            $library = @(Get-LibraryPhotos $Group)
            if (-not $library.Count) { Fail-Scan "No photos in group $Group." 'UNKNOWN_GROUP' }
            $handle = Get-Slug (([Uri]$row[0].product_url).Segments[-1].Trim('/')) 80
            $sceneDir = Join-Path (Get-SessionWorkspaceDir $ProjectRoot) "reference-inputs/$ProjectId-scenes"
            New-Item -ItemType Directory -Force -Path $sceneDir | Out-Null
            $picked = @(); $number = 0; $seen = @(); $hashes = @{}
            foreach ($wantedName in $wanted) {
                $number++
                $photo = @($library | Where-Object { $_.name -eq $wantedName })
                if (-not $photo.Count) { Fail-Scan "No photo '$wantedName' in group $Group (use the names from the scenes list)." 'UNKNOWN_SCENE' }
                $sceneSource = Get-LibraryPhotoFile $Group $photo[0]
                $sha = Get-FileHashText $sceneSource 'SHA256'
                if ($photo[0].sha256 -and $photo[0].sha256 -ne $sha) { Fail-Scan "$wantedName does not match the sha256 of the library catalog." 'SCENE_HASH' }
                if (@($picked | Where-Object { $_.sha256 -eq $sha }).Count) { Fail-Scan 'Two of the scenes are the same picture; pick different ones.' 'SAME_SCENE' }
                # Visual checks (perceptual hash): the same photo re-saved under another name, or a scene another product already uses.
                $sceneHash = Get-PHash $sceneSource ("lib:$Group/$($photo[0].name):$($photo[0].md5)")
                $hashes[$wantedName] = $sceneHash
                foreach ($other in $seen) {
                    $distance = Get-PHashDistance $sceneHash $other.hash
                    if ($distance -le $SceneSameDistance) { Save-PHashCache; Fail-Scan "[CAUSE:SCENE_DUPLICATE] $wantedName and $($other.name) are visually the same picture (hash distance $distance of 256); pick a different scene for one of them." 'SCENE_DUPLICATE' }
                }
                if (-not $AllowReuse) {
                    $reused = @(Find-UsedScenes $sceneHash $Url)
                    if ($reused.Count) { Save-PHashCache; Fail-Scan "[CAUSE:SCENE_REUSED] $wantedName is already used by another product ($($reused[0].where): $($reused[0].url)); pick a scene no product uses (scenes list: used_count 0), or pass -AllowReuse." 'SCENE_REUSED' }
                }
                $seen += [pscustomobject]@{ name = $wantedName; hash = $sceneHash }
                $target = Join-Path $sceneDir ("$handle-scene$number" + [IO.Path]::GetExtension($sceneSource).ToLowerInvariant())
                Copy-Item -LiteralPath $sceneSource -Destination $target -Force
                if ((Get-FileHashText $target 'SHA256') -ne $sha) { Fail-Scan "Copy of $wantedName is damaged." 'SCENE_COPY' }
                $picked += [pscustomobject]@{ file = $target; sha256 = $sha }
            }
            # The slow part (library downloads, hashes, copies) is done. The lock now covers only the final check + the queue write: another shard may have
            # queued this link or taken one of these scenes meanwhile, so both are checked again here.
            $addLock = Enter-QueueAddLock
            try {
                if ((Get-QueuedKeys).Contains($key)) { Save-PHashCache; Fail-Scan 'This link is already in the queue (urls.txt or references.json); it was left as it is.' 'ALREADY_QUEUED' }
                if (-not $AllowReuse) {
                    foreach ($wantedName in $wanted) {
                        $reused = @(Find-UsedScenes $hashes[$wantedName] $Url)
                        if ($reused.Count) { Save-PHashCache; Fail-Scan "[CAUSE:SCENE_REUSED] $wantedName was just taken by another product ($($reused[0].where): $($reused[0].url)); pick a scene no product uses (scenes list: used_count)." 'SCENE_REUSED' }
                    }
                }
                [void](Add-QueueEntry $dir $row[0] $picked)
            } finally { $addLock.Dispose() }
            Save-PHashCache
            # Keep the stock coherent: the product's prepared row (a top-up, or none yet) becomes consumed with the scenes really queued.
            $consumedBy = if ($env:PR_SESSION) { $env:PR_SESSION } else { 'default' }
            [void](Use-PreparedLock $dir {
                $rows = @(Read-PreparedRows $dir)
                $mineRow = @($rows | Where-Object { (Get-ScanUrlKey $_.product_url) -eq $key })
                $record = [pscustomobject]@{ product_url = $row[0].product_url; group = $Group; scenes = ($wanted -join '|'); scene_sha256 = (@($picked | ForEach-Object { $_.sha256 }) -join '|'); scene_count = [string]$wanted.Count; prepared_at = $(if ($mineRow.Count) { [string]$mineRow[0].prepared_at } else { Get-Stamp }); status = 'consumed'; consumed_at = (Get-Stamp); consumed_by = $consumedBy }
                Write-PreparedRows $dir (@($rows | Where-Object { (Get-ScanUrlKey $_.product_url) -ne $key }) + @($record))
                $true
            })
            Write-ScanJson ([ordered]@{ project = $ProjectId; url = $row[0].product_url; product_file = $productFile; scenes = @($picked | ForEach-Object { $_.file }) })
        }
        'prep-todo' {
            # The products still to prepare: the project's rows (same filters as queue-todo), not queued, with no row in prepared.csv yet; -Limit caps it.
            # -RetrySkipped also lists the products whose row is skipped:no-fit (prep-add then replaces that row); ready / consumed rows are never listed.
            $dir = Get-ScanDir $ProjectId
            $queued = Get-QueuedKeys
            $have = New-Object System.Collections.Generic.HashSet[string]
            foreach ($pr in @(Read-PreparedRows $dir)) { if ($RetrySkipped -and ([string]$pr.status).StartsWith('skipped')) { continue }; [void]$have.Add((Get-ScanUrlKey $pr.product_url)) }
            $todo = @(Get-ProjectCandidates $dir | Where-Object { -not $queued.Contains((Get-ScanUrlKey $_.product_url)) -and -not $have.Contains((Get-ScanUrlKey $_.product_url)) })
            $todo = @(Select-OnlyFile $todo { param($r) $r.product_url })
            if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
            # -Grouped: products by kind (collection, else a type word of the title), chunks of 20, each with a product contact sheet when -Sheet.
            if ($Grouped) { Write-ScanJson ([ordered]@{ project = $ProjectId; count = $todo.Count; groups = @(Get-ProductGroups $todo $dir ([bool]$Sheet)) }) }
            else { Write-ScanJson ([ordered]@{ project = $ProjectId; count = $todo.Count; products = @($todo | ForEach-Object { [ordered]@{ url = $_.product_url; title = $_.title; collection = $_.collection; image = (Join-Path (Join-Path $dir 'images') $_.product_image) } }) }) }
        }
        'prep-add' {
            # Stores the scene picks of ONE product in prepared.csv the moment they are made (-Group, -SceneNames a.jpg,b.jpg, -SceneCount S), or notes it as
            # skipped:no-fit with -Skip [-Reason text]. Same checks as queue-add; nothing is copied and urls.txt / references.json are not touched.
            Import-QueueLibs
            $dir = Get-ScanDir $ProjectId
            if (-not $Url) { Fail-Scan '-Url is required.' 'BAD_URL' }
            $key = Get-ScanUrlKey $Url
            $row = @(Read-ScanRows (Join-Path $dir 'products.csv') | Where-Object { (Get-ScanUrlKey $_.product_url) -eq $key })
            if (-not $row.Count) { Fail-Scan "The link is not in project $ProjectId." 'UNKNOWN_URL' }
            if ((Get-QueuedKeys).Contains($key)) { Fail-Scan 'This link is already in the queue; nothing to prepare.' 'ALREADY_QUEUED' }
            $record = [pscustomobject]@{ product_url = $row[0].product_url; group = ''; scenes = ''; scene_sha256 = ''; scene_count = ''; prepared_at = (Get-Stamp); status = ''; consumed_at = ''; consumed_by = '' }
            if ($Skip) {
                $record.status = 'skipped:no-fit'; if ($Reason) { $record.group = ($Reason -replace '\s+', ' ').Trim() }
            } else {
                if (-not $Group) { Fail-Scan '-Group is required (the library group the scenes come from).' 'BAD_GROUP' }
                $wanted = @($SceneNames -split '[,|]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
                if ($wanted.Count -lt 1 -or $wanted.Count -gt 4 -or @($wanted | Sort-Object -Unique).Count -ne $wanted.Count) { Fail-Scan 'Pass 1 to 4 different photos: -SceneNames a.jpg,b.jpg.' 'BAD_SCENES' }
                if ($SceneCount -gt 0 -and $SceneCount -ne $wanted.Count) { Fail-Scan "Pass exactly $SceneCount photos in -SceneNames (got $($wanted.Count))." 'BAD_SCENES' }
                $check = Test-SceneSet $Url $Group $wanted @() ([bool]$AllowReuse)
                Save-PHashCache
                if (-not $check.ok) { Fail-Scan $check.error $check.cause }
                $record.group = $Group; $record.scenes = (@($check.photos | ForEach-Object { $_.name }) -join '|'); $record.scene_sha256 = (@($check.photos | ForEach-Object { $_.sha256 }) -join '|')
                $record.scene_count = [string]$check.photos.Count; $record.status = 'ready'
            }
            $result = Use-PreparedLock $dir {
                $rows = @(Read-PreparedRows $dir)
                $existing = @($rows | Where-Object { (Get-ScanUrlKey $_.product_url) -eq $key })
                if (@($existing | Where-Object { $_.status -in @('ready', 'consumed') }).Count) { return [pscustomobject]@{ ok = $false; error = 'This product is already prepared (ready or consumed); it was left as it is.'; cause = 'ALREADY_PREPARED' } }
                $rows = @($rows | Where-Object { (Get-ScanUrlKey $_.product_url) -ne $key }) + @($record)
                Write-PreparedRows $dir $rows
                return [pscustomobject]@{ ok = $true }
            }
            if (-not $result.ok) { Fail-Scan $result.error $result.cause }
            Write-ScanJson ([ordered]@{ project = $ProjectId; url = $record.product_url; status = $record.status; group = $record.group; scenes = $record.scenes })
        }
        'prep-status' {
            # Counts for the project (narrowed by -Collection / -UnusedOnly): products, ready, skipped, consumed, still to prepare.
            $dir = Get-ScanDir $ProjectId
            $queued = Get-QueuedKeys
            $inFilter = @(Get-ProjectCandidates $dir)
            $candidates = @($inFilter | Where-Object { -not $queued.Contains((Get-ScanUrlKey $_.product_url)) })
            $prepared = @(Read-PreparedRows $dir)
            $byKey = @{}; foreach ($pr in $prepared) { $byKey[(Get-ScanUrlKey $pr.product_url)] = $pr }
            $ready = @($candidates | Where-Object { $byKey.ContainsKey((Get-ScanUrlKey $_.product_url)) -and $byKey[(Get-ScanUrlKey $_.product_url)].status -eq 'ready' }).Count
            $skipped = @($candidates | Where-Object { $byKey.ContainsKey((Get-ScanUrlKey $_.product_url)) -and ([string]$byKey[(Get-ScanUrlKey $_.product_url)].status).StartsWith('skipped') }).Count
            # ready_usable = ready rows with at least -SceneCount scenes (the rows Thêm vào hàng chờ can take with that number of scenes)
            $readyUsable = @($candidates | Where-Object { $k = Get-ScanUrlKey $_.product_url; $byKey.ContainsKey($k) -and $byKey[$k].status -eq 'ready' -and ($SceneCount -le 0 -or [int]$byKey[$k].scene_count -ge $SceneCount) }).Count
            # products = rows of the filter NOT in this window's queue; in_queue = rows of the filter already queued; in_filter = all rows of the filter (with a photo)
            Write-ScanJson ([ordered]@{ project = $ProjectId; in_filter = $inFilter.Count; in_queue = ($inFilter.Count - $candidates.Count); products = $candidates.Count; ready = $ready; ready_usable = $readyUsable; skipped = $skipped; to_prepare = ($candidates.Count - $ready - $skipped)
                    consumed_total = @($prepared | Where-Object { $_.status -eq 'consumed' }).Count; ready_total = @($prepared | Where-Object { $_.status -eq 'ready' }).Count })
        }
        'queue-from-prepared' {
            # Puts up to -Limit READY rows of prepared.csv into the queue instantly (no agent): the project's products in table order (same filters as queue-todo),
            # not queued yet. Every row is re-validated first (scene files exist, sha256 matches, scene not used by another product); a row that no longer
            # validates is dropped back to "not prepared"; a queued row becomes consumed. -SceneCount S takes only rows with at least S scenes and queues the first S.
            Import-QueueLibs
            $dir = Get-ScanDir $ProjectId
            if ($Limit -lt 1) { Fail-Scan '-Limit must be 1 or more.' 'BAD_LIMIT' }
            $session = if ($env:PR_SESSION) { $env:PR_SESSION } else { 'default' }
            $sceneDir = Join-Path (Get-SessionWorkspaceDir $ProjectRoot) "reference-inputs/$ProjectId-scenes"
            # PR_SCAN_TRACE=1 prints where the time goes (stderr); -DryRun validates and reports but writes nothing.
            $trace = $env:PR_SCAN_TRACE -eq '1'; $watch = [Diagnostics.Stopwatch]::StartNew()
            $mark = { param($what) if ($trace) { [Console]::Error.WriteLine(('[trace] {0,7:N1}s {1}' -f $watch.Elapsed.TotalSeconds, $what)) } }
            $answer = Use-PreparedLock $dir {
                & $mark 'lock taken'
                $rows = @(Read-PreparedRows $dir)
                & $mark ('prepared rows read: ' + $rows.Count)
                $queued = Get-QueuedKeys
                & $mark ('queued keys: ' + $queued.Count)
                $byKey = @{}; foreach ($pr in $rows) { $byKey[(Get-ScanUrlKey $pr.product_url)] = $pr }
                $queuedUrls = @(); $dropped = @(); $drop = @{}
                $candidatesAll = @(Get-ProjectCandidates $dir)
                & $mark ('candidates: ' + $candidatesAll.Count)
                foreach ($candidate in $candidatesAll) {
                    if ($queuedUrls.Count -ge $Limit) { break }
                    $k = Get-ScanUrlKey $candidate.product_url
                    if ($queued.Contains($k) -or -not $byKey.ContainsKey($k)) { continue }
                    $pr = $byKey[$k]
                    if ($pr.status -ne 'ready') { continue }
                    $names = @(([string]$pr.scenes) -split '\|' | Where-Object { $_ }); $shas = @(([string]$pr.scene_sha256) -split '\|' | Where-Object { $_ })
                    if ($SceneCount -gt 0 -and $names.Count -lt $SceneCount) { continue }
                    if ($SceneCount -gt 0) { $names = @($names | Select-Object -First $SceneCount); $shas = @($shas | Select-Object -First $SceneCount) }
                    $check = $null
                    try { $check = Test-SceneSet $candidate.product_url ([string]$pr.group) $names $shas $false } catch { $check = [pscustomobject]@{ ok = $false; error = $_.Exception.Message; cause = 'TOOL_ERROR' } }
                    & $mark ('validated ' + $candidate.product_url + ' ok=' + $check.ok)
                    if (-not $check.ok) { $drop[$k] = $true; $dropped += [ordered]@{ url = $candidate.product_url; cause = $check.cause; reason = ($check.error -replace '^\[CAUSE:[A-Z_]+\]\s*', '') }; continue }
                    if ($DryRun) { $queuedUrls += $candidate.product_url; continue }
                    $handle = Get-Slug (([Uri]$candidate.product_url).Segments[-1].Trim('/')) 80
                    New-Item -ItemType Directory -Force -Path $sceneDir | Out-Null
                    $picked = @(); $n = 0; $copyFailed = ''
                    foreach ($photo in $check.photos) {
                        $n++
                        $target = Join-Path $sceneDir ("$handle-scene$n" + [IO.Path]::GetExtension($photo.file).ToLowerInvariant())
                        Copy-Item -LiteralPath $photo.file -Destination $target -Force
                        if ((Get-FileHashText $target 'SHA256') -ne $photo.sha256) { $copyFailed = "Copy of $($photo.name) is damaged." }
                        $picked += [pscustomobject]@{ file = $target; sha256 = $photo.sha256 }
                    }
                    if ($copyFailed) { $dropped += [ordered]@{ url = $candidate.product_url; cause = 'SCENE_COPY'; reason = $copyFailed }; continue }
                    [void](Add-QueueEntry $dir $candidate $picked)
                    $pr.status = 'consumed'; $pr.consumed_at = (Get-Stamp); $pr.consumed_by = $session
                    $queuedUrls += $candidate.product_url
                }
                if (-not $DryRun) { Write-PreparedRows $dir @($rows | Where-Object { -not $drop.ContainsKey((Get-ScanUrlKey $_.product_url)) }) }
                & $mark 'done'
                return [ordered]@{ queued = $queuedUrls; dropped = $dropped }
            }
            Save-PHashCache
            $remainingReady = @(Read-PreparedRows $dir | Where-Object { $_.status -eq 'ready' }).Count
            Write-ScanJson ([ordered]@{ project = $ProjectId; requested = $Limit; queued = @($answer.queued).Count; shortfall = ($Limit - @($answer.queued).Count); urls = @($answer.queued); dropped = @($answer.dropped); ready_left = $remainingReady })
        }
        'scene-index-status' {
            # Counts for the Dự án popup: photos of every enabled library group and how many have a current index entry (same md5).
            $index = Read-SceneIndex
            $groups = @()
            try {
                foreach ($g in @(@((Get-SourceManifest).groups) | Where-Object { $_.enabled -ne $false })) {
                    $name = ([string]$g.name).Normalize([Text.NormalizationForm]::FormC)
                    $groupFiles = @($g.files)
                    $done = @($groupFiles | Where-Object { $e = $index[(Get-SceneIndexKey $name ([string]$_.name))]; $e -and [string]$e.md5 -eq [string]$_.md5 }).Count
                    $groups += [ordered]@{ group = $name; photos = $groupFiles.Count; indexed = $done }
                }
                $offline = $false
            } catch { $offline = $true }
            $photos = 0; $indexed = 0; foreach ($g in $groups) { $photos += $g.photos; $indexed += $g.indexed }
            if ($offline) { $indexed = $index.Count }
            Write-ScanJson ([ordered]@{ photos = $photos; indexed = $indexed; entries = $index.Count; offline = $offline; groups = $groups; file = $SceneIndexPath })
        }
        'scene-index-todo' {
            # The next photos of a group that have no current index entry (-Category narrows, -Limit 1-24, default 20), downloaded and hashed, and ONE
            # contact sheet of them (-Out <png>, default this session's tmp/contact-sheets). A photo visually identical to an indexed photo (or to an earlier
            # photo of this batch) is recorded at once as dup_of (no tags) and not listed. Claude Reads the sheet once and writes the tags with scene-index-add.
            if (-not $Group) { Fail-Scan 'Pass -Group <library group> (scenes lists the groups).' 'BAD_GROUP' }
            $take = if ($Limit -gt 0) { [Math]::Min(24, $Limit) } else { 20 }
            $index = Read-SceneIndex
            $all = @(Get-LibraryPhotosCached $Group | Where-Object { -not $Category -or $_.category -eq $Category })
            if (-not $all.Count) { Fail-Scan "No photos in group $Group." 'UNKNOWN_GROUP' }
            $todo = @($all | Where-Object { -not (Get-SceneIndexEntry $index $Group $_) } | Sort-Object @{ Expression = { [string]$_.md5 } })
            if ($Shard) { $todo = @($todo | Where-Object { Test-InShard ([string]$_.name) }) }
            $known = @($index.Values | Where-Object { $_.phash -and -not $_.dup_of })
            $picked = @(); $dups = @{}; $failed = @()
            foreach ($photo in $todo) {
                if ($picked.Count -ge $take) { break }
                try { $local = Get-LibraryPhotoFile $Group $photo } catch { $failed += [ordered]@{ name = $photo.name; error = ($_.Exception.Message -replace '^\[CAUSE:[A-Z_]+\]\s*', '') }; continue }
                $hash = Get-PHash $local ("lib:$Group/$($photo.name):$($photo.md5)")
                $same = @($known | Where-Object { (Get-PHashDistance $hash $_.phash) -le $SceneSameDistance } | Select-Object -First 1)
                if (-not $same.Count) { $same = @($picked | Where-Object { (Get-PHashDistance $hash $_.phash) -le $SceneSameDistance } | Select-Object -First 1) }
                if ($same.Count) {
                    $dups[(Get-SceneIndexKey $Group $photo.name)] = [ordered]@{ group = $Group; name = $photo.name; category = $photo.category; md5 = $photo.md5; sha256 = (Get-FileHashText $local 'SHA256'); phash = $hash; dup_of = ([string]$same[0].group + '/' + [string]$same[0].name); usable = $false; indexed_at = (Get-Stamp) }
                    continue
                }
                $picked += [pscustomobject]@{ number = $picked.Count + 1; name = $photo.name; category = $photo.category; path = $local; phash = $hash; group = $Group }
            }
            Save-PHashCache
            if ($dups.Count) { [void](Save-SceneIndexEntries $dups) }
            $answer = [ordered]@{ group = $Group; left = [Math]::Max(0, $todo.Count - $picked.Count - $dups.Count); count = $picked.Count; dup_recorded = $dups.Count; failed = $failed }
            if ($picked.Count) {
                $outPath = if ($Out) { $Out } else { Get-ContactSheetPath (Get-SessionWorkspaceDir $ProjectRoot) 'index' }
                $made = New-ContactSheet $picked $outPath $Cols
                $answer['sheet'] = $made.sheet
            }
            $answer['photos'] = @($picked | ForEach-Object { [ordered]@{ n = $_.number; name = $_.name; category = $_.category } })
            Write-ScanJson $answer
        }
        'scene-index-add' {
            # Stores the tags Claude wrote after looking at the photos (one sheet = one call). -File: a JSON array of
            # { group, name, setting, people yes|no, light day|night|warm, wall_space yes|no, fits ["neon wall sign", ...], note, usable (default yes) }.
            # Each item is checked (photo in the library and on disk, fields valid); valid items are written at once under the index lock, the others are
            # listed in `errors` (fix and send only those again). sha256 and phash are computed here, never typed by Claude.
            if (-not $File -or -not (Test-Path -LiteralPath $File)) { Fail-Scan '-File must be the JSON file of tags.' 'BAD_FILE' }
            $data = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
            $items = @(foreach ($entry in $data) { $entry })
            if (-not $items.Count) { Fail-Scan 'The tag file has no items.' 'BAD_FILE' }
            $entries = @{}; $errors = @()
            $by = if ($env:PR_SESSION) { $env:PR_SESSION } else { 'default' }
            foreach ($it in $items) {
                $get = { param($n) $p = $it.PSObject.Properties[$n]; if ($p) { $p.Value } else { $null } }
                $g = [string](& $get 'group'); $n = [string](& $get 'name')
                try {
                    if (-not $g -or -not $n) { throw 'group and name are required.' }
                    $photo = @(Get-LibraryPhotosCached $g | Where-Object { $_.name -eq $n })
                    if (-not $photo.Count) { throw "No photo '$n' in group $g." }
                    $usable = if ($null -eq (& $get 'usable')) { $true } else { ConvertTo-SceneBool (& $get 'usable') 'usable' }
                    $setting = ([string](& $get 'setting')).Trim().ToLowerInvariant() -replace '\s+', ' '
                    if ($setting -notmatch '^[a-z][a-z /-]{1,39}$') { throw 'setting must be a short English place (bedroom, kids room, bar counter, cafe window, wedding backdrop, living room, dining room, office, outdoor, studio ...).' }
                    $light = ([string](& $get 'light')).Trim().ToLowerInvariant()
                    if ($SceneLights -notcontains $light) { throw 'light must be day, night or warm.' }
                    $people = ConvertTo-SceneBool (& $get 'people') 'people'
                    $wall = ConvertTo-SceneBool (& $get 'wall_space') 'wall_space'
                    $rawFits = & $get 'fits'
                    $fitsList = @(@(if ($rawFits -is [array]) { $rawFits } else { ([string]$rawFits) -split '[,;]' }) | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() -replace '\s+', ' ' } | Where-Object { $_ } | Sort-Object -Unique)
                    if ($usable -and -not $fitsList.Count) { throw 'fits must list at least one product type (or set usable: no).' }
                    if ($fitsList.Count -gt 12 -or @($fitsList | Where-Object { $_.Length -gt 60 }).Count) { throw 'fits: at most 12 types of 60 characters each.' }
                    $note = ([string](& $get 'note')).Trim() -replace '\s+', ' '
                    if ($note.Length -gt 160) { $note = $note.Substring(0, 160) }
                    $local = Get-LibraryPhotoFile $g $photo[0]
                    $entries[(Get-SceneIndexKey $g $n)] = [ordered]@{ group = $g.Normalize([Text.NormalizationForm]::FormC); name = $n; category = $photo[0].category; md5 = $photo[0].md5; sha256 = (Get-FileHashText $local 'SHA256')
                        phash = (Get-PHash $local ("lib:$g/$($n):$($photo[0].md5)")); setting = $setting; people = $people; light = $light; wall_space = $wall; fits = @($fitsList); note = $note; usable = $usable; dup_of = ''; indexed_at = (Get-Stamp); by = $by }
                } catch { $errors += [ordered]@{ group = $g; name = $n; error = ($_.Exception.Message -replace '^\[CAUSE:[A-Z_]+\]\s*', '') } }
            }
            Save-PHashCache
            $total = if ($entries.Count) { Save-SceneIndexEntries $entries } else { (Read-SceneIndex).Count }
            Write-ScanJson ([ordered]@{ added = $entries.Count; errors = $errors; index_entries = $total })
        }
        'scene-candidates' {
            # The SAMPLE for one product: -Group's photos in a random order (-Seed, default project + window; -Draw 1..3 = another sample), minus the photos the
            # used-scene ledger holds and the ones that fail the file filters (on disk, size, shape, used by another product, copy of a chosen one). -Limit = K (default 16,
            # max 60). Numbered contact sheets (20 per sheet). Claude looks at the sheet and picks the scenes that fit; nothing is claimed until it records them.
            if (-not $Group) { Fail-Scan 'Pass -Group "<library group>" (CLI scenes lists them).' 'BAD_GROUP' }
            $take = if ($Limit -gt 0) { [Math]::Min(60, $Limit) } else { 16 }
            $drawNo = [Math]::Max(1, [Math]::Min(3, [int]$Draw))
            $sessionTag = if ($env:PR_SESSION) { $env:PR_SESSION } else { 'default' }
            $seedText = $(if ($Seed) { [string]$Seed } else { [string]$Project + '|' + $sessionTag }) + '|' + $drawNo
            $g = $Group.Normalize([Text.NormalizationForm]::FormC)
            $pool = Get-ScenePool $g $Category $seedText ''
            if (-not $pool.photos) { Fail-Scan "The library group $g has no photos: pick a group from 'scenes'." 'NO_SCENES' }
            $chosen = @(); $hashes = @(); $tried = 0
            foreach ($item in $pool.items) {
                if ($chosen.Count -ge $take -or $tried -gt ($take * 12 + 60)) { break }
                $tried++
                $c = Get-SceneCandidate $item '' $hashes
                if (-not $c) { continue }
                $hashes += $c.hash
                $chosen += [pscustomobject]@{ item = $item; file = $c.file }
            }
            Save-PHashCache
            $i = 0
            $items = @($chosen | ForEach-Object { $i++; [pscustomobject]@{ number = $i; name = $_.item.photo.name; path = $_.file; c = $_.item } })
            $sheets = @()
            if ($items.Count) { $sheets = @(New-ContactSheets $items $(if ($Out) { $Out } else { Get-ContactSheetPath (Get-SessionWorkspaceDir $ProjectRoot) 'candidates' }) $Cols 20) }
            Write-ScanJson ([ordered]@{ group = $g; draw = $drawNo; max_draws = 3; photos_in_group = $pool.photos; free = $pool.free; count = $items.Count; sheets = $sheets; candidates = @($items | ForEach-Object { [ordered]@{ n = $_.number; name = $_.name } }) })
        }
        'scene-apply' {
            # Batch: -File picks.json = [ {"url": "...", "group": "Áo", "scenes": ["a.jpg","b.jpg"]}, {"url": "...", "skip": true, "reason": "..."} ]; -Mode prep | queue
            # (prep-add-many / queue-add-many). Every product goes through the same checks as prep-add / queue-add (sha256, not a copy, not used by another product);
            # one that fails is reported with its cause, the others are still written. One lock for prepared.csv.
            Import-QueueLibs
            $dir = Get-ScanDir $ProjectId
            if ($Mode -notin @('prep', 'queue')) { Fail-Scan '-Mode must be prep or queue.' 'BAD_MODE' }
            if (-not $File -or -not (Test-Path -LiteralPath $File)) { Fail-Scan 'Pass -File <picks.json>.' 'BAD_FILE' }
            $picks = (Get-Content -LiteralPath $File -Raw -Encoding UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
            $queued = Get-QueuedKeys
            $rowsByKey = @{}; foreach ($r in @(Read-ScanRows (Join-Path $dir 'products.csv'))) { $rowsByKey[(Get-ScanUrlKey $r.product_url)] = $r }
            $records = @(); $okList = @(); $failed = @()
            foreach ($p in @($picks)) {
                $k = Get-ScanUrlKey ([string]$p.url)
                if (-not $rowsByKey.ContainsKey($k)) { $failed += [ordered]@{ url = [string]$p.url; cause = 'UNKNOWN_URL'; error = "The link is not in project $ProjectId." }; continue }
                if ($queued.Contains($k)) { $failed += [ordered]@{ url = [string]$p.url; cause = 'ALREADY_QUEUED'; error = 'Already in the queue.' }; continue }
                $row = $rowsByKey[$k]
                if ($p.skip) { $records += (New-SkipRecord $row $(if ($p.reason) { ([string]$p.reason -replace '\s+', ' ').Trim() } else { 'no photo fits' })); $okList += [ordered]@{ url = $row.product_url; skipped = $true }; continue }
                $pNames = @(@($p.scenes) | ForEach-Object { [string]$_ } | Where-Object { $_ })
                if ($pNames.Count -lt 1 -or $pNames.Count -gt 4 -or @($pNames | Sort-Object -Unique).Count -ne $pNames.Count) { $failed += [ordered]@{ url = [string]$p.url; cause = 'BAD_SCENES'; error = 'Pass 1 to 4 different photos.' }; continue }
                if ($SceneCount -gt 0 -and $SceneCount -ne $pNames.Count) { $failed += [ordered]@{ url = [string]$p.url; cause = 'BAD_SCENES'; error = "Pass exactly $SceneCount photos (got $($pNames.Count))." }; continue }
                $check = try { Test-SceneSet $row.product_url ([string]$p.group) $pNames @() ([bool]$AllowReuse) } catch { [pscustomobject]@{ ok = $false; error = $_.Exception.Message; cause = 'TOOL_ERROR' } }
                if (-not $check.ok) { $failed += [ordered]@{ url = [string]$p.url; cause = $check.cause; error = ($check.error -replace '^\[CAUSE:[A-Z_]+\]\s*', '') }; continue }
                # picks of this call count as used for the next products of the file
                $script:UsedScenesCache = @($script:UsedScenesCache) + @($check.photos | ForEach-Object { [pscustomobject]@{ hash = [string](Get-PHash $_.file ("lib:$([string]$p.group)/$($_.name):$($_.md5)")); url = [string]$row.product_url; where = 'this call' } })
                $rec = if ($DryRun) { $null } else { try { Save-SceneResult $Mode $row ([string]$p.group) $check $dir } catch { $failed += [ordered]@{ url = [string]$p.url; cause = 'SCENE_COPY'; error = $_.Exception.Message }; continue } }
                if (-not $DryRun -and -not $rec) { $failed += [ordered]@{ url = [string]$p.url; cause = 'ALREADY_QUEUED'; error = 'Queued meanwhile.' }; continue }
                if ($rec) { $records += $rec }
                $okList += [ordered]@{ url = $row.product_url; scenes = @($pNames) }
            }
            Save-PHashCache
            if (-not $DryRun) { Save-PreparedRecords $Mode $dir $records }
            Write-ScanJson ([ordered]@{ project = $ProjectId; mode = $Mode; dry_run = [bool]$DryRun; written = $okList.Count; failed = $failed.Count; ok_items = $okList; errors = $failed })
        }
        'scene-auto' {
            # No agent ("Bốc ngẫu nhiên, không AI"): -Mode prep | queue. Products = the filters of queue-todo / prep-todo (-Limit caps them). Each takes the next
            # photos of the library group that fits its title / collection (-Group forces one) from the filtered pool of that group (Get-ScenePool, seeded by -Seed,
            # default the project id), one cursor per group so two products never share a photo. Same checks and writers as scene-apply.
            Import-QueueLibs
            $dir = Get-ScanDir $ProjectId
            if ($Mode -notin @('prep', 'queue')) { Fail-Scan '-Mode must be prep or queue.' 'BAD_MODE' }
            $S = [Math]::Min(4, [Math]::Max(1, $(if ($SceneCount -gt 0) { $SceneCount } else { 2 })))
            $trace = $env:PR_SCAN_TRACE -eq '1'; $watch = [Diagnostics.Stopwatch]::StartNew()
            $mark = { param($what) if ($trace) { [Console]::Error.WriteLine(('[trace] {0,7:N1}s {1}' -f $watch.Elapsed.TotalSeconds, $what)) } }
            $seedText = if ($Seed) { [string]$Seed } else { [string]$ProjectId }
            $strip = { param($t) (([string]$t).ToLowerInvariant().Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}', '' -replace [char]0x111, 'd') }
            $groupNames = @(@((Get-SourceManifest).groups) | Where-Object { $_.enabled -ne $false } | ForEach-Object { [string]$_.name })
            $kinds = @(
                @{ key = 'the thao'; words = 'jersey fishing running cycling golf sport hiking camping outdoor soccer football baseball basketball' },
                @{ key = 'mu'; words = 'hat cap beanie bucket snapback visor' },
                @{ key = 'coc'; words = 'mug cup tumbler bottle flask thermos' },
                @{ key = 'noi that'; words = 'furniture table chair sofa shelf desk bed stool cabinet' },
                @{ key = 'trang tri'; words = 'sign neon wall art decor poster canvas pillow blanket frame lamp plaque ornament' },
                @{ key = 'ao'; words = 'shirt tee tshirt polo hoodie sweatshirt sweater jacket tank crewneck dress top apparel' }
            )
            $resolve = {
                param($row)
                if ($Group) { return $Group.Normalize([Text.NormalizationForm]::FormC) }
                $text = ' ' + ((& $strip ($row.title + ' ' + $row.collection + ' ' + ([string]$row.product_url -replace '^.*/', ''))) -replace '[^a-z0-9]+', ' ') + ' '
                $best = ''; $bestScore = 0
                foreach ($k in $kinds) {
                    $gname = @($groupNames | Where-Object { (& $strip $_) -like ('*' + $k.key + '*') } | Select-Object -First 1)
                    if (-not $gname.Count) { continue }
                    $score = @($k.words -split ' ' | Where-Object { $text.Contains(' ' + $_ + ' ') -or $text.Contains(' ' + $_ + 's ') }).Count
                    if ($score -gt $bestScore) { $best = [string]$gname[0]; $bestScore = $score }
                }
                if ($best) { return $best }
                foreach ($g in $groupNames) { foreach ($w in @((& $strip $g) -split '[^a-z0-9]+' | Where-Object { $_.Length -ge 3 })) { if ($text.Contains(' ' + $w + ' ')) { return $g } } }
                return ''
            }
            $queued = Get-QueuedKeys
            $haveRow = @{}; foreach ($pr in @(Read-PreparedRows $dir)) { $haveRow[(Get-ScanUrlKey $pr.product_url)] = $pr }
            $todo = @(Get-ProjectCandidates $dir | Where-Object {
                    $k = Get-ScanUrlKey $_.product_url
                    -not $queued.Contains($k) -and $(if ($Mode -eq 'prep') { -not $haveRow.ContainsKey($k) -or ($RetrySkipped -and ([string]$haveRow[$k].status).StartsWith('skipped')) } else { -not $haveRow.ContainsKey($k) -or $haveRow[$k].status -ne 'ready' })
                })
            $todo = @(Select-OnlyFile $todo { param($r) $r.product_url })
            if ($Limit -gt 0) { $todo = @($todo | Select-Object -First $Limit) }
            [void](Get-UsedScenes)
            & $mark ('products: ' + $todo.Count + ', used scenes read')
            $pools = @{}; $cursor = @{}
            $records = @(); $done = @(); $left = @()
            foreach ($row in $todo) {
                $g = & $resolve $row
                if (-not $g -or -not (@($groupNames) -contains $g)) { $left += [ordered]@{ url = $row.product_url; reason = 'no library group fits this product (pass -Group)' }; if ($Mode -eq 'prep') { $records += (New-SkipRecord $row 'no library group') }; continue }
                if (-not $pools.ContainsKey($g)) { $pools[$g] = Get-ScenePool $g '' $seedText ''; $cursor[$g] = 0; & $mark ("pool $g : " + $pools[$g].photos + ' photos, ') }
                $items = $pools[$g].items
                $chosenItems = @(); $hashes = @()
                while ($chosenItems.Count -lt $S -and $cursor[$g] -lt $items.Count) {
                    $item = $items[$cursor[$g]]; $cursor[$g] = $cursor[$g] + 1
                    $c = Get-SceneCandidate $item $row.product_url $hashes
                    if (-not $c) { continue }
                    $hashes += $c.hash; $chosenItems += $item
                }
                if ($chosenItems.Count -lt $S) { $left += [ordered]@{ url = $row.product_url; reason = "not enough unused photos in $g" }; if ($Mode -eq 'prep') { $records += (New-SkipRecord $row "not enough photos in $g") }; continue }
                $pNames = @($chosenItems | ForEach-Object { [string]$_.photo.name })
                $check = Test-SceneSet $row.product_url $g $pNames @() $false
                if (-not $check.ok) { $left += [ordered]@{ url = $row.product_url; reason = ($check.error -replace '^\[CAUSE:[A-Z_]+\]\s*', '') }; continue }
                $script:UsedScenesCache = @($script:UsedScenesCache) + @($hashes | ForEach-Object { [pscustomobject]@{ hash = $_; url = [string]$row.product_url; where = 'this run' } })
                if (-not $DryRun) { $rec = Save-SceneResult $Mode $row $g $check $dir; if (-not $rec) { continue }; $records += $rec }
                $done += [ordered]@{ url = $row.product_url; group = $g; scenes = $pNames }
                & $mark ('product ' + $done.Count)
            }
            Save-PHashCache
            if (-not $DryRun) { Save-PreparedRecords $Mode $dir $records }
            & $mark 'done'
            Write-ScanJson ([ordered]@{ project = $ProjectId; mode = $Mode; dry_run = [bool]$DryRun; scenes = $S; requested = $todo.Count; done = $done.Count; left_out = $left.Count; urls = @($done | ForEach-Object { $_.url }); items = $done; reasons = $left; seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 1) })
        }
        'contact-sheet' {
            # One sheet (or several of 20) of library photos (-Group g -Names a,b,c; -SceneNames works too) or of any files (-Files p1,p2), numbered in the
            # given order, with the legend number -> name (also saved as <png>.json). -Cols (default 4), -Out <png>.
            $list = @(); $i = 0
            $wanted = @((@($Names, $SceneNames) -join ',') -split '[,|]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            if ($wanted.Count) {
                if (-not $Group) { Fail-Scan 'Pass -Group with -Names (library photos).' 'BAD_GROUP' }
                foreach ($w in $wanted) {
                    $photo = @(Get-LibraryPhotosCached $Group | Where-Object { $_.name -eq $w })
                    if (-not $photo.Count) { Fail-Scan "No photo '$w' in group $Group." 'UNKNOWN_SCENE' }
                    $i++; $list += [pscustomobject]@{ number = $i; name = $w; path = (Get-LibraryPhotoFile $Group $photo[0]) }
                }
            }
            foreach ($f in @($Files -split '[,|]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
                if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Fail-Scan "File not found: $f" 'BAD_FILE' }
                $i++; $list += [pscustomobject]@{ number = $i; name = $f; path = $f }
            }
            if (-not $list.Count) { Fail-Scan 'Pass -Group g -Names a,b,c or -Files p1,p2.' 'BAD_SHEET' }
            $sheets = @(New-ContactSheets $list $(if ($Out) { $Out } else { Get-ContactSheetPath (Get-SessionWorkspaceDir $ProjectRoot) 'sheet' }) $Cols 20)
            Write-ScanJson ([ordered]@{ count = $list.Count; sheets = $sheets; legend = @($list | ForEach-Object { [ordered]@{ n = $_.number; name = $_.name } }) })
        }
        default { Fail-Scan "Unknown command '$Command'. Use: start | known | add | add-many | set-menu | status | finish | projects | project | set-used | reviews-todo | set-reviews | queue-direct | queue-todo | scenes | scene-get | queue-add | prep-todo | prep-add | prep-status | queue-from-prepared | scene-index-status | scene-index-todo | scene-index-add | scene-candidates | contact-sheet" 'BAD_COMMAND' }
    }
} catch {
    Fail-Scan $_.Exception.Message 'TOOL_ERROR'
}
