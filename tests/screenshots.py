"""UI-Screenshots mit simulierten Geräten (tests/mock-bt.js).
Aufruf aus dem Repo-Ordner: python3 tests/screenshots.py [Zielpräfix]
Erzeugt Bilder für iPad quer hell/dunkel, quer mit Warnwerten, hochkant und Handy."""
import os, sys, subprocess, time
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
mock = open(os.path.join(root, 'tests', 'mock-bt.js'), encoding='utf-8').read()
out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/obelix'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', root], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
cases = [('quer-hell', 1024, 768, 'light', 'normal'), ('quer-dunkel', 1024, 768, 'dark', 'normal'),
         ('quer-warnung', 1024, 768, 'light', 'low'), ('hoch-hell', 768, 1024, 'light', 'normal'), ('handy', 412, 915, 'light', 'normal')]
errs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, w, h, theme, scen in cases:
            ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2)
            ctx.add_init_script("localStorage.setItem('mock-scen','%s');localStorage.setItem('victron-theme','%s');" % (scen, theme) + mock)
            pg = ctx.new_page()
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto('http://localhost:8765/index.html')
            pg.wait_for_timeout(2500)
            pg.screenshot(path='%s-%s.png' % (out, name), full_page=(name == 'handy'))
            ctx.close()
        b.close()
finally:
    srv.terminate()
print('Fehler:', errs if errs else 'keine')
