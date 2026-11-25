# Model AI: the model and reasoning level Codex uses for every call (writing reviews and making images), chosen in
# Cấu hình and kept once for every tool in workspace/config/ai-model.json. Empty values keep Codex's own default
# (~/.codex/config.toml). ProjectRoot is the install folder.
# A lighter model or a lower reasoning level uses fewer tokens.
. (Join-Path $PSScriptRoot 'config.ps1')
. (Join-Path $PSScriptRoot 'atomic-file.ps1')
$script:AiEfforts = @('low', 'medium', 'high', 'xhigh', 'max', 'ultra')

function Get-AiSettings([string]$ProjectRoot) {
    $path = Get-SharedConfigPath (Join-Path $ProjectRoot 'workspace') 'ai-model.json'
    $saved = if (Test-Path -LiteralPath $path) { try { Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } }
    $model = [string]$saved.model; $effort = [string]$saved.effort
    return [pscustomobject]@{
        model = $(if ($model -match '^[\w./:-]{1,80}$') { $model } else { '' })
        effort = $(if ($script:AiEfforts -contains $effort) { $effort } else { '' })
    }
}

function Set-AiSettings([string]$ProjectRoot, [string]$Model, [string]$Effort) {
    if ($Model -and $Model -notmatch '^[\w./:-]{1,80}$') { throw 'Tên model không hợp lệ.' }
    if ($Effort -and $script:AiEfforts -notcontains $Effort) { throw 'Mức suy nghĩ không hợp lệ.' }
    $path = Get-SharedConfigPath (Join-Path $ProjectRoot 'workspace') 'ai-model.json'
    New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
    Write-FileAtomic $path (ConvertTo-Json -InputObject ([ordered]@{ model = $Model; effort = $Effort })) ([Text.UTF8Encoding]::new($false))
}

# EVERY model of Codex (codex debug models, hidden ones too, marked "(ẩn)"), in its own order, each with all the reasoning levels it
# supports. Read from the CLI each time (new models appear by themselves) and cached in workspace/config/ai-models-cache.json; without Codex
# or when the list cannot be read, the cache is used.
function Get-AiModels([string]$ProjectRoot = '') {
    $cache = if ($ProjectRoot) { Get-SharedConfigPath (Join-Path $ProjectRoot 'workspace') 'ai-models-cache.json' } else { '' }
    $codex = @(Get-Command codex -CommandType Application -ErrorAction SilentlyContinue)[0]
    if ($codex) {
        try {
            $catalog = (& $codex.Source debug models 2>$null | Out-String) | ConvertFrom-Json
            $list = @(foreach ($m in @($catalog.models)) {
                    if ([string]$m.slug -notmatch '^[\w./:-]{1,80}$') { continue }
                    $name = [string]$(if ($m.display_name) { $m.display_name } else { $m.slug })
                    if ($m.visibility -ne 'list') { $name += ' (ẩn)' }
                    [pscustomobject]@{ slug = [string]$m.slug; name = $name
                        efforts = @(@($m.supported_reasoning_levels) | ForEach-Object { [string]$_.effort } | Where-Object { $script:AiEfforts -contains $_ })
                        default_effort = [string]$m.default_reasoning_level }
                })
            if ($list.Count -gt 0) {
                if ($cache) { try { New-Item -ItemType Directory -Force -Path (Split-Path $cache -Parent) | Out-Null; Write-FileAtomic $cache (ConvertTo-Json -InputObject @($list) -Depth 5) ([Text.UTF8Encoding]::new($false)) } catch { } }
                return $list
            }
        } catch { }
    }
    if ($cache -and (Test-Path -LiteralPath $cache)) {
        try { return @(foreach ($cachedModel in (Get-Content -LiteralPath $cache -Raw -Encoding UTF8 | ConvertFrom-Json)) { $cachedModel }) } catch { }
    }
    return @()
}

# What a run really uses, shown when it starts: the Model AI choice, or else Codex's own top-level settings in
# config.toml ($CODEX_HOME or ~/.codex), so a run never goes on an unexpected model unnoticed.
function Get-AiModelSummary([string]$ProjectRoot) {
    $chosen = Get-AiSettings $ProjectRoot
    $home_ = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
    $toml = try { ((Get-Content -LiteralPath (Join-Path $home_ 'config.toml') -Raw -Encoding UTF8) -split '(?m)^\s*\[')[0] } catch { '' }
    $read = { param($Key) if ($toml -match "(?m)^\s*$Key\s*=\s*[""']([^""']*)[""']") { $Matches[1] } else { '' } }
    $model = if ($chosen.model) { $chosen.model } else { & $read 'model' }
    $effort = if ($chosen.effort) { $chosen.effort } else { & $read 'model_reasoning_effort' }
    $provider = & $read 'model_provider'
    $names = @{ low = 'thấp'; medium = 'vừa'; high = 'cao'; xhigh = 'rất cao'; max = 'tối đa'; ultra = 'siêu cao' }
    $text = $(if ($model) { $model } else { 'model mặc định của Codex' })
    if ($effort) { $text += " · suy nghĩ $(if ($names[$effort]) { $names[$effort] } else { $effort })" }
    $text += $(if ($chosen.model -or $chosen.effort) { ' (chọn trong Cấu hình)' } else { ' (mặc định của Codex)' })
    if ($provider -and $provider -ne 'openai') { $text += " · qua $provider" }
    return $text
}
