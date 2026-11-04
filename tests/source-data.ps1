. (Join-Path $PSScriptRoot 'helpers.ps1')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'src/bootstrap.ps1')
# The library lives in the GitHub repo product-review-sources (manifest.json + catalog.json); a group is downloaded
# into workspace/source-photos/<group>. Each check runs offline on a small catalog and a mocked manifest.
$dir = Join-Path $TestWorkspaceRoot ('source-data-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$photo = { param($file, $category) [ordered]@{ category = $category; file = $file; source_group = ($file -split '/')[0]; sha256 = ('0' * 63) + [string]$file.Length } }
@{ schema_version = 1; photos = @((& $photo 'Áo/a.jpg' 'polo-shirts'), (& $photo 'Áo/bb.jpg' 'polo-shirts'), (& $photo 'Nội thất/c.jpg' 'dining-tables')) } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $dir 'catalog.json') -Encoding UTF8
$entries = @(Get-SampleCatalogEntries $dir)
if ($entries.Count -ne 3) { throw 'The catalog must list every photo.' }
if ((Get-SourceCatalog $dir).Count) { throw 'Groups not downloaded yet must be skipped, not listed.' }
if ((Get-SourcePhotoDirectory $dir 'Nội thất') -ne [IO.Path]::GetFullPath((Join-Path $dir 'Nội thất'))) { throw 'The file picker opens the wrong local folder.' }
New-Item -ItemType File -Force -Path (Join-Path $dir 'Áo/a.jpg'), (Join-Path $dir 'Áo/bb.jpg') | Out-Null
if ((Get-SourceCatalog $dir).Count -ne 2) { throw 'Downloaded photos must be listed with their catalog entry.' }
if ((@(Get-SourcePhotoGroups $dir))[0] -ne 'Áo') { throw 'Local folders are ordered incorrectly.' }

# Links: raw GitHub files, the Vietnamese group URL-encoded.
if ((Get-SourceFileUrl ('Nội thất'.Normalize([Text.NormalizationForm]::FormD)) 'x.jpg') -ne 'https://raw.githubusercontent.com/hoangpham2263/product-review-sources/main/source-photos/N%E1%BB%99i%20th%E1%BA%A5t/x.jpg') { throw 'Source links must point at the sources repo, group in NFC and URL-encoded.' }

# The picker lists only the groups switched on in the manifest; offline it keeps the last list.
$project = Join-Path $dir 'project'
New-Item -ItemType Directory -Force -Path (Join-Path $project 'workspace') | Out-Null
function Get-SourceManifest { throw 'offline' }
if ((@(Get-SourceGroupChoices $project) -join '|') -ne 'Áo|Nội thất') { throw 'Never online, the picker starts with Áo and Nội thất.' }
function Get-SourceManifest {
    [pscustomobject]@{ groups = @(
            [pscustomobject]@{ name = 'Mũ'; enabled = $true; files = @() }
            [pscustomobject]@{ name = 'Nội thất'.Normalize([Text.NormalizationForm]::FormD); enabled = $true; files = @() }
            [pscustomobject]@{ name = 'Đồ bếp'; enabled = $false; files = @() }
            [pscustomobject]@{ name = 'Áo'; enabled = $true; files = @() }) }
}
if ((@(Get-SourceGroupChoices $project) -join '|') -ne 'Áo|Nội thất|Mũ') { throw 'The picker must show exactly the switched-on groups.' }
function Get-SourceManifest { throw 'offline' }
if ((@(Get-SourceGroupChoices $project) -join '|') -ne 'Áo|Nội thất|Mũ') { throw 'Offline, the picker must keep the last switched-on groups.' }

# Mặc định: the picker opens on the saved danh mục; clearing it brings back the empty choice.
Set-DefaultSourceGroup $project ('Nội thất'.Normalize([Text.NormalizationForm]::FormD))
if ((Get-DefaultSourceGroup $project) -ne 'Nội thất') { throw 'The default danh mục must be saved (as NFC).' }
Set-DefaultSourceGroup $project ''
if (Get-DefaultSourceGroup $project) { throw 'Unticking Mặc định must clear the default danh mục.' }

# Out of reach, the picker says so and shows this machine's photos.
$listing = Get-SourcePickerFiles $dir 'Áo'
if ($listing.Error -notmatch 'Không kết nối được kho ảnh' -or @($listing.Files).Count -ne 2 -or @($listing.Files | Where-Object { -not $_.local }).Count) { throw 'Offline, the picker must list local photos and say why.' }

# The picker first shows the copies the sync index knows, then marks the manifest's listing against them.
@{ 'a.jpg' = 'm1' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dir 'Áo/.sync.json') -Encoding UTF8
$indexed = @(Get-SourceIndexedFiles $dir 'Áo')
if ($indexed.Count -ne 1 -or $indexed[0].name -ne 'a.jpg') { throw 'Only the photos the sync index knows are shown before the listing.' }
function Get-SourceManifest { [pscustomobject]@{ groups = @([pscustomobject]@{ name = 'Áo'; enabled = $true; files = @([pscustomobject]@{ name = 'a.jpg'; md5 = 'm1' }, [pscustomobject]@{ name = 'new.jpg'; md5 = 'm2' }) }) } }
$listed = @((Get-SourcePickerFiles $dir 'Áo').Files)
if ($listed.Count -ne 2 -or -not $listed[0].local -or $listed[1].local -or $listed[1].url -notmatch '/%C3%81o/new\.jpg$') { throw 'The listing must keep local copies and mark new photos as not on this machine.' }

$blocked = $false; try { Get-SourcePhotoDirectory $dir '../outside' | Out-Null } catch { $blocked = $true }
if (-not $blocked) { throw 'Local group navigation escaped the library.' }
Remove-Item -LiteralPath $dir -Recurse -Force
Write-Host 'PASS: GitHub source links, switched-on groups, offline fallback, downloaded groups only.'
