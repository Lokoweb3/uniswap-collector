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

## Saved

- **2026-09-15-original** — the dark teal look the site has had since the glass-theme
  work: near-black `#031116` ground, mint green `#14F46F` for live values, pink `#FF517A`
  for out-of-range edges, muted `#7D9A94` labels. Committed at `27143f6`+; every earlier
  version is also in git history for `dashboard.css` and `wallet.html`.
