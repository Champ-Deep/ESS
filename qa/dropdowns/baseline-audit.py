"""Audit the untouched c5923eb build with the same synthetic data."""
import importlib.util
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

spec = importlib.util.spec_from_file_location('audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
cookies = json.loads(os.environ['QA_COOKIES'])
results = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(375, 812), (768, 1024), (1280, 720), (1440, 900)]:
        context = browser.new_context(viewport={'width': width, 'height': height}, reduced_motion='reduce')
        context.add_cookies([{'name': 'champ_access', 'value': cookies['super_admin'], 'url': 'http://127.0.0.1:3198'}])
        page = context.new_page()
        for route in ['admin', 'dashboard']:
            assert page.goto('http://127.0.0.1:3198/' + route).status == 200
            page.wait_for_timeout(250)
            assert page.locator('.nav-trigger').count() == 0
            results.append({'state': f'{route}-{width}', 'findings': page.evaluate(audit.PROBE)})
            if route == 'dashboard' and width == 375:
                page.get_by_role('button', name='Your account', exact=True).click()
                results.append({'state': 'display-375', 'findings': page.evaluate(audit.PROBE)})
        context.close()
    browser.close()
Path('qa/dropdowns/results/baseline-audit.json').write_text(json.dumps(results, indent=2))
print(f'Baseline audited in {len(results)} states. Findings are retained, not suppressed.')
