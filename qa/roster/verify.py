import atexit
import importlib.util
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:3208'
OUT = Path('qa/roster/results')
COOKIES = json.loads(os.environ['QA_COOKIES'])
checks, errors, audits = [], [], []
spec = importlib.util.spec_from_file_location('audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
atexit.register(lambda: OUT.joinpath('behavior.json').write_text(json.dumps({'checks': checks, 'console_errors': errors, 'audits': audits}, indent=2)))

def record(name, detail=True):
    checks.append({'check': name, 'detail': detail})
    print('PASS', name, flush=True)

def load(page, route):
    response = page.goto(BASE + route)
    assert response.status == 200, (route, response.status, page.locator('body').inner_text()[:600])
    page.wait_for_load_state('networkidle')

def inspect(page, name):
    raw = page.evaluate(audit.PROBE)
    scoped = audit.PROBE.replace("const vis = (el) => {", "const vis = (el) => { if (!el.checkVisibility() || el.closest('.ess-sr-only')) return false;")
    scope = ':is(.your-team, .your-team *, [aria-labelledby=reports-to-heading], [aria-labelledby=reports-to-heading] *)'
    scoped = re.sub(r"document.querySelectorAll\('([^']+)'\)", lambda m: "document.querySelectorAll('" + scope + ':is(' + m[1] + ")')", scoped)
    findings = page.evaluate(scoped)
    audits.append({'state': name, 'whole_page': raw, 'changed_controls': findings})
    assert not [f for f in findings if f['severity'] == 'FAIL' and f['where']], findings
    bounds = page.locator('.home-actions, .your-team, [aria-labelledby=reports-to-heading]').evaluate_all("els => els.filter(e => e.checkVisibility()).map(e => ({name:e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:innerWidth}))")
    assert all(b['left'] >= -1 and b['right'] <= b['width'] + 1 for b in bounds), bounds
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
    record(name + ': changed controls audit and geometry', bounds)

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(375,812), (768,1024), (960,900), (1440,900)]:
        context = browser.new_context(viewport={'width':width,'height':height}, has_touch=width < 700, reduced_motion='reduce')
        context.add_cookies([{'name':'champ_access','value':COOKIES['lead'],'url':BASE}])
        page = context.new_page()
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        load(page, '/dashboard')
        expect(page).to_have_title('Home - Champ HR ESS Portal')
        expect(page.locator('.nav-list a[href="/dashboard"]')).to_have_attribute('aria-label','Home')
        expect(page.locator('.nav-list a[href="/dashboard"]')).to_have_attribute('aria-current','page')
        expect(page.locator('.topbar a[href="/team"]')).to_have_count(0)
        expect(page.get_by_role('tab', name='Today', exact=True)).to_be_visible()
        chip = page.locator('.your-team')
        expect(chip).to_have_attribute('aria-label', 'Your team, 6 people')
        expect(chip.locator('.team-face')).to_have_count(4)
        expect(chip.locator('.team-more')).to_have_text('+2')
        if width < 960: expect(chip).to_be_hidden()
        else: expect(chip).to_be_visible()
        inspect(page, f'home-{width}')
        if width != 960: page.screenshot(path=str(OUT/f'home-{width}.png'), full_page=True)
        if width >= 960:
            chip.focus(); expect(chip).to_be_focused(); page.keyboard.press('Enter')
        else:
            page.locator('.nav-list a[href="/team"]').tap() if width < 700 else page.locator('.nav-list a[href="/team"]').focus()
            if width >= 700: page.keyboard.press('Enter')
        page.wait_for_url(BASE+'/team')
        page.wait_for_load_state('networkidle')
        expect(page.locator('.nav-list a[href="/team"]')).to_have_attribute('aria-current','page')
        expect(page.get_by_role('tab')).to_have_count(2)
        expect(page.get_by_role('tab',name='People',exact=True)).to_have_attribute('aria-selected','true')
        page.get_by_role('tab',name='Schedules',exact=True).click()
        assert 'view=weekoff' in page.url
        expect(page.get_by_role('heading',name='Team weekly roster',exact=True)).to_be_visible()
        page.reload(); page.wait_for_load_state('networkidle')
        expect(page.get_by_role('tab',name='Schedules',exact=True)).to_have_attribute('aria-selected','true')
        if width != 960: page.screenshot(path=str(OUT/f'schedules-{width}.png'),full_page=True)
        page.get_by_role('tab',name='People',exact=True).click()
        assert 'view=' not in page.url
        load(page, '/team?view=weekoff')
        expect(page.get_by_role('tab',name='Schedules',exact=True)).to_have_attribute('aria-selected','true')
        load(page, '/profile')
        card = page.locator('[aria-labelledby="reports-to-heading"]')
        expect(card).to_contain_text('Roster QA admin(QA1)')
        expect(card.get_by_role('link',name='See your team')).to_be_visible()
        inspect(page, f'profile-{width}')
        if width != 960:
            page.screenshot(path=str(OUT/f'profile-{width}.png'),full_page=True)
            card.screenshot(path=str(OUT/f'profile-card-{width}.png'))
        card.get_by_role('link',name='See your team').click(); page.wait_for_url(BASE+'/team')
        record(f'{width}: Home/Profile entry points, Team active state, two tabs, warm/cold schedule links and reload')
        if width == 1440:
            load(page, '/hr-contacts')
            expect(page.locator('.ess-page-head a[href="/dashboard"]')).to_contain_text('Home')
            record('HR contacts breadcrumb names Home and keeps the dashboard deep link')
            for route in ['/dashboard','/profile','/team?view=weekoff']:
                load(page, route)
                page.evaluate("document.documentElement.setAttribute('data-ess-theme','dark')")
                page.wait_for_timeout(500)
                inspect(page, 'dark-'+route.split('?')[0].strip('/'))
                page.screenshot(path=str(OUT/f'dark-{route.split("?")[0].strip("/")}.png'),full_page=True)
        context.close()
    for role in ['employee','orphan','empty','admin','manager']:
        context = browser.new_context(viewport={'width':1440,'height':900})
        context.add_cookies([{'name':'champ_access','value':COOKIES[role],'url':BASE}])
        page = context.new_page()
        page.on('pageerror', lambda err: errors.append(str(err)))
        load(page,'/dashboard')
        expect(page.locator('.your-team')).to_have_count(1 if role == 'admin' else 0)
        load(page,'/profile')
        card = page.locator('[aria-labelledby="reports-to-heading"]')
        if role in ['orphan','empty','admin']:
            expect(card).to_contain_text('No manager on file')
            expect(card.locator('a')).to_have_count(0)
        elif role == 'employee':
            expect(card).to_contain_text('Roster QA lead(QA2)')
            expect(card.locator('a')).to_have_count(0)
        else:
            expect(card.get_by_role('link',name='See your team')).to_be_visible()
        if role in ['employee','orphan']:
            expect(page.locator('.nav-list a[href="/team"]')).to_have_count(0)
            page.goto(BASE+'/team?view=weekoff')
            page.wait_for_load_state('networkidle')
            assert page.url == BASE+'/dashboard', page.url
        else:
            load(page,'/team?view=weekoff')
            expect(page.get_by_role('tab',name='Schedules',exact=True)).to_have_attribute('aria-selected','true')
        if role == 'admin':
            load(page,'/admin/people?view=weekoff')
            expect(page.get_by_role('tab',name='Week-off rosters',exact=True)).to_have_attribute('aria-selected','true')
            expect(page.get_by_role('tab',name='Directory',exact=True)).to_be_visible()
            expect(page.get_by_role('tab',name='Schedules',exact=True)).to_have_count(0)
        record(role+': real permission gate, empty team and manager visibility, embedded labels where applicable')
        context.close()
    browser.close()
assert not errors, errors
print(f'{len(checks)} checks passed, zero browser console errors')
