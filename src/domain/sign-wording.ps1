# Sign wording of a made-to-order lettered product (neon name/logo sign): ONE template, prompts/sign-wording.txt, used by every
# image path (Codex: workflow/steps/02-create-image.ps1; Claude (Flow): agent.ps1). The wording comes from references.json
# scene.sign_text or, in the Claude (Flow) path, from the agent (src/agent.ps1 set-sign-text), " | " = line break.
# Rules live in the templates (prompts/sign-wording*.txt, prompts/sign-choice.txt); the code only fills the placeholders and checks.
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

# Lettered product without a chosen wording: the image AI reads the scene of image 1 and picks wording itself.
# Only the paths that cannot look at the images use it (Codex, Claude (Flow) runs created before exact wording).
function Get-AutoSignWordingRule([int]$ProductImage = 2, [string]$Overrides = 'the product text and the no-text rule') {
    $template = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../prompts/sign-wording-auto.txt') -Raw -Encoding UTF8
    $text = $template.Replace('{{OVERRIDES}}', $Overrides).Replace('{{PRODUCT_IMAGE}}', [string]$ProductImage)
    return (($text -split '\r?\n' | Where-Object { $_.Trim() }) -join ' ')
}

# The rule for one item: typed sign_text wins, else automatic wording when the context says the product is lettered, else ''.
function Get-ItemSignRule([string]$SignText, $Context, [int]$ProductImage = 2, [string]$Overrides = 'the product text and the no-text rule') {
    if ($SignText) { return Get-SignWordingRule $SignText $ProductImage $Overrides }
    if ($Context -and $Context.PSObject.Properties['lettered'] -and $Context.lettered -eq $true) { return Get-AutoSignWordingRule $ProductImage $Overrides }
    return ''
}

# The sample lettering of the product photo as the context step wrote it (context.sample_text, " | " = line break), or ''.
function Get-ContextSampleText($Context) {
    if ($Context -and $Context.PSObject.Properties['sample_text'] -and $Context.sample_text) { return ([string]$Context.sample_text).Trim() }
    return ''
}

# Product name / details with the sample lettering taken out, so a prompt that carries an exact SIGN WORDING
# never also quotes "Your Name" as a detail to copy.
function Remove-SampleLettering([string]$Text, $Context, [string]$Replacement = 'customer lettering (see SIGN WORDING)') {
    if (-not $Text) { return $Text }
    $q = '["''‘’“”]'
    $t = $Text
    # Every line of words on a lettered sign is replaced, the design's own words included: no remark may call any lettering fixed or kept.
    $t = [regex]::Replace($t, '(?i)\s*\((?:[^()]*\b(?:part of the design|fixed|kept)\b[^()]*)\)', '')
    $t = [regex]::Replace($t, '(?i)\bfixed\s+(?:words?|text|wording|lettering)\b', 'customer lettering')
    foreach ($line in @(Get-SignWordingLines (Get-ContextSampleText $Context) | Where-Object { $_.Length -ge 3 })) {
        $t = [regex]::Replace($t, "${q}?\s*" + [regex]::Escape($line) + "\s*${q}?", " $Replacement ", 'IgnoreCase')
    }
    # Quoted "Your ..." / 'YOUR LOGO', and unquoted Your Gamer Tag / YOUR GYM NAME (Your + up to 3 capitalised words).
    $t = [regex]::Replace($t, "${q}\s*your\b[^""'‘’“”]{0,40}${q}", " $Replacement ", 'IgnoreCase')
    $t = [regex]::Replace($t, "\b(?:Your|YOUR)(?:\s+(?:[A-Z][A-Za-z'’]*|&)){1,3}", $Replacement)
    $t = [regex]::Replace($t, '(?i)\b(?:sample|placeholder)\s+(?:text|script|lettering|wording|words?|names?)\s*(?:reading|that reads|saying)?\s*', 'the ')
    $t = [regex]::Replace($t, '(?i)\bthe\s+the\b', 'the')
    $t = [regex]::Replace($t, '(?i)(customer lettering)(\s+customer lettering)+', '$1')
    $t = [regex]::Replace($t, '\s{2,}', ' ')
    $t = [regex]::Replace($t, '\s+([,.;:])', '$1')
    return $t.Trim()
}

# Case- and spacing-tolerant form of a sign wording, to compare what the sign reads with sign_text.
function ConvertTo-SignCompareText([string]$Text) {
    $t = ([string]$Text).ToLowerInvariant() -replace '[‘’]', "'" -replace '[“”]', '"'
    return ($t -replace '[\s|]+', '' -replace '[.,!?:;"\-]', '')
}

# Checks a wording chosen for one item. $SampleText: the sample lettering (its line count is enforced when known);
# $Others: sign_text of the other items of the run. Returns @{ ok; error; cause } or @{ ok; lines; warnings }.
function Test-SignTextChoice([string]$Text, [string]$SampleText = '', [string[]]$Others = @()) {
    $fail = { param($m) [ordered]@{ ok = $false; error = $m; cause = 'BAD_SIGN_TEXT' } }
    $text = ([string]$Text).Trim()
    if (-not $text) { return (& $fail 'The wording is empty.') }
    if ($text -notmatch '^[\x20-\x7E]+$') { return (& $fail 'Use plain ASCII English only (no accents, emoji or curly quotes).') }
    if ($text -notmatch '[A-Za-z]') { return (& $fail 'The wording has no letters.') }
    $lines = @(Get-SignWordingLines $text)
    if (-not $lines.Count) { return (& $fail 'The wording is empty.') }
    $sample = @(Get-SignWordingLines $SampleText)
    $warnings = @()
    if ($sample.Count) {
        if ($lines.Count -ne $sample.Count) { return (& $fail "The sample lettering has $($sample.Count) line(s) ($($sample -join ' | ')); give the same number of lines, separated by ' | '.") }
    } else { $warnings += 'Line count not checked: the context has no sample_text; match the line count of the sample yourself.' }
    foreach ($line in $lines) {
        $words = @($line -split '\s+' | Where-Object { $_ })
        if ($words.Count -gt 3) { return (& $fail "At most 3 words per line: '$line' has $($words.Count).") }
        if ($line -match '(?i)\byour\b|\b(?:name|logo|text|wording)\s+here\b|^(?:sample|placeholder|lorem)\b|\bipsum\b') { return (& $fail "'$line' is placeholder wording; choose real wording that fits the scene.") }
        foreach ($s in $sample) { if ((ConvertTo-SignCompareText $s) -eq (ConvertTo-SignCompareText $line)) { return (& $fail "'$line' repeats the sample lettering of the product photo.") } }
    }
    $key = ConvertTo-SignCompareText $text
    foreach ($o in @($Others | Where-Object { $_ })) {
        if ((ConvertTo-SignCompareText $o) -eq $key) { return [ordered]@{ ok = $false; error = "Another item of this run already reads '$o'; vary the wording."; cause = 'SIGN_TEXT_DUPLICATE' } }
    }
    $otherLines = @($Others | Where-Object { $_ } | ForEach-Object { Get-SignWordingLines $_ } | ForEach-Object { ConvertTo-SignCompareText $_ })
    $shared = @($lines | Where-Object { $otherLines -contains (ConvertTo-SignCompareText $_) })
    if ($shared.Count) { $warnings += "Line(s) also used by another item: $($shared -join ', ') (allowed, but vary names where you can)." }
    return [ordered]@{ ok = $true; lines = $lines; warnings = $warnings }
}
