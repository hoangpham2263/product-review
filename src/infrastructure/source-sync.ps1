# Source library: the public GitHub repo hoangpham2263/product-review-sources, source-photos/<group>/<file>, listed in
# source-photos/manifest.json (groups, enabled, files with md5) and described in source-photos/catalog.json. A run
# downloads only the chosen group into workspace/source-photos/<group>/ and fetches only new or changed files (md5).
# PR_SOURCES_URL points tests at a local copy.
$script:SourcesUrl = 'https://raw.githubusercontent.com/hoangpham2263/product-review-sources/main/source-photos'
$script:SourceManifestCache = $null

function Get-SourcesUrl { if ($env:PR_SOURCES_URL) { return $env:PR_SOURCES_URL.TrimEnd('/') } return $script:SourcesUrl }

function Get-SourceFileUrl([string]$Group, [string]$Name) {
    return '{0}/{1}/{2}' -f (Get-SourcesUrl), [Uri]::EscapeDataString($Group.Normalize([Text.NormalizationForm]::FormC)), [Uri]::EscapeDataString($Name)
}

# The manifest, read again after a minute (the app's PowerShell is long-lived, the picker asks often).
function Get-SourceManifest {
    $cache = $script:SourceManifestCache
    if ($cache -and ((Get-Date) - $cache.At).TotalSeconds -lt 60) { return $cache.Data }
    $data = Invoke-RestMethod -Uri "$(Get-SourcesUrl)/manifest.json" -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 60
    $script:SourceManifestCache = @{ At = Get-Date; Data = $data }
    return $data
}

function Get-RemoteSourceGroups {
    return @(@((Get-SourceManifest).groups) | Where-Object { $_.enabled -ne $false } | ForEach-Object { [string]$_.name })
}

# Groups for the picker: only the switched-on groups of the manifest, read each time the picker opens. The last list is
# kept in workspace/source-groups.json for offline use.
function Get-SourceGroupChoices([string]$ProjectRoot) {
    $cache = Join-Path $ProjectRoot 'workspace/source-groups.json'
    $groups = try {
        $fetched = @(Get-RemoteSourceGroups)
        try { Set-Content -LiteralPath $cache -Value (ConvertTo-Json -InputObject $fetched -Compress) -Encoding UTF8 } catch { Write-Verbose $_ }
        ,$fetched
    } catch {
        Write-Verbose $_
        if (Test-Path -LiteralPath $cache) { ,@(foreach ($g in (Get-Content -LiteralPath $cache -Raw -Encoding UTF8 | ConvertFrom-Json)) { [string]$g }) }
        else { ,@('Áo', 'Nội thất') }
    }
    return @($groups | ForEach-Object { ([string]$_).Normalize([Text.NormalizationForm]::FormC) } | Sort-Object -Unique |
        Sort-Object @{ Expression = { if ($_ -eq 'Áo') { 0 } elseif ($_ -eq 'Nội thất') { 1 } else { 2 } } }, @{ Expression = { $_ } })
}

# One group's files in the manifest: { name, md5, url }.
function Get-SourceGroupListing([string]$Group) {
    $Group = $Group.Normalize([Text.NormalizationForm]::FormC)
    $entry = @(@((Get-SourceManifest).groups) | Where-Object { ([string]$_.name).Normalize([Text.NormalizationForm]::FormC) -eq $Group })
    if (-not $entry.Count) { throw "Không có danh mục $Group trong kho ảnh." }
    return @(@($entry[0].files) | ForEach-Object { [pscustomobject]@{ name = [string]$_.name; md5 = [string]$_.md5; url = (Get-SourceFileUrl $Group ([string]$_.name)) } })
}

