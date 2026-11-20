# Step 5: results.json, the URL queue and the Loox file. Local only.
# Checkpoint successful work before removing its URL from the queue.
function Save-ProductCheckpoint($Results, $Result, $Completed, $Item, [string]$List, [bool]$UrlDone = $true) {
    Assert-PublicPhotoDelivery $Result
    $Results.Add($Result)
    Save-BatchResults $Results.ToArray() $script:Batch.Dir
    if (-not $UrlDone) { return }
    $Completed.Add($Item.Url)
    Write-Lines $script:Batch.CompletedUrls $Completed.ToArray()
    Remove-FromQueue $List $Item.Url
    # The link is done: its row in a Quét web table becomes used = T (never fails the checkpoint).
    [void](Set-ScanUsed $Item.Url)
    # A review-only row has no image delivery; it must not drop a saved image delivery of the same link.
    if (-not $Result.review_only) { Remove-CompletedDeliveryCache $Item.Url }
}

function Complete-BatchExport($Results, [string]$NamesPath) {
    if (-not $Results.Count) { return }
    foreach($row in $Results){Assert-PublicPhotoDelivery $row}
    Write-Host ([Environment]::NewLine + '[METADATA] Assigning random review fields locally...') -ForegroundColor Cyan
    Complete-ReviewMetadata $Results.ToArray() $NamesPath
    Save-BatchResults $Results.ToArray() $script:Batch.Dir
}
