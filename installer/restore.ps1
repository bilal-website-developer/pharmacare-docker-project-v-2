[CmdletBinding(DefaultParameterSetName = 'Restore')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Restore')]
    [ValidateNotNullOrEmpty()]
    [string]$ArchivePath,
    [Parameter(Mandatory = $true, ParameterSetName = 'Restore')]
    [ValidateNotNullOrEmpty()]
    [string]$ConfirmShopSlug,
    [Parameter(Mandatory = $true, ParameterSetName = 'ScratchTest')]
    [switch]$ScratchTest,
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
    throw 'Restore requires the installed Compose file.'
}
if (-not $ComposeProjectName -and (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
        if ($line -match '^COMPOSE_PROJECT_NAME=(.*)$') { $ComposeProjectName = $Matches[1] }
    }
}
if (-not $ComposeProjectName -or $ComposeProjectName -notmatch '^[a-z0-9][a-z0-9_-]*$') {
    throw 'Supply a valid Compose project name or configure it in the installation environment file.'
}

if ($ScratchTest) {
    $startResult = Invoke-DockerCommand -Arguments @(
        'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile,
        '--profile', 'backup', '--profile', 'backup-restore', 'up', '--detach', '--wait', '--wait-timeout', '60',
        'mongo-restore-scratch'
    )
    if ($startResult.ExitCode -ne 0) {
        throw "Could not start the tmpfs-only scratch Mongo service (exit $($startResult.ExitCode)): $($startResult.Output -join ' ')"
    }
    try {
        $restoreResult = Invoke-DockerCommand -Arguments @(
            'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile,
            '--profile', 'backup', '--profile', 'backup-restore', 'run', '--rm', '--no-deps', 'mongo-backup', 'restore-latest'
        )
        $restoreResult.Output | Where-Object { $_ -match 'mongo_restore_rehearsal_(complete|failed)' } | ForEach-Object { Write-Output $_ }
        if ($restoreResult.ExitCode -ne 0) {
            throw "Scratch restore/count comparison failed (exit $($restoreResult.ExitCode)): $($restoreResult.Output -join ' ')"
        }
    }
    finally {
        $stopResult = Invoke-DockerCommand -Arguments @(
            'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile,
            '--profile', 'backup-restore', 'stop', 'mongo-restore-scratch'
        )
        if ($stopResult.ExitCode -ne 0) {
            throw "Could not stop the scratch Mongo service (exit $($stopResult.ExitCode))."
        }
    }
    exit 0
}

$resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop).Path
$sidecar = "$resolvedArchive.sha256"
if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
    throw 'Restore archive requires its SHA256 sidecar.'
}
$expectedLine = [System.IO.File]::ReadAllText($sidecar).Trim()
$expectedHash = ($expectedLine -split '\s+')[0]
$expectedName = ($expectedLine -split '\s+')[-1]
if (($expectedName -ne [System.IO.Path]::GetFileName($resolvedArchive)) -or
    ($expectedHash -notmatch '^[a-f0-9]{64}$') -or
    ((Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash)) {
    throw 'Restore archive SHA256 verification failed.'
}
$validationStart = Invoke-DockerCommand -Arguments @(
    'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile,
    '--profile', 'backup-restore', 'up', '--detach', '--wait', '--wait-timeout', '60', 'mongo-restore-scratch'
)
if ($validationStart.ExitCode -ne 0) {
    throw "Could not start tmpfs archive validation (exit $($validationStart.ExitCode))."
}
try {
    $validationResult = Invoke-DockerCommand -Arguments @(
        'run', '--rm', '--network', "${ComposeProjectName}_database",
        '--volume', "$([System.IO.Path]::GetDirectoryName($resolvedArchive)):/backup:ro", 'mongo:8.0.12',
        'mongorestore', '--host', "$ComposeProjectName-mongo-restore-scratch-1", '--port', '27017',
        '--dryRun', '--gzip', "--archive=/backup/$([System.IO.Path]::GetFileName($resolvedArchive))"
    )
}
finally {
    $validationStop = Invoke-DockerCommand -Arguments @(
        'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile,
        '--profile', 'backup-restore', 'stop', 'mongo-restore-scratch'
    )
    if ($validationStop.ExitCode -ne 0) {
        throw "Could not stop tmpfs archive validation (exit $($validationStop.ExitCode))."
    }
}
if ($validationResult.ExitCode -ne 0) {
    throw "Restore archive failed mongorestore validation (exit $($validationResult.ExitCode)): $($validationResult.Output -join ' ')"
}

$shopSlug = $null
foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^VITE_SHOP_SLUG=(.*)$') { $shopSlug = $Matches[1] }
}
if (-not $shopSlug -or $ConfirmShopSlug -cne $shopSlug) {
    throw 'Restore confirmation did not exactly match this installation shop slug.'
}
$preRestoreDirectory = Join-Path $root 'updates\restore-safety'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
    (Join-Path $PSScriptRoot '..\scripts\backup-external.ps1') `
    -DestinationDirectory $preRestoreDirectory -RepositoryRoot $root -ComposeProjectName $ComposeProjectName
if ($LASTEXITCODE -ne 0) { throw 'Could not create a verified pre-restore backup.' }
$safetyArchive = Get-ChildItem -LiteralPath $preRestoreDirectory -Filter 'pharmacare-*.archive.gz' -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $safetyArchive) { throw 'Pre-restore safety backup was not found.' }

function Restore-ArchiveToShop {
    param([string]$Path)
    $stopResult = Invoke-DockerCommand -Arguments @(
        'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile, 'stop', 'api', 'web'
    )
    if ($stopResult.ExitCode -ne 0) { throw 'Could not stop API and web before restore.' }
    $containerResult = Invoke-DockerCommand -Arguments @(
        'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile, 'ps', '--quiet', 'mongo'
    )
    $container = ($containerResult.Output -join "`n").Trim()
    if ($containerResult.ExitCode -ne 0 -or -not $container) { throw 'Mongo service container was not found.' }
    $containerNameResult = Invoke-DockerCommand -Arguments @('inspect', '--format', '{{.Name}}', $container)
    $containerName = ($containerNameResult.Output -join "`n").Trim()
    if ($containerNameResult.ExitCode -ne 0) { throw 'Could not identify the Mongo container.' }
    $containerName = $containerName.Trim().TrimStart('/')
    $copyResult = Invoke-DockerCommand -Arguments @('cp', $Path, "${containerName}:/tmp/pharmacare-restore.archive.gz")
    if ($copyResult.ExitCode -ne 0) { throw 'Could not stage the verified restore archive.' }
    $restoreResult = Invoke-DockerCommand -Arguments @(
        'exec', $containerName, 'sh', '-c',
        'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --drop --gzip --archive=/tmp/pharmacare-restore.archive.gz'
    )
    if ($restoreResult.ExitCode -ne 0) { throw 'Mongo restore command failed.' }
    $removeResult = Invoke-DockerCommand -Arguments @('exec', $containerName, 'rm', '-f', '/tmp/pharmacare-restore.archive.gz')
    if ($removeResult.ExitCode -ne 0) { throw 'Could not remove the staged restore archive.' }
    $startResult = Invoke-DockerCommand -Arguments @(
        'compose', '--project-directory', $root, '--project-name', $ComposeProjectName, '--file', $composeFile, 'up', '--detach'
    )
    if ($startResult.ExitCode -ne 0) { throw 'Could not restart shop services after restore.' }
}

try {
    Restore-ArchiveToShop $resolvedArchive
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(3)
    $healthy = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 5
            if ($health.status -eq 'ok' -and $health.database -eq 'ok') {
                $healthy = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 5
    }
    if (-not $healthy) { throw 'Restored shop failed the API/database health check.' }
    Write-Host 'Restore succeeded; API and Mongo health checks passed.'
}
catch {
    $restoreFailure = $_
    try {
        Restore-ArchiveToShop $safetyArchive.FullName
        Write-Error 'Requested restore failed. The pre-restore safety backup was restored.'
    }
    catch {
        throw "Requested restore failed and automatic recovery also failed: $($restoreFailure.Exception.Message)"
    }
    throw $restoreFailure
}
