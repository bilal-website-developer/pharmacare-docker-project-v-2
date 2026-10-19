[CmdletBinding()]
param(
    [switch]$UpdateNow,
    [string]$ConfigPath = 'updates\update-config.json',
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'update-engine.ps1')

$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$configFile = if ([System.IO.Path]::IsPathRooted($ConfigPath)) {
    $ConfigPath
} else {
    Join-Path $root $ConfigPath
}
$updatesRoot = Join-Path $root 'updates'
$statePath = Join-Path $updatesRoot 'update-state.json'
$composeFile = Join-Path $root 'docker-compose.yml'
$envFile = Join-Path $root '.env'

function Get-EnvValue {
    param([string]$Name)
    foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
        if ($line -match ('^' + [regex]::Escape($Name) + '=(.*)$')) {
            return $Matches[1]
        }
    }
    return $null
}

function Invoke-Docker {
    param([string[]]$Arguments, [switch]$Capture)
    if ($Capture) {
        $output = & docker @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Docker operation failed.' }
        return ($output -join "`n").Trim()
    }
    & docker @Arguments *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker operation failed.' }
}

function Get-ShopTimeZone {
    param([string]$ConfiguredId)
    try { return [TimeZoneInfo]::FindSystemTimeZoneById($ConfiguredId) } catch {}
    if ($ConfiguredId -eq 'Asia/Karachi') {
        return [TimeZoneInfo]::FindSystemTimeZoneById('Pakistan Standard Time')
    }
    throw 'Configured shop time zone is not available on this Windows host.'
}

function Get-LocalImageNames {
    $apiImage = Get-EnvValue 'PHARMA_API_IMAGE'
    $webImage = Get-EnvValue 'PHARMA_WEB_IMAGE'
    if (-not $apiImage) { $apiImage = 'pharma-care-api:local' }
    if (-not $webImage) { $webImage = 'pharma-care-web:local' }
    return @($apiImage, $webImage, 'mongo:8.0.12', 'nginx:1.27.5-alpine', 'caddy:2.10-alpine')
}

function Get-CurrentImageIds {
    $result = @{}
    foreach ($image in (Get-LocalImageNames)) {
        $id = Invoke-Docker -Arguments @('image', 'inspect', '--format', '{{.Id}}', $image) -Capture
        if (-not $id) { throw 'Could not identify every currently deployed image.' }
        $result[$image] = $id
    }
    return $result
}

