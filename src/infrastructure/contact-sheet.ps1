# Contact sheet: up to 24 photos tiled into ONE png (about 300 px per tile) with a big number on each tile, plus a legend number -> name.
# Claude Reads one sheet instead of opening 12-20 files one by one (scene index, scene candidates, product groups). It only draws pictures;
# it never judges or picks anything.
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
. (Join-Path $PSScriptRoot '../../core/setup/atomic-file.ps1')

$script:ContactSheetMax = 24
# $Items: objects with number (int), name (legend text) and path (a JPG / PNG on disk). Writes $Out (png) and $Out + '.json' (the legend).
# Returns { sheet, legend = [{ n, name }], missing = [names that could not be drawn] }.
function New-ContactSheet([object[]]$Items, [string]$Out, [int]$Cols = 4, [int]$Tile = 300) {
    $Items = @($Items)
    if (-not $Items.Count) { throw '[CAUSE:BAD_SHEET] No photos to put on the sheet.' }
    if ($Items.Count -gt $script:ContactSheetMax) { throw "[CAUSE:BAD_SHEET] At most $($script:ContactSheetMax) photos per sheet (got $($Items.Count))." }
    if ($Cols -lt 1) { $Cols = 4 }
    if ($Cols -gt $Items.Count) { $Cols = $Items.Count }
    if ($Tile -lt 120) { $Tile = 120 }
    $gap = 6
    $rows = [int][math]::Ceiling($Items.Count / $Cols)
    $width = $Cols * $Tile + ($Cols + 1) * $gap
    $height = $rows * $Tile + ($rows + 1) * $gap
    $sheet = New-Object System.Drawing.Bitmap $width, $height
    $g = [System.Drawing.Graphics]::FromImage($sheet)
    $font = New-Object System.Drawing.Font 'Arial', ([single]([math]::Max(20, [int]($Tile / 8)))), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $black = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 0, 0, 0))
    $white = [System.Drawing.Brushes]::White
    $yellow = [System.Drawing.Brushes]::Yellow
    $legend = New-Object Collections.Generic.List[object]
    $missing = New-Object Collections.Generic.List[string]
    try {
        $g.Clear([System.Drawing.Color]::FromArgb(255, 40, 40, 40))
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        for ($i = 0; $i -lt $Items.Count; $i++) {
            $item = $Items[$i]
            $x = $gap + ($i % $Cols) * ($Tile + $gap)
            $y = $gap + [math]::Floor($i / $Cols) * ($Tile + $gap)
            $g.FillRectangle([System.Drawing.Brushes]::Gainsboro, $x, $y, $Tile, $Tile)
            $img = $null
            try {
                $img = [System.Drawing.Image]::FromFile([string]$item.path)
                # fit the whole photo in the tile (no crop: a wall or a corner of the room must stay visible)
                $scale = [math]::Min($Tile / $img.Width, $Tile / $img.Height)
                $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)
                $g.DrawImage($img, (New-Object System.Drawing.Rectangle ([int]($x + ($Tile - $w) / 2)), ([int]($y + ($Tile - $h) / 2)), $w, $h))
            } catch {
                $missing.Add([string]$item.name)
                $g.DrawString('?', $font, $black, [single]($x + $Tile / 2 - 10), [single]($y + $Tile / 2 - 20))
            } finally { if ($img) { $img.Dispose() } }
            $label = [string]$item.number
            $size = $g.MeasureString($label, $font)
            $g.FillRectangle($black, [single]$x, [single]$y, [single]($size.Width + 12), [single]($size.Height + 4))
            $g.DrawString($label, $font, $(if ($missing.Contains([string]$item.name)) { $yellow } else { $white }), [single]($x + 6), [single]($y + 2))
            $legend.Add([ordered]@{ n = [int]$item.number; name = [string]$item.name })
        }
        $full = [IO.Path]::GetFullPath($Out)
        $dir = Split-Path $full -Parent
        if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $tmp = "$full.$PID.tmp.png"
        $sheet.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-BytesAtomic $full ([IO.File]::ReadAllBytes($tmp))
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Write-FileAtomic ($full + '.json') (ConvertTo-Json -InputObject @($legend.ToArray()) -Compress -Depth 4)
    } finally {
        $font.Dispose(); $black.Dispose(); $g.Dispose(); $sheet.Dispose()
    }
    return [pscustomobject]@{ sheet = $full; legend = @($legend.ToArray()); missing = @($missing.ToArray()) }
}

# Several sheets for a long list (chunks of $PerSheet, numbering continues across sheets). $OutBase 'x.png' -> x-1.png, x-2.png ...
function New-ContactSheets([object[]]$Items, [string]$OutBase, [int]$Cols = 4, [int]$PerSheet = 20) {
    $Items = @($Items)
    if ($PerSheet -lt 1 -or $PerSheet -gt $script:ContactSheetMax) { $PerSheet = 20 }
    $sheets = @()
    if (-not $Items.Count) { return $sheets }
    $stem = [IO.Path]::Combine([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutBase)), [IO.Path]::GetFileNameWithoutExtension($OutBase))
    $chunks = [int][math]::Ceiling($Items.Count / $PerSheet)
    for ($c = 0; $c -lt $chunks; $c++) {
        $part = @($Items | Select-Object -Skip ($c * $PerSheet) -First $PerSheet)
        $path = if ($chunks -eq 1) { "$stem.png" } else { "$stem-$($c + 1).png" }
        $made = New-ContactSheet $part $path $Cols
        $sheets += [ordered]@{ sheet = $made.sheet; first = [int]$part[0].number; last = [int]$part[-1].number; missing = $made.missing }
    }
    return $sheets
}

# Default place for sheets: this session's tmp/contact-sheets (never the shared workspace).
function Get-ContactSheetPath([string]$SessionDir, [string]$Stem) {
    $safe = ($Stem -replace '[^\w.-]+', '-').Trim('-'); if (-not $safe) { $safe = 'sheet' }
    return (Join-Path (Join-Path $SessionDir 'tmp/contact-sheets') ("{0}-{1}.png" -f $safe, (Get-Date -Format 'HHmmss-fff')))
}
