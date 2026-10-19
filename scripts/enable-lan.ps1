[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$')]
    [string]$LanHostname,
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$composeFile = Join-Path $root 'docker-compose.yml'
$lanFile = Join-Path $root 'docker-compose.lan.yml'
if (-not (Test-Path -LiteralPath (Join-Path $root '.env') -PathType Leaf)) {
    throw 'Run the LAN setup after the local installer has created this shop.'
}
if (-not (Test-Path -LiteralPath $lanFile -PathType Leaf)) {
    throw 'LAN Compose configuration is missing.'
}

$isAdministrator = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
    throw 'Run LAN setup from an elevated PowerShell window to create the Private-profile firewall rule.'
}

$oldHostname = [Environment]::GetEnvironmentVariable('LAN_HOSTNAME', 'Process')
try {
    $env:LAN_HOSTNAME = $LanHostname
    & docker compose --project-directory $root -f $composeFile -f $lanFile config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'LAN Compose configuration validation failed.' }

    $mongoPorts = & docker compose --project-directory $root -f $composeFile -f $lanFile port mongo 27017 2>$null
    if ($LASTEXITCODE -eq 0 -and $mongoPorts) {
        throw 'MongoDB must not publish a host port in LAN mode.'
    }

    & docker compose --project-directory $root -f $composeFile -f $lanFile up --detach
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the HTTPS LAN proxy.' }

    $curl = Get-Command curl.exe -ErrorAction Stop
    & $curl.Source --insecure --fail --silent --show-error `
        --resolve "$LanHostname`:443:127.0.0.1" "https://$LanHostname/api/health" *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Initial HTTPS request failed while Caddy created its internal certificate.' }

    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(3)
    $caddyContainer = $null
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $caddyContainer = & docker compose --project-directory $root -f $composeFile -f $lanFile ps --quiet caddy
        if ($LASTEXITCODE -eq 0 -and $caddyContainer) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $caddyContainer) { throw 'Caddy did not start in LAN mode.' }

    $exportDirectory = Join-Path $root 'exports'
    New-Item -ItemType Directory -Path $exportDirectory -Force | Out-Null
    $certificatePath = Join-Path $exportDirectory 'pharmacare-lan-root.crt'
    & docker cp "$($caddyContainer.Trim()):/data/caddy/pki/authorities/local/root.crt" $certificatePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
        throw 'Could not export the Caddy internal root certificate.'
    }

    $ruleName = 'PharmaCare HTTPS LAN (Private)'
    $firewallRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($firewallRule) {
        Set-NetFirewallRule -DisplayName $ruleName -Enabled True -Profile Private -Action Allow
        $firewallRule | Get-NetFirewallAddressFilter |
            Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet
    } else {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
            -LocalPort 443 -Action Allow -Profile Private -RemoteAddress LocalSubnet | Out-Null
    }

    & $curl.Source --fail --silent --show-error --cacert $certificatePath `
        --resolve "$LanHostname`:443:127.0.0.1" "https://$LanHostname/api/health"
    if ($LASTEXITCODE -ne 0) { throw 'HTTPS health request failed certificate validation.' }

    $powerSettings = & powercfg.exe /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null
    if ($LASTEXITCODE -ne 0 -or $powerSettings -match 'Current AC Power Setting Index:\s+0x0+$') {
        Write-Warning 'The admin PC may sleep when idle; change Windows power settings to keep the shop server available.'
    }
    Write-Host "LAN HTTPS is enabled at https://$LanHostname/"
    Write-Host "Client trust certificate exported to $certificatePath"
    Write-Host 'Firewall access is limited to the Private profile and LocalSubnet.'
}
finally {
    [Environment]::SetEnvironmentVariable('LAN_HOSTNAME', $oldHostname, 'Process')
}
