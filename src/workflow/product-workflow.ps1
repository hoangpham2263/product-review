# One product: steps 1-5. BatchWorkflow runs steps 6-7 after workers finish.
function Invoke-ProductItem($Item, [string]$ItemId) {
    $script:Config.ActiveProductUrl = $Item.Url
    $script:Config.ActiveScene = if ($Item.PSObject.Properties['Scene']) { $Item.Scene } else { $null }
    $cached=Read-DeliveryCache $Item
    if($cached){
        Write-Host '  [RESULT-RESUME] Reusing saved image and review; no AI generation.' -ForegroundColor Cyan
        $row=Restore-DeliveryCache $cached $ItemId
        Save-DeliveryCache $Item $ItemId $row
        return $row
    }
    $product = Read-ProductInput $Item $ItemId
    $download = $product.Reference
    if ($script:Config.ReviewOnly) { return Invoke-ReviewOnlyItem $Item $ItemId $product }
    try {
        $reviewPhoto = Get-ReviewPhoto $ItemId $product.Context
        $request = New-ProductImageRequest $product.Reference $ItemId $product.Context $reviewPhoto
        $bundle = Save-ProductReferenceBundle $Item $ItemId $product.Context $request
        $product.Reference = $bundle.ProductPath
        Complete-ProductImage $request $product.Context $ItemId | Out-Null
    } finally {
        # The downloaded original is archived as refs/<item>/NN-product; drop the loose copy.
        if ((Split-Path $download -Parent) -eq $script:Batch.Refs -and (Test-Path -LiteralPath $download)) { Remove-Item -LiteralPath $download -Force }
    }
    $body = New-Review $request.Output $ItemId $product.Context
    # Local paths never stand in for failed uploads.
    $row=[pscustomobject][ordered]@{
        product_handle = $Item.Handle
        rating = ''
        author = ''
        email = ''
        body = $body
        created_at = ''
        verified_purchase = 'true'
        photo_url = $(if($script:Config.Results -or $script:Config.ResultsRequired){''}else{$request.Output -replace '\\','/'})
        photo_path = ($request.Output -replace '\\', '/')
    }
    Save-DeliveryCache $Item $ItemId $row
    return $row
}
# Review-only item: no image is made. The review is written from the attached ORIGINAL review photo (Get-ReviewPhoto
# stops this item with a clear error when none is attached; other items go on). Nothing is uploaded: photo_url stays
# empty and the row is flagged review_only so Duyệt shows the review photo as "chỉ review" and Loox gets an empty photo column.
function Invoke-ReviewOnlyItem($Item, [string]$ItemId, $Product) {
    $download = $Product.Reference
    try {
        $reviewPhoto = Get-ReviewPhoto $ItemId $Product.Context
        # Archive review photo + product (refs/<item>/01-..., 02-product); the review reads the archived copy.
        $request = [pscustomobject]@{ Images = @($reviewPhoto, $Product.Reference); Prompt = ''; Output = '' }
        Save-ProductReferenceBundle $Item $ItemId $Product.Context $request | Out-Null
    } finally {
        if ((Split-Path $download -Parent) -eq $script:Batch.Refs -and (Test-Path -LiteralPath $download)) { Remove-Item -LiteralPath $download -Force }
    }
    $photo = $request.Images[0]
    Write-Host '  [REVIEW-ONLY] No image step; writing the review from the original review photo.' -ForegroundColor Cyan
    $body = New-Review $photo $ItemId $Product.Context
    return [pscustomobject][ordered]@{
        product_handle = $Item.Handle
        rating = ''
        author = ''
        email = ''
        body = $body
        created_at = ''
        verified_purchase = 'true'
        photo_url = ''
        photo_path = ($photo -replace '\\', '/')
        review_only = $true
        item_id = $ItemId
    }
}
