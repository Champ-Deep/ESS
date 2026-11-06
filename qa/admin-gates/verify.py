import atexit
import importlib.util
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:3197'
OUT = Path('qa/admin-gates/results')
COOKIES = json.loads(os.environ['QA_COOKIES'])
checks, errors, audits = [], [], []

def record(name, detail: object=True):
    checks.append({'check': name, 'detail': detail})
    print('PASS', name, flush=True)

atexit.register(lambda: OUT.joinpath('behavior.json').write_text(json.dumps({'checks':checks,'console_errors':errors,'audits':audits}, indent=2)))
spec = importlib.util.spec_from_file_location('visual_audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
assert spec is not None and spec.loader is not None
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

# Discover every exported method in every policy-publishing API caller.
api_routes = []
for file in Path('src/routes/api').rglob('+server.ts'):
    source = file.read_text()
    if "'policies.publish'" not in source:
        continue
    route = '/' + str(file.parent.relative_to('src/routes')).replace('[id]', '00000000-0000-4000-8000-000000000000')
    api_routes.extend((method, route) for method in re.findall(r'export const (GET|POST|PATCH|DELETE|PUT):', source))
assert api_routes
record('discovered all policy API methods', api_routes)

with sync_playwright() as p:
    browser = p.chromium.launch()
    for account in [*COOKIES, 'anonymous']:
        context = browser.new_context(viewport={'width':1440,'height':900})
        if account in COOKIES:
            context.add_cookies([{'name':'champ_access','value':COOKIES[account],'url':BASE}])
        publish = account in ['super_admin','admin_granted']
        tweaks = account == 'super_admin'
        for route, allowed in [('/admin/policies',publish),('/admin/tweaks',tweaks)]:
            response = context.request.get(BASE + route, max_redirects=0)
            assert response.status == (200 if allowed else 303), (account,route,response.status,response.text()[:500])
            if not allowed:
                assert response.headers['location'] in ['/login','/admin','/dashboard']
            data = context.request.get(BASE + route + '/__data.json', max_redirects=0)
            payload = data.json() if data.status == 200 else {}
            if not allowed:
                assert data.status == 303 or payload.get('type') == 'redirect', (account,route,data.status,payload)
            record(f'{account}: page and data route {route}', {'page_status':response.status,'data_status':data.status})
        if not publish:
            for method, route in api_routes:
                response = context.request.fetch(BASE + route,method=method,data='{}',headers={'Content-Type':'application/json','Origin':BASE},max_redirects=0)
                assert response.status == (401 if account == 'anonymous' else 403), (account,method,route,response.status,response.text()[:300])
            record(f'{account}: every policy API denies access', len(api_routes))
        else:
            response = context.request.post(BASE + '/api/admin/policy-documents',multipart={'kind':'holiday_calendar'},headers={'Origin':BASE})
            assert response.status == 400, (account,response.status,response.text()[:200])
            record(f'{account}: upload passes authorization and validates empty input')
        if account != 'anonymous':
            page = context.new_page()
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.on('console',lambda msg:errors.append(msg.text) if msg.type == 'error' else None)
            page.goto(BASE + ('/dashboard' if account == 'employee' else '/admin'))
            page.wait_for_load_state('networkidle')
            expect(page.locator('.admin-tabs a[href="/admin/policies"]')).to_have_count(1 if publish else 0)
            expect(page.locator('.admin-tabs a[href="/admin/tweaks"]')).to_have_count(1 if tweaks else 0)
            if not publish:
                expect(page.locator('a[href^="/admin/policies"]')).to_have_count(0)
            if not tweaks:
                expect(page.locator('a[href^="/admin/tweaks"]')).to_have_count(0)
            if account != 'employee':
                page.keyboard.press('Control+k')
                expect(page.get_by_role('dialog')).to_be_visible()
                expect(page.get_by_role('dialog').get_by_role('button',name=re.compile('^Publish policies'))).to_have_count(1 if publish else 0)
                expect(page.get_by_role('dialog').get_by_role('button',name=re.compile('^Design tweaks'))).to_have_count(1 if tweaks else 0)
                page.keyboard.press('Escape')
            if account in ['admin_granted','employee_granted']:
                page.screenshot(path=str(OUT / f'{account}-1440.png'),full_page=True)
            assert context.request.get(BASE + '/policies').status == 200
            record(f'{account}: navigation and command entries match access, employee policies remain readable')
        context.close()

    for width,height in [(375,812),(768,1024),(1280,720),(1440,900)]:
        context = browser.new_context(viewport={'width':width,'height':height},has_touch=width<700,reduced_motion='reduce')
        context.add_cookies([{'name':'champ_access','value':COOKIES['employee'],'url':BASE}])
        page = context.new_page()
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('console',lambda msg:errors.append(msg.text) if msg.type == 'error' else None)
        page.goto(BASE + '/policies')
        page.wait_for_load_state('networkidle')
        toggle = page.locator('.theme-toggle')
        expect(toggle).to_have_accessible_name('Switch to dark mode')
        expect(toggle).to_have_count(1)
        assert toggle.inner_text() == ''
        expect(toggle.locator('svg')).to_have_count(1)
        expect(toggle).to_have_attribute('data-theme','light')
        moon = toggle.locator('svg').inner_html()
        toggle.focus()
        assert toggle.evaluate('e=>getComputedStyle(e).outlineStyle') != 'none'
        for theme in ['light','dark']:
            if theme == 'dark':
                if width < 700: toggle.tap()
                else: toggle.press('Enter')
                expect(page.get_by_role('button',name='Switch to light mode',exact=True)).to_be_visible()
                assert toggle.locator('svg').inner_html() != moon
            page.wait_for_function('(theme)=>localStorage.getItem("essTheme") === theme || theme === "light"',arg=theme)
            page.wait_for_timeout(350)
            bounds = toggle.bounding_box()
            assert bounds['width'] >= 44 and bounds['height'] >= 44, bounds
            assert 0 <= bounds['x'] and bounds['x']+bounds['width'] <= width
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            geometry = page.locator('.topbar .right > button, .topbar .right > a, .topbar .right > .me').evaluate_all('els=>els.filter(e=>e.checkVisibility()).map(e=>{const r=e.getBoundingClientRect();return {name:e.getAttribute("aria-label")||e.className,left:r.left,right:r.right,top:r.top,bottom:r.bottom}})')
            assert all(a['right'] <= b['left'] for a,b in zip(geometry,geometry[1:])), geometry
            raw = page.evaluate(audit.PROBE)
            scoped = [f for f in page.evaluate(audit.PROBE.replace("document.querySelectorAll('*')", "document.querySelectorAll('.theme-toggle, .theme-toggle *')")) if 'theme-toggle' in f.get('where','')]
            audits.append({'width':width,'theme':theme,'findings':raw,'theme_control':scoped})
            assert not [f for f in scoped if f['severity']=='FAIL'], scoped
            if width != 1280:
                page.screenshot(path=str(OUT / f'theme-{width}-{theme}.png'),full_page=True)
            colors = toggle.evaluate('e=>{const c=document.createElement("canvas").getContext("2d"); const rgb=s=>{c.clearRect(0,0,1,1);c.fillStyle=s;c.fillRect(0,0,1,1);return Array.from(c.getImageData(0,0,1,1).data).slice(0,3)};const s=getComputedStyle(e);return {ink:rgb(s.color),ground:rgb(s.backgroundColor)}}')
            def luminance(rgb):
                channels = [v/255 for v in rgb]
                return sum(weight*(v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4) for weight,v in zip([.2126,.7152,.0722],channels))
            light,dark = sorted([luminance(colors['ink']),luminance(colors['ground'])],reverse=True)
            contrast = (light+.05)/(dark+.05)
            assert contrast >= 3, (colors,contrast)
            record(f'{width} {theme}: single icon, label, geometry, no overflow and scoped audit',{'bounds':bounds,'icon_contrast':contrast})
        page.add_init_script('document.addEventListener("DOMContentLoaded",()=>{window.qaPrepaint=document.documentElement.getAttribute("data-ess-theme")})')
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(page.locator('.theme-toggle')).to_have_attribute('data-theme','dark')
        assert page.evaluate('window.qaPrepaint') == 'dark'
        assert page.evaluate('localStorage.getItem("essTheme")') == 'dark'
        page.get_by_role('button',name='Your account',exact=True).click()
        expect(page.get_by_role('group',name='Appearance',exact=True)).to_have_count(0)
        expect(page.get_by_role('button',name='Light',exact=True)).to_have_count(0)
        expect(page.get_by_role('button',name='Dark',exact=True)).to_have_count(0)
        page.keyboard.press('Escape')
        toggle.press('Space')
        expect(toggle).to_have_attribute('data-theme','light')
        page.reload(); page.wait_for_load_state('networkidle')
        expect(toggle).to_have_attribute('data-theme','light')
        assert page.evaluate('localStorage.getItem("essTheme")') == 'light'
        record(f'{width}: dark prepaint and persistence, light persistence, keyboard, no duplicate account toggle')
        context.close()
    context = browser.new_context(viewport={'width':375,'height':812})
    context.add_cookies([{'name':'champ_access','value':COOKIES['employee'],'url':BASE}])
    context.add_init_script('Storage.prototype.setItem = function(){throw new DOMException("Blocked storage","SecurityError")}')
    page = context.new_page()
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(BASE + '/policies');page.wait_for_load_state('networkidle')
    page.get_by_role('button',name='Switch to dark mode',exact=True).click()
    expect(page.get_by_role('button',name='Switch to light mode',exact=True)).to_be_visible()
    record('blocked storage: theme still switches without exception')
    context.close()
    browser.close()
assert not errors, errors
print(f'{len(checks)} behavior checks passed; zero console errors',flush=True)