# catalog.json beside the downloaded groups, so the reference archive knows each photo's source.
function Update-SourceCatalog([string]$SourceDir) {
    New-Item -ItemType Directory -Path $SourceDir -Force | Out-Null
    $path = Join-Path $SourceDir 'catalog.json'
    try { Invoke-WebRequest -Uri "$(Get-SourcesUrl)/catalog.json" -OutFile "$path.part" -UseBasicParsing -TimeoutSec 120; Move-Item -LiteralPath "$path.part" -Destination $path -Force }
    catch { Remove-Item -LiteralPath "$path.part" -Force -ErrorAction SilentlyContinue; Write-Verbose $_ }
}

# $OnProgress (optional) gets (images downloaded so far, images to download) after the listing and each batch.
function Sync-SourceGroup([string]$SourceDir, [string]$Group, [scriptblock]$OnProgress) {
    $Group = $Group.Normalize([Text.NormalizationForm]::FormC)
    $folder = Get-SourcePhotoDirectory $SourceDir $Group
    $listing = @(Get-SourceGroupListing $Group)
    Update-SourceCatalog $SourceDir
    # name -> md5 of the files earlier syncs wrote; only these are ever removed again.
    $index = Read-SourceSyncIndex $folder
    $indexPath = Join-Path $folder '.sync.json'
    $remote = @{}
    $missing = New-Object Collections.Generic.List[object]
    foreach ($file in $listing) {
        $name = [string]$file.name
        if (-not $name -or [IO.Path]::GetFileName($name) -ne $name -or $name.EndsWith('.part')) { continue }
        $remote[$name] = $true
        if ($index[$name] -ne $file.md5 -or -not (Test-Path -LiteralPath (Join-Path $folder $name))) { $missing.Add($file) }
    }
    $removed = 0
    foreach ($name in @($index.Keys)) {
        if ($remote[$name]) { continue }
        Remove-Item -LiteralPath (Join-Path $folder $name) -Force -ErrorAction SilentlyContinue
        $index.Remove($name); $removed++
    }
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(2)
    $done = 0
    if ($OnProgress) { & $OnProgress 0 $missing.Count }
    try {
        # Eight downloads at a time; the index is saved after each batch so a stopped sync resumes.
        for ($at = 0; $at -lt $missing.Count; $at += 8) {
            $batch = @($missing | Select-Object -Skip $at -First 8)
            $tasks = @($batch | ForEach-Object { $client.GetByteArrayAsync([string]$_.url) })
            [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$tasks)
            for ($i = 0; $i -lt $batch.Count; $i++) {
                [IO.File]::WriteAllBytes((Join-Path $folder $batch[$i].name), $tasks[$i].Result)
                $index[[string]$batch[$i].name] = [string]$batch[$i].md5
            }
            $done += $batch.Count
            $index | ConvertTo-Json | Set-Content -LiteralPath $indexPath -Encoding UTF8
            Write-Host "  [SOURCE] $Group`: $done/$($missing.Count)" -ForegroundColor Cyan
            if ($OnProgress) { & $OnProgress $done $missing.Count }
        }
    } finally { $client.Dispose() }
    $index | ConvertTo-Json | Set-Content -LiteralPath $indexPath -Encoding UTF8
    return [pscustomobject]@{ Group = $Group; Total = $remote.Count; Downloaded = $done; Removed = $removed }
}

# Images of one group already on this machine (after Tải về máy), for the "Từ kho ảnh" picker.
function Get-LocalSourceFiles([string]$SourceDir, [string]$Group) {
    $folder = Join-Path $SourceDir $Group.Normalize([Text.NormalizationForm]::FormC)
    if (-not (Test-Path -LiteralPath $folder)) { return @() }
    return @(Get-ChildItem -LiteralPath $folder -File | Where-Object { $_.Extension -match '^\.(png|jpe?g)$' } | Sort-Object Name | ForEach-Object FullName)
}

