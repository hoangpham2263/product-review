# Du an (project store) and Quet web: everything a web project keeps lives in workspace/projects/<id>/ so a shop is scanned once and
# then only updated:
#   project.json  {id, name, site, host, created, updated, last_scan, last_reviews_check, max_per_collection}
#   menu.json     [{name, url, products}]  the categories of the site and how many products each holds here
#   products.csv  the table Nhap hang loat reads (columns below); `used` = F until the link has been run, then T
#   images/       the main image of each product
#   reviews.json  what was last seen per product link: {count, rating, source, checked_at} (only the numbers Claude reports)
#   session.json  the current scan: which links were seen / added (a merge never deletes anything)
# Older scans in workspace/scans/<id>/ (same table) still get `used` updates. Plumbing only: Claude finds the products and reads the
# review numbers on the pages (docs/scan-prompt.md, docs/reviews-count-prompt.md); these functions only write what it reports.
$script:ScanColumns = @('product_url', 'product_image', 'review_images', 'sign_text', 'title', 'collection', 'used', 'reviews_count', 'reviews_checked_at')

function Get-ProjectsRoot([string]$ProjectRoot = '') {
    if (-not $ProjectRoot) { $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
    return (Join-Path $ProjectRoot 'workspace/projects')
}
# Kept for older callers: the root where the scan tables live now.
function Get-ScanRoot([string]$ProjectRoot = '') { return (Get-ProjectsRoot $ProjectRoot) }
function Get-LegacyScanRoot([string]$ProjectRoot = '') {
    if (-not $ProjectRoot) { $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
    return (Join-Path $ProjectRoot 'workspace/scans')
}

# T / TRUE / 1 / X / Y / YES (any case) = used.
function Test-UsedFlag([string]$Value) {
    return ([string]$Value).Trim() -match '^(t|true|1|x|y|yes)$'
}

# One cell of the table: quoted, quotes doubled, one line (the import reads the file line by line).
function ConvertTo-ScanCell([string]$Value) {
    $one = (([string]$Value) -replace '\s+', ' ').Trim()
    return '"' + ($one -replace '"', '""') + '"'
}

function Read-ScanRows([string]$CsvPath) {
    if (-not (Test-Path -LiteralPath $CsvPath)) { return @() }
    $text = (Read-TextRetry $CsvPath) -replace '^﻿', ''
    $lines = @($text -split '\r?\n' | Where-Object { $_.Trim() })
    if ($lines.Count -lt 2) { return @() }
    return @($lines | ConvertFrom-Csv)
}

function Write-ScanRows([string]$CsvPath, $Rows) {
    $out = New-Object System.Collections.Generic.List[string]
    $out.Add($script:ScanColumns -join ',')
    foreach ($row in @($Rows)) {
        $out.Add((@($script:ScanColumns | ForEach-Object { $p = $row.PSObject.Properties[$_]; ConvertTo-ScanCell $(if ($p) { [string]$p.Value } else { '' }) }) -join ','))
    }
    Write-FileAtomic $CsvPath (($out -join "`r`n") + "`r`n") ([Text.UTF8Encoding]::new($true))
}

# The same product link for the same page: host in lower case, no #fragment, no trailing slash.
function Get-ScanUrlKey([string]$Url) {
    $u = ([string]$Url).Trim() -replace '#.*$', ''
    $uri = $null
    if ([Uri]::TryCreate($u, [UriKind]::Absolute, [ref]$uri)) { $u = $uri.GetLeftPart([UriPartial]::Scheme) + $uri.Host.ToLowerInvariant() + $(if (-not $uri.IsDefaultPort) { ':' + $uri.Port } else { '' }) + $uri.PathAndQuery }
    return $u.TrimEnd('/')
}

# ---- project files ----
# Several sessions can work on the same project folder (scan, review count, prep, queue-from-prepared, a finished link marking its row used): every
# change of products.csv / reviews.json / menu.json / project.json is a read-modify-write under ONE lock per project (Use-ProjectLock), re-reading the file
# inside the lock and changing only the touched rows, and every write goes through a temp file + rename (Write-FileAtomic).
. (Join-Path $PSScriptRoot '../../core/setup/atomic-file.ps1')
function Read-ProjectJson([string]$Path, $Default = $null) {
    if (-not (Test-Path -LiteralPath $Path)) { return $Default }
    try { return ((Read-TextRetry $Path) | ConvertFrom-Json) } catch { return $Default }
}
function Write-ProjectJson([string]$Path, $Value) {
    Write-FileAtomic $Path (ConvertTo-Json -InputObject $Value -Depth 8) ([Text.UTF8Encoding]::new($false))
}
function Get-ProjectSiteHost([string]$Value) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https') -or -not $uri.Host) { return '' }
    return ($uri.Host.ToLowerInvariant() -replace '^www\.', '')
}
# dreamyvows.com -> dreamyvows-com
function Get-ProjectId([string]$SiteHost) {
    $s = ([string]$SiteHost).ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    $s = $s.Trim('-')
    if ($s.Length -gt 60) { $s = $s.Substring(0, 60).Trim('-') }
    return $s
}
function Get-ProjectDir([string]$Root, [string]$Id) {
    if (-not $Id -or $Id -notmatch '^[a-z0-9][a-z0-9-]{1,60}$') { return '' }
    $dir = Join-Path $Root $Id
    if (Test-Path -LiteralPath (Join-Path $dir 'project.json')) { return $dir }
    return ''
}
function Get-Stamp { return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') }

# Finds the project of a site or creates it (products.csv with only the header, empty menu). Returns @{ Dir; Info; New }.
function Open-Project([string]$Root, [string]$Site, [int]$Max = 20) {
    $siteHost = Get-ProjectSiteHost $Site
    if (-not $siteHost) { throw 'The site must be the shop home page link (http or https).' }
    $id = Get-ProjectId $siteHost
    $dir = Join-Path $Root $id
    $isNew = -not (Test-Path -LiteralPath (Join-Path $dir 'project.json'))
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'images') | Out-Null
    if ($isNew) {
        # two sessions opening the same new site at once: only the first creates the files (re-checked inside the lock)
        [void](Use-ProjectLock $dir {
            if (Test-Path -LiteralPath (Join-Path $dir 'project.json')) { return $false }
            $info = [ordered]@{ id = $id; name = $siteHost; site = $Site.Trim(); host = $siteHost; created = (Get-Stamp); updated = (Get-Stamp); last_scan = ''; last_reviews_check = ''; max_per_collection = $Max }
            Write-ScanRows (Join-Path $dir 'products.csv') @()
            Write-ProjectJson (Join-Path $dir 'menu.json') @()
            Write-ProjectJson (Join-Path $dir 'project.json') $info
            return $true
        })
    }
    return @{ Dir = $dir; Info = (Read-ProjectJson (Join-Path $dir 'project.json')); New = $isNew }
}
function Save-ProjectInfo([string]$Dir, $Info) { Write-ProjectJson (Join-Path $Dir 'project.json') $Info }
function Set-ProjectField([string]$Dir, [string]$Name, $Value) { [void](Use-ProjectLock $Dir { Set-ProjectFieldCore $Dir $Name $Value }) }
function Set-ProjectFieldCore([string]$Dir, [string]$Name, $Value) {
    $info = Read-ProjectJson (Join-Path $Dir 'project.json')
    if (-not $info) { return }
    $info | Add-Member NoteProperty $Name $Value -Force
    $info | Add-Member NoteProperty updated (Get-Stamp) -Force
    Save-ProjectInfo $Dir $info
}

# ---- menu ----
# Remembers a category (and its link when known).
function Update-ProjectMenu([string]$Dir, [string]$Name, [string]$Url) { [void](Use-ProjectLock $Dir { Update-ProjectMenuCore $Dir $Name $Url }) }
function Update-ProjectMenuCore([string]$Dir, [string]$Name, [string]$Url) {
    if (-not $Name) { return }
    $path = Join-Path $Dir 'menu.json'
    $menu = @(foreach ($m in @(Read-ProjectJson $path @())) { $m })
    $hit = @($menu | Where-Object { $_.name -eq $Name } | Select-Object -First 1)
    if ($hit.Count) { if ($Url -and -not $hit[0].url) { $hit[0].url = $Url } }
    else { $menu += [pscustomobject]@{ name = $Name; url = [string]$Url; products = 0 } }
    Write-ProjectJson $path $menu
}
# menu.json with the product count of every category (categories that only appear in the table are added).
function Save-ProjectMenu([string]$Dir) { return (Use-ProjectLock $Dir { Save-ProjectMenuCore $Dir }) }
function Save-ProjectMenuCore([string]$Dir) {
    $rows = @(Read-ScanRows (Join-Path $Dir 'products.csv'))
    $menu = @(foreach ($m in @(Read-ProjectJson (Join-Path $Dir 'menu.json') @())) { $m })
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($m in $menu) { $out.Add([pscustomobject]@{ name = [string]$m.name; url = [string]$m.url; products = @($rows | Where-Object { $_.collection -eq $m.name }).Count }) }
    foreach ($group in @($rows | Group-Object collection)) {
        if ($group.Name -and -not @($out | Where-Object { $_.name -eq $group.Name }).Count) { $out.Add([pscustomobject]@{ name = [string]$group.Name; url = ''; products = $group.Count }) }
    }
    Write-ProjectJson (Join-Path $Dir 'menu.json') $out.ToArray()
    return $out.ToArray()
}

# ---- summaries ----
function Get-ProjectSummary([string]$Dir) {
    $info = Read-ProjectJson (Join-Path $Dir 'project.json')
    $rows = @(Read-ScanRows (Join-Path $Dir 'products.csv'))
    $per = [ordered]@{}
    foreach ($group in @($rows | Group-Object collection)) { $per[[string]$group.Name] = $group.Count }
    [ordered]@{
        id = [string]$info.id; name = [string]$info.name; site = [string]$info.site; dir = $Dir; csv = (Join-Path $Dir 'products.csv')
        products = $rows.Count; used = @($rows | Where-Object { Test-UsedFlag $_.used }).Count
        with_reviews = @($rows | Where-Object { [string]$_.reviews_checked_at }).Count
        # Chuẩn bị trước: rows of prepared.csv still "ready" (not yet taken by the queue)
        prepared = $(try { $pf = Join-Path $Dir 'prepared.csv'; if (Test-Path -LiteralPath $pf) { @(Import-Csv -LiteralPath $pf -Encoding UTF8 | Where-Object { [string]$_.status -eq 'ready' }).Count } else { 0 } } catch { 0 })
        collections = $per; created = [string]$info.created; last_scan = [string]$info.last_scan; last_reviews_check = [string]$info.last_reviews_check
        max_per_collection = $(if ($info.max_per_collection) { [int]$info.max_per_collection } else { 20 })
    }
}
function Get-ProjectList([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'project.json') } | Sort-Object Name | ForEach-Object { [pscustomobject](Get-ProjectSummary $_.FullName) })
}

