[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$project = 'cp-lan-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$hostname = "$project.local"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pharmacare-lan-test-$([Guid]::NewGuid().ToString('N'))"
$emptyEnvFile = Join-Path $tempRoot 'compose-empty.env'
$updatesDirectory = Join-Path $tempRoot 'updates'
$certificatePath = Join-Path $tempRoot 'caddy-root.crt'
$composeFile = Join-Path $root 'docker-compose.yml'
$lanComposeFile = Join-Path $root 'docker-compose.lan.yml'
$environmentNames = @(
    'COMPOSE_PROJECT_NAME', 'WEB_PORT', 'WEB_ORIGIN', 'UPDATES_DIRECTORY',
    'MONGO_ROOT_USERNAME', 'MONGO_ROOT_PASSWORD', 'MONGO_REPLICA_KEY',
    'MONGO_APP_DB', 'MONGO_APP_USERNAME', 'MONGO_APP_PASSWORD',
    'MONGO_BACKUP_USERNAME', 'MONGO_BACKUP_PASSWORD',
    'JWT_ACCESS_SECRET', 'REFRESH_TOKEN_PEPPER', 'BOOTSTRAP_SHOP_SLUG',
    'SETUP_CODE_HASH', 'SETUP_CODE_EXPIRES_AT', 'CONTROL_PLANE_URL',
    'LICENCE_PUBLIC_KEY', 'UPDATER_CONFIG_PATH', 'VITE_BACKEND',
    'VITE_SHOP_SLUG', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
    'DEMO_MODE', 'DEMO_NODE_ENV', 'LAN_HOSTNAME'
)
$originalEnvironment = @{}
$projectStarted = $false
$resolvedTempRoot = $null

function New-TestHex {
    param([int]$ByteCount = 32)
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

function Set-TestEnvironment {
    param([string]$Name, [AllowNull()][string]$Value)
    if (-not $originalEnvironment.ContainsKey($Name)) {
        $originalEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Invoke-Compose {
    param([string[]]$Arguments, [switch]$Capture)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($Capture) {
            $output = & docker.exe compose --project-directory $root `
                --project-name $project --env-file $emptyEnvFile `
                --file $composeFile --file $lanComposeFile @Arguments 2>$null
            $exitCode = $LASTEXITCODE
            if ($exitCode -ne 0) { throw "Docker Compose failed with exit code $exitCode." }
            return ($output -join "`n").Trim()
        }
        & docker.exe compose --project-directory $root `
            --project-name $project --env-file $emptyEnvFile `
            --file $composeFile --file $lanComposeFile @Arguments
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) { throw "Docker Compose failed with exit code $exitCode." }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

try {
    New-Item -ItemType Directory -Path $tempRoot, $updatesDirectory -Force | Out-Null
    $resolvedTempRoot = (Resolve-Path -LiteralPath $tempRoot).Path
    [System.IO.File]::WriteAllText($emptyEnvFile, '', (New-Object System.Text.UTF8Encoding($false)))
    $httpsListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, 443)
    try {
        $httpsListener.Start()
    }
    catch {
        throw 'Host port 443 is not available for the throwaway LAN test.'
    }
    finally {
        $httpsListener.Stop()
    }

    $mongoReplicaBytes = New-Object byte[] 64
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($mongoReplicaBytes) }
    finally { $rng.Dispose() }
    $mongoReplicaKey = [Convert]::ToBase64String($mongoReplicaBytes)
    [Array]::Clear($mongoReplicaBytes, 0, $mongoReplicaBytes.Length)

    Set-TestEnvironment 'COMPOSE_PROJECT_NAME' $project
    Set-TestEnvironment 'WEB_PORT' '18080'
    Set-TestEnvironment 'WEB_ORIGIN' "https://$hostname"
    Set-TestEnvironment 'UPDATES_DIRECTORY' $updatesDirectory
    Set-TestEnvironment 'MONGO_ROOT_USERNAME' ('testroot' + (New-TestHex 4))
    Set-TestEnvironment 'MONGO_ROOT_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'MONGO_REPLICA_KEY' $mongoReplicaKey
    Set-TestEnvironment 'MONGO_APP_DB' ('cp_lan_' + (New-TestHex 6))
    Set-TestEnvironment 'MONGO_APP_USERNAME' ('testapp' + (New-TestHex 4))
    Set-TestEnvironment 'MONGO_APP_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'MONGO_BACKUP_USERNAME' ('testbackup' + (New-TestHex 4))
    Set-TestEnvironment 'MONGO_BACKUP_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'JWT_ACCESS_SECRET' (New-TestSecret 64)
    Set-TestEnvironment 'REFRESH_TOKEN_PEPPER' (New-TestSecret 64)
    Set-TestEnvironment 'BOOTSTRAP_SHOP_SLUG' 'lan-https-test'
    Set-TestEnvironment 'SETUP_CODE_HASH' ''
    Set-TestEnvironment 'SETUP_CODE_EXPIRES_AT' ''
    Set-TestEnvironment 'CONTROL_PLANE_URL' ''
    Set-TestEnvironment 'LICENCE_PUBLIC_KEY' ''
    Set-TestEnvironment 'UPDATER_CONFIG_PATH' '/app/updates/update-config.json'
    Set-TestEnvironment 'VITE_BACKEND' 'api'
    Set-TestEnvironment 'VITE_SHOP_SLUG' 'lan-https-test'
    Set-TestEnvironment 'VITE_SUPABASE_URL' ''
    Set-TestEnvironment 'VITE_SUPABASE_ANON_KEY' ''
    Set-TestEnvironment 'DEMO_MODE' 'false'
    Set-TestEnvironment 'DEMO_NODE_ENV' 'production'
    Set-TestEnvironment 'LAN_HOSTNAME' $hostname

    $composeConfigJson = Invoke-Compose -Arguments @('config', '--format', 'json') -Capture
    $composeConfig = $composeConfigJson | ConvertFrom-Json
    if ($composeConfig.services.mongo.ports) {
        throw 'LAN test configuration unexpectedly published MongoDB.'
    }
    Remove-Variable -Name composeConfigJson, composeConfig
    $projectStarted = $true
    Invoke-Compose -Arguments @('up', '--detach', 'mongo', 'mongo-init', 'api', 'web', 'caddy')

    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(4)
    $httpCurlSucceeded = $false
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & curl.exe --ssl-no-revoke --insecure --fail --silent --show-error `
                --max-time 5 --resolve "$hostname`:443:127.0.0.1" `
                "https://$hostname/api/health" *> $null
            if ($LASTEXITCODE -eq 0) { $httpCurlSucceeded = $true; break }
        }
        finally {
            $ErrorActionPreference = $previousPreference
        }
        Start-Sleep -Seconds 3
    }
    if (-not $httpCurlSucceeded) { throw 'Caddy did not serve the throwaway HTTPS health endpoint.' }

    $caddyContainer = Invoke-Compose -Arguments @('ps', '--quiet', 'caddy') -Capture
    if (-not $caddyContainer) { throw 'Throwaway Caddy container was not found.' }
    & docker.exe cp "${caddyContainer}:/data/caddy/pki/authorities/local/root.crt" $certificatePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
        throw 'Could not export the throwaway Caddy root certificate.'
    }

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & curl.exe --ssl-no-revoke --cacert $certificatePath `
            --resolve "$hostname`:443:127.0.0.1" --fail --silent --show-error `
            --max-time 15 --output NUL --write-out 'Trusted HTTPS response: HTTP %{http_code}\n' `
            "https://$hostname/api/health"
        $curlExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($curlExitCode -ne 0) { throw 'Caddy root certificate trust check failed.' }
    Write-Host 'PASS: curl.exe --ssl-no-revoke validated the Caddy root certificate without --insecure.'
}
finally {
    try {
        if ($projectStarted) {
            Invoke-Compose -Arguments @('down')
            foreach ($volumeName in @("${project}_mongo_data", "${project}_mongo_backups", "${project}_caddy_data", "${project}_caddy_config")) {
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
                Write-Warning 'Refused to remove the temporary LAN test directory outside the OS temp folder.'
            }
        }
    }
}
