# Codex CLI (codex exec), signed in with ChatGPT (Cấu hình → Đăng nhập Codex): text and images, no API key.
# Invoke-CodexExec is the provider; the rest runs and reads one CLI process. Uses common.ps1.

function Get-CodexLaunch {
    $path = (Get-Command codex -ErrorAction Stop).Source
    # macOS/Linux: the codex command is directly executable.
    if (-not $script:OnWindows -or [IO.Path]::GetExtension($path) -eq '.exe') { return @{FileName=$path; Prefix=@()} }
    # npm's PowerShell/cmd shims are unnecessary: start its Node launcher directly.
    $launcher = Join-Path (Split-Path $path -Parent) 'node_modules/@openai/codex/bin/codex.js'
    if (-not (Test-Path -LiteralPath $launcher)) { throw 'Codex executable not found. Run setup to check the installation.' }
    return @{FileName=(Get-Command node.exe -ErrorAction Stop).Source; Prefix=@($launcher)}
}

# Isolate the CLI so its internal reconnect loop cannot block a worker indefinitely.
function Invoke-CodexProcess([string]$PromptText, [string[]]$CommandArgs, [string]$Trace,
    [int]$TimeoutSeconds, [int]$ReconnectSeconds = 60, [string]$CommandPath = '', [int]$ProgressSeconds = 30) {
    $launch = if ($CommandPath) { @{FileName=$CommandPath; Prefix=@()} } else { Get-CodexLaunch }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $launch.FileName
    $allArgs = @($launch.Prefix) + @($CommandArgs)
    $start.Arguments = (@($allArgs | ForEach-Object { ConvertTo-CliArgument $_ }) -join ' ')
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8; $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $writer = [IO.StreamWriter]::new($Trace, $false, [Text.UTF8Encoding]::new($false)); $writer.AutoFlush = $true
    $watch = [Diagnostics.Stopwatch]::StartNew(); $reconnectAt = -1.0; $notified = $false; $nextProgress = $ProgressSeconds
    $cause = ''; $exitCode = -1; $started = $false; $stopConfirmed = $false
    try {
        [void]$process.Start(); $started = $true
        # Windows PowerShell's default stdin writer may use the system code page.
        # Write explicit UTF-8 bytes so Vietnamese feedback is preserved in every caller.
        $promptBytes = [Text.UTF8Encoding]::new($false).GetBytes($PromptText)
        $inputWrite = $process.StandardInput.BaseStream.WriteAsync($promptBytes, 0, $promptBytes.Length); $inputClosed = $false
        $readers = @($process.StandardOutput, $process.StandardError)
        $pending = @($readers[0].ReadLineAsync(), $readers[1].ReadLineAsync())
        while ($true) {
            if (-not $inputClosed -and $inputWrite.IsCompleted) {
                try {
                    $inputWrite.GetAwaiter().GetResult()
                    $process.StandardInput.Close()
                } catch [IO.IOException] {
                    # A CLI may exit/close stdin early; drain its diagnostic output and exit code.
                    $writer.WriteLine('CLI closed its input stream before the prompt was fully accepted.')
                }
                $inputClosed = $true
            }
            for ($i = 0; $i -lt 2; $i++) {
                # Drain only a bounded number of lines per poll so a noisy CLI cannot defeat the deadline.
                for ($n = 0; $n -lt 100 -and $null -ne $pending[$i] -and $pending[$i].IsCompleted; $n++) {
                    $line = $pending[$i].GetAwaiter().GetResult()
                    if ($null -eq $line) { $pending[$i] = $null; break }
                    $writer.WriteLine($line)
                    # Only CLI stream-status lines start the reconnect deadline. Tool
                    # source text and background MCP/analytics warnings are not a lost model stream.
                    if ($line -match '(?i)^(?:ERROR:\s*)?(?:Reconnecting\b|stream disconnected\b|connection reset\b|failed to connect\b|error sending request\b)') {
                        if (-not $notified) { Write-Host '  [AI-CONNECTION] Connection interrupted; waiting for recovery...' -ForegroundColor Yellow; $notified = $true }
                        if ($reconnectAt -lt 0) { $reconnectAt = $watch.Elapsed.TotalSeconds }
                    } elseif ($reconnectAt -ge 0 -and ($line -match '^(assistant|thinking|tool\s|exec\s)' -or $line -match '^\s*\{\s*"type"\s*:\s*"(?:item\.|turn\.)')) {
                        $reconnectAt = -1; $notified = $false
                        Write-Host '  [AI-RESUMED] Response stream resumed.' -ForegroundColor Cyan
                    }
                    $pending[$i] = $readers[$i].ReadLineAsync()
                }
            }
            if ($process.HasExited -and $null -eq $pending[0] -and $null -eq $pending[1]) { $exitCode = $process.ExitCode; break }
            if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { $cause = 'AI_TIMEOUT'; break }
            if ($reconnectAt -ge 0 -and ($watch.Elapsed.TotalSeconds - $reconnectAt) -ge $ReconnectSeconds) { $cause = 'NETWORK'; break }
            if ($reconnectAt -lt 0 -and $ProgressSeconds -gt 0 -and $watch.Elapsed.TotalSeconds -ge $nextProgress) {
                Write-Host ("  [AI-WAIT] {0}/{1}s elapsed." -f [int]$watch.Elapsed.TotalSeconds, $TimeoutSeconds) -ForegroundColor DarkGray
                $nextProgress += $ProgressSeconds
            }
            Start-Sleep -Milliseconds 100
        }
        if ($cause) { $writer.WriteLine("Stopped local CLI: $cause after $([int]$watch.Elapsed.TotalSeconds)s.") }
    } finally {
        # Kill only this invocation and its descendants; retain the queue and diagnostic files.
        if ($started -and -not $process.HasExited) {
            $treeKilled = Stop-ProcessTree $process
            $exited = $process.WaitForExit(5000)
            $stopConfirmed = $treeKilled -and $exited
        } elseif ($started -and -not $cause) {
            $stopConfirmed = $true
        }
        $writer.Dispose(); $process.Dispose(); $watch.Stop()
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Cause = $cause; StopConfirmed = $stopConfirmed }
}

