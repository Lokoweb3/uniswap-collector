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

- **2026-10-18-phosphor** — the terminal skin: monospace everywhere, phosphor text on
  near-black, scanlines, a blinking prompt cursor, bracketed labels. Restore it, then remove
  `&family=Sora:wght@500;600;700` from the font link in `dashboard.html` and `wallet.html`.

The current look, **Event Horizon**, is a deep-space skin appended to the end of
`dashboard.css`: a nebula on `<html>`, a scattered starfield drifting behind the page, a
shooting star every ~13 s, the glowing accretion ring of a black hole off the top-right
corner, smoked-glass cards with an iridescent rim, and a holographic portfolio total whose
rim and colour slowly turn through aqua, violet, rose and gold. Sora for headings and big
figures. Status colours keep their meaning. Phones keep the sky but drop the motion and the
blur; reduced motion stops every animation. The chain picker sits at the bottom-left on
phones. Deleting that final block returns Midnight Neon.
- **2026-11-19-event-horizon** — the look in place until 2026-11-19: black-hole sky with a
  drifting starfield, smoked glass cards with an iridescent rim, aqua `#7DF9FF` accent, Sora
  titles. Includes the "All positions at a glance" table rules.
- **2026-11-19-vice-coast** — the current look: an 80s coastal crime-caper poster. Dusk sky
  with a low sun and a neon grid, hot pink `#FF5FB0` for what you can act on, teal `#3FE0D8`
  second series, tall condensed capitals (Bebas Neue) for titles and big figures, a neon script
  (Yellowtail) for the site name, both from the Google Fonts link in the two HTML pages; for titles and big
  figures; a banded sun on the horizon behind a skyline, a moving grid floor, faint
  scanlines, the portfolio total as a green outlined money counter, section titles as slanted
  tags, and "wanted" stars on positions near the edge or out of range. It is a layer
  appended to `dashboard.css` (`html:root`, so the Wallet page follows without its own
  `<style>` block changing; both folders carry the same `wallet-style.html`).
