$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'update-engine.ps1')

function New-FakeOperations {
    param(
        [Parameter(Mandatory = $true)][string]$Scenario,
        [Parameter(Mandatory = $true)][hashtable]$State
    )

    $State.HealthChecks = 0
    return @{
        CaptureImages = { return @('old-api-image', 'old-web-image') }.GetNewClosure()
        CreateBackup = {
            return [pscustomobject]@{ Verified = $true; Data = $State.Data }
        }.GetNewClosure()
        Download = {
            param($Release, $Attempt)
            if ($Scenario -eq 'interrupted-download' -and $Attempt -eq 1) {
                throw 'synthetic interrupted transfer'
            }
            return [pscustomobject]@{ Bundle = 'fake-bundle'; Attempt = $Attempt }
        }.GetNewClosure()
        VerifyRelease = {
            param($Release, $Download)
            if ($Scenario -eq 'tampered-bundle') {
                throw 'bundle SHA256 or signature invalid'
            }
        }.GetNewClosure()
        LoadImages = {
            param($Download)
            $State.Images = 'new-images'
        }.GetNewClosure()
        RunMigrations = { $State.MigrationRan = $true }.GetNewClosure()
        RestartServices = { $State.Restarts++ }.GetNewClosure()
        CheckHealth = {
            $State.HealthChecks++
            if ($Scenario -eq 'forced-failure' -and $State.HealthChecks -eq 1) {
                throw 'synthetic health check failure'
            }
        }.GetNewClosure()
        SmokeTest = { $State.SmokeTestRan = $true }.GetNewClosure()
        RestoreImages = {
            param($PreviousImages)
            $State.Images = 'old-images'
        }.GetNewClosure()
        RestoreBackup = {
            param($Backup)
            $State.Data = $Backup.Data
        }.GetNewClosure()
        WriteStatus = {
            param($Status, $Version, $Message)
            $State.Status = $Status
        }.GetNewClosure()
        RetainTwoVersions = { $State.RetentionApplied = $true }.GetNewClosure()
    }
}

function Assert-Scenario {
    param([string]$Name, [scriptblock]$Action)
    & $Action
    Write-Host "PASS: $Name"
}

$release = [pscustomobject]@{ version = 'test-version' }
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pharmacare-update-test-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    $success = @{ Data = 'persistent-records'; Images = 'old-images'; Restarts = 0 }
    Invoke-UpdateTransaction -Release $release -Operations (New-FakeOperations 'success' $success) `
        -StatePath (Join-Path $tempRoot 'success.json')
    if (($success.Data -ne 'persistent-records') -or ($success.Images -ne 'new-images') -or
        ($success.Status -ne 'succeeded') -or (-not $success.SmokeTestRan)) {
        throw 'Successful update did not preserve test data and install the new images.'
    }
    Write-Host 'PASS: successful update keeps existing data and passes health/smoke checks'

    $failure = @{ Data = 'persistent-records'; Images = 'old-images'; Restarts = 0; HealthChecks = 0 }
    try {
        Invoke-UpdateTransaction -Release $release -Operations (New-FakeOperations 'forced-failure' $failure) `
            -StatePath (Join-Path $tempRoot 'failure.json')
        throw 'Forced failure unexpectedly succeeded.'
    }
    catch {
        if ($_.Exception.Message -notmatch 'rolled back') { throw }
    }
    if (($failure.Data -ne 'persistent-records') -or ($failure.Images -ne 'old-images') -or
        ($failure.Status -ne 'rolled_back')) {
        throw 'Forced failure did not roll back images and backup data.'
    }
    Write-Host 'PASS: forced health failure rolls back previous images and backup data'

    $tampered = @{ Data = 'persistent-records'; Images = 'old-images'; Restarts = 0 }
    try {
        Invoke-UpdateTransaction -Release $release -Operations (New-FakeOperations 'tampered-bundle' $tampered) `
            -StatePath (Join-Path $tempRoot 'tampered.json')
        throw 'Tampered bundle unexpectedly succeeded.'
    }
    catch {
        if ($_.Exception.Message -notmatch 'rolled back') { throw }
    }
    if ($tampered.Images -ne 'old-images' -or $tampered.Status -ne 'rolled_back') {
        throw 'Tampered bundle was not rejected before deployment.'
    }
    Write-Host 'PASS: tampered bundle is rejected before image deployment'

    $retry = @{ Data = 'persistent-records'; Images = 'old-images'; Restarts = 0 }
    Invoke-UpdateTransaction -Release $release -Operations (New-FakeOperations 'interrupted-download' $retry) `
        -StatePath (Join-Path $tempRoot 'retry.json') -MaximumDownloadAttempts 2
    if ($retry.Status -ne 'succeeded') {
        throw 'Interrupted download did not retry to success.'
    }
    Write-Host 'PASS: interrupted download retries and succeeds'
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
