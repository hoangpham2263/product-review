# Perceptual hash of a picture (16x16 dHash = 256 bits, hex), robust to resize and recompress. Used only to CHECK scenes (same picture saved twice,
# a scene already used by another product); it never chooses anything. Cache: workspace/source-photos/phash.json (key = path|size|mtime or lib:name:md5).
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
$script:PHashCache = $null
$script:PHashCacheDirty = $false
function Get-PHashCachePath { return (Join-Path $LibraryDir 'phash.json') }
function Initialize-PHashCache {
    if ($null -ne $script:PHashCache) { return }
    $script:PHashCache = @{}
    $path = Get-PHashCachePath
    if (Test-Path -LiteralPath $path) {
        try {
            $saved = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($prop in $saved.PSObject.Properties) { $script:PHashCache[$prop.Name] = [string]$prop.Value }
        } catch { $script:PHashCache = @{} }
    }
}
function Save-PHashCache {
    if (-not $script:PHashCacheDirty) { return }
    $path = Get-PHashCachePath
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
    $script:PHashCache | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
    $script:PHashCacheDirty = $false
}
function Compute-PHash([string]$Path) {
    $source = $null; $small = $null; $graphics = $null
    try {
        $source = [System.Drawing.Image]::FromFile($Path)
        $small = New-Object System.Drawing.Bitmap 17, 16
        $graphics = [System.Drawing.Graphics]::FromImage($small)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($source, (New-Object System.Drawing.Rectangle 0, 0, 17, 16), 0, 0, $source.Width, $source.Height, [System.Drawing.GraphicsUnit]::Pixel)
        $bytes = New-Object byte[] 32
        $bit = 0
        for ($y = 0; $y -lt 16; $y++) {
            $prev = $null
            for ($x = 0; $x -lt 17; $x++) {
                $c = $small.GetPixel($x, $y)
                $gray = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
                if ($x -gt 0) {
                    if ($prev -gt $gray) { $bytes[[int][math]::Floor($bit / 8)] = $bytes[[int][math]::Floor($bit / 8)] -bor (1 -shl ($bit % 8)) }
                    $bit++
                }
                $prev = $gray
            }
        }
        return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        if ($graphics) { $graphics.Dispose() }
        if ($small) { $small.Dispose() }
        if ($source) { $source.Dispose() }
    }
}
# Hash of a file on disk ('' when it cannot be read). -Key lets a library photo be cached by name+md5 instead of path+size+mtime.
function Get-PHash([string]$Path, [string]$Key = '') {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    Initialize-PHashCache
    if (-not $Key) { $info = Get-Item -LiteralPath $Path; $Key = "file:$($info.FullName)|$($info.Length)|$($info.LastWriteTimeUtc.Ticks)" }
    if ($script:PHashCache.ContainsKey($Key)) { return $script:PHashCache[$Key] }
    try { $hash = Compute-PHash $Path } catch { return '' }
    $script:PHashCache[$Key] = $hash
    $script:PHashCacheDirty = $true
    return $hash
}
# Same picture = small distance (resize/recompress gave 0-6 of 256 in tests, different photos 99+): 20 is the limit used by scan.ps1.
if (-not ("PHashMath" -as [type])) {
    Add-Type -TypeDefinition @"
public static class PHashMath {
    public static int Distance(string a, string b) {
        if (a == null || b == null || a.Length != b.Length || a.Length == 0) return 999;
        int d = 0;
        for (int i = 0; i < a.Length; i += 2) {
            int x = System.Convert.ToInt32(a.Substring(i, 2), 16) ^ System.Convert.ToInt32(b.Substring(i, 2), 16);
            while (x != 0) { d += x & 1; x >>= 1; }
        }
        return d;
    }
}
"@
}
function Get-PHashDistance([string]$A, [string]$B) { return [PHashMath]::Distance($A, $B) }
