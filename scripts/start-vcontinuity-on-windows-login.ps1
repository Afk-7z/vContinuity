$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entry = Join-Path $root 'src\vcontinuity\unified-http.mjs'
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$expectedVersion = [string]$package.version
$port = if ($env:VCONTINUITY_PORT) { [int]$env:VCONTINUITY_PORT } else { 7781 }

function Test-ListeningPort([int]$Port) {
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(500)
        if ($ok -and $client.Connected) {
            $client.EndConnect($iar)
            $client.Dispose()
            return $true
        }
        $client.Dispose()
    } catch {}
    return $false
}

if (-not (Test-Path $entry)) {
    throw "vContinuity entrypoint not found: $entry"
}

if (-not (Test-ListeningPort $port)) {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $env:VCONTINUITY_PORT = [string]$port
    Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden
}

$deadline = (Get-Date).AddSeconds(60)
do {
    try {
        $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/healthz" -f $port) -TimeoutSec 4
        if ($health.ok -and
            $health.service -eq 'vcontinuity' -and
            $health.version -eq $expectedVersion -and
            $health.webTools -eq 13 -and
            $health.agentTools -eq 1 -and
            $health.computerUseTools -eq 0 -and
            $health.oauth.enabled) {
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 600
} while ((Get-Date) -lt $deadline)

throw "vContinuity $expectedVersion failed readiness on port $port."
