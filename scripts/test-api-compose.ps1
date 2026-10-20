[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$project = 'cp-api-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pharmacare-api-test-$([Guid]::NewGuid().ToString('N'))"
$emptyEnvFile = Join-Path $tempRoot 'compose-empty.env'
$updatesDirectory = Join-Path $tempRoot 'updates'
$composeFile = Join-Path $root 'docker-compose.yml'
$environmentNames = @(
    'COMPOSE_PROJECT_NAME', 'WEB_PORT', 'WEB_ORIGIN', 'UPDATES_DIRECTORY',
    'MONGO_ROOT_USERNAME', 'MONGO_ROOT_PASSWORD', 'MONGO_REPLICA_KEY',
    'MONGO_APP_DB', 'MONGO_APP_USERNAME', 'MONGO_APP_PASSWORD',
    'MONGO_BACKUP_USERNAME', 'MONGO_BACKUP_PASSWORD',
    'JWT_ACCESS_SECRET', 'REFRESH_TOKEN_PEPPER', 'BOOTSTRAP_SHOP_SLUG',
    'SETUP_CODE_HASH', 'SETUP_CODE_EXPIRES_AT', 'CONTROL_PLANE_URL',
    'LICENCE_PUBLIC_KEY', 'UPDATER_CONFIG_PATH', 'VITE_BACKEND',
    'VITE_SHOP_SLUG', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
    'DEMO_MODE', 'DEMO_NODE_ENV'
)
$originalEnvironment = @{}
$projectStarted = $false
$resolvedTempRoot = $null

function New-TestSecret {
    param([int]$ByteCount = 48)
    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes)
    }
    finally {
        $rng.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function New-TestHex {
    param([int]$ByteCount = 4)
    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $rng.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Set-TestEnvironment {
    param([string]$Name, [AllowNull()][string]$Value)
    if (-not $originalEnvironment.ContainsKey($Name)) {
        $originalEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Invoke-Compose {
    param([string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker.exe compose --project-directory $root --project-name $project `
            --env-file $emptyEnvFile --file $composeFile @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { throw "Docker Compose failed with exit code $exitCode." }
}

try {
    New-Item -ItemType Directory -Path $tempRoot, $updatesDirectory -Force | Out-Null
    $resolvedTempRoot = (Resolve-Path -LiteralPath $tempRoot).Path
    [System.IO.File]::WriteAllText($emptyEnvFile, '', (New-Object System.Text.UTF8Encoding($false)))

    $replicaBytes = New-Object byte[] 64
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($replicaBytes) }
    finally { $rng.Dispose() }
    $replicaKey = [Convert]::ToBase64String($replicaBytes)
    [Array]::Clear($replicaBytes, 0, $replicaBytes.Length)

    Set-TestEnvironment 'COMPOSE_PROJECT_NAME' $project
    Set-TestEnvironment 'WEB_PORT' '18081'
    Set-TestEnvironment 'WEB_ORIGIN' 'http://localhost:18081'
    Set-TestEnvironment 'UPDATES_DIRECTORY' $updatesDirectory
    Set-TestEnvironment 'MONGO_ROOT_USERNAME' ('testroot' + (New-TestHex))
    Set-TestEnvironment 'MONGO_ROOT_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'MONGO_REPLICA_KEY' $replicaKey
    Set-TestEnvironment 'MONGO_APP_DB' ('cp_api_' + (New-TestHex 6))
    Set-TestEnvironment 'MONGO_APP_USERNAME' ('testapp' + (New-TestHex))
    Set-TestEnvironment 'MONGO_APP_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'MONGO_BACKUP_USERNAME' ('testbackup' + (New-TestHex))
    Set-TestEnvironment 'MONGO_BACKUP_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'JWT_ACCESS_SECRET' (New-TestSecret 64)
    Set-TestEnvironment 'REFRESH_TOKEN_PEPPER' (New-TestSecret 64)
    Set-TestEnvironment 'BOOTSTRAP_SHOP_SLUG' 'api-compose-test'
    Set-TestEnvironment 'SETUP_CODE_HASH' ''
    Set-TestEnvironment 'SETUP_CODE_EXPIRES_AT' ''
    Set-TestEnvironment 'CONTROL_PLANE_URL' ''
    Set-TestEnvironment 'LICENCE_PUBLIC_KEY' ''
    Set-TestEnvironment 'UPDATER_CONFIG_PATH' '/app/updates/update-config.json'
    Set-TestEnvironment 'VITE_BACKEND' 'api'
    Set-TestEnvironment 'VITE_SHOP_SLUG' 'api-compose-test'
    Set-TestEnvironment 'VITE_SUPABASE_URL' ''
    Set-TestEnvironment 'VITE_SUPABASE_ANON_KEY' ''
    Set-TestEnvironment 'DEMO_MODE' 'false'
    Set-TestEnvironment 'DEMO_NODE_ENV' 'production'

    Invoke-Compose -Arguments @('config', '--quiet')
    $projectStarted = $true
    Invoke-Compose -Arguments @('up', '--detach', 'mongo', 'mongo-init')

    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(4)
    $ready = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $mongoId = & docker.exe compose --project-name $project --env-file $emptyEnvFile `
            --file $composeFile ps --quiet mongo
        if ($LASTEXITCODE -eq 0 -and $mongoId) {
            $mongoHealth = (& docker.exe inspect --format '{{.State.Health.Status}}' $mongoId.Trim()).Trim()
            $initId = & docker.exe compose --project-name $project --env-file $emptyEnvFile `
                --file $composeFile ps --all --quiet mongo-init
            $initExitCode = $null
            if ($LASTEXITCODE -eq 0 -and $initId) {
                $initState = (& docker.exe inspect --format '{{.State.Status}} {{.State.ExitCode}}' $initId.Trim()).Trim()
                if ($initState -match '^exited (\d+)$') { $initExitCode = [int]$Matches[1] }
            }
            if ($mongoHealth -eq 'healthy' -and $initExitCode -eq 0) {
                $ready = $true
                break
            }
            if ($initExitCode -and $initExitCode -ne 0) {
                throw 'Mongo initialization failed in the throwaway API test project.'
            }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw 'Throwaway Mongo did not become healthy with initialization complete.' }

    Invoke-Compose -Arguments @('--profile', 'test', 'run', '--build', '--rm', '--no-deps', 'api-test')
    Write-Host 'PASS: docker compose run --build --rm --no-deps api-test completed on throwaway Mongo.'
}
finally {
    try {
        if ($projectStarted) {
            Invoke-Compose -Arguments @('down')
            foreach ($volumeName in @("${project}_mongo_data", "${project}_mongo_backups")) {
                $existingVolumes = @(& docker.exe volume ls --quiet --filter "name=^$([regex]::Escape($volumeName))$")
                if ($LASTEXITCODE -eq 0 -and $existingVolumes -contains $volumeName) {
                    $labelsText = docker.exe volume inspect --format '{{json .Labels}}' $volumeName
                    $labels = $labelsText | ConvertFrom-Json
                    if ($labels.'com.docker.compose.project' -eq $project) {
                        docker.exe volume rm $volumeName | Out-Null
                    } else {
                        Write-Warning "Refused cleanup for $volumeName because its Compose project label differs."
                    }
                }
            }
        }
    }
    finally {
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
        }
        if ($resolvedTempRoot) {
            $tempPath = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
            if ($resolvedTempRoot.StartsWith($tempPath, [StringComparison]::OrdinalIgnoreCase)) {
                Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
            } else {
                Write-Warning 'Refused to remove the temporary API test directory outside the OS temp folder.'
            }
        }
    }
}
