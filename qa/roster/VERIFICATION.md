# Roster navigation verification

Task: t_d92e8a16. Base: developer00777/ESS main 1bb8dc6. Branch: feat/roster-home-profile-team.

## Delivered mapping

| Entry | Destination | Visibility |
|---|---|---|
| Rail Home | /dashboard | Existing rail access |
| Home Your team | /team | canTeam, non-empty teamPeek, width at least 960px |
| Profile Reports to | Existing resolved manager display | Everyone viewing their own profile |
| Profile See your team | /team | Manager exists and canTeam is true |
| Rail Team | /team | Existing canTeam rule |
| Team People / Schedules | /team and /team?view=weekoff | Existing server gate |
| Embedded admin directory / week-off rosters | /admin/people | Existing admin permissions, labels unchanged |

No route moved. No redirect was added because the old paths still work directly. The spec explicitly retains the embedded admin surface. Old schedule deep links continue opening Schedules. Home's Today view tab keeps its name. HR contacts' back breadcrumb and the still-present top-bar Home link use the new name consistently. The other top-bar cleanup belongs to sibling work.

## Changed production files

- src/lib/components/SidebarNav.svelte
- src/lib/components/TopBar.svelte
- src/routes/(app)/+layout.svelte
- src/routes/(app)/dashboard/+page.svelte
- src/routes/(app)/profile/+page.svelte
- src/routes/(app)/team/+page.svelte
- src/routes/(app)/hr-contacts/+page.svelte

Existing Avatar is still used by the account menu. Only obsolete team props and team CSS were removed. Data loaders, server access rules, schemas and route paths are unchanged. Manager display is reused verbatim from resolveManagers, including the code. No additional framework or dependency was installed, per the explicit Svelte-reuse ruling on this card.

## Executed checks

| Command | Actual output |
|---|---|
| npm run check | Exit 0. svelte-check found 0 errors and 32 warnings in 9 files |
| npm test | Exit 0. 38 test files passed, 554 tests passed |
| npm run build | Exit 0. Built in 11.11s, adapter-node done |
| node qa/roster/run.mjs | Exit 0. 21 checks passed, zero browser console errors |
| git diff --check | Exit 0 |

Node: nvm default v24.13.1. Test URL: http://127.0.0.1:3208. This was the real production build, not a component harness. The runner starts and stops the app. The URL is not a long-lived preview. No public app deployment was made because the runtime requires backend services and this is a local synthetic-data verification run.

The runner uses only dedicated loopback Docker Postgres, MongoDB and Redis services named champhr-roster-pg, champhr-roster-mongo and champhr-roster-redis. Database and schemas are synthetic. An allowlisted server environment excludes external integrations. Short-lived JWTs are generated in memory. No production credentials, personal records or external sends were used. Services were stopped after verification.

## Coverage

Real authenticated Home, Profile, Team and HR contacts routes. Widths 375, 768, 960 and 1440, with reduced motion. Desktop dark Home, Profile and Team were also rendered and audited. Phone Team navigation was tapped, Home and rail links were activated by keyboard, and Profile links were clicked.

Assertions cover four visible avatars and +N, the accessible total, hidden chip below 960, absent chip for null/empty data, preserved Today tab, Home title, Home and Team active states, cold and warm schedule deep links, refresh, return to People, manager presence, missing manager, denied employee access, employee-role managers, assigned-team leads, empty assigned teams, admin access and unchanged embedded labels. No routes redirect for authorized fixture users because their routes did not move. Unauthorized employees still redirect to Home.

## Visual and machine findings

Opened review-headers.png, review-profile-cards.png, review-schedules.png and review-dark.png. These show the changed header/card regions at phone, tablet and desktop widths, plus the dark-state surfaces. Review found no clipping or collisions in the changed controls. Your team sits beside Apply leave. Intentional avatar overlap and existing roster-table horizontal scrolling are retained. The unchanged lower content of tall full-page screenshots was not independently visually reviewed.

A real audit failure found the new Profile link's inherited 36px button height. It now has a 44px minimum target. A relocated avatar tint measured 4.48:1, below 4.5:1. The Home chip now uses --ess-text for initials, leaving shared Avatar untouched. Final scoped element audit reports zero failures. No hardcoded color was added.

The full-page audit is not clean. It reports small targets and contrast/input-label issues outside the changed controls. Raw findings are retained in results/behavior.json. The scoped probe restricts element queries to the Home chip and Reports to card, excludes invisible nodes, and does not assert page-level heading rules on those component subtrees. It preserves the unmodified whole-page findings separately. WARNs for static glass and transition-all come from the existing ESS card and global reduced-motion CSS; default-font preserves the app's existing Inter font, also mandated by the loaded corporate brand skill. These are not a whole-app accessibility approval.

Added production lines have zero em dashes or en dashes. Existing untouched copy still contains them; this task did not rewrite unrelated pages.

## Known inherited backend failure

Initial real-route QA found GET /team returning 500 for authorized users with teamId null. team/+page.server.ts compares users.team_id to an empty string, and loadAssignableRosters also compares week_off_rosters.team_id to an empty string. Both fail against UUID columns. Server source is byte-identical to origin/main. This is not caused by the navigation move.

Follow-up t_10622f13 is assigned to the main profile. It must preserve roster scope while handling null teams. Final passing fixtures use assigned teams for allowed roles, including an empty assigned team and an employee-role manager. Do not interpret the 21 passing checks as verification that unassigned authorized users work. They do not. No backend patch was made in this frontend card.

## Evidence and reproduction

All paths below are relative to this checkout:

- qa/roster/results/check.log, test.log, build.log, browser.log, server.log
- qa/roster/results/behavior.json
- qa/roster/results/home-{375,768,1440}.png
- qa/roster/results/profile-card-{375,768,1440}.png
- qa/roster/results/schedules-{375,768,1440}.png
- qa/roster/results/dark-{dashboard,profile,team}.png
- qa/roster/results/review-{headers,profile-cards,schedules,dark}.png

Generated results are ignored by Git and retained locally. Committed runner and browser assertions are qa/roster/run.mjs and qa/roster/verify.py. To reproduce on this workstation: use nvm default, docker start champhr-roster-pg champhr-roster-mongo champhr-roster-redis, npm run build, then node qa/roster/run.mjs. Playwright/Chromium and the visual-verify audit script path declared in verify.py must be available. Do not point this runner at a shared database. First-time schema setup requires DATABASE_URL=postgres://postgres@127.0.0.1:55439/champhr_roster npm run db:push against the dedicated fixture only.

## Limits and integration

No Safari, Firefox, physical device, screen reader or external hosted preview. No HR create, approve, import or profile-save mutation was submitted. Existing backend null-team failures remain tracked separately. Dependency install reported 19 existing vulnerabilities; dependencies were not changed.

hotspot: TopBar.svelte and dashboard/+page.svelte overlap the sibling redesign branches. Integrate the roster removal and home-actions block without overwriting Display, theme toggle, widget disclosures or admin navigation. Current main blue-collar/act-as changes were retained by fast-forwarding the clean checkout before implementation. This phase completes into the existing integration child t_20d254f2 rather than opening a duplicate same-card review lane.
