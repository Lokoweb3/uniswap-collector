# Unseals the DPAPI-protected passphrase and hands it to the collector via an
# environment variable scoped to this process only. Nothing is persisted.
#
#   .\run-collector.ps1 -Mode simulate
#   .\run-collector.ps1 -Mode collect
#   .\run-collector.ps1 -Mode full

param(
    [ValidateSet("simulate", "collect", "full")]
    [string]$Mode = "simulate"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$secretsDir   = Join-Path $env:USERPROFILE ".lp-collector"
$keystorePath = Join-Path $secretsDir "operator-keystore.json"
$passPath     = Join-Path $secretsDir "operator-pass.dpapi"

if ($Mode -ne "simulate") {
    if (-not (Test-Path $keystorePath)) {
        Write-Host "No keystore found. Run setup-key.ps1 first." -ForegroundColor Red
        exit 1
    }

    # DPAPI unseal. This only succeeds as the same Windows user on the same machine.
    $secure = Get-Content $passPath | ConvertTo-SecureString
    $plain  = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
                [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

    $env:LP_KEYSTORE_PATH = $keystorePath
    $env:LP_KEYSTORE_PASS = $plain
}

$exitCode = 1
try {
    node (Join-Path $here "collector.js") "--mode=$Mode"
    $exitCode = $LASTEXITCODE
}
finally {
    # Always clear, even if node throws.
    Remove-Item Env:\LP_KEYSTORE_PASS -ErrorAction SilentlyContinue
    Remove-Item Env:\LP_KEYSTORE_PATH -ErrorAction SilentlyContinue
    $plain = $null
    [GC]::Collect()
}

exit $exitCode
