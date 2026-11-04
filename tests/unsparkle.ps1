$ErrorActionPreference = 'Stop'
# Google's sparkle (Flow pictures) is undone, not painted over; a picture without it is left alone (src/image/unsparkle.mjs).
& node --test (Join-Path $PSScriptRoot 'unsparkle.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'unsparkle.test.mjs failed.' }
Write-Host 'PASS: the Flow sparkle is removed from Flow pictures, and other pictures are left as they are.'