# ---- used flag ----
# Sets used for a link in one table; returns how many rows changed.
function Set-ProjectUsed([string]$Dir, [string]$Url, [bool]$Used) { return (Use-ProjectLock $Dir { Set-ProjectUsedCore $Dir $Url $Used }) }
function Set-ProjectUsedCore([string]$Dir, [string]$Url, [bool]$Used) {
    $csv = Join-Path $Dir 'products.csv'
    $rows = @(Read-ScanRows $csv)
    if (-not $rows.Count) { return 0 }
    $key = Get-ScanUrlKey $Url; $hit = 0
    foreach ($row in $rows) {
        if ((Get-ScanUrlKey $row.product_url) -ne $key) { continue }
        if ((Test-UsedFlag $row.used) -ne $Used) { $row.used = $(if ($Used) { 'T' } else { 'F' }); $hit++ }
    }
    if ($hit) { Write-ScanRows $csv $rows }
    return $hit
}
# Sets used=T for a product link in every project table and every older scan table (called when a link finishes: agent finish,
# Codex checkpoint). Returns how many rows changed; never throws (a missing or broken table must not fail a finished link).
function Set-ScanUsed([string]$Url, [string]$ScanRoot = '') {
    $changed = 0
    try {
        if (-not $Url) { return 0 }
        $roots = if ($ScanRoot) { @($ScanRoot) } else { @((Get-ProjectsRoot), (Get-LegacyScanRoot)) }
        foreach ($root in $roots) {
            if (-not (Test-Path -LiteralPath $root)) { continue }
            foreach ($dir in @(Get-ChildItem -LiteralPath $root -Directory)) {
                if (-not (Test-Path -LiteralPath (Join-Path $dir.FullName 'products.csv'))) { continue }
                $changed += (Set-ProjectUsed $dir.FullName $Url $true)
            }
        }
    } catch { Write-Verbose $_ }
    return $changed
}

