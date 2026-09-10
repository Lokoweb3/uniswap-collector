#!/usr/bin/env bash
# One-time setup. Creates the operator wallet and an scrypt-encrypted keystore.
#
#   ./setup-key.sh

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SECRETS="$HOME/.lp-collector"
KEYSTORE="$SECRETS/operator-keystore.json"

case "$SECRETS" in
  /mnt/[a-z]/*)
    echo "Refusing to store keys under $SECRETS." >&2
    echo "That is a Windows drive mounted into WSL. Unix permissions there are" >&2
    echo "not enforced by default, so chmod 600 would give you no protection." >&2
    echo "Run this as a WSL user whose \$HOME is on the ext4 filesystem." >&2
    exit 1
    ;;
esac

mkdir -p "$SECRETS"
chmod 700 "$SECRETS"

if [ -f "$KEYSTORE" ]; then
  echo "A keystore already exists at $KEYSTORE"
  read -r -p "Overwrite? The existing operator wallet becomes UNRECOVERABLE. (type YES) " ans
  [ "$ans" = "YES" ] || { echo "Aborted."; exit 0; }
fi

echo
echo "Choose a passphrase for the operator keystore."
echo "You will re-enter it when you unlock for a run, so pick something you can type."
echo

read -r -s -p "Passphrase: " P1; echo
read -r -s -p "Confirm:    " P2; echo

[ "$P1" = "$P2" ] || { echo "Passphrases do not match." >&2; exit 1; }
[ "${#P1}" -ge 12 ] || { echo "Use at least 12 characters." >&2; exit 1; }

LP_SETUP_PASS="$P1" node "$HERE/make-wallet.js" "$KEYSTORE"
chmod 600 "$KEYSTORE"
unset P1 P2 LP_SETUP_PASS

cat <<'NEXT'

Setup complete.

This keystore lives on the ext4 side and is used by the WSL scripts only. If you
ever also run the Windows PowerShell setup, it creates a SEPARATE operator
wallet with its own keystore under your Windows profile. The two cannot share
one keystore -- DPAPI sealing is not readable from Linux, and a keystore under
/mnt/ has no meaningful permissions. Pick one side and stay on it, or you will
have two operator addresses and only one of them approved on your positions.

NEXT STEPS before running in collect or full mode:
  1. Send a small gas float to the operator address above. 0.01 ETH is plenty.
  2. From your MAIN wallet, approve the operator on the position manager:
       narrowest, per position:  approve(operatorAddress, tokenId)
       all at once:              setApprovalForAll(operatorAddress, true)
  3. Set wallets.main (and collector.sweepDestination) in settings.json to your main wallet.
  4. ./run-collector.sh simulate

setApprovalForAll also lets the operator call decreaseLiquidity and transfer the
position NFTs. Per-tokenId approval does the same but only for positions you
name. Prefer per-tokenId if you are being careful.
NEXT