# Inspect tool results, never prompts, tool arguments or assistant claims, for error evidence.
function Get-CodexToolFailure([string]$Trace) {
    if(-not (Test-Path -LiteralPath $Trace -PathType Leaf)){return}
    $raw=Get-Content -LiteralPath $Trace -Raw -Encoding UTF8
    $payloads=[Collections.Generic.List[string]]::new()
    function Add-ToolEvidence($Value,[int]$Depth=0){
        if($null -eq $Value -or $Depth -gt 12){return}
        if($Value -is [string]){
            try{$decoded=ConvertFrom-Json -InputObject $Value -ErrorAction Stop}catch{$decoded=$null}
            if($decoded -and $decoded -isnot [string]){Add-ToolEvidence $decoded ($Depth+1)}
            $payloads.Add($Value)
        }elseif($Value -is [array]){foreach($part in $Value){Add-ToolEvidence $part ($Depth+1)}}
        else{
            # Keep sibling HTTP status and error fields together; recurse through text wrappers.
            $payloads.Add(($Value|ConvertTo-Json -Depth 20 -Compress))
            foreach($key in @('error','result','content','text','output','structuredContent')){
                if($Value.PSObject.Properties[$key]){Add-ToolEvidence $Value.$key ($Depth+1)}
            }
        }
    }
    $hasEvents=$false
    foreach($line in @($raw -split '\r?\n')){
        try{$event=ConvertFrom-Json -InputObject $line -ErrorAction Stop}catch{continue}
        if($event.type -match '^(item\.|turn\.|thread\.)'){$hasEvents=$true}
        if($event.item.type -in @('mcp_tool_call','tool_call')){
            if($event.item.error -is [string]){Add-ToolEvidence ([pscustomobject]@{error=[pscustomobject]@{message=$event.item.error}})}
            elseif($event.item.error){Add-ToolEvidence ([pscustomobject]@{error=$event.item.error})}
            Add-ToolEvidence $event.item.result
            if($event.item.result.isError -or $event.item.status -eq 'failed'){
                $toolText=@($event.item.result.content | Where-Object type -eq 'text' | ForEach-Object text) -join ' '
                if($toolText){Add-ToolEvidence ([pscustomobject]@{error=[pscustomobject]@{message=$toolText}})}
            }
        }elseif($event.type -in @('error','turn.failed')){Add-ToolEvidence ([pscustomobject]@{error=$event})}
        elseif($event.error){Add-ToolEvidence $event}
    }
    # Compatibility with older human-readable traces: only explicit tool error payloads.
    # JSONL traces must never fall back to matching quoted prompts/source/assistant messages.
    if(-not $hasEvents -and $raw -match '(?im)^\s*(?:HTTP\s+[45]\d\d\b|"(?:type|code)"\s*:\s*"(?:usage_limit_reached|insufficient_quota)"|(?:Error|ERROR):)'){
        $payloads.Add($raw)
    }
    $found=@()
    foreach($payload in $payloads){
        $kind='';$message='';$status='';$reset=''
        if($payload -match '"(?:type|code)"\s*:\s*"(?<kind>usage_limit_reached|insufficient_quota|quota_exceeded)"'){$kind=$Matches.kind;$cause='QUOTA'}
        elseif($payload -match '(?im)^(?:Error|ERROR):[^\r\n]*\b(usage_limit_reached|insufficient_quota)\b'){$kind=$Matches[1];$cause='QUOTA'}
        elseif($payload -match '"(?:type|code)"\s*:\s*"(?<kind>invalid_api_key|authentication_error|unauthorized)"'){$kind=$Matches.kind;$cause='AUTH'}
        elseif($payload -match '(?i)HTTP\s*(?<status>[45]\d\d)\b'){$kind='tool_http_error';$cause='TOOL_ERROR';$status=$Matches.status}
        elseif($payload -match '"error"\s*:\s*\{[^{}]*"message"\s*:'){$kind='tool_error';$cause='TOOL_ERROR'}
        else{continue}
        if($payload -match '"message"\s*:\s*("(?:\\.|[^"\\])*")'){
            try{$message=ConvertFrom-Json -InputObject $Matches[1] -ErrorAction Stop}catch{}
        }
        if($payload -match '(?i)(?:HTTP\s*|"(?:status|status_code|statusCode|http_status)"\s*:\s*"?)([45]\d\d)'){$status=$Matches[1]}
        if($payload -match '"resets_at"\s*:\s*(\d+)'){
            try{$reset=[DateTimeOffset]::FromUnixTimeSeconds([long]$Matches[1]).ToOffset([TimeSpan]::FromHours(7)).ToString('HH:mm:ss dd/MM/yyyy')+' (UTC+7)'}catch{}
        }
        elseif($payload -match '"resets_in_seconds"\s*:\s*(\d+)'){$reset="sau $($Matches[1]) giây theo phản hồi dịch vụ (chưa có thời điểm tuyệt đối)"}
        $detail="[CAUSE:$cause] $kind"
        if($status){$detail+="; HTTP $status"}
        if($message){$detail+="; Message: $($message -replace '[\r\n]+',' ')"}
        if($reset){$detail+="; Reset: $reset"}
        $found+=@([pscustomobject]@{Cause=$cause;Detail=$detail;Score=$(if($cause -eq 'QUOTA'){100}else{0})+$(if($status){2}else{0})+$(if($reset){1}else{0})})
    }
    $found|Sort-Object Score -Descending|Select-Object -First 1
}

