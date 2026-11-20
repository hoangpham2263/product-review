# Sign wording of a made-to-order lettered product (neon name/logo sign): ONE template, prompts/sign-wording.txt, used by every
# image path (Codex: workflow/steps/02-create-image.ps1; Claude (Flow): agent.ps1). The wording comes from references.json
# scene.sign_text, " | " = line break. Rules live in the template; the code only fills the placeholders.
function Get-SignWordingLines([string]$SignText) {
    return @(([string]$SignText) -split ' *[|] *' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# $ProductImage: number of the product photo in the prompt (Codex and Flow both use 2).
# $Overrides: what the wording wins over in the surrounding prompt, e.g. 'the product text and rule 6'.
function Get-SignWordingRule([string]$SignText, [int]$ProductImage = 2, [string]$Overrides = 'the product text and the no-text rule') {
    $lines = @(Get-SignWordingLines $SignText)
    if (-not $lines.Count) { return '' }
    $template = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../prompts/sign-wording.txt') -Raw -Encoding UTF8
    $quoted = (@($lines | ForEach-Object { '"' + $_ + '"' })) -join ', '
    $text = $template.Replace('{{OVERRIDES}}', $Overrides).Replace('{{PRODUCT_IMAGE}}', [string]$ProductImage).Replace('{{LINE_COUNT}}', [string]$lines.Count).Replace('{{LINES}}', $quoted)
    return (($text -split '\r?\n' | Where-Object { $_.Trim() }) -join ' ')
}

# Lettered product without a typed wording (the normal case): the image AI/agent reads the scene of image 1 and picks wording that fits it.
function Get-AutoSignWordingRule([int]$ProductImage = 2, [string]$Overrides = 'the product text and the no-text rule') {
    $template = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../prompts/sign-wording-auto.txt') -Raw -Encoding UTF8
    $text = $template.Replace('{{OVERRIDES}}', $Overrides).Replace('{{PRODUCT_IMAGE}}', [string]$ProductImage)
    return (($text -split '?
' | Where-Object { $_.Trim() }) -join ' ')
}

# The rule for one item: typed sign_text wins, else automatic wording when the context says the product is lettered, else ''.
function Get-ItemSignRule([string]$SignText, $Context, [int]$ProductImage = 2, [string]$Overrides = 'the product text and the no-text rule') {
    if ($SignText) { return Get-SignWordingRule $SignText $ProductImage $Overrides }
    if ($Context -and $Context.PSObject.Properties['lettered'] -and $Context.lettered -eq $true) { return Get-AutoSignWordingRule $ProductImage $Overrides }
    return ''
}