# ---- review numbers: only what Claude reports is stored; nothing here reads or parses a page ----
# Stores the number Claude saw on the product page. Returns $false when the link is not in the project.
function Set-ProjectReviews([string]$Dir, [string]$Url, [int]$Count, [string]$Rating = '', [string]$Source = '') { return (Use-ProjectLock $Dir { Set-ProjectReviewsCore $Dir $Url $Count $Rating $Source }) }
function Set-ProjectReviewsCore([string]$Dir, [string]$Url, [int]$Count, [string]$Rating = '', [string]$Source = '') {
    $csv = Join-Path $Dir 'products.csv'
    $rows = @(Read-ScanRows $csv)
    $key = Get-ScanUrlKey $Url; $stamp = Get-Stamp; $hit = 0
    foreach ($row in $rows) {
        if ((Get-ScanUrlKey $row.product_url) -ne $key) { continue }
        $row | Add-Member NoteProperty reviews_count ([string]$Count) -Force
        $row | Add-Member NoteProperty reviews_checked_at $stamp -Force
        $hit++
    }
    if (-not $hit) { return $false }
    Write-ScanRows $csv $rows
    $path = Join-Path $Dir 'reviews.json'
    $seen = [ordered]@{}
    $old = Read-ProjectJson $path $null
    if ($old) { foreach ($p in $old.PSObject.Properties) { $seen[$p.Name] = $p.Value } }
    $seen[$key] = [ordered]@{ count = $Count; rating = $Rating; source = $Source; checked_at = $stamp }
    Write-ProjectJson $path $seen
    Set-ProjectField $Dir 'last_reviews_check' $stamp
    return $true
}
# Links to read next: never checked first (table order), then the oldest check.
function Get-ReviewsTodo([string]$Dir, [int]$Limit = 0) {
    $rows = @(Read-ScanRows (Join-Path $Dir 'products.csv'))
    $never = @($rows | Where-Object { -not [string]$_.reviews_checked_at })
    $done = @($rows | Where-Object { [string]$_.reviews_checked_at } | Sort-Object { [string]$_.reviews_checked_at })
    $list = @($never) + @($done)
    if ($Limit -gt 0) { $list = @($list | Select-Object -First $Limit) }
    return @($list | ForEach-Object { [pscustomobject]@{ url = [string]$_.product_url; title = [string]$_.title; collection = [string]$_.collection; reviews_count = [string]$_.reviews_count; reviews_checked_at = [string]$_.reviews_checked_at } })
}