function New-VerifiedBackup {
    $backupLog = & docker compose --project-directory $root --project-name $script:projectName `
        --file $composeFile --profile backup run --rm --no-deps mongo-backup backup-once 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Mongo backup command failed.' }

    $volume = "${script:projectName}_mongo_backups"
    $archiveName = Invoke-Docker -Arguments @(
        'run', '--rm', '--mount', "source=$volume,target=/backups,readonly",
        'mongo:8.0.12', 'sh', '-c',
        'ls -1t /backups/pharmacare-*.archive.gz 2>/dev/null | head -n 1 | xargs -r basename'
    ) -Capture
    if (-not $archiveName -or $archiveName -notmatch '^pharmacare-[0-9]{8}T[0-9]{6}Z\.archive\.gz$') {
        throw 'No completed Mongo backup archive was found.'
    }

    $backupDirectory = Join-Path $updatesRoot 'backups'
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $backupPath = Join-Path $backupDirectory $archiveName
    $copyContainer = "pharmacare-backup-copy-$([Guid]::NewGuid().ToString('N'))"
    $copyId = Invoke-Docker -Arguments @(
        'create', '--name', $copyContainer,
        '--mount', "source=$volume,target=/backups,readonly",
        'mongo:8.0.12', 'sleep', '30'
    ) -Capture
    try {
        Invoke-Docker -Arguments @('cp', "${copyContainer}:/backups/$archiveName", $backupPath)
    }
    finally {
        Invoke-Docker -Arguments @('rm', '--force', $copyContainer)
    }
    Invoke-Docker -Arguments @(
        'run', '--rm', '--volume', "${backupDirectory}:/backup:ro",
        'mongo:8.0.12', 'mongorestore', '--dryRun', '--gzip',
        "--archive=/backup/$archiveName"
    )
    return [pscustomobject]@{ Verified = $true; Path = $backupPath; ArchiveName = $archiveName }
}

function Restore-VerifiedBackup {
    param([pscustomobject]$Backup)
    & docker compose --project-directory $root --project-name $script:projectName `
        --file $composeFile stop api web 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop API and web before restoring backup.' }
    $mongoContainer = Invoke-Docker -Arguments @(
        'compose', '--project-directory', $root, '--project-name', $script:projectName,
        '--file', $composeFile, 'ps', '--all', '--quiet', 'mongo'
    ) -Capture
    if (-not $mongoContainer) { throw 'Mongo container could not be located for restore.' }
    $containerId = ($mongoContainer -split "`n")[0].Trim()
    $containerName = Invoke-Docker -Arguments @('inspect', '--format', '{{.Name}}', $containerId) -Capture
    $containerName = $containerName.TrimStart('/')
    Invoke-Docker -Arguments @('cp', $Backup.Path, "${containerName}:/tmp/pharmacare-rollback.archive.gz")
    & docker exec $containerName sh -c 'mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --drop --gzip --archive=/tmp/pharmacare-rollback.archive.gz'
    if ($LASTEXITCODE -ne 0) { throw 'Could not restore the verified Mongo backup.' }
    & docker exec $containerName rm -f /tmp/pharmacare-rollback.archive.gz
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the temporary rollback archive.' }
}

function Get-ApprovedRelease {
    $requestUri = [uri]::new(($script:config.controlPlaneUrl.TrimEnd('/') + '/functions/v1/control-plane/get-release'))
    try {
        return Invoke-RestMethod -Uri $requestUri -Method Post -ContentType 'application/json' `
            -Headers @{ 'x-device-key-hash' = $script:config.deviceKeyHash } `
            -Body (@{ channel = $script:config.channel } | ConvertTo-Json -Compress) -TimeoutSec 20
    }
    catch {
        $statusCode = 0
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        if ($statusCode -eq 404) { return $null }
        throw
    }
}

function Get-ReleaseBundle {
    param([pscustomobject]$Release, [int]$Attempt)
    $bundleUri = [uri]::new([string]$Release.bundle_path)
    if ($bundleUri.Scheme -ne 'https') { throw 'Approved release bundle URL must use HTTPS.' }
    $manifestUri = [uri]::new('./release-manifest.json', $bundleUri)
    $manifestPath = Join-Path $updatesRoot 'release-manifest.json.partial'
    $signaturePath = Join-Path $updatesRoot 'release-manifest.json.sig'
    $bundleDirectory = Join-Path $updatesRoot 'download'
    New-Item -ItemType Directory -Path $bundleDirectory -Force | Out-Null
    try {
        Invoke-WebRequest -Uri $manifestUri -OutFile $manifestPath -TimeoutSec 60
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if (($manifest.version -ne $Release.version) -or
            ($manifest.images_sha256 -ne $Release.sha256) -or
            ($manifest.bundle_file -notmatch '^[A-Za-z0-9._-]+$')) {
            throw 'Downloaded release manifest does not match the approved release.'
        }
        $downloadedBundle = Join-Path $bundleDirectory $manifest.bundle_file
        $bundleUri = [uri]::new($manifest.bundle_file, $manifestUri)
        Invoke-WebRequest -Uri $bundleUri -OutFile "$downloadedBundle.partial" -TimeoutSec 900
        Move-Item -LiteralPath "$downloadedBundle.partial" -Destination $downloadedBundle -Force
        Move-Item -LiteralPath $manifestPath -Destination (Join-Path $bundleDirectory 'release-manifest.json') -Force
        [System.IO.File]::WriteAllText(
            (Join-Path $bundleDirectory 'release-manifest.json.sig'),
            ([string]$Release.signature).Trim() + "`n",
            (New-Object System.Text.UTF8Encoding($false))
        )
        return [pscustomobject]@{
            Directory = $bundleDirectory
            ManifestPath = Join-Path $bundleDirectory 'release-manifest.json'
            SignaturePath = Join-Path $bundleDirectory 'release-manifest.json.sig'
        }
    }
    catch {
        Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
        Get-ChildItem -LiteralPath $bundleDirectory -Filter '*.partial' -File -ErrorAction SilentlyContinue |
            Remove-Item -Force
        throw
    }
}

