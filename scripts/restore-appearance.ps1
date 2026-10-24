# Explicit offline recovery. All paths are required; no automatic profile discovery.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BackupPath,
    [Parameter(Mandatory=$true)][string]$TargetPath,
    [Parameter(Mandatory=$true)][switch]$ConfirmAppStopped
)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmAppStopped) { throw 'Stop PLIX before recovery and pass -ConfirmAppStopped.' }
$source = [IO.Path]::GetFullPath($BackupPath)
$target = [IO.Path]::GetFullPath($TargetPath)
if ([StringComparer]::OrdinalIgnoreCase.Equals($source, $target)) { throw 'Backup and target must differ.' }
$directory = [IO.Path]::GetDirectoryName($target)
if (-not [IO.Directory]::Exists($directory)) { throw 'Target directory must already exist.' }
if ([IO.Directory]::Exists($target)) { throw 'Target must be a file.' }

function Assert-Bytes([byte[]]$Expected, [string]$Path) {
    $actual = [IO.File]::ReadAllBytes($Path)
    if ($actual.Length -ne $Expected.Length) { throw "Verification failed: $Path" }
    for ($i = 0; $i -lt $actual.Length; $i++) {
        if ($actual[$i] -ne $Expected[$i]) { throw "Verification failed: $Path" }
    }
}
function Write-Verified([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    Assert-Bytes $Bytes $Path
}

$bytes = [IO.File]::ReadAllBytes($source)
# Validate syntax only. Never serialize via PowerShell: preserve source bytes.
# The next PLIX startup validates compatibility and can keep the restored file protected.
$text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
$null = ConvertFrom-Json -InputObject $text -ErrorAction Stop
if (-not $text.TrimStart().StartsWith('{')) { throw 'Backup must contain a JSON object.' }

$token = [Guid]::NewGuid().ToString('N')
$quarantine = $null
$temporary = $target + '.restore-' + $token + '.tmp'
try {
    Write-Verified $temporary $bytes
    if ([IO.File]::Exists($target)) {
        # Refuse to replace if the original cannot be read, synced and verified.
        $original = [IO.File]::ReadAllBytes($target)
        $quarantine = $target + '.before-restore-' + $token + '.bak'
        Write-Verified $quarantine $original
        Assert-Bytes $original $target
        [IO.File]::Replace($temporary, $target, [NullString]::Value)
    } else {
        # File.Move refuses an unexpected destination; no overwrite in the missing case.
        [IO.File]::Move($temporary, $target)
    }
    Assert-Bytes $bytes $target
    [pscustomobject]@{
        Restored = $target
        OriginalBackup = $quarantine
        SourceBackup = $source
        Status = 'Exact bytes restored. Restart PLIX for schema compatibility validation.'
    }
} finally {
    # Only our own staging file is disposable. Originals and backups are retained.
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