# The ChatGPT account Codex is signed in with: the email in its sign-in token (auth.json), never the token itself.
function Get-CodexAccount {
    try {
        $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
        $part = ((Get-Content -LiteralPath (Join-Path $codexHome 'auth.json') -Raw | ConvertFrom-Json).tokens.id_token -split '\.')[1].Replace('-', '+').Replace('_', '/')
        $part += '=' * ((4 - $part.Length % 4) % 4)
        return [string]([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json).email
    } catch { return '' }
}

# Tokens one Codex call used, from the usage on its turn.completed events (codex exec --json). $null when absent.
function Get-CodexTokenUsage([string]$Trace) {
    if (-not (Test-Path -LiteralPath $Trace)) { return $null }
    $total = [pscustomobject]@{ Input = 0L; Cached = 0L; Output = 0L }; $found = $false
    foreach ($line in [IO.File]::ReadLines($Trace)) {
        if ($line -notmatch '"turn\.completed"' -or $line -notmatch '"usage"') { continue }
        try { $usage = ($line | ConvertFrom-Json).usage } catch { continue }
        if (-not $usage) { continue }
        $total.Input += [long]$usage.input_tokens; $total.Cached += [long]$usage.cached_input_tokens; $total.Output += [long]$usage.output_tokens; $found = $true
    }
    if ($found) { return $total } else { return $null }
}

# One codex exec call: the reply is written to $ResultFile and returned. -Sandbox workspace-write lets Codex save the
# image the prompt asks for (an image call), tried once: its caller can first recover a file Codex saved anyway.
# A text call is retried on a busy service or a lost stream, at most $Attempts times; never with another model, and
# never on a sign-in, credit or input error.
function Invoke-CodexExec([string]$PromptText, [string[]]$Images, [string]$ResultFile, [string]$WorkDir,
    [string]$Sandbox = 'read-only', [string]$Model = '', [string]$Effort = '', [int]$TimeoutSec = 0,
    [int]$ReconnectSec = 60, [int]$Attempts = 0, [int]$RetryDelaySec = -1) {
    $isImage = $Sandbox -eq 'workspace-write'
    $maxAttempts = if ($Attempts -gt 0) { $Attempts } elseif ($isImage) { 1 } else { 3 }
    if ($TimeoutSec -le 0) { $TimeoutSec = if ($isImage) { 480 } else { 180 } }
    $script:CodexCallTokens = $null
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $attemptFile = if ($attempt -eq 1) { $ResultFile } else { "$ResultFile.attempt-$attempt.txt" }
        # project_doc_max_bytes=0: Codex otherwise loads every AGENTS.md from the repo root down to WorkDir by itself
        # (the repo's and the tool's lessons), outside the prompt. Everything the AI needs is in the prompt and images.
        $commandArgs = @('exec', '--json', '--skip-git-repo-check', '-s', $Sandbox, '-C', $WorkDir, '-c', 'project_doc_max_bytes=0', '-o', $attemptFile)
        if ($Model) { $commandArgs += @('-m', $Model) }
        if ($Effort) { $commandArgs += @('-c', "model_reasoning_effort=$Effort") }
        foreach ($photo in $Images) { $commandArgs += @('-i', $photo) }
        $trace = "$attemptFile.console.log"
        # A new invocation must not accidentally consume an old last-message file.
        if(Test-Path -LiteralPath $attemptFile){Remove-Item -LiteralPath $attemptFile -Force}
        $execution = Invoke-CodexProcess $PromptText $commandArgs $trace $TimeoutSec $ReconnectSec
        # Every call's tokens, failed ones too, so the app can add them up for the run.
        $usage = Get-CodexTokenUsage $trace
        if ($usage) {
            Write-Host "[TOKENS] in=$($usage.Input) cached=$($usage.Cached) out=$($usage.Output)"
            if (-not $script:CodexCallTokens) { $script:CodexCallTokens = [pscustomobject]@{ Input = 0L; Cached = 0L; Output = 0L } }
            $script:CodexCallTokens.Input += $usage.Input; $script:CodexCallTokens.Cached += $usage.Cached; $script:CodexCallTokens.Output += $usage.Output
        }
        $toolFailure=Get-CodexToolFailure $trace
        if ($execution.Cause -and -not $execution.StopConfirmed) { throw "AI failed; previous process termination is unconfirmed. Details: $trace [CAUSE:PROCESS_ACTIVE]" }
        if ($execution.ExitCode -eq 0) {
            $text=if(Test-Path -LiteralPath $attemptFile){[IO.File]::ReadAllText($attemptFile,[Text.Encoding]::UTF8).Trim()}else{''}
            if ($text -or $isImage) {
                if ($attemptFile -ne $ResultFile -and (Test-Path -LiteralPath $attemptFile)) { Copy-Item -LiteralPath $attemptFile -Destination $ResultFile -Force }
                if(-not $isImage -and $toolFailure){throw "$($toolFailure.Detail); Details: $trace"}
                # Image traces survive until technical PNG validation succeeds.
                if(-not $isImage){Remove-Item -LiteralPath $trace -Force -ErrorAction SilentlyContinue}
                return $text
            }
        }
        if($toolFailure){throw "$($toolFailure.Detail); Details: $trace"}
        $failure = if (Test-Path -LiteralPath $trace) { Get-Content -LiteralPath $trace -Raw -Encoding UTF8 } else { '' }
        # JSON event text may quote prompts or assistant guesses; only direct CLI stderr
        # participates in the legacy fallback after structured evidence has been checked.
        $failure=(@($failure -split '\r?\n' | Where-Object {$_ -notmatch '^\s*\{'}) -join "`n")
        # Never change the model, and never retry permanent auth/credit/input failures.
        $permanent = $failure -match '(?i)out of credits|insufficient_quota|usage_limit_reached|usage limit|quota exceeded|invalid.api.key|unauthorized|authentication failed'
        $transient = $execution.Cause -in @('AI_TIMEOUT','NETWORK') -or $failure -match '(?i)Selected model is at capacity|rate.limit.exceeded|too many requests|HTTP\s*(429|502|503|504)|temporarily unavailable|server overloaded|connection reset|Reconnecting|stream disconnected'
        if ($permanent -or -not $transient -or $attempt -eq $maxAttempts) {
            $cause = if ($execution.Cause) { $execution.Cause }
                elseif ($failure -match '(?i)out of credits|insufficient_quota|usage_limit_reached|usage limit|quota exceeded') { 'QUOTA' }
                elseif ($failure -match '(?i)invalid.api.key|unauthorized|authentication failed') { 'AUTH' }
                elseif ($failure -match '(?i)connection reset|timed out|name resolution|Reconnecting|stream disconnected|Transport channel closed') { 'NETWORK' }
                elseif ($transient) { 'BUSY' } else { 'UNKNOWN' }
            throw "AI failed. Details: $trace [CAUSE:$cause]"
        }
        $delay = if ($RetryDelaySec -ge 0) { $RetryDelaySec } else { [int](3 * [Math]::Pow(2, $attempt - 1)) }
        Write-Host "  [RETRY] AI busy; attempt $($attempt + 1)/$maxAttempts in ${delay}s..." -ForegroundColor Yellow
        if ($delay -gt 0) { Start-Sleep -Seconds $delay }
    }
}

