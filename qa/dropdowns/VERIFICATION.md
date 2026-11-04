# Dropdown-collapse verification

Task: t_1e1c989e. Branch: feat/admin-dropdown-collapse. Base: c5923ebb5eeb9c36e836fc70aab3e24b6ae3780c.

## Scope delivered

Spec items 2, 5, 8 and 9 only. Display contains the existing Text size and Dock controls. More on your month contains AttendanceHeatmap and OnboardingPanel, with their original data props and handlers. Admin sections are grouped into People, Time off and System, preserving the single-child and empty-group rules. New contains the original five capability-filtered task links, on the overview only. Recent admin activity is a persistent disclosure. No API, route, capability, auth, database schema or dependency changes.

The approved 21st.dev Svelte-native port exception is used. NavMenu credits Origin UI Dropdown Menu demo 383. React and Radix were not installed.

## Changed source files

- src/lib/admin-tabs.ts
- src/lib/admin-tabs.test.ts
- src/lib/components/NavMenu.svelte
- src/lib/components/TopBar.svelte
- src/lib/styles/disclosure.css
- src/routes/(app)/admin/+layout.svelte
- src/routes/(app)/admin/+page.svelte
- src/routes/(app)/dashboard/+page.svelte

QA scripts and this report live in qa/dropdowns. Generated logs, screenshots and archived baseline are ignored by Git, retained locally.

## Executed checks

| Command | Actual result |
|---|---|
| npm run check | Exit 0. 0 errors, 32 warnings in 9 files |
| npm test | Exit 0. 37 test files passed, 540 tests passed |
| npm run build | Exit 0. Node adapter build completed |
| node qa/dropdowns/run.mjs | Exit 0. 66 behavior checks passed, zero browser console errors |
| node qa/dropdowns/run.mjs --baseline | Exit 0. Original build audited in 9 states |
| git diff --check | Exit 0 |

Node: nvm default v24.13.1. Test URL: http://127.0.0.1:3198, real /admin and /dashboard routes served by the production build. The runner starts and stops this server, so the URL is not a persistent hosted preview.

Synthetic fixture data is in isolated loopback Docker Postgres, MongoDB and Redis services. JWTs are generated in memory for each run. Integrations are excluded from the server environment. No production records or external sends were used. A legacy synthetic QA user remains from an earlier attempt; screenshots correctly show four fixture users, not real employees.

## Browser coverage

375x812, 390x844, 768x1024, 1280x720 and 1440x900. Phone menu opening includes a touch tap. Arrow key wrap, Home, End, Escape focus return, Tab exit, outside dismissal and Ctrl K are exercised. All twelve admin routes are reached through the UI. Current-route state and worst child severity are checked. New preserves all original task URLs; restricted roles retain only permitted items. A chat-only custom role proves the real single-child System behavior and the one-entry New case. Zoom-only grouping is covered by the unit test because system.zoom is not grantable to a custom role in the existing application.

Home and activity are closed by default, and both open and closed choices survive reload. Display controls persist text scale and Dock. All 91 heatmap cells render; selecting a cell changes its detail and survives closing/reopening the disclosure. At 1280x720, the closed Home content has no vertical scroll. Admin navigation has no horizontal scroll. Changed containers stay within viewport bounds.

Dark System menu contrast is audited after the existing theme transition settles. Reduced-motion is enabled for the primary run. No new animation was introduced.

## Machine audit, without a false clean claim

The full visual-verify PROBE ran on the real routes in opened and closed states. Original findings are preserved in results/audit.json. The original build was independently rendered with the same fixture data; all 373 archived src files byte-match c5923eb.

Full-page audit still reports pre-existing failures: small mobile tap targets in the rail, top bar, calendar and moved widget controls, plus the existing search-label contrast at tablet width. Every visible failure signature in this change also occurs in the original build. This is not a whole-app accessibility pass.

The generic probe also counts screen-reader-only text and descendants of closed details as visible. A separate visibility-corrected pass excludes checkVisibility() failures and .ess-sr-only descendants. Raw results remain intact. The new menu triggers, menu entries and disclosure summaries have zero FAIL findings in this corrected, explicitly scoped pass. Font warnings preserve the existing ESS font. Transition-all warnings come from inherited app-wide reduced-motion styling; the new components have no transitions.

No new em dash or en dash occurs in added production lines. Existing page copy and titles contain inherited dashes, not altered by this scoped task.

## Visual review and fixes

Opened final admin, Home, activity and Display screenshots at phone, tablet and desktop widths. New menu screenshots were also opened at 375 and 1440.

The first desktop reveal had a genuinely invisible heatmap: its old size container measured height 0px against scrollHeight 132px. A failing browser assertion caught it. The parent now removes size containment in the disclosure, with final measured height equal to scrollHeight: 300px at 375, 279px at 768, 209px at 1280 and 279px at 1440. Preventing flex shrink in the expanded Home also preserves Champ's disabled note.

The final touch run also exposed the now-visible Dismiss buttons as undersized. Their touch targets are now at least 44px, with no new visible audit failure signatures after rebuilding and rerunning.

An image review claimed the phone New menu's final description was clipped. The DOM disproved this: menu top 153.1875px, bottom 524.1875px, final entry bottom 519.1875px, viewport height 812px, clientHeight and scrollHeight both 369px. No menu content is clipped. Dropdown overlap with underlying status content is intentional and dismissible. Mobile tabs are a wrapping flex row, not a rigid two-column grid, so label starts vary between rows by design. No requested widget was removed.

Early route tests used a 250ms load sleep and intermittently clicked during startup. The final runner waits for network idle before route interactions. A complete final pass succeeds; the earlier failed runs are not reported as passes.

## Evidence paths

All relative to this checkout:

- qa/dropdowns/check.log
- qa/dropdowns/test.log
- qa/dropdowns/build.log
- qa/dropdowns/browser.log
- qa/dropdowns/heatmap-red.log
- qa/dropdowns/results/behavior.json
- qa/dropdowns/results/audit.json
- qa/dropdowns/results/baseline-audit.json
- qa/dropdowns/results/admin-{375,768,1440}-{closed,open}.png
- qa/dropdowns/results/admin-1440-dark-open.png
- qa/dropdowns/results/home-{375,768,1280,1440}-{closed,open}.png
- qa/dropdowns/results/new-{375,1440}-open.png
- qa/dropdowns/results/activity-1440-open.png
- qa/dropdowns/results/display-375-open.png

## Reproduction on this workspace

Use nvm default, run npm run build, then start the existing dedicated services with docker start champhr-dropdowns-pg champhr-dropdowns-mongo champhr-dropdowns-redis. Run node qa/dropdowns/run.mjs. The Python on PATH must have Playwright and Chromium; visual-verify's audit script path is declared in verify.py. The baseline audit additionally requires the archived c5923eb build in qa/dropdowns/baseline. Do not point these fixture scripts at a shared database.

## Limits and handoff

No production deployment, upstream push, PR, merge, Safari/Firefox run, physical-device test or screen-reader run. Native Popover API support is required. Underlying create/upload/approve operations were not submitted; their unchanged links and permission checks were verified.

TopBar.svelte, dashboard/+page.svelte and admin-tabs.ts overlap sibling redesign cards. Integrate deliberately; do not overwrite their theme, roster or label changes.

GitHub reports viewerPermission READ for developer00777/ESS, and Champ-Deep/ESS does not exist. Publication is blocked until upstream write access is granted or an owned fork is explicitly approved. Source and verification are preserved locally for the main reviewer.
