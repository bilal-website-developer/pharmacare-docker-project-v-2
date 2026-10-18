[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$ManifestPath,
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$PrivateKeyPath,
    [string]$SignaturePath
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
    throw 'OpenSSL is required to sign the release manifest.'
}
$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$resolvedKey = (Resolve-Path -LiteralPath $PrivateKeyPath).Path
$outputPath = if ($SignaturePath) {
    $SignaturePath
} else {
    "$resolvedManifest.sig"
}
if (Test-Path -LiteralPath $outputPath) {
    throw 'The signature output already exists; it was not overwritten.'
}
$temporarySignature = Join-Path ([System.IO.Path]::GetTempPath()) "pharmacare-sign-$([Guid]::NewGuid().ToString('N')).bin"
try {
    & openssl pkeyutl -sign -rawin -inkey $resolvedKey -in $resolvedManifest -out $temporarySignature
    if ($LASTEXITCODE -ne 0) { throw 'OpenSSL could not sign the release manifest.' }

    $signatureBytes = [System.IO.File]::ReadAllBytes($temporarySignature)
    $signature = [Convert]::ToBase64String($signatureBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $parent = Split-Path -Parent $outputPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($outputPath, $signature + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host 'Release manifest signed; only the detached signature was written.'
}
finally {
    if (Test-Path -LiteralPath $temporarySignature) {
        Remove-Item -LiteralPath $temporarySignature -Force
    }
}