if ((-not (Test-Path -LiteralPath $composeFile -PathType Leaf)) -or
    (-not (Test-Path -LiteralPath $envFile -PathType Leaf))) {
    throw 'Updater requires the installed Compose file and environment file.'
}
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    Write-UpdateState -Path $statePath -Status 'not_configured' -Message 'Control-plane update settings are not configured.'
    Write-Host 'Updater is not configured; no release check or Docker operation was attempted.'
    exit 0
}
$script:config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
if ((-not $script:config.controlPlaneUrl) -or
    ($script:config.deviceKeyHash -notmatch '^[a-f0-9]{64}$') -or
    ($script:config.channel -notin @('pilot', 'stable')) -or
    (-not $script:config.publicKeyPath)) {
    throw 'Updater configuration is incomplete.'
}
$publicKeyPath = if ([System.IO.Path]::IsPathRooted($script:config.publicKeyPath)) {
    $script:config.publicKeyPath
} else {
    Join-Path $root $script:config.publicKeyPath
}
if (-not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) {
    throw 'Release verification public key is unavailable.'
}
$script:config.publicKeyPath = $publicKeyPath
$script:projectName = Get-EnvValue 'COMPOSE_PROJECT_NAME'
if (-not $script:projectName -or $script:projectName -notmatch '^[a-z0-9][a-z0-9_-]*$') {
    throw 'Compose project name is invalid.'
}

if (-not $UpdateNow) {
    $timezone = Get-ShopTimeZone ([string]$script:config.timezone)
    $shopNow = [TimeZoneInfo]::ConvertTime([DateTimeOffset]::Now, $timezone)
    if ($shopNow.Hour -lt 2 -or $shopNow.Hour -ge 5) {
        Write-UpdateState -Path $statePath -Status 'deferred' -Message 'Outside the 02:00-05:00 shop maintenance window.'
        Write-Host 'Update deferred: outside the 02:00-05:00 shop maintenance window.'
        exit 0
    }
}

$release = Get-ApprovedRelease
if (-not $release -or $release.status -ne 'approved') {
    Write-UpdateState -Path $statePath -Status 'no_approved_release' -Message 'No approved release is available.'
    Write-Host 'No approved release is available.'
    exit 0
}

