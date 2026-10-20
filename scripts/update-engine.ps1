function Write-UpdateState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Status,
        [string]$Version,
        [string]$Message
    )

    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $state = [ordered]@{
        status = $Status
        version = $Version
        message = $Message
        updated_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    [System.IO.File]::WriteAllText(
        $Path,
        ($state | ConvertTo-Json -Depth 4) + "`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function Invoke-UpdateTransaction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Release,
        [Parameter(Mandatory = $true)][hashtable]$Operations,
        [Parameter(Mandatory = $true)][string]$StatePath,
        [ValidateRange(1, 10)][int]$MaximumDownloadAttempts = 3
    )

    $requiredOperations = @(
        'CaptureImages', 'CreateBackup', 'Download', 'VerifyRelease',
        'LoadImages', 'RunMigrations', 'RestartServices', 'CheckHealth',
        'SmokeTest', 'RestoreImages', 'RestoreBackup', 'WriteStatus', 'RetainTwoVersions'
    )
    foreach ($operation in $requiredOperations) {
        if (-not $Operations.ContainsKey($operation) -or $Operations[$operation] -isnot [scriptblock]) {
            throw "Update operation is missing: $operation"
        }
    }

    $version = [string]$Release.version
    $previousImages = & $Operations.CaptureImages
    if ($null -eq $previousImages) {
        throw 'Could not record the current image IDs; update was not started.'
    }

    $backup = & $Operations.CreateBackup
    if ($null -eq $backup -or $backup.Verified -ne $true) {
        throw 'A verified backup is required before applying a release.'
    }

    $download = $null
    $lastDownloadError = $null
    for ($attempt = 1; $attempt -le $MaximumDownloadAttempts; $attempt++) {
        try {
            $download = & $Operations.Download $Release $attempt
            if ($null -eq $download) { throw 'Download did not return a bundle.' }
            break
        }
        catch {
            $lastDownloadError = $_
            if ($attempt -lt $MaximumDownloadAttempts) {
                Start-Sleep -Seconds ([Math]::Min($attempt, 3))
            }
        }
    }
    if ($null -eq $download) {
        & $Operations.WriteStatus 'failed' $version 'Download failed after retry attempts.'
        throw "Download failed after $MaximumDownloadAttempts attempts: $($lastDownloadError.Exception.Message)"
    }

    try {
        & $Operations.VerifyRelease $Release $download
        & $Operations.WriteStatus 'installing' $version 'Release verified; applying update.'
        & $Operations.LoadImages $download
        & $Operations.RunMigrations
        & $Operations.RestartServices
        & $Operations.CheckHealth
        & $Operations.SmokeTest
        & $Operations.RetainTwoVersions
        & $Operations.WriteStatus 'succeeded' $version 'Update and smoke test succeeded.'
        return
    }
    catch {
        $updateError = $_
        $rollbackErrors = [System.Collections.Generic.List[string]]::new()
        try { & $Operations.RestoreImages $previousImages }
        catch { $rollbackErrors.Add('image rollback failed') }
        try { & $Operations.RestoreBackup $backup }
        catch { $rollbackErrors.Add('database backup restore failed') }
        try { & $Operations.RestartServices }
        catch { $rollbackErrors.Add('service restart failed') }
        try { & $Operations.CheckHealth }
        catch { $rollbackErrors.Add('service health check failed after rollback') }

        if ($rollbackErrors.Count -gt 0) {
            & $Operations.WriteStatus 'rollback_failed' $version ($rollbackErrors -join '; ')
            throw "Update failed and rollback was incomplete: $($rollbackErrors -join '; ')"
        }
        & $Operations.WriteStatus 'rolled_back' $version 'Update failed; previous images and verified backup were restored.'
        throw "Update failed and was rolled back: $($updateError.Exception.Message)"
    }
}
