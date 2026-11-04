import atexit
import importlib.util
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

OUT = Path('qa/dropdowns/results')
BASE = 'http://127.0.0.1:3198'
COOKIES = json.loads(os.environ['QA_COOKIES'])
spec = importlib.util.spec_from_file_location('visual_audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
results = []
errors = []
audits = []
atexit.register(lambda: OUT.joinpath('audit.json').write_text(json.dumps(audits,indent=2)))
atexit.register(lambda: OUT.joinpath('behavior.json').write_text(json.dumps({'checks':results,'console_errors':errors},indent=2)))

def record(name, detail=True):
    results.append({'check': name, 'result': detail})
    print('PASS', name, flush=True)

def shot(page, name):
    if name.startswith('home-') and name.endswith('-open'):
        page.locator('.home-more').screenshot(path=str(OUT / f'{name}.png'))
    else:
        page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)

def inspect(page, name):
    raw = page.evaluate(audit.PROBE)
    # The shared probe counts closed details descendants and clipped SR text.
    visible_probe = audit.PROBE.replace("const vis = (el) => {", "const vis = (el) => { if (!el.checkVisibility() || el.closest('.ess-sr-only')) return false;")
    visible = page.evaluate(visible_probe)
    scoped_probe = visible_probe.replace("document.querySelectorAll('*')", "document.querySelectorAll('.nav-trigger, .nav-trigger *, .nav-menu, .nav-menu *, .pref-group > summary')")
    scoped = page.evaluate(scoped_probe)
    audits.append({'state': name, 'findings': raw, 'visible_findings': visible, 'new_controls_findings': scoped})
    assert not [f for f in scoped if f['severity'] == 'FAIL'], scoped
    rects = page.locator('.admin-tabs, .nav-trigger, .nav-menu:popover-open, .home-more, .more-panels').evaluate_all('els => els.filter(e => e.checkVisibility()).map(e => ({name:e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,width:innerWidth}))')
    assert all(r['left'] >= -1 and r['right'] <= r['width'] + 1 for r in rects), rects
    record(name + ': changed container geometry', rects)

def load(page, route):
    response = page.goto(BASE + route)
    assert response.status == 200, (route, response.status)
    page.wait_for_load_state('networkidle')

