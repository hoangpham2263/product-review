# Takes Google's sparkle out of the bottom right corner of a picture its web AI made (src/image/unsparkle.mjs, plain Node, the
# same on every OS). The picture is changed in place; the untouched one is first copied to Backup when that is given.
# Returns what was done: @{ applied = $true|$false; kind = 'star'|'pill'|''; method = 'detected'|'weak'|'' }; a picture with no mark is left as it is (applied $false).
# -Flow: the picture comes from Flow, which always stamps a mark, so a weak match is still taken (an unclear corner is not left alone).
$script:ReviewUnsparkleScript = Join-Path $PSScriptRoot 'unsparkle.mjs'

function Remove-ReviewImageSparkle([Parameter(Mandatory)][string]$Image, [string]$Backup = '', [switch]$Flow) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Chưa có Node.js nên chưa gỡ được dấu sao của Google.' }
    $clean = "$Image.clean.png"
    $reply = & node $script:ReviewUnsparkleScript '--image' $Image '--out' $clean $(if ($Flow) { '--flow' }) 2>&1
    if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $clean -Force -ErrorAction SilentlyContinue; throw (($reply | ForEach-Object { "$_" }) -join ' ').Trim() }
    $result = (($reply | ForEach-Object { "$_" }) -join '') | ConvertFrom-Json
    $applied = [bool]$result.applied
    if ($applied -and $Backup) {
        New-Item -ItemType Directory -Force -Path (Split-Path $Backup -Parent) | Out-Null
        Copy-Item -LiteralPath $Image -Destination $Backup -Force
    }
    if ($applied) { Move-Item -LiteralPath $clean -Destination $Image -Force } else { Remove-Item -LiteralPath $clean -Force -ErrorAction SilentlyContinue }
    @{ applied = $applied; kind = [string]$result.kind; method = [string]$result.method }
}