# ---- Windows sandbox race (lesson): codex gives each -C WorkDir its own capability SID and, at startup, runs
# "setup refresh" to grant it write access. With a NEW WorkDir and many codex processes starting at once, those refreshes
# overwrite each other: the batch root gets the right SID but images/refs/logs keep an old one, and Codex then fails
# to save into images (the PNG stays under ~/.codex/generated_images). So: one tiny sequential codex call per new WorkDir
# first, only then the subfolders and the parallel jobs; then compare the ACLs and repair empty folders.

# SIDs (S-1-5-21-..., i.e. not named accounts) holding a Modify ACE on a folder, from icacls.
function Get-CodexFolderSids([string]$Path) {
    $sids = [Collections.Generic.List[string]]::new()
    foreach ($line in @(& icacls.exe $Path 2>$null)) {
        if ($line -match '(S-1-5-21-[\d-]+):(?<flags>(?:\([^)]+\))+)' -and $Matches.flags -match '\(M\)' -and $Matches.flags -notmatch '\(DENY\)') {
            $sid = $line -replace '^.*?(S-1-5-21-[\d-]+):.*$', '$1'
            if (-not $sids.Contains($sid)) { $sids.Add($sid) }
        }
    }
    return ,$sids.ToArray()
}

# Create $Dir and its subfolders the safe way for Codex on Windows. Never throws; notes go to $LogFile (created under
# the first subfolder named 'logs', if any) and the console.
function Initialize-CodexWorkDir([string]$Dir, [string[]]$SubDirs, [int]$WarmupSec = 90) {
    $notes = [Collections.Generic.List[string]]::new()
    $note = { param($m) $notes.Add("$((Get-Date).ToString('HH:mm:ss')) $m"); Write-Host "  [CODEX-SETUP] $m" -ForegroundColor DarkGray }
    New-Item -ItemType Directory -Force $Dir | Out-Null
    if ($script:OnWindows) {
        $trace = Join-Path ([IO.Path]::GetTempPath()) "codex-warmup-$([guid]::NewGuid().ToString('N')).log"
        try {
            $args2 = @('exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', $Dir, '-c', 'project_doc_max_bytes=0')
            & $note 'Warm-up: one small Codex call for this work folder, before the parallel jobs.'
            $run = Invoke-CodexProcess 'Reply with exactly: OK' $args2 $trace $WarmupSec 20 '' 0
            & $note "Warm-up finished: exit=$($run.ExitCode) cause=$($run.Cause)"
        } catch { & $note "Warm-up failed (run continues): $($_.Exception.Message)" }
        finally { Remove-Item -LiteralPath $trace -Force -ErrorAction SilentlyContinue }
    }
    # Subfolders only now, so they inherit the ACEs the warm-up just wrote.
    foreach ($sub in $SubDirs) { New-Item -ItemType Directory -Force $sub | Out-Null }
    if ($script:OnWindows) {
        try {
            $rootSids = @(Get-CodexFolderSids $Dir)
            if (-not $rootSids.Count) { & $note 'ACL check skipped: no Codex SID found on the work folder.' }
            else {
                foreach ($sub in $SubDirs) {
                    for ($try = 1; $try -le 2; $try++) {
                        $subSids = @(Get-CodexFolderSids $sub)
                        $missing = @($rootSids | Where-Object { $_ -notin $subSids })
                        if (-not $missing.Count) { if ($try -eq 2) { & $note "ACL repaired: $(Split-Path $sub -Leaf)" }; break }
                        if ($try -eq 2) { & $note "ACL still differs on $(Split-Path $sub -Leaf); Codex may fail to save there."; break }
                        if (@(Get-ChildItem -LiteralPath $sub -Force).Count) { & $note "ACL differs on $(Split-Path $sub -Leaf) but it is not empty; left as is."; break }
                        & $note "ACL differs on $(Split-Path $sub -Leaf) (root SID $($missing -join ',') missing); recreating the empty folder."
                        Remove-Item -LiteralPath $sub -Force; New-Item -ItemType Directory -Force $sub | Out-Null
                    }
                }
            }
        } catch { & $note "ACL check failed (run continues): $($_.Exception.Message)" }
    }
    $logsDir = @($SubDirs | Where-Object { (Split-Path $_ -Leaf) -eq 'logs' })[0]
    if ($logsDir -and (Test-Path -LiteralPath $logsDir)) {
        try { [IO.File]::WriteAllLines((Join-Path $logsDir 'codex-setup.log'), $notes.ToArray(), [Text.UTF8Encoding]::new($false)) } catch {}
    }
}