$versionsRoot = Join-Path $updatesRoot 'versions'
$downloadDirectory = Join-Path $updatesRoot 'download'
$operations = @{
    CaptureImages = {
        $imageIds = Get-CurrentImageIds
        $snapshot = Join-Path $versionsRoot 'previous-images.tar'
        New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
        Invoke-Docker -Arguments (@('save', '--output', $snapshot) + @($imageIds.Keys))
        return [pscustomobject]@{ Ids = $imageIds; Snapshot = $snapshot }
    }.GetNewClosure()
    CreateBackup = { return New-VerifiedBackup }.GetNewClosure()
    Download = { param($item, $attempt) return Get-ReleaseBundle $item $attempt }.GetNewClosure()
    VerifyRelease = {
        param($item, $download)
        $manifest = Get-Content -LiteralPath $download.ManifestPath -Raw | ConvertFrom-Json
        if ($manifest.version -ne $item.version -or $manifest.images_sha256 -ne $item.sha256) {
            throw 'Release manifest does not match the control-plane approval.'
        }
        & node.exe (Join-Path $PSScriptRoot 'release-signature.mjs') verify `
            $download.ManifestPath $download.SignaturePath $script:config.publicKeyPath $download.Directory
        if ($LASTEXITCODE -ne 0) { throw 'Release bundle signature verification failed.' }
    }.GetNewClosure()
    LoadImages = {
        param($download)
        $manifest = Get-Content -LiteralPath $download.ManifestPath -Raw | ConvertFrom-Json
        Invoke-Docker -Arguments @('load', '--input', (Join-Path $download.Directory $manifest.bundle_file))
    }.GetNewClosure()
    RunMigrations = {
        & docker compose --project-directory $root --project-name $script:projectName `
            --file $composeFile run --rm --no-deps mongo-init *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Forward-safe Mongo initialization/migrations failed.' }
    }.GetNewClosure()
    RestartServices = {
        & docker compose --project-directory $root --project-name $script:projectName `
            --file $composeFile up --detach --no-build *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Compose service restart failed.' }
    }.GetNewClosure()
    CheckHealth = {
        $deadline = [DateTimeOffset]::UtcNow.AddMinutes(3)
        while ([DateTimeOffset]::UtcNow -lt $deadline) {
            try {
                $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/health' -TimeoutSec 5
                if ($health.status -eq 'ok' -and $health.database -eq 'ok') { return }
            } catch {}
            Start-Sleep -Seconds 5
        }
        throw 'API health check failed after update.'
    }.GetNewClosure()
    SmokeTest = {
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/setup/status' -TimeoutSec 10
        if ($null -eq $status.needsSetup) { throw 'Shop setup smoke test failed.' }
    }.GetNewClosure()
    RestoreImages = {
        param($previous)
        Invoke-Docker -Arguments @('load', '--input', $previous.Snapshot)
        foreach ($tag in $previous.Ids.Keys) {
            Invoke-Docker -Arguments @('image', 'tag', $previous.Ids[$tag], $tag)
        }
    }.GetNewClosure()
    RestoreBackup = { param($backup) Restore-VerifiedBackup $backup }.GetNewClosure()
    WriteStatus = {
        param($status, $version, $message)
        Write-UpdateState -Path $statePath -Status $status -Version $version -Message $message
    }.GetNewClosure()
    RetainTwoVersions = {
        $current = Join-Path $versionsRoot ([string]$release.version)
        New-Item -ItemType Directory -Path $current -Force | Out-Null
        $snapshot = Join-Path $current 'images.tar'
        Invoke-Docker -Arguments (@('save', '--output', $snapshot) + @((Get-LocalImageNames)))
        $all = @(Get-ChildItem -LiteralPath $versionsRoot -Directory |
            Where-Object { $_.Name -ne 'previous-images.tar' } |
            Sort-Object LastWriteTimeUtc -Descending)
        foreach ($old in ($all | Select-Object -Skip 2)) {
            $resolvedOld = (Resolve-Path -LiteralPath $old.FullName).Path
            if (-not $resolvedOld.StartsWith((Resolve-Path -LiteralPath $versionsRoot).Path, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Version retention path escaped the updates directory.'
            }
            Remove-Item -LiteralPath $resolvedOld -Recurse -Force
        }
    }.GetNewClosure()
}

try {
    Invoke-UpdateTransaction -Release $release -Operations $operations -StatePath $statePath
    Write-Host "Update succeeded for release $($release.version)."
}
catch {
    $currentState = $null
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try { $currentState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch {}
    }
    if ($null -eq $currentState -or $currentState.status -notin @('rolled_back', 'rollback_failed', 'failed')) {
        Write-UpdateState -Path $statePath -Status 'failed' -Version ([string]$release.version) `
            -Message 'Update failed; inspect local updater diagnostics.'
    }
    throw
}
