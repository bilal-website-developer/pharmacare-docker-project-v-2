[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationDirectory,
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ComposeProjectName
)

$ErrorActionPreference = 'Stop'

function Invoke-DockerCommand {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & docker @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    $safeOutput = @($output | ForEach-Object {
        $line = [string]$_
        foreach ($name in @('MONGO_ROOT_PASSWORD', 'MONGO_REPLICA_KEY', 'MONGO_APP_PASSWORD', 'MONGO_BACKUP_PASSWORD', 'JWT_ACCESS_SECRET', 'REFRESH_TOKEN_PEPPER')) {
            $value = [Environment]::GetEnvironmentVariable($name)
            if ($value) { $line = $line.Replace($value, '[REDACTED]') }
        }
        $line
    })

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = $safeOutput
    }
}

$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$composeFile = Join-Path $root 'docker-compose.yml'
$envFile = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) {
    throw 'External backup requires the installed Compose file.'
}
$destination = [System.IO.Path]::GetFullPath($DestinationDirectory)
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($destination.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
    $destination.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'External backup destination must be outside the installation folder.'
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null

if (-not $ComposeProjectName -and (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
        if ($line -match '^COMPOSE_PROJECT_NAME=(.*)$') { $ComposeProjectName = $Matches[1] }
    }
}
if (-not $ComposeProjectName -or $ComposeProjectName -notmatch '^[a-z0-9][a-z0-9_-]*$') {
    throw 'Supply a valid Compose project name or configure it in the installation environment file.'
}

$backupResult = Invoke-DockerCommand -Arguments @(
    'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile,
    '--profile', 'backup', 'run', '--rm', '--no-deps', 'mongo-backup', 'backup-once'
)
if ($backupResult.ExitCode -ne 0) {
    throw "Mongo backup command failed (exit $($backupResult.ExitCode)): $($backupResult.Output -join ' ')"
}

$volume = "${ComposeProjectName}_mongo_backups"
$archiveResult = Invoke-DockerCommand -Arguments @(
    'run', '--rm', '--mount', "source=$volume,target=/backups,readonly",
    'mongo:8.0.12', 'sh', '-c', 'ls -1t /backups/pharmacare-*.archive.gz 2>/dev/null | head -n 1 | xargs -r basename'
)
$archiveName = ($archiveResult.Output -join "`n").Trim()
if (($archiveResult.ExitCode -ne 0) -or (-not $archiveName) -or
    ($archiveName -notmatch '^pharmacare-[0-9]{8}T[0-9]{6}Z\.archive\.gz$')) {
    throw 'No completed backup archive was found.'
}
$archivePath = Join-Path $destination $archiveName
$containerName = "pharmacare-backup-copy-$([Guid]::NewGuid().ToString('N'))"
$createResult = Invoke-DockerCommand -Arguments @(
    'create', '--name', $containerName, '--mount', "source=$volume,target=/backups,readonly", 'mongo:8.0.12', 'sleep', '30'
)
if ($createResult.ExitCode -ne 0) {
    throw "Could not create a temporary archive-copy container (exit $($createResult.ExitCode)): $($createResult.Output -join ' ')"
}
try {
    $copyResult = Invoke-DockerCommand -Arguments @('cp', "${containerName}:/backups/$archiveName", $archivePath)
    if ($copyResult.ExitCode -ne 0) {
        throw "Could not copy the archive to the external folder (exit $($copyResult.ExitCode)): $($copyResult.Output -join ' ')"
    }
}
finally {
    $removeResult = Invoke-DockerCommand -Arguments @('rm', '--force', $containerName)
    if ($removeResult.ExitCode -ne 0) {
        throw "Could not remove temporary archive-copy container (exit $($removeResult.ExitCode))."
    }
}

$scratchStart = Invoke-DockerCommand -Arguments @(
    'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile,
    '--profile', 'backup-restore', 'up', '--detach', '--wait', '--wait-timeout', '60', 'mongo-restore-scratch'
)
if ($scratchStart.ExitCode -ne 0) {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    throw "Could not start the tmpfs archive-verification target (exit $($scratchStart.ExitCode))."
}
try {
    $verifyResult = Invoke-DockerCommand -Arguments @(
        'run', '--rm', '--network', "${ComposeProjectName}_database", '--volume', "${destination}:/backup:ro", 'mongo:8.0.12',
        'mongorestore', '--host', "$ComposeProjectName-mongo-restore-scratch-1", '--port', '27017',
        '--dryRun', '--gzip', "--archive=/backup/$archiveName", "--nsInclude=$($env:MONGO_APP_DB).*"
    )
}
finally {
    $scratchStop = Invoke-DockerCommand -Arguments @(
        'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile,
        '--profile', 'backup-restore', 'stop', 'mongo-restore-scratch'
    )
    if ($scratchStop.ExitCode -ne 0) {
        throw "Could not stop the tmpfs archive-verification target (exit $($scratchStop.ExitCode))."
    }
}
if ($verifyResult.ExitCode -ne 0) {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    throw "The external archive failed mongorestore verification (exit $($verifyResult.ExitCode)): $($verifyResult.Output -join ' ')"
}
$digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(
    "$archivePath.sha256",
    "$digest  $archiveName`n",
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "External backup copied and archive-verified: $archivePath"
Write-Host "SHA256 checksum written to $archivePath.sha256"
