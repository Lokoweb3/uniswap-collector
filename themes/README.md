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
