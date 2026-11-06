. (Join-Path $PSScriptRoot 'helpers.ps1')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'src/bootstrap.ps1')
function Assert($Value,[string]$Message){if(-not $Value){throw $Message}}
$temp=Join-Path $TestWorkspaceRoot ('batch-review-'+[Guid]::NewGuid().ToString('N'))
try{
    New-Item -ItemType Directory -Path (Join-Path $temp 'images') -Force|Out-Null
    $rows=@(foreach($n in 1..3){
        $image=Join-Path $temp "images/00$n-tee.png";New-TestPng $image 1 1 ([byte[]](10,0,0))
        $refs=Join-Path $temp "refs/00$n-tee";New-Item -ItemType Directory -Path $refs -Force|Out-Null
        $original=Join-Path $refs 'product.png';New-TestPng $original 4 4 ([byte[]](0,100,0))
        New-TestPng (Join-Path $refs 'scene.png') 4 4 ([byte[]](0,0,100))
        Write-FeedbackJson (Join-Path $refs 'manifest.json') @{item_id="00$n-tee";product_url='https://example.test/products/tee';images=@(@{role='scene';file='scene.png'},@{role='product';file='product.png'})}
        [pscustomobject]@{product_handle='tee';rating='5';author='A';email='';body="b$n";created_at='2026-10-28';verified_purchase='true';photo_url="https://x.test/img/$n.png";photo_path=($image -replace '\\','/')}
    })
    Save-BatchResults $rows $temp
    $items=@(Get-BatchReview $temp)
    Assert ($items.Count -eq 3 -and -not $items[0].Decision) "Every result must be listed, undecided. Rows=$($rows.Count) Items=$($items.Count) Decision=$($items[0].Decision)"
    Assert ((Split-Path $items[0].ProductPath -Leaf) -eq 'product.png' -and (Split-Path $items[0].ScenePath -Leaf) -eq 'scene.png') 'Each result must know its product photo and the review photo it was made from.'
    $project=Join-Path $temp 'project';$rejected=Join-Path $project 'workspace/rejected'
    Set-BatchReviewDecision $temp '001-tee' ok $rejected
    Set-BatchReviewDecision $temp '002-tee' bad $rejected
    # A review marked Bỏ is noted with its text and reason, and goes out with the next Gửi lỗi.
    $sample=Join-Path $rejected ((Split-Path $temp -Leaf)+'__002-tee')
    Assert (@(Get-ChildItem -LiteralPath $sample -File).Name -join ',' -eq 'sample.json' -and (Get-Content -LiteralPath (Join-Path $sample 'sample.json') -Raw -Encoding UTF8|ConvertFrom-Json).body -eq 'b2') 'A rejected review is noted with its text only, no image copies.'
    Set-BatchReviewDecision $temp '002-tee' ok $rejected
    Assert (-not (Test-Path -LiteralPath $sample)) 'Changing a Bỏ before it is sent must drop the kept copy.'
    Set-BatchReviewDecision $temp '002-tee' bad $rejected -Reason ' sai màu áo '
    $unsent=@(Get-UnsentRejectedSamples $project)
    Assert ($unsent.Count -eq 1) 'Only unsent rejected samples belong to a report.'
    $note=Get-Content -LiteralPath (Join-Path $unsent[0].FullName 'sample.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($note.id -eq '002-tee' -and $note.reason -eq 'sai màu áo') 'The AI must be able to read the saved rejection reason.'
    # support-report.mjs marks a sent sample with .sent.
    [IO.File]::WriteAllText((Join-Path $unsent[0].FullName '.sent'), (Get-Date).ToString('o'))
    Assert (-not @(Get-UnsentRejectedSamples $project).Count) 'Samples sent once must not be sent again.'
    Set-BatchReviewDecision $temp '002-tee' bad $rejected
    Assert (-not (Test-Path (Join-Path $temp 'loox_import.csv'))) 'No Loox file may exist before the review is done.'
    $exports=Join-Path $temp 'exports'
    $failed=$false;try{Export-ReviewedCsvMany @($temp) $exports|Out-Null}catch{$failed=$_.Exception.Message -match 'chưa duyệt'}
    Assert $failed 'The final file must wait until every image is checked.'
    Set-BatchReviewDecision $temp '003-tee' ok $rejected
    Set-BatchReviewDecision $temp '003-tee' '' $rejected
    Assert (-not @(Get-BatchReview $temp)[2].Decision) 'Clicking a decision again must clear it.'
    Set-BatchReviewDecision $temp '003-tee' ok $rejected
    $exported=Export-ReviewedCsvMany @($temp) $exports
    Assert ((Split-Path $exported -Parent) -eq $exports -and (Split-Path $exported -Leaf) -match '^loox_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}h[0-9]{2}m[0-9]{2}s(-[0-9]+)?.csv$' -and -not (Test-Path (Join-Path $temp 'loox_import.csv'))) 'The reviewed export is one Loox file named by time, straight in exports.'
    $csv=@(Import-Csv $exported)
    Assert ($csv.Count -eq 2 -and ($csv.body -join ',') -eq 'b1,b3' -and @($csv|Where-Object product_handle -eq 'tee').Count -eq 2) 'Rejecting one review removed other reviews of the same product.'
    # Several runs reviewed together give one Loox file; runs already exported are not offered again.
    $out=Join-Path $temp 'output';$exports=Join-Path $temp 'exports'
    foreach($name in 'run-a','run-b'){
        $dir=Join-Path $out $name;New-Item -ItemType Directory -Path $dir -Force|Out-Null
        $r=@(foreach($n in 1..2){[pscustomobject]@{product_handle="tee-$name";rating='5';author='A';email='';body="$name-$n";created_at='2026-10-28';verified_purchase='true';photo_url="https://x.test/$name/$n.png";photo_path=(Join-Path $dir "images/00$n-tee-$name.png")}})
        Save-BatchResults $r $dir
    }
    $pending=@(Get-UnexportedBatchDirs $out)
    Assert ($pending.Count -eq 2 -and (Split-Path $pending[0] -Leaf) -eq 'run-a') 'Both runs are waiting to be exported, oldest first.'
    $failed=$false;try{Export-ReviewedCsvMany $pending $exports|Out-Null}catch{$failed=$_.Exception.Message -match 'chưa duyệt'}
    Assert $failed 'The combined file must wait until every image of every run is checked.'
    foreach($dir in $pending){foreach($item in @(Get-BatchReview $dir)){Set-BatchReviewDecision $dir $item.Id $(if($item.Id -like '001*'){'ok'}else{'bad'}) $rejected}}
    $combined=Export-ReviewedCsvMany $pending $exports
    $both=@(Import-Csv $combined)
    Assert ($both.Count -eq 2 -and ($both.body -join ',') -eq 'run-a-1,run-b-1') "One file with the accepted images of both runs, got: $($both.body -join ',')"
    Assert ((Split-Path $combined -Parent) -eq $exports -and (Split-Path $combined -Leaf) -match '^loox_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}h[0-9]{2}m[0-9]{2}s(-[0-9]+)?.csv$' -and @(Get-ChildItem -LiteralPath $exports | Where-Object { $_.PSIsContainer -or $_.Extension -ne '.csv' }).Count -eq 0) 'The export is one CSV named by time, straight in exports, with nothing else beside it.'
    Assert ((Get-Content -LiteralPath (Join-Path $pending[0] 'exported.txt') -Raw) -eq $combined -and -not (Test-Path (Join-Path $pending[0] 'loox_import.csv')) -and -not @(Get-UnexportedBatchDirs $out).Count) 'Each run is marked exported by a note, not by a second CSV.'
    # Links come from the run: an accepted image without a public link stops the export instead of writing a CSV Loox cannot read.
    $local=Join-Path $out 'run-c';New-Item -ItemType Directory -Path $local -Force|Out-Null
    $r=@(foreach($n in 1..2){[pscustomobject]@{product_handle='tee-c';rating='5';author='A';email='';body="run-c-$n";created_at='2026-10-28';verified_purchase='true';photo_url="C:/x/00$n-tee-c.png";photo_path=(Join-Path $local "images/00$n-tee-c.png")}})
    Save-BatchResults $r $local
    Set-BatchReviewDecision $local '001-tee-c' ok $rejected;Set-BatchReviewDecision $local '002-tee-c' bad $rejected
    $before=@(Get-ChildItem -LiteralPath $exports -File).Count
    $failed=$false;try{Export-ReviewedCsvMany @($local) $exports|Out-Null}catch{$failed=$_.Exception.Message -match 'RESULT_UPLOAD'}
    Assert ($failed -and @(Get-ChildItem -LiteralPath $exports -File).Count -eq $before -and -not (Test-Path (Join-Path $local 'exported.txt'))) 'An accepted image without a public link must stop the export and leave nothing behind.'
    # A run stopped before its end has no rating, author or date: the export fills them for the accepted rows and keeps them.
    $stopped=Join-Path $out 'run-d';New-Item -ItemType Directory -Path $stopped -Force|Out-Null
    $r=@(foreach($n in 1..3){[pscustomobject]@{product_handle='tee-d';rating='';author='';email='';body="run-d-$n";created_at='';verified_purchase='';photo_url="https://raw.test/run-d/00$n.png";photo_path=(Join-Path $stopped "images/00$n-tee-d.png")}})
    Save-BatchResults $r $stopped
    foreach($n in 1..3){Set-BatchReviewDecision $stopped "00$n-tee-d" $(if($n -eq 3){'bad'}else{'ok'}) $rejected}
    $filled=@(Import-Csv (Export-ReviewedCsvMany @($stopped) $exports))
    Assert ($filled.Count -eq 2 -and @($filled|Where-Object{$_.rating -in '4','5' -and $_.author -and $_.created_at -and $_.verified_purchase -eq 'TRUE'}).Count -eq 2) 'Accepted rows of a stopped run get rating, author and date at export.'
    $saved=@(Get-BatchReview $stopped)
    Assert ($saved[0].Row.rating -and $saved[0].Row.author -and -not $saved[2].Row.rating) 'The filled values are kept in results.json; the rejected row is left alone.'
    # The app's backend (rpc.ps1) loads its own list of scripts: the export functions it calls must be among them.
    $rpc=Get-Content -LiteralPath (Join-Path $root 'src/mac/rpc.ps1') -Raw -Encoding UTF8
    Assert ($rpc -match "workflow/steps/04-complete-metadata.ps1") 'rpc.ps1 must load step 4: the export fills rating, author and date of a stopped run.'
    Assert ($rpc -match "application/loox-export.ps1") 'rpc.ps1 must load loox-export.ps1, or Xuất file Loox fails with a missing command.'
}finally{
    Get-ChildItem -LiteralPath (Join-Path (Split-Path (Split-Path ([IO.Path]::GetFullPath($temp)) -Parent) -Parent) 'rejected') -Directory -Filter ((Split-Path $temp -Leaf)+'__*') -ErrorAction SilentlyContinue|Remove-Item -Recurse -Force
    $resolved=[IO.Path]::GetFullPath($temp);$allowed=[IO.Path]::GetFullPath($TestWorkspaceRoot).TrimEnd('\')+'\'
    if($resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -like 'batch-review-*'){Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue}
}
Write-Host 'PASS: every result is checked before the final CSV, which keeps only accepted images.'
