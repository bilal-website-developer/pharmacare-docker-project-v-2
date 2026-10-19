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
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required to sign a release manifest.'
}

$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$resolvedKey = (Resolve-Path -LiteralPath $PrivateKeyPath).Path
$outputPath = if ($SignaturePath) { $SignaturePath } else { "$resolvedManifest.sig" }
if (Test-Path -LiteralPath $outputPath) {
    throw 'The signature output already exists; it was not overwritten.'
}

$helper = Join-Path $PSScriptRoot 'release-signature.mjs'
& node.exe $helper sign $resolvedManifest $resolvedKey $outputPath
if ($LASTEXITCODE -ne 0) {
    throw 'Node.js could not sign and verify the release manifest.'
}
