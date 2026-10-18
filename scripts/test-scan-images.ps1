$ErrorActionPreference = 'Stop'

$scanner = Join-Path $PSScriptRoot 'scan-images.ps1'
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) "pharmacare-scan-test-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $fakeToken = 'eyJ' + 'hbGciOiJub25lIn0.' + 'eyJ0ZXN0IjoidGVzdCJ9.' + 'c2lnbmF0dXJl'
    [System.IO.File]::WriteAllText((Join-Path $fixture 'app.js'), "const fake = '$fakeToken';")

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -ScanDirectory $fixture
    $scanExitCode = $LASTEXITCODE
    if ($scanExitCode -eq 0) { throw 'Scanner accepted a synthetic JWT-like value.' }
    Write-Host 'Scanner negative test passed: a synthetic JWT-like value caused a non-zero exit.'

    Remove-Item -LiteralPath (Join-Path $fixture 'app.js')
    [System.IO.File]::WriteAllText((Join-Path $fixture '.env.example'), 'example configuration')
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scanner -ScanDirectory $fixture
    $envScanExitCode = $LASTEXITCODE
    if ($envScanExitCode -eq 0) { throw 'Scanner accepted an .env.example file.' }
    Write-Host 'Scanner negative test passed: an .env.example file caused a non-zero exit.'
}
finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
exit 0