# Files for the "Từ kho ảnh" picker, the same on Windows and macOS. The picker first shows the local copies the sync
# index knows (at once), then the manifest's listing; without network it keeps to what is on this machine and says
# why under the grid.
function Get-SourcePickerFiles([string]$SourceDir, [string]$Group) {
    try {
        return @{ Files = @(Get-SourceGroupFiles $SourceDir $Group); Error = '' }
    } catch {
        $local = @(Get-LocalSourceFiles $SourceDir $Group | ForEach-Object { [pscustomobject]@{ name = [IO.Path]::GetFileName($_); md5 = ''; url = ''; local = $_ } })
        return @{ Files = $local; Error = 'Không kết nối được kho ảnh (mạng). Đang hiện ảnh có trên máy.' }
    }
}

# The danh mục the picker opens on, chosen with its Mặc định box (workspace/source-default.txt); '' for none.
function Get-DefaultSourceGroup([string]$ProjectRoot) {
    $path = Join-Path $ProjectRoot 'workspace/source-default.txt'
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    return (Get-Content -LiteralPath $path -Raw -Encoding UTF8).Trim().Normalize([Text.NormalizationForm]::FormC)
}

function Set-DefaultSourceGroup([string]$ProjectRoot, [string]$Group) {
    $path = Join-Path $ProjectRoot 'workspace/source-default.txt'
    if ($Group) { [IO.File]::WriteAllText($path, $Group.Normalize([Text.NormalizationForm]::FormC), [Text.UTF8Encoding]::new($false)) }
    else { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

# Local copies an earlier sync or pick recorded, without asking GitHub: what the picker shows first.
function Get-SourceIndexedFiles([string]$SourceDir, [string]$Group) {
    $folder = Join-Path $SourceDir $Group.Normalize([Text.NormalizationForm]::FormC)
    $index = Read-SourceSyncIndex $folder
    foreach ($name in @($index.Keys | Sort-Object)) {
        $path = Join-Path $folder $name
        if (Test-Path -LiteralPath $path) { [pscustomobject]@{ name = $name; md5 = $index[$name]; url = ''; local = $path } }
    }
}

# A group's images in the library, each with the local copy when one is already in place (synced or picked).
function Get-SourceGroupFiles([string]$SourceDir, [string]$Group) {
    $folder = Join-Path $SourceDir $Group.Normalize([Text.NormalizationForm]::FormC)
    $index = Read-SourceSyncIndex $folder
    foreach ($file in @(Get-SourceGroupListing $Group)) {
        $name = [string]$file.name
        if (-not $name -or [IO.Path]::GetFileName($name) -ne $name) { continue }
        $path = Join-Path $folder $name
        $local = if ($index[$name] -eq $file.md5 -and (Test-Path -LiteralPath $path)) { $path } else { '' }
        [pscustomobject]@{ name = $name; md5 = $file.md5; url = $file.url; local = $local }
    }
}

# Uses picked library images directly: downloads only the ones not on this machine yet, into the group folder and its
# sync index, so a later Tải về máy never downloads them twice. Returns local paths.
function Save-SourceGroupFiles([string]$SourceDir, [string]$Group, [object[]]$Files) {
    $folder = Get-SourcePhotoDirectory $SourceDir $Group.Normalize([Text.NormalizationForm]::FormC)
    $index = Read-SourceSyncIndex $folder
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'catalog.json'))) { Update-SourceCatalog $SourceDir }
    foreach ($file in @($Files)) {
        $name = [IO.Path]::GetFileName([string]$file.name)
        if (-not $name) { continue }
        $path = Join-Path $folder $name
        if ($index[$name] -ne $file.md5 -or -not (Test-Path -LiteralPath $path)) {
            Invoke-WebRequest -Uri (Get-SourceFileUrl $Group $name) -OutFile $path -UseBasicParsing -TimeoutSec 120
            $index[$name] = [string]$file.md5
            $index | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $folder '.sync.json') -Encoding UTF8
        }
        $path
    }
}

function Read-SourceSyncIndex([string]$Folder) {
    $index = @{}
    $indexPath = Join-Path $Folder '.sync.json'
    if (Test-Path -LiteralPath $indexPath) {
        foreach ($p in (Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties) { $index[$p.Name] = [string]$p.Value }
    }
    return $index
}
