# Saved themes

Each folder is a complete look for the site:

- `dashboard.css` — Dashboard (`/`) and Analytics (`/analytics`)
- `wallet-style.html` — the `<style>` block inside `wallet.html` (the Wallet page)

## Put one back

    ./themes/apply.sh 2026-09-15-original

Then reload the page (shift-reload to bypass the browser cache). No restart needed;
the server reads the CSS from disk on each request.

## Save the look you have now before changing it

    mkdir -p themes/<name> && cp dashboard.css themes/<name>/dashboard.css
    node -e 'const fs=require("fs"),s=fs.readFileSync("wallet.html","utf8"),a=s.indexOf("<style"),b=s.indexOf("</style>",a)+8;fs.writeFileSync("themes/<name>/wallet-style.html",s.slice(a,b))'

## Important: the Midnight Neon redesign is more than a stylesheet

`apply.sh` swaps stylesheets only. The Midnight Neon redesign (2026-09-15) also restructured
`dashboard.html`, `dashboard.js`, `insights-view.js` and the markup of `wallet.html`, so
putting the old stylesheet back on the new markup will NOT give you the old site. To go back
to the pre-redesign site completely, use git:

    git log --oneline -- dashboard.html          # find the commit before the redesign
    git checkout <that-commit> -- dashboard.html dashboard.css dashboard.js insights-view.js wallet.html

`apply.sh` remains the right tool for swapping a palette between two designs that share the
same markup.

## Saved

- **2026-09-15-original** — the dark teal look the site has had since the glass-theme
  work: near-black `#031116` ground, mint green `#14F46F` for live values, pink `#FF517A`
  for out-of-range edges, muted `#7D9A94` labels. Committed at `27143f6`+; every earlier
  version is also in git history for `dashboard.css` and `wallet.html`.
- **2026-09-15-midnight-neon** — the current look: #080D18 ground, #111A2B cards, cyan
  #29D9FF for what you can act on, violet #8B5CFF as the second chart series, and
  green/amber/coral only for real status. IBM Plex Sans for the interface, JetBrains Mono
  for every figure. Snapshot taken after the redesign; see the note above about markup.
- **2026-10-18-midnight-neon-v2** — Midnight Neon as it stood on 2026-10-18, just before
  the Velvet skin: same palette as above, with the October changes (the Change and Fees
  claimed tiles, compact empty wallets, the pricing footer link). Put it back with
  `./themes/apply.sh 2026-10-18-midnight-neon-v2`; it shares the current markup, so this
  is a clean swap.

- **2026-10-18-velvet** — plum-black ground with a slow aurora, frosted-glass cards, one
  magenta → violet → cyan gradient for the portfolio total, active page, primary button and
  range rails; Space Grotesk headings (add `&family=Space+Grotesk:wght@500;600;700` back to
  the font link in `dashboard.html` and `wallet.html` if you restore it).

The current look, **Phosphor**, is a terminal skin appended to the end of `dashboard.css`:
monospace everywhere, pale phosphor text on near-black, faint scanlines, a blinking prompt
cursor, bracketed labels and a soft glow on the figures that matter; green / amber / red
still only mean a status. Mobile first: 44px touch targets, no sideways scroll, and the chain
picker moved to the bottom-left on phones so it no longer covers the page tabs. Deleting that
final block returns Midnight Neon.
