# ChampHR admin gates and theme icon: verification

## Result
Design tweaks is super_admin-only. Publish policies requires super_admin, or an admin base role with the explicit policies.publish capability. This follows main's 2026-11-06 ruling and preserves the spec's unchanged admin defaults. Employee/team_lead legacy grants are ignored without deleting stored roles. Both capability resolution and shared server guards enforce the limits. Cache reuse now checks the base role to prevent a privileged cached result from crossing a role change.

The topbar contains a single native theme icon button. Moon targets dark, sun targets light. The accessible label and title name the action. Existing setTheme, essTheme and app.html pre-paint behavior are preserved. The target is 44px, including short laptop screens, rather than the spec's 38px, for touch accessibility. Account-menu duplicate controls were removed.

## Changed application files
| File | Change |
|---|---|
| src/lib/capabilities.ts | Restrict legacy publishing grants by base role; make design tweaks non-grantable; describe restrictions |
| src/lib/capabilities.test.ts | Default, legacy-grant, explicit admin and tab-label regressions |
| src/lib/server/capabilities.ts | Independent role checks at shared guard boundary; role-aware cache reuse |
| src/lib/server/capabilities.test.ts | Guard denial, anonymous, admin/super_admin allowance and cached-role downgrade tests |
| src/lib/components/TopBar.svelte | Single labelled icon button, 44px target, explicit token ink, focus ring; no persistence rewrite |
| src/lib/admin-tabs.ts | Publish policies and Design tweaks labels |
| docs/functionality-map.md | Correct role and route descriptions |

QA scripts, design contract and this report live under qa/admin-gates. Logs, baseline checkout and screenshots are ignored by git.

## Executed evidence
| Command | Real result |
|---|---|
| npm test -- src/lib/capabilities.test.ts, before fix | 3 failed, 10 passed. Reproduced unrestricted employee/team_lead grants and admin design tweaks |
| npm run check | Exit 0. 0 errors, 32 existing warnings in 9 files |
| npm test | Exit 0. 548 tests in 37 files, before baseline extraction |
| npm test -- --exclude 'qa/admin-gates/baseline/**' | Exit 0. 548 tests in 37 files on final source. Excludes only the temporary original-source checkout |
| npm run build | Exit 0. adapter-node completed |
| node qa/admin-gates/run.mjs | Exit 0. 41 grouped behavior checks, zero browser console errors |
| node qa/admin-gates/run.mjs --baseline | Exit 0. Original c5923eb audited at 8 matching viewport/theme states |
| git diff --check | Exit 0 |
| Added-lines prohibited dash scan | 0 |

Production build was served at http://127.0.0.1:3197 using isolated synthetic Postgres/Mongo/Redis fixtures and randomly signed local test sessions. Accounts: super_admin, default admin, explicitly granted admin, employee, legacy-granted employee and legacy-granted team_lead, plus anonymous. No production accounts or data were used. Local fixture sessions exercise the actual hook, capability load, page loads, layout and endpoint handlers, not mocked routes.

Both protected pages and their SvelteKit data URLs were checked for all seven session states. Every exported method across the policy-publishing API callers was discovered from source: 12 methods. All five denied account states received 401/403 at all 12. Super_admin and explicitly granted admin reached upload validation (400 missing file) without publishing or sending anything. Default admin stayed denied. Navigation, command-palette and whole-page restricted links were checked, including legacy-delegated non-admins who can still enter other admin sections. Employee-facing /policies remains readable.

Theme tests ran at 375, 768, 1280 and 1440, both themes: one icon, target label, icon change, touch, Enter/Space, visible focus, 44px target, peer-control separation, no horizontal page scroll, both persistence directions, dark pre-paint, no account-menu duplicate and graceful blocked-storage behavior. No source change to app.html. Measured settled icon contrast is 16.83:1 light and 15.29:1 dark.

## Visual review
All eight full screenshots were opened. Final six theme crops were also opened as results/theme-contact.png. Theme controls are distinct, visible, correctly placed between bell and avatar, and their focus rings do not collide with adjacent controls. Vision's initial ground/state descriptions were inaccurate; computed colors and settled contact-sheet review resolve them. Cropping the desktop contact sheet cuts the unrelated search field, not the live page. Legacy mobile policy tabs scroll and their placeholder truncates, unchanged by this patch.

Screenshot paths, relative to this checkout:
- qa/admin-gates/results/theme-{375,768,1440}-{light,dark}.png
- qa/admin-gates/results/admin_granted-1440.png
- qa/admin-gates/results/employee_granted-1440.png
- qa/admin-gates/results/theme-contact.png

The non-admin overview's existing 'Publish the leave policy' summary is plain span text, not an action or link. SummaryStrip.svelte was inspected; no unauthorized entry point exists there. No unrelated summary-widget change was made.

Full-page accessibility is not clean. Existing small tap targets, an iOS-zoom input, light-theme search/avatar and policy-link contrast findings remain. The original c5923eb production build was audited on the same fixture and viewport/theme matrix: zero new normalized FAIL signatures in all eight states. New theme-control findings are empty. Inter is inherited and unchanged, not a font migration. Raw findings and comparison are in results/behavior.json, baseline-audit.json and audit-comparison.json.

## Registry provenance
Live 21st.dev source was retrieved for campsite Theme Toggle id 554 and ayushmxxn Theme Toggle id 1216. The former is a three-radio React/next-themes settings panel. The latter supplies the binary sun/moon interaction adapted to a native single Svelte button and existing persistence. Kokonut search did not produce a matching independent single-icon candidate. The shadcn CLI was actually attempted under nvm default v24.13.1 with the environment key kept secret. It stops at a React-library choice (Base UI, React Aria, Radix); exit 0 did not install anything. This uses the same app's approved Svelte-native exception recorded on t_1e1c989e, not a claim of successful React installation. No dependency or framework change.

## Review and integration limits
Work stays on ui/admin-gates-theme-t_abd5b451, based on c5923eb, for narrow sibling integration. Main has advanced to 1bb8dc6. TopBar.svelte and admin-tabs.ts overlap dropdown PR 4 and the roster branch. Preserve their independent changes during root integration in t_20d254f2.

No auth-provider configuration, database migration, employee-role defaults, policy-page internals, or design-tweaks internals changed. Legacy JWT base-role staleness remains the existing authentication contract; this patch does not redesign token revocation. No real policy upload, AI extraction, publish, delete or outbound mutation was submitted. Safari, Firefox, screen reader and physical-device checks were not performed. No public preview deployment was made for an authenticated fixture server. Test server and all three gates fixture containers were stopped and read back as stopped; port 3197 is free. Nothing merged.