# Codex may generate the image but be denied when saving it into the batch. Find the PNG of THIS job: the thread id
# comes from the job's own trace, and only a file named in that trace under <codex home>/generated_images/<thread>/
# that is a PNG written since $Since qualifies. Returns '' when not certain.
function Find-CodexGeneratedImage([string]$Trace, [datetime]$Since) {
    if (-not (Test-Path -LiteralPath $Trace -PathType Leaf)) { return '' }
    $raw = Get-Content -LiteralPath $Trace -Raw -Encoding UTF8
    if ($raw -notmatch '"thread_id"\s*:\s*"(?<t>[0-9a-fA-F-]{36})"') { return '' }
    $thread = $Matches.t
    $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
    $dir = Join-Path (Join-Path $codexHome 'generated_images') $thread
    $names = @([regex]::Matches($raw, 'generated_images[\\/]+' + [regex]::Escape($thread) + '[\\/]+(?<f>[A-Za-z0-9._-]+\.png)') | ForEach-Object { $_.Groups['f'].Value })
    for ($i = $names.Count - 1; $i -ge 0; $i--) {
        $file = Join-Path $dir $names[$i]
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $item = Get-Item -LiteralPath $file
        if ($item.Length -lt 8 -or $item.LastWriteTime -lt $Since) { continue }
        $head = [byte[]]::new(8)
        $stream = [IO.File]::OpenRead($file); try { [void]$stream.Read($head, 0, 8) } finally { $stream.Dispose() }
        if (($head -join ',') -eq '137,80,78,71,13,10,26,10') { return $file }
    }
    return ''
}
