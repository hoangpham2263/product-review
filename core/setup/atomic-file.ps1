# Atomic writes and file locks for files that more than one session (app window) can touch at the same time.
# - Write-FileAtomic / Write-BytesAtomic: the content goes to a temp file next to the target and replaces it in one step, so a reader never sees a
#   half-written file and two writers never interleave.
# - Use-FileLock: an exclusive OS file lock (FileShare.None) around a read-modify-write. The OS frees it when the process dies, so a crash never leaves
#   a project blocked; waiting is a short retry loop with a timeout.
# - Use-ProjectLock: Use-FileLock on <project dir>/.project.lock, re-entrant inside one process (a locked function may call another locked one).
function Write-BytesAtomic([string]$Path, [byte[]]$Bytes) {
    $full = [IO.Path]::GetFullPath($Path)
    $dir = Split-Path $full -Parent
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = "$full.$PID.$([Guid]::NewGuid().ToString('N').Substring(0, 6)).tmp"
    [IO.File]::WriteAllBytes($tmp, $Bytes)
    try {
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            try {
                if (Test-Path -LiteralPath $full) { [IO.File]::Replace($tmp, $full, [NullString]::Value) } else { [IO.File]::Move($tmp, $full) }
                return
            } catch [IO.IOException] { if ($attempt -eq 4) { throw }; Start-Sleep -Milliseconds (40 * ($attempt + 1)) }
        }
    } finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }
}
function Write-FileAtomic([string]$Path, [string]$Text, $Encoding = $null) {
    if (-not $Encoding) { $Encoding = [Text.UTF8Encoding]::new($false) }
    $preamble = $Encoding.GetPreamble()
    $body = $Encoding.GetBytes($Text)
    Write-BytesAtomic $Path ([byte[]]($preamble + $body))
}
# Reads a text file that another process may be replacing at this very moment (Write-FileAtomic): a sharing violation is retried a few times.
function Read-TextRetry([string]$Path, [int]$Tries = 10) {
    for ($i = 0; $i -lt $Tries; $i++) {
        try { return [IO.File]::ReadAllText($Path) }
        catch [IO.IOException] { if ($i -eq $Tries - 1) { throw }; Start-Sleep -Milliseconds (30 + 30 * $i) }
    }
}
function Use-FileLock([string]$LockPath, [scriptblock]$Body, [int]$TimeoutSec = 30) {
    $lockDir = Split-Path ([IO.Path]::GetFullPath($LockPath)) -Parent
    if ($lockDir) { New-Item -ItemType Directory -Force -Path $lockDir | Out-Null }
    $deadline = (Get-Date).AddSeconds($TimeoutSec); $stream = $null
    while (-not $stream) {
        try { $stream = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] {
            if ((Get-Date) -gt $deadline) { throw "[CAUSE:LOCK_BUSY] $([IO.Path]::GetFileName($LockPath)) is held by another process; try again in a few seconds." }
            Start-Sleep -Milliseconds (80 + (Get-Random -Maximum 120))
        }
    }
    try { return (& $Body) } finally { $stream.Dispose() }
}
$script:HeldProjectLocks = @{}
function Use-ProjectLock([string]$Dir, [scriptblock]$Body, [int]$TimeoutSec = 30) {
    $key = ([IO.Path]::GetFullPath($Dir)).ToLowerInvariant()
    if ($script:HeldProjectLocks.ContainsKey($key)) { return (& $Body) }
    $script:HeldProjectLocks[$key] = $true
    try { return (Use-FileLock (Join-Path $Dir '.project.lock') $Body $TimeoutSec) } finally { $script:HeldProjectLocks.Remove($key) }
}
