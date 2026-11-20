# Loox export: the one place that writes a Loox import file.
# One file per export, straight in workspace/exports and named by time: loox_2026-11-05_10h33m06s.csv. It is the file to
# import into Loox and holds the accepted images of every run chosen in Duyệt (one run or several). Each run it took gets
# <run>/exported.txt (the path of that file) so Duyệt can show it as exported. Nothing else is written next to it.
# The links come from the run itself: every image is uploaded to the results repo when it is made (run-images.ps1 without -LocalOnly), so photo_url is already
# an https link. An accepted image without one stops the export, because Loox could not read it.
# Rating, author, email and date are set by step 4 at the end of a run; a run that was stopped never got them, so the accepted rows of such a run
# get them here (same rules, 04-complete-metadata.ps1) and keep them in the run's results.json.
# Only after every image of every run has a decision; only images marked ok go into the file.

# Every image of the runs with its decision; throws while one is undecided or nothing is accepted.
function Get-ReviewedForExport([string[]]$BatchDirs) {
    $all = @(foreach ($dir in $BatchDirs) { foreach ($item in @(Get-BatchReview $dir)) { [pscustomobject]@{ Dir = $dir; Item = $item } } })
    if (-not $all.Count) { throw 'Chưa có ảnh nào để duyệt.' }
    $left = @($all | Where-Object { -not $_.Item.Decision })
    if ($left.Count) { throw "Còn $($left.Count) ảnh chưa duyệt." }
    if (-not @($all | Where-Object { $_.Item.Decision -in @('ok', 'text') }).Count) { throw 'Chưa có đánh giá nào được giữ.' }
    return $all
}

# A run is exported once it has exported.txt (older runs: their own loox_import.csv).
function Test-BatchExported([string]$BatchDir) {
    return (Test-Path -LiteralPath (Join-Path $BatchDir 'exported.txt')) -or (Test-Path -LiteralPath (Join-Path $BatchDir 'loox_import.csv'))
}

# Runs with results that are not exported yet, oldest first.
function Get-UnexportedBatchDirs([string]$OutputRoot) {
    if (-not (Test-Path -LiteralPath $OutputRoot)) { return @() }
    return @(Get-ChildItem -LiteralPath $OutputRoot -Directory | Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName 'results.json')) -and -not (Test-BatchExported $_.FullName) } | Sort-Object Name | ForEach-Object { $_.FullName })
}

# One Loox file for the runs given; returns its path (<ExportRoot>/loox_<time>.csv).
function Export-ReviewedCsvMany([string[]]$BatchDirs, [string]$ExportRoot) {
    $all = Get-ReviewedForExport $BatchDirs
    $ok = @($all | Where-Object { $_.Item.Decision -in @('ok', 'text') })
    # A review-only row has no image: its photo_url stays empty on purpose (Loox accepts an empty photo column).
    $noLink = @($ok | Where-Object { $_.Item.Decision -ne 'text' -and -not $_.Item.ReviewOnly -and [string]$_.Item.Row.photo_url -notmatch '^https://' })
    if ($noLink.Count) { throw "[CAUSE:RESULT_UPLOAD] $($noLink.Count) ảnh Giữ chưa có link công khai (chạy ở chế độ chỉ lưu máy), Loox không đọc được. Chạy bằng nút Bắt đầu để ảnh được đưa lên kho kết quả." }
    $bare = @($ok | Where-Object { -not [string]$_.Item.Row.rating })
    if ($bare.Count) {
        Complete-ReviewMetadata @($bare | ForEach-Object { $_.Item.Row }) (Join-Path $PSScriptRoot '../../data/names.txt')
        foreach ($dir in @($bare | ForEach-Object { $_.Dir } | Select-Object -Unique)) { Save-BatchResults @($all | Where-Object { $_.Dir -eq $dir } | ForEach-Object { $_.Item.Row }) $dir }
    }
    New-Item -ItemType Directory -Force -Path $ExportRoot | Out-Null
    $stamp = (Get-Date).ToString("yyyy-MM-dd_HH'h'mm'm'ss's'")
    $path = Join-Path $ExportRoot "loox_$stamp.csv"
    for ($n = 2; Test-Path -LiteralPath $path; $n++) { $path = Join-Path $ExportRoot "loox_$stamp-$n.csv" }
    $exportRows = @(foreach ($entry in $ok) {
        # Clear only the exported copy: keep the original image/link for comparison and changing the decision later.
        $copy = $entry.Item.Row.PSObject.Copy()
        if ($entry.Item.Decision -eq 'text') { $copy.photo_url = '' }
        $copy
    })
    Save-Csv $exportRows $path
    foreach ($dir in $BatchDirs) { [IO.File]::WriteAllText((Join-Path $dir 'exported.txt'), $path, [Text.UTF8Encoding]::new($false)) }
    return $path
}
