import importlib.util
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:3197'
OUT = Path('qa/admin-gates/results')
spec = importlib.util.spec_from_file_location('visual_audit','/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
assert spec is not None and spec.loader is not None
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
findings = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for width,height in [(375,812),(768,1024),(1280,720),(1440,900)]:
        for theme in ['light','dark']:
            context = browser.new_context(viewport={'width':width,'height':height},has_touch=width<700,reduced_motion='reduce')
            context.add_cookies([{'name':'champ_access','value':json.loads(os.environ['QA_COOKIES'])['employee'],'url':BASE}])
            context.add_init_script(f'localStorage.setItem("essTheme", "{theme}")')
            page = context.new_page()
            page.goto(BASE + '/policies');page.wait_for_load_state('networkidle');page.wait_for_timeout(350)
            findings.append({'width':width,'theme':theme,'findings':page.evaluate(audit.PROBE)})
            context.close()
    browser.close()
(OUT / 'baseline-audit.json').write_text(json.dumps(findings,indent=2))
print('Baseline audit complete:',len(findings),'viewport/theme states')
