"""Offline Chrome layout checks. Actual markup/CSS, synthetic data, no application APIs.
Run: python3 test/mobile-layout.py. Requires Windows Chrome from WSL.
Screenshots and results are written to a temporary directory.
"""
from pathlib import Path
import html, json, os, re, subprocess, tempfile, sys
root = Path(__file__).resolve().parent.parent
chrome = os.environ.get('CHROME', '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe')
distro = os.environ.get('WSL_DISTRO_NAME', 'Ubuntu')
out = Path(tempfile.mkdtemp(prefix='lp-mobile-layout-'))
unc = lambda p: '\\\\wsl.localhost\\' + distro + str(p).replace('/', '\\')
css = (root / 'dashboard.css').read_text()
common = [chrome, '--headless=new', '--disable-gpu', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-extensions', '--host-resolver-rules=MAP * ~NOTFOUND', '--user-data-dir=' + unc(out / 'profile'), '--virtual-time-budget=1000']
print('Artifacts:', out, flush=True)
pages = sys.argv[1:] or ['dashboard', 'analytics', 'arm', 'vault', 'sell', 'mint']
for page in pages:
    wallet = page not in ['dashboard', 'analytics']
    markup = (root / ('wallet.html' if wallet else 'dashboard.html')).read_text()
    markup = re.sub(r'<script\b[^>]*>[\s\S]*?</script>', '', markup)
    markup = re.sub(r'<link\b[^>]*>', '', markup)
    markup = markup.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'"></head>')
    markup = markup.replace('<head>', '<head><style>' + css + '</style>')
    markup = markup.replace('<body>', '<body class="page-' + page + '">')
    setup = '''
    document.querySelectorAll('.tab').forEach(s=>s.hidden=s.id!=='sec-PAGE');
    document.querySelectorAll('.tabs a').forEach(a=>a.classList.toggle('here',a.dataset.tab==='PAGE'));
    document.querySelectorAll('.pages a').forEach(a=>a.classList.toggle('here',a.id==='nav-NAV'));
    document.querySelectorAll('section[hidden]:not(.tab)').forEach(e=>e.hidden=false);
    document.querySelectorAll('select').forEach(e=>{if(!e.options.length)e.add(new Option('Main wallet · ETH / USDG','fixture'));});
    const vals=['$24,580.42','$186.70','12.8%','$2,460.15','+8.42%'];
    document.querySelectorAll('.summary .stat > .n').forEach((e,i)=>e.textContent=vals[i%vals.length]);
    const owner=document.getElementById('owner'); if(owner)owner.textContent='0x1234567890123456789012345678901234567890';
    const table=document.getElementById('weektable'); if(table)table.innerHTML='<table class="etable"><tr><th>Metric</th><th>Previous week</th><th>Latest week</th></tr><tr><td>Recorded fee earnings</td><td>$123,456.78</td><td>$234,567.89</td></tr></table>';
    '''.replace('PAGE', page).replace('NAV', 'wallet' if wallet else ('dash' if page == 'dashboard' else 'analytics'))
    markup = markup.replace('</body>', '<script>' + setup + '</script></body>')
    for width in [320, 375, 430, 768, 1280]:
        checks = '''
        const f=document.querySelector('iframe'), d=f.contentDocument, w=f.contentWindow;
        const errors=[];const visible=e=>e.getClientRects().length&&w.getComputedStyle(e).visibility!=='hidden';
        if(w.innerWidth!==WIDTH)errors.push('wrong viewport');
        if(d.documentElement.scrollWidth>WIDTH)errors.push('page overflow');
        // Detect clipped content too: overflow-x:clip on the outer wrapper can mask it.
        for(const e of d.querySelectorAll('a,button,input,select,.stat,.card,.etablewrap')){
          if(!visible(e)||e.closest('table'))continue;
          const r=e.getBoundingClientRect();
          if(r.right>WIDTH+1||r.left< -1)errors.push('clipped '+(e.id||e.className||e.tagName));
        }
        if(WIDTH<=640){
          for(const e of d.querySelectorAll('.pages a,.tabs a,button.reload,.tab button')){
            if(visible(e)&&e.getBoundingClientRect().height<43)errors.push('small target '+(e.id||e.textContent));
          }
          for(const e of d.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select')){
            if(visible(e)&&parseFloat(w.getComputedStyle(e).fontSize)<16)errors.push('small input '+e.id);
          }
        }
        document.body.dataset.errors=JSON.stringify(errors);
        document.body.dataset.checked='true';
        '''.replace('WIDTH', str(width))
        wrapper = '<body style="margin:0"><iframe style="border:0;width:' + str(width) + 'px;height:1000px" srcdoc="' + html.escape(markup, quote=True) + '"></iframe><script>setTimeout(()=>{' + checks + '},500)</script></body>'
        file = out / (page + '-' + str(width) + '.html'); file.write_text(wrapper)
        url = 'file://wsl.localhost/' + distro + str(file)
        result = subprocess.run(common + ['--window-size=1280,1000', '--dump-dom', url], capture_output=True, text=True, timeout=25)
        match = re.search(r'data-errors="([^"]*)"', result.stdout)
        errors = json.loads(html.unescape(match[1])) if match else ['Chrome did not complete checks: ' + result.stderr[-400:]]
        assert result.returncode == 0 and not errors, (page, width, errors)
        print('PASS', page, width, flush=True)
        if width == 375 and page in ['dashboard','sell']:
            shot = subprocess.run(common + ['--window-size=500,1000', '--hide-scrollbars', '--screenshot=' + unc(out / (page + '.png')), url], capture_output=True, timeout=25)
            assert shot.returncode == 0
print('PASS:', len(pages)*5, 'offline page/viewport combinations', flush=True)
