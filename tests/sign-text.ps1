. (Join-Path $PSScriptRoot 'helpers.ps1')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'src/bootstrap.ps1')
. (Join-Path $root 'src/application/batch-import.ps1')
function Assert($Value, [string]$Message) { if (-not $Value) { throw $Message } }
# Sign wording (sign_text) of made-to-order lettered products: set per product image, kept when a review image is added later,
# kept when a draft is copied into the project, cleared by empty text, readable from the import table.
$temp = Join-Path $TestWorkspaceRoot ('sign-text-' + [Guid]::NewGuid().ToString('N'))
try {
    $a = Join-Path $temp 'a'; $b = Join-Path $temp 'b'
    New-Item -ItemType Directory -Force -Path "$a/workspace", "$b/workspace", "$temp/img", "$temp/csv/images" | Out-Null
    $png = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    $make = { param($Name, $Seed) $p = "$temp/img/$Name"; [IO.File]::WriteAllBytes($p, [byte[]]($png + [Text.Encoding]::UTF8.GetBytes($Seed))); $p }
    $prod = & $make 'prod.png' 'prod'; $s1 = & $make 's1.png' 's1'; $s2 = & $make 's2.png' 's2'
    $url = 'https://shop.test/products/neon'
    $mapA = Join-Path $a 'workspace/reference-inputs/references.json'
    [void](Save-ManualReference $a $url $prod Product)
    [void](Save-ManualReference $a $url $s1 Scene 0)
    Set-ManualSignText $mapA $url 0 'Bar | The Copper Lounge'
    $entry = @((Read-ManualReferenceMap $mapA).entries)[0]
    Assert (@(Get-ManualScenes $entry)[0].sign_text -eq 'Bar | The Copper Lounge') 'Sign wording must be saved on the review image.'
    [void](Save-ManualReference $a $url $s2 Scene 0)
    $entry = @((Read-ManualReferenceMap $mapA).entries)[0]
    Assert (@(Get-ManualScenes $entry | Where-Object { $_.sign_text -eq 'Bar | The Copper Lounge' }).Count -eq 2) 'A review image added later must keep the sign wording.'
    Set-ManualSignText $mapA $url 0 "IRON WORKS`r`nGYM"
    $entry = @((Read-ManualReferenceMap $mapA).entries)[0]
    Assert (@(Get-ManualScenes $entry)[0].sign_text -eq 'IRON WORKS | GYM') 'A line break in the box must become " | ".'
    Copy-ManualEntry $b $url $entry
    $mapB = Join-Path $b 'workspace/reference-inputs/references.json'
    $copied = @((Read-ManualReferenceMap $mapB).entries)[0]
    Assert (@(Get-ManualScenes $copied | Where-Object { $_.sign_text -eq 'IRON WORKS | GYM' }).Count -eq 2) 'Copying a draft into the project must keep the sign wording.'
    Set-ManualSignText $mapB $url 0 ''
    $copied = @((Read-ManualReferenceMap $mapB).entries)[0]
    Assert (-not @(Get-ManualScenes $copied | Where-Object { $_.PSObject.Properties['sign_text'] }).Count) 'Empty text must clear the sign wording.'
    Copy-Item $prod "$temp/csv/images/p.png"; Copy-Item $s1 "$temp/csv/images/r.png"
    $parsed = ConvertFrom-ProductBatch "product_url,product_image,review_images,sign_text`nhttps://shop.test/x,p.png,r.png,Emma & Liam" "$temp/csv"
    Assert (-not @($parsed.Errors).Count -and $parsed.Rows[0].SignText -eq 'Emma & Liam') 'The import table must read the sign_text column.'
    Assert (-not @((ConvertFrom-ProductBatch 'https://shop.test/a').Errors).Count) 'Plain links must still parse.'
    # The shared prompt template (prompts/sign-wording.txt) used by the Codex and Claude (Flow) paths.
    $rule = Get-SignWordingRule 'Bar | The Copper Lounge' 2 'the product text and rule 6'
    Assert ($rule -match 'exactly these 2 line\(s\)' -and $rule -match '"Bar", "The Copper Lounge"' -and $rule -match 'rule 6' -and $rule -notmatch '\{\{') 'The sign wording rule must fill every placeholder of the template.'
    Assert ((Get-SignWordingRule '') -eq '') 'No sign_text must give no sign wording rule.'
    'sign-text OK'
} finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
