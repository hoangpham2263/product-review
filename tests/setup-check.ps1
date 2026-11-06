$ErrorActionPreference = 'Stop'
$entry = Join-Path (Split-Path $PSScriptRoot -Parent) 'core/setup/setup-check.ps1'
$global:SetupTestAuthScenario = 'chatgpt'
function codex {
    switch ($global:SetupTestAuthScenario) {
        chatgpt { Write-Error 'Logged in using ChatGPT'; $global:LASTEXITCODE = 0 }
        api { Write-Error 'Logged in using API key'; $global:LASTEXITCODE = 0 }
        missing { Write-Error 'Not logged in'; $global:LASTEXITCODE = 1 }
    }
}
foreach ($scenario in @('chatgpt', 'api', 'missing')) {
    $global:SetupTestAuthScenario = $scenario
    $json = & $entry -AsJson | Out-String
    $report = $json | ConvertFrom-Json
    $expected = $scenario -ne 'missing'
    if ($report.Ready -ne $expected -or $report.Checks.Count -ne $(if ($expected) { 4 } else { 3 })) { throw 'Incorrect sign-in readiness.' }
    if ($json -match 'Write-Error|CategoryInfo|Logged in using|auth\.json|\.codex|credit|token') { throw 'Technical sign-in details leaked into the user report.' }
    if ($scenario -eq 'chatgpt' -and $report.Checks[2].Message -notmatch 'đã đăng nhập') { throw 'Successful stderr status was rejected.' }
    if ($scenario -eq 'api' -and $report.Checks[2].Message -notmatch 'tính phí riêng') { throw 'API sign-in must not be reported as ChatGPT.' }
    if (-not $expected -and -not $report.Checks[2].Action) { throw 'Missing sign-in must include user guidance.' }
    $states = @($report.Steps | ForEach-Object State)
    if (($report.Steps | ForEach-Object Id) -join ',' -ne 'node,codex,login,quota,browser,google,antigravity') { throw 'Check steps are missing or out of order.' }
    if ($expected -and $states[2] -ne 'ok') { throw 'Signed-in step must pass.' }
    if (-not $expected -and ($states[2] -ne 'fail' -or $states[3] -ne 'wait' -or $report.Steps[2].Action -ne 'login')) { throw 'Missing sign-in must block the quota step and offer sign-in.' }
}
# Cài / cập nhật tất cả AI: the button, the server step and every place that looks for agy (Google's Windows installer puts it in %LOCALAPPDATA%\agy\bin).
$core = Join-Path (Split-Path $PSScriptRoot -Parent) 'core'
$page = Get-Content -LiteralPath (Join-Path $core 'setup/page.html') -Raw -Encoding UTF8
$api = Get-Content -LiteralPath (Join-Path $core 'setup/config-api.mjs') -Raw -Encoding UTF8
if ($page -notmatch 'class="btn primary all"' -or $page -notmatch 'id="all-result"') { throw 'Cấu hình needs the Cài / cập nhật tất cả AI button and its result line.' }
if ($api -notmatch 'step === "update-all"' -or $api -notmatch '@openai/codex@latest' -or $api -notmatch 'antigravity\.google/cli/install\.ps1') { throw 'The update-all step must update Codex and install Antigravity CLI from its official installer.' }
if ($api -match 'iex' -or $api -match '\|\s*iex') { throw 'The installer must be saved to a file and run from there, never piped into PowerShell.' }
foreach ($file in 'setup/setup-check.ps1', 'ai/providers/antigravity.ps1') {
    if ((Get-Content -LiteralPath (Join-Path $core $file) -Raw -Encoding UTF8) -notmatch 'LOCALAPPDATA') { throw "$file must also look for agy in %LOCALAPPDATA%\agy\bin." }
}
Write-Host 'PASS: ChatGPT/API sign-in, missing login and clean setup messages, including successful stderr output.'
