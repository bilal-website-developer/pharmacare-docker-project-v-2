[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pharmacare-real-update-" + [Guid]::NewGuid().ToString('N'))
$project = 'cp-real-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$shopUpdates = Join-Path $tempRoot 'shop-updates'
$releaseRoot = Join-Path $tempRoot 'releases'
$releaseIndex = Join-Path $tempRoot 'release-index.json'
$nodeOutput = Join-Path $tempRoot 'fake-control-plane.stdout.log'
$nodeError = Join-Path $tempRoot 'fake-control-plane.stderr.log'
$environmentNames = @(
    'COMPOSE_PROJECT_NAME', 'WEB_PORT', 'WEB_ORIGIN', 'UPDATES_DIRECTORY',
    'MONGO_ROOT_USERNAME', 'MONGO_ROOT_PASSWORD', 'MONGO_REPLICA_KEY',
    'MONGO_APP_DB', 'MONGO_APP_USERNAME', 'MONGO_APP_PASSWORD',
    'MONGO_BACKUP_USERNAME', 'MONGO_BACKUP_PASSWORD',
    'JWT_ACCESS_SECRET', 'REFRESH_TOKEN_PEPPER', 'BOOTSTRAP_SHOP_SLUG',
    'SETUP_CODE_HASH', 'SETUP_CODE_EXPIRES_AT', 'CONTROL_PLANE_URL',
    'LICENCE_PUBLIC_KEY', 'UPDATER_CONFIG_PATH', 'VITE_BACKEND',
    'VITE_SHOP_SLUG', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
    'DEMO_MODE', 'DEMO_NODE_ENV', 'TEST_CONTROL_PLANE_CONFIG',
    'TEST_RELEASE_CERT_PASSWORD', 'REAL_STACK_BASE_URL',
    'REAL_STACK_SETUP_CODE', 'REAL_STACK_ACTIVATION_CODE',
    'REAL_STACK_ADMIN_EMAIL', 'REAL_STACK_ADMIN_PASSWORD'
)
$originalEnvironment = @{}
$createdImageTags = [System.Collections.Generic.List[string]]::new()
$controlPlaneProcess = $null
$previousCertificateValidationCallback = $null
$releaseCertificateThumbprint = $null
$tempPathResolved = $null
$projectStarted = $false
$completed = $false

function Set-TestEnvironment {
    param([string]$Name, [AllowNull()][string]$Value)
    if (-not $originalEnvironment.ContainsKey($Name)) {
        $originalEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
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

function Get-FreePort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments, [string]$FailureMessage)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
}

function New-ReleaseBundle {
    param(
        [string]$Version,
        [string[]]$Images,
        [string]$PrivateKeyPath
    )
    $directory = Join-Path $releaseRoot $Version
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $bundlePath = Join-Path $directory 'images.tar'
    Invoke-Checked 'docker.exe' (@('save', '--output', $bundlePath) + $Images) 'Docker image bundle creation failed.'

    $bundleHash = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestPath = Join-Path $directory 'release-manifest.json'
    $signaturePath = Join-Path $directory 'release-manifest.json.sig'
    $manifest = [ordered]@{
        version = $Version
        bundle_file = 'images.tar'
        images_sha256 = $bundleHash
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText(
        $manifestPath,
        $manifest + "`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    Invoke-Checked 'node.exe' @(
        (Join-Path $repository 'scripts\release-signature.mjs'),
        'sign',
        $manifestPath,
        $PrivateKeyPath,
        $signaturePath
    ) 'Ed25519 signing of the throwaway update bundle failed.'

    $signature = [System.IO.File]::ReadAllText($signaturePath).Trim()
    $release = [ordered]@{
        version = $Version
        status = 'approved'
        sha256 = $bundleHash
        signature = $signature
        bundle_path = "https://127.0.0.1:$script:releasePort/releases/"
        testReleaseDirectory = $directory
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText(
        $releaseIndex,
        $release + "`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    return $bundlePath
}

function Get-ShopCounts {
    $loginBody = [ordered]@{
        email = $script:adminEmail
        password = $script:adminPassword
    } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Uri "$script:baseUrl/api/auth/login" `
        -Method Post -ContentType 'application/json' -Body $loginBody -TimeoutSec 15
    if (-not $login.accessToken) { throw 'Shop login after update did not return an access session.' }
    $headers = @{ Authorization = "Bearer $($login.accessToken)" }
    $users = Invoke-RestMethod -Uri "$script:baseUrl/api/users" -Headers $headers -TimeoutSec 15
    $medicines = Invoke-RestMethod -Uri "$script:baseUrl/api/medicines?search=Real%20E2E%20Medicine" `
        -Headers $headers -TimeoutSec 15
    return [pscustomobject]@{
        Users = @($users.users).Count
        Medicines = @($medicines.items).Count
    }
}

function New-LocalHttpsCertificates {
    param([string]$Directory)
    $leafKey = [System.Security.Cryptography.RSA]::Create(2048)
    $leafCertificate = $null
    try {
        $leafRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
            'CN=127.0.0.1',
            $leafKey,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
        )
        $subjectAltNames = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $subjectAltNames.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
        $leafRequest.CertificateExtensions.Add($subjectAltNames.Build())
        $leafRequest.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
        )
        $leafRequest.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
                [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
                [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment -bor
                [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign,
                $true
            )
        )
        $extendedUsage = [System.Security.Cryptography.OidCollection]::new()
        [void]$extendedUsage.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
        $leafRequest.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($extendedUsage, $true)
        )
        $leafCertificate = $leafRequest.CreateSelfSigned(
            [DateTimeOffset]::UtcNow.AddMinutes(-5),
            [DateTimeOffset]::UtcNow.AddDays(1)
        )
        $rootPath = Join-Path $Directory 'test-root.cer'
        $certificatePath = Join-Path $Directory 'test-server.pfx'
        [System.IO.File]::WriteAllBytes(
            $rootPath,
            $leafCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
        )
        $script:releaseCertificatePassword = New-TestSecret
        [System.IO.File]::WriteAllBytes(
            $certificatePath,
            $leafCertificate.Export(
                [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
                $script:releaseCertificatePassword
            )
        )
        return [pscustomobject]@{
            RootPath = $rootPath
            CertificatePath = $certificatePath
            RootThumbprint = $leafCertificate.Thumbprint
        }
    }
    finally {
        if ($leafCertificate) { $leafCertificate.Dispose() }
        $leafKey.Dispose()
    }
}

try {
    New-Item -ItemType Directory -Path $tempRoot, $shopUpdates, $releaseRoot -Force | Out-Null
    $tempPathResolved = (Resolve-Path -LiteralPath $tempRoot).Path
    $projectDatabase = ('cp_' + $project.Replace('-', '_'))
    $webPort = Get-FreePort
    $script:releasePort = Get-FreePort
    $script:controlPlanePort = Get-FreePort
    $script:baseUrl = "http://127.0.0.1:$webPort"
    $script:adminEmail = "owner-$([Guid]::NewGuid().ToString('N').Substring(0, 8))@example.test"
    $script:adminPassword = "Aa1!RealStack-$([Guid]::NewGuid().ToString('N'))"
    $setupCode = New-TestSecret 32
    $activationCode = New-TestSecret 32
    $setupHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $setupHash = $setupHashAlgorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($setupCode))
    }
    finally { $setupHashAlgorithm.Dispose() }
    $setupHashText = ([BitConverter]::ToString($setupHash)).Replace('-', '').ToLowerInvariant()

    $privateKeyPath = Join-Path $tempRoot 'test-signing-private.pem'
    $publicKeyPath = Join-Path $tempRoot 'test-signing-public.pem'
    $keyGeneration = @'
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const [privatePath, publicPath] = process.argv.slice(1);
const pair = generateKeyPairSync('ed25519');
writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
'@
    & node.exe -e $keyGeneration $privateKeyPath $publicKeyPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate the temporary Ed25519 test key pair.' }
    $publicKey = [System.IO.File]::ReadAllText($publicKeyPath).Replace("`r", '').Replace("`n", '')
    $certificate = New-LocalHttpsCertificates -Directory $tempRoot
    $releaseCertificateThumbprint = $certificate.RootThumbprint

    $fakeConfigPath = Join-Path $tempRoot 'fake-control-plane-config.json'
    $fakeConfig = [ordered]@{
        privateKeyPath = $privateKeyPath
        certificatePath = $certificate.CertificatePath
        controlPlanePort = $script:controlPlanePort
        releasePort = $script:releasePort
        releaseIndexPath = $releaseIndex
        shopId = [Guid]::NewGuid().ToString()
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText(
        $fakeConfigPath,
        $fakeConfig + "`n",
        (New-Object System.Text.UTF8Encoding($false))
    )

    foreach ($name in $environmentNames) {
        Set-TestEnvironment -Name $name -Value $null
    }
    Set-TestEnvironment 'COMPOSE_PROJECT_NAME' $project
    Set-TestEnvironment 'WEB_PORT' ([string]$webPort)
    Set-TestEnvironment 'WEB_ORIGIN' $script:baseUrl
    Set-TestEnvironment 'UPDATES_DIRECTORY' $shopUpdates
    Set-TestEnvironment 'MONGO_ROOT_USERNAME' 'throwaway_root'
    Set-TestEnvironment 'MONGO_ROOT_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'MONGO_REPLICA_KEY' (New-TestSecret 64)
    Set-TestEnvironment 'MONGO_APP_DB' $projectDatabase
    Set-TestEnvironment 'MONGO_APP_USERNAME' 'throwaway_api'
    Set-TestEnvironment 'MONGO_APP_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'MONGO_BACKUP_USERNAME' 'throwaway_backup'
    Set-TestEnvironment 'MONGO_BACKUP_PASSWORD' (New-TestSecret)
    Set-TestEnvironment 'JWT_ACCESS_SECRET' (New-TestSecret 64)
    Set-TestEnvironment 'REFRESH_TOKEN_PEPPER' (New-TestSecret 64)
    Set-TestEnvironment 'BOOTSTRAP_SHOP_SLUG' 'real-stack-test'
    Set-TestEnvironment 'SETUP_CODE_HASH' $setupHashText
    Set-TestEnvironment 'SETUP_CODE_EXPIRES_AT' ([DateTimeOffset]::UtcNow.AddHours(2).ToString('o'))
    Set-TestEnvironment 'CONTROL_PLANE_URL' "http://host.docker.internal:$script:controlPlanePort"
    Set-TestEnvironment 'LICENCE_PUBLIC_KEY' $publicKey
    Set-TestEnvironment 'UPDATER_CONFIG_PATH' '/app/updates/update-config.json'
    Set-TestEnvironment 'VITE_BACKEND' 'api'
    Set-TestEnvironment 'VITE_SHOP_SLUG' 'real-stack-test'
    Set-TestEnvironment 'VITE_SUPABASE_URL' ''
    Set-TestEnvironment 'VITE_SUPABASE_ANON_KEY' ''
    Set-TestEnvironment 'DEMO_MODE' 'false'
    Set-TestEnvironment 'DEMO_NODE_ENV' 'production'
    Set-TestEnvironment 'TEST_CONTROL_PLANE_CONFIG' $fakeConfigPath
    Set-TestEnvironment 'TEST_RELEASE_CERT_PASSWORD' $script:releaseCertificatePassword
    Set-TestEnvironment 'REAL_STACK_BASE_URL' $script:baseUrl
    Set-TestEnvironment 'REAL_STACK_SETUP_CODE' $setupCode
    Set-TestEnvironment 'REAL_STACK_ACTIVATION_CODE' $activationCode
    Set-TestEnvironment 'REAL_STACK_ADMIN_EMAIL' $script:adminEmail
    Set-TestEnvironment 'REAL_STACK_ADMIN_PASSWORD' $script:adminPassword

    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $controlPlaneProcess = Start-Process -FilePath $nodePath `
        -ArgumentList @('scripts/test-real-control-plane.mjs') `
        -WorkingDirectory $repository `
        -WindowStyle Hidden `
        -RedirectStandardOutput $nodeOutput `
        -RedirectStandardError $nodeError `
        -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($controlPlaneProcess.HasExited) { throw 'The local test control plane did not start.' }
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $connect = $client.ConnectAsync('127.0.0.1', $script:controlPlanePort)
            if ($connect.Wait(250)) { $ready = $true; break }
        }
        catch {}
        finally { $client.Dispose() }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'The local test control plane did not become reachable.' }

    Invoke-Checked 'docker.exe' @(
        'compose', '--project-name', $project, 'config', '--quiet'
    ) 'Throwaway Compose configuration validation failed.'
    Invoke-Checked 'docker.exe' @(
        'compose', '--project-name', $project, 'build', '--quiet', 'api'
    ) 'Real shop API image build failed.'
    $projectStarted = $true
    Invoke-Checked 'docker.exe' @(
        'compose', '--project-name', $project, 'up', '--detach', 'mongo', 'mongo-init', 'api', 'web'
    ) 'Throwaway real API/Mongo Compose startup failed.'

    $healthy = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "$script:baseUrl/api/health" -TimeoutSec 3
            if ($health.status -eq 'ok' -and $health.database -eq 'ok') {
                $healthy = $true
                break
            }
        }
        catch {}
        Start-Sleep -Seconds 2
    }
    if (-not $healthy) { throw 'The real API/Mongo test stack did not become healthy.' }

    & npm.cmd run test:e2e:real
    if ($LASTEXITCODE -ne 0) {
        $apiContainer = & docker.exe compose --project-name $project ps --quiet api
        if ($LASTEXITCODE -eq 0 -and $apiContainer) {
            $duplicateKeyLog = & docker.exe compose --project-name $project logs --no-color api 2>$null |
                Select-String -Pattern '"event":"sale_duplicate_key"'
            if ($duplicateKeyLog) {
                $duplicateKeyLog | ForEach-Object { Write-Host $_.Line }
            }
            $diagnosticScriptPath = Join-Path $shopUpdates 'real-stack-diagnostics.cjs'
            $diagnosticScript = @'
const { MongoClient } = require("mongodb");
(async () => {
  const user = encodeURIComponent(process.env.MONGO_APP_USERNAME);
  const password = encodeURIComponent(process.env.MONGO_APP_PASSWORD);
  const databaseName = process.env.MONGO_APP_DB;
  const client = new MongoClient(`mongodb://${user}:${password}@mongo:27017/${encodeURIComponent(databaseName)}?authSource=${encodeURIComponent(databaseName)}`);
  try {
    await client.connect();
    const database = client.db(databaseName);
    const counters = await database.collection("counters").find({}, { projection: { kind: 1, lastValue: 1 } }).toArray();
    const [sales, movements, cashEntries, draftCompletions, indexes] = await Promise.all([
      database.collection("sales").countDocuments({}),
      database.collection("stockMovements").countDocuments({}),
      database.collection("cashBookEntries").countDocuments({}),
      database.collection("saleDraftCompletions").countDocuments({}),
      Promise.all(["counters", "sales", "stockMovements", "salePayments", "cashBookEntries", "saleDraftCompletions", "auditLogs"]
        .map(async (name) => {
          try {
            return [name, await database.collection(name).listIndexes().toArray()];
          } catch (error) {
            if (error?.code === 26) return [name, []];
            throw error;
          }
        }))
    ]);
    console.log(JSON.stringify({
      counterSequences: counters.map(({ kind, lastValue }) => ({ kind, lastValue: lastValue?.toString() })),
      sales,
      stockMovements: movements,
      cashBookEntries: cashEntries,
      saleDraftCompletions: draftCompletions,
      uniqueIndexes: Object.fromEntries(indexes.map(([name, list]) => [
        name,
        list.filter(({ unique }) => unique).map(({ name: indexName, key }) => ({ name: indexName, key }))
      ]))
    }));
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(JSON.stringify({
    diagnosticFailure: error?.name ?? "unknown",
    code: error?.code ?? null,
    codeName: error?.codeName ?? null
  }));
  process.exitCode = 1;
});
'@
            [System.IO.File]::WriteAllText(
                $diagnosticScriptPath,
                $diagnosticScript + "`n",
                (New-Object System.Text.UTF8Encoding($false))
            )
            & docker.exe exec $apiContainer.Trim() node /app/updates/real-stack-diagnostics.cjs
            if ($LASTEXITCODE -ne 0) { Write-Warning 'Could not collect safe Mongo counter diagnostics.' }
        }
        throw 'Real-stack Playwright business workflow failed.'
    }
    $activationConfig = Get-Content -LiteralPath (Join-Path $shopUpdates 'update-config.json') -Raw |
        ConvertFrom-Json
    if (($activationConfig.deviceKeyHash -notmatch '^[a-f0-9]{64}$') -or
        ($activationConfig.publicKeyPath -ne 'licence-public.pem') -or
        ($activationConfig.timezone -ne 'Asia/Karachi')) {
        throw 'First-run activation did not provision the expected updater configuration.'
    }
    Write-Host 'PASS: first-run activation wrote the host-mounted updater config and hash-only device credential.'

    $beforeUpdate = Get-ShopCounts
    if ($beforeUpdate.Users -ne 4 -or $beforeUpdate.Medicines -ne 1) {
        throw 'Unexpected real-stack user/product counts before updater rehearsal.'
    }

    $releaseImages = @(
        'pharma-care-api:local',
        'pharma-care-web:local',
        'mongo:8.0.12',
        'nginx:1.27.5-alpine',
        'caddy:2.10-alpine'
    )
    [void](New-ReleaseBundle -Version 'real-success-1' -Images $releaseImages -PrivateKeyPath $privateKeyPath)
    $previousCertificateValidationCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {
        param($sender, $serverCertificate, $certificateChain, $sslPolicyErrors)
        return $serverCertificate.GetCertHashString() -eq $script:releaseCertificateThumbprint
    }
    & (Join-Path $repository 'scripts\update.ps1') `
        -UpdateNow `
        -RepositoryRoot $repository `
        -ConfigPath (Join-Path $shopUpdates 'update-config.json') `
        -UpdatesDirectoryPath $shopUpdates `
        -HealthCheckTimeoutSeconds 30
    $successState = Get-Content -LiteralPath (Join-Path $shopUpdates 'update-state.json') -Raw |
        ConvertFrom-Json
    if ($successState.status -ne 'succeeded') { throw 'The real Docker update did not reach succeeded state.' }
    $afterUpdate = Get-ShopCounts
    if ($afterUpdate.Users -ne $beforeUpdate.Users -or $afterUpdate.Medicines -ne $beforeUpdate.Medicines) {
        throw 'Real Docker update changed persisted shop record counts.'
    }
    Write-Host "PASS: real Docker update succeeded and retained $($afterUpdate.Users) users and $($afterUpdate.Medicines) medicine."

    $originalApiId = (docker image inspect --format '{{.Id}}' 'pharma-care-api:local').Trim()
    if ($LASTEXITCODE -ne 0 -or -not $originalApiId) { throw 'Could not record the original API image ID.' }
    $retainedApiTag = "pharma-care-api:retained-$($project.Substring($project.Length - 8))"
    $brokenApiTag = "pharma-care-api:broken-$($project.Substring($project.Length - 8))"
    Invoke-Checked 'docker.exe' @('image', 'tag', $originalApiId, $retainedApiTag) 'Could not retain the original API image.'
    $createdImageTags.Add($retainedApiTag)
    $brokenDockerfile = Join-Path $tempRoot 'Dockerfile.forced-failure'
    [System.IO.File]::WriteAllText(
        $brokenDockerfile,
        "FROM pharma-care-api:local`nCMD [""node"", ""-e"", ""process.exit(19)""]`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    Invoke-Checked 'docker.exe' @(
        'build', '--quiet', '--tag', $brokenApiTag, '--file', $brokenDockerfile, $tempRoot
    ) 'Could not build the deliberate failing API image.'
    $createdImageTags.Add($brokenApiTag)
    $brokenApiId = (docker image inspect --format '{{.Id}}' $brokenApiTag).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $brokenApiId) { throw 'Could not identify the deliberate failing API image.' }
    Invoke-Checked 'docker.exe' @('image', 'tag', $brokenApiId, 'pharma-care-api:local') 'Could not stage the failing API image.'
    try {
        [void](New-ReleaseBundle -Version 'real-forced-failure-1' -Images $releaseImages -PrivateKeyPath $privateKeyPath)
    }
    finally {
        Invoke-Checked 'docker.exe' @('image', 'tag', $originalApiId, 'pharma-care-api:local') 'Could not restore the original API image tag.'
    }

    try {
        & (Join-Path $repository 'scripts\update.ps1') `
            -UpdateNow `
            -RepositoryRoot $repository `
            -ConfigPath (Join-Path $shopUpdates 'update-config.json') `
            -UpdatesDirectoryPath $shopUpdates `
            -HealthCheckTimeoutSeconds 20
        throw 'The forced-failure update unexpectedly succeeded.'
    }
    catch {
        if ($_.Exception.Message -eq 'The forced-failure update unexpectedly succeeded.') { throw }
    }
    $rollbackState = Get-Content -LiteralPath (Join-Path $shopUpdates 'update-state.json') -Raw |
        ConvertFrom-Json
    if ($rollbackState.status -ne 'rolled_back') { throw 'The real Docker failure did not complete automatic rollback.' }
    $afterRollback = Get-ShopCounts
    if ($afterRollback.Users -ne $beforeUpdate.Users -or $afterRollback.Medicines -ne $beforeUpdate.Medicines) {
        throw 'Real Docker rollback did not preserve the verified shop record counts.'
    }
    Write-Host "PASS: forced real Docker health failure rolled back automatically and retained $($afterRollback.Users) users and $($afterRollback.Medicines) medicine."
    $completed = $true
}
finally {
    if ($controlPlaneProcess -and -not $controlPlaneProcess.HasExited) {
        Stop-Process -Id $controlPlaneProcess.Id -Force
        $controlPlaneProcess.WaitForExit()
    }
    if ($projectStarted) {
        & docker.exe compose --project-name $project down
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Throwaway Compose containers did not all stop cleanly.' }
        foreach ($volumeName in @("${project}_mongo_data", "${project}_mongo_backups")) {
            $existingVolumes = @(& docker.exe volume ls --quiet --filter "name=^$([regex]::Escape($volumeName))$")
            if ($LASTEXITCODE -eq 0 -and $existingVolumes -contains $volumeName) {
                $labelsText = docker.exe volume inspect --format '{{json .Labels}}' $volumeName
                $labels = $labelsText | ConvertFrom-Json
                if ($labels.'com.docker.compose.project' -eq $project) {
                    docker.exe volume rm $volumeName | Out-Null
                } else {
                    Write-Warning "Refused cleanup for volume $volumeName because its project label differs."
                }
            }
        }
    }
    foreach ($tag in $createdImageTags) {
        docker.exe image rm $tag *> $null
    }
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCertificateValidationCallback
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
    if ($tempPathResolved) {
        $tempRootPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if ($tempPathResolved.StartsWith($tempRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $tempPathResolved -Recurse -Force
        } else {
            Write-Warning 'Refused to remove the temporary directory because it is outside the OS temp folder.'
        }
    }
    if (-not $completed) { Write-Host 'Real update test did not complete; throwaway resources were cleaned where ownership was verified.' }
}