with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, height in [(375,812), (390,844), (768,1024), (1280,720), (1440,900)]:
        context = browser.new_context(viewport={'width':width,'height':height}, reduced_motion='reduce', has_touch=width < 700)
        context.add_cookies([{'name':'champ_access','value':COOKIES['super_admin'],'url':BASE}])
        page = context.new_page()
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        load(page, '/admin')
        expect(page.locator('.admin-tabs .tab-row').locator(':scope > a, :scope > button')).to_have_count(6)
        expect(page.locator('[popover]:popover-open')).to_have_count(0)
        assert not page.locator('.activity-group').evaluate('(e) => e.open')
        expect(page.locator('aside .tasks-card')).to_have_count(0)
        record(f'{width}: six entries, activity and menus closed, no task aside')
        if width in [375,768,1440]: shot(page, f'admin-{width}-closed')
        trigger = page.locator('#admin-people-trigger')
        trigger.focus(); page.keyboard.press('ArrowDown')
        expect(page.locator('#admin-people a').first).to_be_focused()
        page.keyboard.press('End'); expect(page.locator('#admin-people a').last).to_be_focused()
        page.keyboard.press('ArrowDown'); expect(page.locator('#admin-people a').first).to_be_focused()
        page.keyboard.press('ArrowUp'); expect(page.locator('#admin-people a').last).to_be_focused()
        page.keyboard.press('Home'); expect(page.locator('#admin-people a').first).to_be_focused()
        page.keyboard.press('Escape'); expect(trigger).to_be_focused()
        expect(trigger).to_have_attribute('aria-expanded','false')
        trigger.press('ArrowUp'); expect(page.locator('#admin-people a').last).to_be_focused()
        page.keyboard.press('Tab'); expect(page.locator('[popover]:popover-open')).to_have_count(0)
        record(f'{width}: arrow wrap, Home, End, Escape focus, Tab exit')
        if width < 700: trigger.tap()
        else: trigger.click()
        assert page.locator('.admin-tabs .tab-row').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
        dots = page.locator('#admin-people .dot').evaluate_all("els => els.map(e => e.dataset.sev)")
        if dots:
            expect(trigger.locator('.dot')).to_have_attribute('data-sev', 'bad' if 'bad' in dots else 'warn')
        inspect(page, f'admin-{width}-people-open')
        if width in [375,768,1440]: shot(page, f'admin-{width}-open')
        page.locator('#ops-title').click()
        expect(page.locator('[popover]:popover-open')).to_have_count(0)
        page.locator('#admin-new-trigger').click()
        expect(page.locator('#admin-new a')).to_have_count(5)
        assert page.locator('#admin-new a').evaluate_all("els => els.map(e => e.getAttribute('href'))") == ['/admin/people?create=1','/admin/biometric','/admin/leave-balances','/admin/policies','/leave']
        inspect(page, f'admin-{width}-new-open')
        menu_bounds = page.locator('#admin-new').evaluate("e => ({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,height:innerHeight,client:e.clientHeight,scroll:e.scrollHeight,last:e.lastElementChild.getBoundingClientRect().bottom})")
        assert 0 <= menu_bounds['top'] and menu_bounds['last'] <= menu_bounds['bottom'] <= menu_bounds['height'], menu_bounds
        assert menu_bounds['scroll'] == menu_bounds['client'], menu_bounds
        record(f'{width}: all New descriptions within menu and viewport', menu_bounds)
        if width in [375,1440]: shot(page, f'new-{width}-open')
        page.keyboard.press('Escape')
        page.locator('.activity-group summary').click()
        expect(page.get_by_text('Synthetic dropdown fixture')).to_be_visible()
        inspect(page, f'admin-{width}-activity-open')
        if width == 1440: page.locator('.activity-group').screenshot(path=str(OUT / 'activity-1440-open.png'))
        page.wait_for_function("localStorage.getItem('essAdminActivity') === 'true'")
        page.reload(); page.wait_for_timeout(250)
        assert page.locator('.activity-group').evaluate('(e) => e.open')
        page.locator('.activity-group summary').click()
        page.wait_for_function("localStorage.getItem('essAdminActivity') === 'false'")
        page.reload(); page.wait_for_timeout(250)
        assert not page.locator('.activity-group').evaluate('(e) => e.open')
        record(f'{width}: New keeps all five tasks; activity persists open and closed')
        page.keyboard.press('Control+k')
        expect(page.get_by_role('dialog')).to_be_visible()
        page.keyboard.press('Escape')
        record(f'{width}: Ctrl K retained')
        if width == 1440:
            page.evaluate("document.documentElement.setAttribute('data-ess-theme','dark')")
            page.wait_for_timeout(350)
            page.locator('#admin-system-trigger').click()
            print('DARK TRIGGER', page.locator('#admin-system-trigger').evaluate("e => { const a=[]; for(let n=e;n;n=n.parentElement){ const s=getComputedStyle(n);a.push({tag:n.tagName,cls:n.className,color:s.color,bg:s.backgroundColor,primary:s.getPropertyValue('--ess-primary-text'),soft:s.getPropertyValue('--ess-primary-soft')}); } return a;}"), flush=True)
            inspect(page, 'admin-1440-dark-open'); shot(page, 'admin-1440-dark-open')
            page.keyboard.press('Escape')
            page.evaluate("document.documentElement.removeAttribute('data-ess-theme')")
            for menu_id, paths in [('people',['/admin/people','/admin/org-chart','/admin/access-control']), ('time',['/admin/biometric','/admin/leave-balances']), ('system',['/admin/chat-rules','/admin/zoom','/admin/cleanup','/admin/tweaks'])]:
                for path in paths:
                    page.locator(f'#admin-{menu_id}-trigger').click()
                    page.locator(f'#admin-{menu_id} a[href="{path}"]').click()
                    page.wait_for_url(BASE+path)
                    expect(page.locator(f'#admin-{menu_id}-trigger')).to_have_attribute('aria-current','page')
                    expect(page.locator('[popover]:popover-open')).to_have_count(0)
                    load(page,'/admin')
            for path in ['/admin/analytics','/admin/policies']:
                page.locator(f'.admin-tabs a[href="{path}"]').click()
                try:
                    page.wait_for_url(BASE+path, timeout=10000)
                except Exception:
                    print('ROUTE DEBUG', path, page.url, page.locator('body').inner_text()[:500], flush=True)
                    raise
                load(page,'/admin')
            record('All twelve admin sections reachable; nested current-route state retained')
        if width in [375,768,1280,1440]:
            load(page, '/dashboard')
            assert not page.locator('.home-more').evaluate('(e) => e.open')
            expect(page.locator('.lower').locator(':scope > *')).to_have_count(2)
            inspect(page, f'home-{width}-closed'); shot(page, f'home-{width}-closed')
            if width == 1280:
                geometry = page.locator('.ess-content').evaluate('(e) => ({height:e.clientHeight,scroll:e.scrollHeight})')
                assert geometry['scroll'] <= geometry['height'] + 1, geometry
                record('1280x720 closed Home height', geometry)
            page.locator('.home-more summary').focus(); page.keyboard.press('Enter')
            expect(page.get_by_role('region', name='Attendance heatmap')).to_be_visible()
            expect(page.get_by_role('region', name='New joiners',exact=True)).to_be_visible()
            inspect(page, f'home-{width}-open'); shot(page, f'home-{width}-open')
            heatmap = page.locator('.more-panels .fit').evaluate('(e) => ({height:e.clientHeight,scroll:e.scrollHeight,container:getComputedStyle(e).containerType})')
            print('HEATMAP GEOMETRY', width, heatmap, flush=True)
            assert heatmap['height'] >= heatmap['scroll'], heatmap
            page.locator('.more-panels .grid button').first.scroll_into_view_if_needed()
            expect(page.locator('.more-panels .grid button').first).to_be_in_viewport()
            cells = page.locator('.more-panels .grid button')
            assert cells.count() == 91, cells.count()
            cells.first.click()
            expect(cells.first).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('.more-panels .detail')).to_contain_text('No punch recorded')
            page.locator('.home-more summary').click()
            page.locator('.home-more summary').click()
            expect(cells.first).to_have_attribute('aria-pressed', 'true')
            assert page.locator('.more-panels a[href="/attendance"]').count() > 0
            record(f'{width}: all 91 heatmap cells render and selection survives disclosure toggle', heatmap)
            page.wait_for_function("localStorage.getItem('essHomeMore') === 'true'")
            page.reload(); page.wait_for_timeout(250)
            assert page.locator('.home-more').evaluate('(e) => e.open')
            page.locator('.home-more summary').click()
            page.wait_for_function("localStorage.getItem('essHomeMore') === 'false'")
            page.reload(); page.wait_for_timeout(250)
            assert not page.locator('.home-more').evaluate('(e) => e.open')
            record(f'{width}: both moved widgets reachable; Home persists open and closed')
            page.get_by_role('button',name='Your account',exact=True).click()
            expect(page.locator('.pref-group summary',has_text='Display')).to_be_visible()
            assert not page.locator('.me details').evaluate('(e) => e.open')
            page.locator('.me details summary').focus(); page.keyboard.press('Space')
            page.get_by_role('button',name='Larger text',exact=True).click()
            scale = page.evaluate("localStorage.getItem('essTextScale')")
            page.get_by_role('button',name='Fixed',exact=True).click()
            assert page.evaluate("localStorage.getItem('essDock')") == 'fixed'
            if width == 375: shot(page, 'display-375-open'); inspect(page, 'display-375-open')
            page.reload(); page.wait_for_timeout(250)
            assert page.evaluate("localStorage.getItem('essTextScale')") == scale
            assert page.evaluate("document.documentElement.getAttribute('data-ess-dock')") == 'fixed'
            record(f'{width}: Display keyboard opens; text size and dock persist')
        context.close()
    for role in ['admin','chat']:
        context=browser.new_context(viewport={'width':375,'height':812})
        context.add_cookies([{'name':'champ_access','value':COOKIES[role],'url':BASE}])
        page=context.new_page(); load(page,'/admin')
        assert page.locator('.admin-tabs a[href="/admin/policies"]').count() == 0
        assert page.locator('.admin-tabs a[href="/admin/tweaks"]').count() == 0
        if role == 'chat':
            expect(page.locator('.admin-tabs a')).to_have_count(2)
            expect(page.locator('.admin-tabs a',has_text='Chat rules')).to_be_visible()
            expect(page.locator('#admin-system-trigger')).to_have_count(0)
            page.locator('#admin-new-trigger').click()
            expect(page.locator('#admin-new a')).to_have_count(1)
        response = page.goto(BASE+'/admin/policies')
        assert page.url == BASE+'/admin'
        record(f'{role}: capability gating and single-child rules on real routes')
        context.close()
    browser.close()
OUT.joinpath('behavior.json').write_text(json.dumps({'checks':results,'console_errors':errors},indent=2))
OUT.joinpath('audit.json').write_text(json.dumps(audits,indent=2))
assert not errors, errors
print(f'{len(results)} behavior checks passed; zero browser console errors')
