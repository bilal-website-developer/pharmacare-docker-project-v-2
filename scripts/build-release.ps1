[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')]
    [string]$Version,
    [string]$OutputDirectory = 'artifacts\releases'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory
} else {
    Join-Path $repoRoot $OutputDirectory
}
$releaseRoot = Join-Path $outputRoot "pharmacare-$Version"
if (Test-Path -LiteralPath $releaseRoot) {
    throw 'The release output directory already exists; it was not changed.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI is required to build a release.' }

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$previousLocation = Get-Location
$oldSupabaseUrl = [Environment]::GetEnvironmentVariable('VITE_SUPABASE_URL', 'Process')
$oldSupabaseAnonKey = [Environment]::GetEnvironmentVariable('VITE_SUPABASE_ANON_KEY', 'Process')
try {
    Set-Location $repoRoot
    $env:VITE_SUPABASE_URL = ''
    $env:VITE_SUPABASE_ANON_KEY = ''
    $env:VITE_BACKEND = 'api'
    $env:VITE_SHOP_SLUG = 'release'

    & docker compose build --pull api mongo-init web
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose image build failed.' }
    & docker pull mongo:8.0.12
    if ($LASTEXITCODE -ne 0) { throw 'Could not pull the pinned MongoDB image.' }
    & docker pull nginx:1.27.5-alpine
    if ($LASTEXITCODE -ne 0) { throw 'Could not pull the pinned Nginx image.' }
    & docker pull caddy:2.10-alpine
    if ($LASTEXITCODE -ne 0) { throw 'Could not pull the pinned Caddy image.' }

    $images = @(
        'pharma-care-api:local',
        'pharma-care-web:local',
        'mongo:8.0.12',
        'nginx:1.27.5-alpine',
        'caddy:2.10-alpine'
    )
    & (Join-Path $PSScriptRoot 'scan-images.ps1') -Image $images
    if ($LASTEXITCODE -ne 0) { throw 'Image secret scan failed; the bundle was not created.' }

    $bundlePath = Join-Path $releaseRoot 'images.tar'
    & docker save --output $bundlePath $images
    if ($LASTEXITCODE -ne 0) { throw 'Could not save release images.' }

    Copy-Item -LiteralPath (Join-Path $repoRoot 'docker-compose.yml') -Destination $releaseRoot
    Copy-Item -LiteralPath (Join-Path $repoRoot 'docker-compose.lan.yml') -Destination $releaseRoot
    Copy-Item -LiteralPath (Join-Path $repoRoot 'docker') -Destination $releaseRoot -Recurse
    Copy-Item -LiteralPath (Join-Path $repoRoot 'Dockerfile') -Destination $releaseRoot
    Copy-Item -LiteralPath (Join-Path $repoRoot 'installer') -Destination $releaseRoot -Recurse
    $releaseScripts = Join-Path $releaseRoot 'scripts'
    New-Item -ItemType Directory -Path $releaseScripts | Out-Null
    foreach ($script in @(
        'update.ps1',
        'update-engine.ps1',
        'release-signature.mjs',
        'enable-lan.ps1',
        'backup-external.ps1'
    )) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination $releaseScripts
    }
    $releaseServer = Join-Path $releaseRoot 'server'
    New-Item -ItemType Directory -Path $releaseServer | Out-Null
    Copy-Item -LiteralPath (Join-Path (Join-Path $repoRoot 'server') 'Dockerfile') -Destination $releaseServer
    $releaseDocs = Join-Path $releaseRoot 'docs'
    New-Item -ItemType Directory -Path $releaseDocs | Out-Null
    foreach ($document in @('INSTALLER.md', 'DOCKER.md', 'DEPLOYMENT.md', 'SHOP_OWNER_GUIDE.md', 'SUPPORT_RUNBOOK.md')) {
        $source = Join-Path (Join-Path $repoRoot 'docs') $document
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination $releaseDocs
        }
    }
    $manifest = [ordered]@{
        version = $Version
        images = $images
        bundle_file = 'images.tar'
        images_sha256 = (Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
        created_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    $manifestPath = Join-Path $releaseRoot 'release-manifest.json'
    [System.IO.File]::WriteAllText(
        $manifestPath,
        ($manifest | ConvertTo-Json -Depth 4) + "`n",
        (New-Object System.Text.UTF8Encoding($false))
    )

    $checksumLines = foreach ($file in Get-ChildItem -LiteralPath $releaseRoot -File -Recurse | Sort-Object FullName) {
        $relativePath = $file.FullName.Substring($releaseRoot.Length).TrimStart('\')
        $digest = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$digest  $relativePath"
    }
    [System.IO.File]::WriteAllLines(
        (Join-Path $releaseRoot 'SHA256SUMS.txt'),
        [string[]]$checksumLines,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host "Release bundle created at $releaseRoot"
}
finally {
    [Environment]::SetEnvironmentVariable('VITE_SUPABASE_URL', $oldSupabaseUrl, 'Process')
    [Environment]::SetEnvironmentVariable('VITE_SUPABASE_ANON_KEY', $oldSupabaseAnonKey, 'Process')
    Set-Location $previousLocation
}
