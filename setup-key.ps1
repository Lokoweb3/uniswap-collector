# One-time setup. Creates the operator wallet and protects its passphrase with
# Windows DPAPI, so the encrypted blob on disk is only decryptable by THIS
# Windows user account on THIS machine. Copying it elsewhere yields nothing.
#
# Run once:  powershell -ExecutionPolicy Bypass -File .\setup-key.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$secretsDir = Join-Path $env:USERPROFILE ".lp-collector"
if (-not (Test-Path $secretsDir)) {
    New-Item -ItemType Directory -Path $secretsDir | Out-Null
}

$keystorePath = Join-Path $secretsDir "operator-keystore.json"
$passPath     = Join-Path $secretsDir "operator-pass.dpapi"

if (Test-Path $keystorePath) {
    Write-Host "A keystore already exists at $keystorePath" -ForegroundColor Yellow
    $ans = Read-Host "Overwrite it? Any existing operator wallet will be UNRECOVERABLE. (type YES)"
    if ($ans -ne "YES") { Write-Host "Aborted."; exit 0 }
}

Write-Host ""
Write-Host "Choose a passphrase for the operator keystore." -ForegroundColor Cyan
Write-Host "You do NOT need to memorise it -- it gets stored via DPAPI below."
Write-Host "Make it long and random."
Write-Host ""

$pass1 = Read-Host "Passphrase" -AsSecureString
$pass2 = Read-Host "Confirm"    -AsSecureString

$p1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass1))
$p2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass2))

if ($p1 -ne $p2) { Write-Host "Passphrases do not match." -ForegroundColor Red; exit 1 }
if ($p1.Length -lt 12) { Write-Host "Use at least 12 characters." -ForegroundColor Red; exit 1 }

# Protect the passphrase with DPAPI, scoped to the current user.
$pass1 | ConvertFrom-SecureString | Set-Content -Path $passPath -Encoding ASCII
Write-Host "Passphrase sealed to $passPath (DPAPI, current user only)." -ForegroundColor Green

# Generate the wallet and write an encrypted keystore via node.
$env:LP_SETUP_PASS = $p1
node (Join-Path $here "make-wallet.js") $keystorePath
Remove-Item Env:\LP_SETUP_PASS

# Clear the plaintext copies from memory as best we can.
$p1 = $null; $p2 = $null
[GC]::Collect()

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "NEXT STEPS -- do these before running in collect or full mode:" -ForegroundColor Cyan
Write-Host "  1. Send a small gas float to the operator address printed above (0.01 ETH is plenty)."
Write-Host "  2. From your MAIN wallet, approve the operator on the position manager."
Write-Host "     Narrowest option, per position:  approve(operatorAddress, tokenId)"
Write-Host "     Convenient option, all at once:  setApprovalForAll(operatorAddress, true)"
Write-Host "  3. Set ownerAddress and sweepDestination in config.json to your main wallet."
Write-Host "  4. Run:  .\run-collector.ps1 -Mode simulate"
Write-Host ""
Write-Host "Note: setApprovalForAll also lets the operator call decreaseLiquidity and" -ForegroundColor Yellow
Write-Host "transfer the position NFTs. Per-tokenId approval does too, but only for the" -ForegroundColor Yellow
Write-Host "positions you name. Prefer per-tokenId if you are being careful." -ForegroundColor Yellow
