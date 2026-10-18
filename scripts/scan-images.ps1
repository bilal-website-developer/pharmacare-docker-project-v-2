[CmdletBinding()]
param(
    [string[]]$Image = @('pharma-care-api:local', 'pharma-care-web:local', 'mongo:8.0.12', 'nginx:1.27.5-alpine'),
    [string]$ScanDirectory
)

$ErrorActionPreference = 'Stop'

$secretPatterns = @(
    @{ Name = 'Supabase URL'; Pattern = 'https?://[a-z0-9-]+\.supabase\.(?:co|in)\b' },
    @{ Name = 'Supabase key'; Pattern = '\bsb_(?:publishable|secret)_[A-Za-z0-9._-]{8,}\b' },
    @{ Name = 'JWT-like value'; Pattern = '\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b' },
    @{ Name = 'Private key'; Pattern = '-----BEGIN (?:RSA |EC |OPENSSH |ED25519 |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{80,}?-----END (?:RSA |EC |OPENSSH |ED25519 |ENCRYPTED )?PRIVATE KEY-----' },
    @{ Name = 'Secret environment assignment'; Pattern = '(?im)^\s*(?:SUPABASE|VITE_SUPABASE)_[A-Z0-9_]*(?:KEY|TOKEN|URL)\s*[:=]\s*["'']?[^"''\s#]{3,}' },
    @{ Name = 'Credential-like API key'; Pattern = '\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b' }
)
$textExtensions = @(
    '.cjs', '.conf', '.css', '.html', '.ini', '.js', '.json', '.md', '.mjs', '.pem',
    '.properties', '.ps1', '.sh', '.sql', '.svg', '.toml', '.ts', '.txt', '.xml',
    '.yaml', '.yml'
)

function Find-UnsafeContent {
    param([Parameter(Mandatory = $true)][string]$Root)

    $findings = [System.Collections.Generic.List[string]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force) {
        if ($file.Name -match '^\.env(?:\..+)?$') {
            $findings.Add(".env file: $($file.FullName)")
            continue
        }

        if ($file.Length -gt 33554432) { continue }
        if ($file.Extension -and $textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }

        try {
            $content = [System.IO.File]::ReadAllText($file.FullName)
        }
        catch {
            throw "Could not inspect a file in the scan target: $($file.FullName)"
        }
        foreach ($rule in $secretPatterns) {
            if ([regex]::IsMatch($content, $rule.Pattern)) {
                $findings.Add("$($rule.Name): $($file.FullName)")
            }
        }
    }
    return $findings
}

if ($ScanDirectory) {
    if (-not (Test-Path -LiteralPath $ScanDirectory -PathType Container)) {
        throw 'The scan directory does not exist.'
    }
    $directoryFindings = @(Find-UnsafeContent -Root (Resolve-Path -LiteralPath $ScanDirectory).Path)
    if ($directoryFindings.Count -gt 0) {
        Write-Error "Image scan failed with $($directoryFindings.Count) finding(s):`n$($directoryFindings -join "`n")"
        exit 1
    }
    Write-Host 'Directory scan passed: no .env files, Supabase URLs/keys, JWT-like values, or private keys found.'
    exit 0
}

if ($Image.Count -eq 0) { throw 'Specify at least one image to scan.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI is required to scan images.' }
$python = Get-Command python.exe -ErrorAction SilentlyContinue
$usePythonLauncher = $false
if (-not $python) {
    $python = Get-Command py.exe -ErrorAction SilentlyContinue
    $usePythonLauncher = [bool]$python
}
if (-not $python) { throw 'Python 3 is required to scan exported image filesystems.' }
$archiveScanner = Join-Path $PSScriptRoot 'scan-image-archive.py'

foreach ($imageName in $Image) {
    $containerName = "pharmacare-scan-$([Guid]::NewGuid().ToString('N'))"
    $archivePath = Join-Path ([System.IO.Path]::GetTempPath()) "$containerName.tar"
    $containerCreated = $false
    try {
        & docker create --name $containerName $imageName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not create a read-only scan container for image $imageName." }
        $containerCreated = $true
        & docker export --output $archivePath $containerName
        if ($LASTEXITCODE -ne 0) { throw "Could not export image filesystem for $imageName." }
        if ($usePythonLauncher) {
            & $python.Source -3 $archiveScanner $archivePath
        }
        else {
            & $python.Source $archiveScanner $archivePath
        }
        if ($LASTEXITCODE -eq 1) { throw "Image scan failed for $imageName." }
        if ($LASTEXITCODE -ne 0) { throw "Image scanner could not inspect $imageName." }
        Write-Host "Image scan passed: $imageName"
    }
    finally {
        if ($containerCreated) {
            & docker rm $containerName | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove the temporary scanner container $containerName." }
        }
        if (Test-Path -LiteralPath $archivePath) {
            Remove-Item -LiteralPath $archivePath -Force
        }
    }
}
