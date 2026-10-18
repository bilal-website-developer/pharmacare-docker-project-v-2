$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
if (Test-Path -LiteralPath $envPath) {
    throw 'A .env file already exists. It was not read or changed; move it aside yourself if you intend to generate new credentials.'
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

$lines = @(
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
    'BOOTSTRAP_SHOP_SLUG=main'
    'VITE_SUPABASE_URL='
    'VITE_SUPABASE_ANON_KEY='
)

$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($envPath, ($lines -join "`n") + "`n", $encoding)
Write-Host 'Created .env with random local secrets. Secret values were not displayed.'
