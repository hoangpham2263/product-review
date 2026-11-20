# Claude Code CLI (claude -p, headless), signed in with the user's Claude account: text only, no API key, no Chrome,
# no MCP. The review photos are read by Claude itself: they are copied into a folder of their own and named in the
# prompt, and Read is the ONLY tool it has (no Bash, no Write, no web). Uses common.ps1.

function Get-ClaudeCommand {
    # Same lookup as agent mode (core/setup/agent-run.mjs findClaude): PR_CLAUDE_CLI, else the first claude on PATH.
    if ($env:PR_CLAUDE_CLI -and (Test-Path -LiteralPath $env:PR_CLAUDE_CLI)) { return $env:PR_CLAUDE_CLI }
    $found = @(Get-Command claude -All -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -eq 'Application' } | ForEach-Object { $_.Source })
    $pick = if ($script:OnWindows) { @($found | Where-Object { $_ -match '\.(exe|cmd|bat)$' }) | Select-Object -First 1 } else { $null }
    if (-not $pick) { $pick = $found | Select-Object -First 1 }
    if ($pick) { return $pick }
    foreach ($path in @((Join-Path $HOME '.local/bin/claude'), (Join-Path $HOME '.local/bin/claude.exe'), (Join-Path $HOME '.claude/local/claude'))) { if (Test-Path -LiteralPath $path) { return $path } }
    throw 'AI failed. Chưa có Claude Code CLI (claude). Cài Claude Code rồi đăng nhập (hoặc đặt PR_CLAUDE_CLI), hoặc chọn AI khác. [CAUSE:AUTH]'
}

# The cause of a failed call, from what the CLI said (never from the prompt).
function Get-ClaudeFailureCause([string]$Detail) {
    if ($Detail -match '(?i)not logged in|please run /login|log in|login|sign in|unauthori[sz]ed|authentication|invalid.api.key|oauth|token.*(expired|revoked)|\b401\b') { return 'AUTH' }
    if ($Detail -match '(?i)usage limit|limit reached|quota|credit balance|out of credits|rate.limit|too many requests|\b429\b|resets? at') { return 'QUOTA' }
    if ($Detail -match '(?i)overloaded|\b(502|503|504|529)\b|temporarily unavailable|capacity') { return 'BUSY' }
    if ($Detail -match '(?i)ECONNRESET|ENOTFOUND|ETIMEDOUT|network|connection|fetch failed|getaddrinfo') { return 'NETWORK' }
    return 'UNKNOWN'
}

function Invoke-ClaudeText([string]$Prompt, [string[]]$Images, [string]$ResultFile, [int]$TimeoutSec = 300, [string]$Model = '') {
    $claude = Get-ClaudeCommand
    # A folder of its own in the system temp, outside the repo: no CLAUDE.md/AGENTS.md of the project is above it. It
    # holds only this prompt's images. Read reaches nothing else (the folder is the working directory).
    $work = Join-Path ([IO.Path]::GetTempPath()) "hub-claude-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $names = @(); $i = 0
    foreach ($image in @($Images | Where-Object { $_ })) {
        $i++
        $name = "image-$i$([IO.Path]::GetExtension($image).ToLowerInvariant())"
        Copy-Item -LiteralPath $image -Destination (Join-Path $work $name) -Force
        $names += (Join-Path $work $name)
    }
    $imageNote = if ($names.Count) { "The images this prompt refers to, in order, are these files. Open each one with the Read tool before answering:`n" + (($names | ForEach-Object { "- $_" }) -join "`n") + "`n`n" } else { '' }
    $full = $imageNote + $Prompt + "`nReply with only the answer asked for, nothing else. You only have the Read tool, for the images above; do not create, change or run anything."
    # --tools Read: the only tool there is. --strict-mcp-config with no --mcp-config: no MCP server at all.
    # --no-session-persistence: nothing is kept in the user's Claude history. The prompt goes in on stdin.
    $commandArgs = @('-p', '--output-format', 'json', '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config', '--permission-mode', 'default', '--no-session-persistence', '--max-turns', '12')
    if ($Model) { $commandArgs += @('--model', $Model) }
    $fileName = $claude; $allArgs = $commandArgs
    if ($script:OnWindows -and $claude -match '\.(cmd|bat)$') { $fileName = (Get-Command cmd.exe).Source; $allArgs = @('/c', $claude) + $commandArgs }
    $detail = ''; $cause = ''
    try {
        for ($attempt = 1; $attempt -le 2; $attempt++) {
            $start = [Diagnostics.ProcessStartInfo]::new()
            $start.FileName = $fileName
            $start.Arguments = (@($allArgs | ForEach-Object { ConvertTo-CliArgument $_ }) -join ' ')
            $start.WorkingDirectory = $work
            $start.UseShellExecute = $false; $start.CreateNoWindow = $true
            $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
            $start.StandardOutputEncoding = [Text.Encoding]::UTF8; $start.StandardErrorEncoding = [Text.Encoding]::UTF8
            $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
            $timedOut = $false
            try {
                [void]$process.Start()
                $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
                $bytes = [Text.UTF8Encoding]::new($false).GetBytes($full)
                try { $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length); $process.StandardInput.Close() } catch [IO.IOException] {}
                if (-not $process.WaitForExit($TimeoutSec * 1000)) {
                    $timedOut = $true
                    [void](Stop-ProcessTree $process); [void]$process.WaitForExit(5000)
                }
                $stdout = if ($timedOut) { '' } else { $out.Result }
                $stderr = if ($timedOut) { '' } else { $err.Result }
                $exitCode = if ($timedOut) { -1 } else { $process.ExitCode }
            } finally { $process.Dispose() }
            if ($timedOut) { $cause = 'AI_TIMEOUT'; $detail = "hết $TimeoutSec giây"; if ($attempt -lt 2) { Write-Host '  [RETRY] Claude; attempt 2/2...' -ForegroundColor Yellow }; continue }
            $reply = $null
            try { $reply = $stdout | ConvertFrom-Json -ErrorAction Stop } catch {}
            # Tokens of this call (failed ones too), for the usage log. Claude's usage, never any credential.
            if ($reply -and $reply.usage) {
                $u = $reply.usage
                $script:CodexCallTokens = [pscustomobject]@{
                    Input = [long]$u.input_tokens + [long]$u.cache_creation_input_tokens
                    Cached = [long]$u.cache_read_input_tokens
                    Output = [long]$u.output_tokens }
            }
            $text = if ($reply -and $reply.result -is [string]) { $reply.result.Trim() } else { '' }
            if ($exitCode -eq 0 -and $reply -and -not $reply.is_error -and $text) {
                [IO.File]::WriteAllText($ResultFile, $text, [Text.UTF8Encoding]::new($false))
                # One finished call, counted in the app's usage line.
                Write-Host '  [AI-CALL] claude'
                return $text
            }
            $detail = (@($(if ($reply -and $reply.result -is [string]) { $reply.result }), $stderr, $(if (-not $reply) { $stdout })) | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() }) -join ' '
            if (-not $detail) { $detail = "claude thoát với mã $exitCode, không có nội dung." }
            $cause = Get-ClaudeFailureCause $detail
            # Retry only a busy service or a lost connection, never a sign-in or limit problem.
            if ($cause -notin @('BUSY', 'NETWORK') -or $attempt -ge 2) { break }
            Write-Host '  [RETRY] Claude; attempt 2/2...' -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        }
    } finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    throw "AI failed. Claude CLI: $(if ($detail.Length -gt 300) { $detail.Substring(0, 300) } else { $detail }) [CAUSE:$cause]"
}
