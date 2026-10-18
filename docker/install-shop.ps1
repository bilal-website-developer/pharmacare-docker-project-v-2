[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 63)]
    [ValidatePattern('^[a-zA-Z0-9-]+$')]
    [string]$ShopSlug
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
$composeFile = Join-Path $repoRoot 'docker-compose.yml'
if (-not (Test-Path -LiteralPath $composeFile)) {
    throw 'Run the installer from a complete Pharma Care release directory.'
}
if (Test-Path -LiteralPath $envPath) {
    throw 'A .env file already exists. It was not read or changed; use a separate install directory or follow the documented update procedure.'
}

function New-Secret {
    param(
        [Parameter(Mandatory = $true)][int]$ByteCount,
        [switch]$RequireDiversity
    )

    do {
        $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $bytes = New-Object byte[] $ByteCount
            $generator.GetBytes($bytes)
            $secret = [Convert]::ToBase64String($bytes)
        }
        finally {
            $generator.Dispose()
        }

        $hasDiversity = -not $RequireDiversity
        if ($RequireDiversity) {
            $classCount = 0
            if ($secret -cmatch '[a-z]') { $classCount++ }
            if ($secret -cmatch '[A-Z]') { $classCount++ }
            if ($secret -match '[0-9]') { $classCount++ }
            if ($secret -match '[^A-Za-z0-9]') { $classCount++ }
            $uniqueCharacterCount = @($secret.ToCharArray() | Sort-Object -Unique).Count
            $hasDiversity = $classCount -ge 3 -and $uniqueCharacterCount -ge 12
        }
    } until ($hasDiversity)

    return $secret
}

function Invoke-Compose {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & docker compose @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($Arguments[0]) failed with exit code $LASTEXITCODE."
    }
}

$slug = $ShopSlug.ToLowerInvariant()
$projectSlug = $slug
if ($projectSlug.Length -gt 30) {
    $projectSlug = $projectSlug.Substring(0, 30)
}
$instanceId = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$projectName = "pharmacare-$projectSlug-$instanceId"
$setupCodeBytes = New-Object byte[] 32
$randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $randomGenerator.GetBytes($setupCodeBytes)
}
finally {
    $randomGenerator.Dispose()
}
$setupCode = [Convert]::ToBase64String($setupCodeBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $setupCodeHash = ([BitConverter]::ToString($sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($setupCode)))).Replace('-', '').ToLowerInvariant()
}
finally {
    $sha256.Dispose()
}
$setupCodeExpiresAt = [DateTimeOffset]::UtcNow.AddHours(4).ToString(
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [System.Globalization.CultureInfo]::InvariantCulture
)

$lines = @(
    "COMPOSE_PROJECT_NAME=$projectName"
    'WEB_ORIGIN=http://localhost:8080'
    'VITE_BACKEND=api'
    "VITE_SHOP_SLUG=$slug"
    'MONGO_ROOT_USERNAME=pharmacare_root'
    "MONGO_ROOT_PASSWORD=$(New-Secret -ByteCount 48 -RequireDiversity)"
    "MONGO_REPLICA_KEY=$(New-Secret -ByteCount 64)"
    'MONGO_APP_DB=pharmacare'
    'MONGO_APP_USERNAME=pharmacare_api'
    "MONGO_APP_PASSWORD=$(New-Secret -ByteCount 48 -RequireDiversity)"
    'MONGO_BACKUP_USERNAME=pharmacare_backup'
    "MONGO_BACKUP_PASSWORD=$(New-Secret -ByteCount 48 -RequireDiversity)"
    "JWT_ACCESS_SECRET=$(New-Secret -ByteCount 64 -RequireDiversity)"
    "REFRESH_TOKEN_PEPPER=$(New-Secret -ByteCount 64 -RequireDiversity)"
    "BOOTSTRAP_SHOP_SLUG=$slug"
    "SETUP_CODE_HASH=$setupCodeHash"
    "SETUP_CODE_EXPIRES_AT=$setupCodeExpiresAt"
    'DEMO_MODE=false'
    'DEMO_NODE_ENV=production'
    'VITE_SUPABASE_URL='
    'VITE_SUPABASE_ANON_KEY='
)

$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($envPath, ($lines -join "`n") + "`n", $encoding)
$setupCodeHash = $null

Write-Host 'Created a per-install .env without displaying its contents.'
Write-Host 'This local installer binds the web UI to loopback only; it does not configure LAN HTTPS.'
Write-Host 'One-time first-run setup code (expires in four hours; enter it in the setup wizard):'
Write-Host $setupCode
$setupCode = $null

$originalLocation = Get-Location
try {
    Set-Location $repoRoot
    Invoke-Compose -Arguments @('config', '--quiet')
    $bundledImages = Join-Path $repoRoot 'images.tar'
    if (Test-Path -LiteralPath $bundledImages -PathType Leaf) {
        & docker load --input $bundledImages
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not load the bundled Docker images.'
        }
    }
    else {
        Invoke-Compose -Arguments @('build')
    }
    Invoke-Compose -Arguments @('up', '--detach')

    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
    $healthy = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri 'http://localhost:8080/api/health' -Method Get -TimeoutSec 3
            if ($health.status -eq 'ok' -and $health.database -eq 'ok') {
                $healthy = $true
                break
            }
        }
        catch {
        }
        Start-Sleep -Seconds 2
    }
    if (-not $healthy) {
        throw 'The API did not become healthy within five minutes. Inspect docker compose ps and redacted service logs; do not remove volumes.'
    }

    $setupStatus = Invoke-RestMethod -Uri 'http://localhost:8080/api/setup/status' -Method Get -TimeoutSec 5
    if ($setupStatus.needsSetup -ne $true) {
        throw 'The configured database already contains a shop; the first-run setup code was not consumed.'
    }
    Invoke-Compose -Arguments @('ps')
    Write-Host 'Local shop services are healthy. Open http://localhost:8080 and complete the first-run wizard.'
}
finally {
    Set-Location $originalLocation
}
