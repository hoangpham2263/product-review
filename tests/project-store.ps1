. (Join-Path $PSScriptRoot 'helpers.ps1')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'src/bootstrap.ps1')
. (Join-Path $root 'src/application/batch-import.ps1')
function Assert($Value, [string]$Message) { if (-not $Value) { throw $Message } }
# Dự án: one project folder per web (project.json, menu.json, products.csv, images/); a project is found again by its site, `used` and the
# review numbers survive, a link that finishes is marked used in every project table, and Nhập hàng loạt reads the table (used = T skipped).
$temp = Join-Path $TestWorkspaceRoot ('project-store-' + [Guid]::NewGuid().ToString('N'))
try {
    $projects = Join-Path $temp 'projects'
    $opened = Open-Project $projects 'https://www.shop.test/' 20
    Assert ($opened.New -and (Split-Path $opened.Dir -Leaf) -eq 'shop-test') 'A new project is created, its id is the site host.'
    Assert ((Get-ProjectDir $projects 'shop-test') -eq $opened.Dir) 'The project is found by its id.'
    Assert (-not (Open-Project $projects 'https://shop.test' 20).New) 'The same site finds the same project (www and trailing slash ignored).'
    $csv = Join-Path $opened.Dir 'products.csv'
    New-Item -ItemType Directory -Force -Path (Join-Path $opened.Dir 'images') | Out-Null
    $png = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1)
    foreach ($n in 'a', 'b') { [IO.File]::WriteAllBytes((Join-Path (Join-Path $opened.Dir 'images') "$n.png"), $png) }
    Write-ScanRows $csv @(
        [pscustomobject]@{ product_url = 'https://shop.test/products/a'; product_image = 'a.png'; title = 'A'; collection = 'Cat 1'; used = 'F' }
        [pscustomobject]@{ product_url = 'https://shop.test/products/b'; product_image = 'b.png'; title = 'B'; collection = 'Cat 2'; used = 'F' })
    Update-ProjectMenu $opened.Dir 'Cat 1' 'https://shop.test/collections/c1'
    $menu = @(Save-ProjectMenu $opened.Dir)
    Assert ($menu.Count -eq 2 -and @($menu | Where-Object { $_.name -eq 'Cat 1' })[0].url -eq 'https://shop.test/collections/c1' -and @($menu | Where-Object { $_.name -eq 'Cat 2' })[0].products -eq 1) 'menu.json has the categories, their link and product count.'
    # review numbers: only what is reported is stored
    Assert (Set-ProjectReviews $opened.Dir 'https://shop.test/products/b' 17 '4.8' 'stars line') 'A reported review number is stored.'
    Assert (-not (Set-ProjectReviews $opened.Dir 'https://shop.test/products/zzz' 3)) 'A link that is not in the project is refused.'
    $rows = @(Read-ScanRows $csv)
    $b = @($rows | Where-Object { $_.product_url -like '*/b' })[0]
    Assert ($b.reviews_count -eq '17' -and $b.reviews_checked_at) 'reviews_count and reviews_checked_at are written to the table.'
    $todo = @(Get-ReviewsTodo $opened.Dir)
    Assert ($todo.Count -eq 2 -and $todo[0].url -like '*/a' -and $todo[1].url -like '*/b') 'reviews-todo lists never-checked links first.'
    # used
    Assert ((Set-ProjectUsed $opened.Dir 'https://shop.test/products/a' $true) -eq 1) 'used can be set to T.'
    Assert ((Set-ScanUsed 'https://shop.test/products/b' $projects) -eq 1) 'A finished link is marked used in every project table.'
    $summary = Get-ProjectSummary $opened.Dir
    Assert ($summary.products -eq 2 -and $summary.used -eq 2 -and $summary.with_reviews -eq 1) 'The summary counts products, used and checked links.'
    Assert (@(Get-ProjectList $projects).Count -eq 1) 'The project list has the project.'
    # Nhập hàng loạt: review columns accepted, used = T skipped
    Set-ProjectUsed $opened.Dir 'https://shop.test/products/b' $false | Out-Null
    $parsed = ConvertFrom-ProductBatch ([IO.File]::ReadAllText($csv)) $opened.Dir
    Assert (-not @($parsed.Errors).Count -and @($parsed.Rows).Count -eq 1 -and $parsed.Skipped -eq 1) 'The import reads the project table: 1 row to run, 1 used row skipped, no unknown column.'
    'project-store OK'
} finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
