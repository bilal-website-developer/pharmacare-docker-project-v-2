$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
    throw 'No .env file exists. Run docker\generate-secrets.ps1 for a new local installation.'
}

$contents = [System.IO.File]::ReadAllText($envPath)
if ($contents -match '(?m)^MONGO_BACKUP_(USERNAME|PASSWORD)=') {
    throw 'Backup credentials already exist in .env. No changes were made.'
}

$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $bytes = New-Object byte[] 48
    $generator.GetBytes($bytes)
    $password = [Convert]::ToBase64String($bytes)
}
finally {
    $generator.Dispose()
}

$separator = if ($contents.EndsWith("`n")) { '' } else { "`n" }
$addition = @(
    'MONGO_BACKUP_USERNAME=pharmacare_backup'
    "MONGO_BACKUP_PASSWORD=$password"
) -join "`n"
[System.IO.File]::AppendAllText(
    $envPath,
    "$separator$addition`n",
    (New-Object System.Text.UTF8Encoding($false))
)
$password = $null
$contents = $null
Write-Host 'Added a dedicated random, database-read-only Mongo backup credential to .env. Values were not displayed.'
