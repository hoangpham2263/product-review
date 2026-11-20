. (Join-Path $PSScriptRoot 'helpers.ps1')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'src/bootstrap.ps1')
function Assert($Value,$Message){if(-not $Value){throw $Message}}
$temp=Join-Path $TestWorkspaceRoot ('text-only-'+[guid]::NewGuid().ToString('N'))
try {
New-Item -ItemType Directory $temp -Force|Out-Null
$rows=@(foreach($n in 1..3){[pscustomobject]@{product_handle='same-product';rating=5;author='Demo A.';email='demo@int';body="body$n";created_at='2026-11-13';photo_url="https://example.test/$n.png";photo_path=(Join-Path $temp "00$n.png");verified_purchase='true'}})
$rows[1].photo_url=''
Save-BatchResults $rows $temp
$rejects=Join-Path $temp 'rejected'
Set-BatchReviewDecision $temp '001' ok $rejects
Set-BatchReviewDecision $temp '002' text $rejects
Set-BatchReviewDecision $temp '003' bad $rejects
$items=@(Get-BatchReview $temp)
Assert ($items[1].Decision -eq 'text' -and $items[0].Decision -eq 'ok' -and $items[2].Decision -eq 'bad') 'Decisions must persist independently for reviews of the same product'
Assert ((Get-PendingReviewCount $temp) -eq 0) 'Text-only counts as a completed decision'
$file=Export-ReviewedCsvMany @($temp) (Join-Path $temp 'exports')
$csv=@(Import-Csv $file)
Assert ($csv.Count -eq 2 -and $csv[0].photo_url -eq 'https://example.test/1.png' -and -not $csv[1].photo_url -and $csv[1].body -eq 'body2') 'Keep both content rows, omit only the selected photo, exclude rejected row'
$rows[1].photo_url='https://example.test/2.png';Save-BatchResults $rows $temp
$file=Export-ReviewedCsvMany @($temp) (Join-Path $temp 'exports')
$csv=@(Import-Csv $file)
$saved=Get-Content (Join-Path $temp 'results.json') -Raw -Encoding UTF8|ConvertFrom-Json
Assert (-not $csv[1].photo_url -and $saved[1].photo_url -eq 'https://example.test/2.png') 'Export must not alter original image links'
Set-BatchReviewDecision $temp '002' ok $rejects
$file=Export-ReviewedCsvMany @($temp) (Join-Path $temp 'exports')
$csv=@(Import-Csv $file)
Assert ($csv[1].photo_url -eq 'https://example.test/2.png') 'Switching back to Keep restores the photo'
Write-Host 'PASS: per-review text-only decision, export with/without link, original preserved, decision reversible.'
}finally{
$resolved=[IO.Path]::GetFullPath($temp);$allowed=[IO.Path]::GetFullPath($TestWorkspaceRoot).TrimEnd('\')+'\'
if($resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'text-only-*'){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
