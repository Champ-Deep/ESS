# Champ HR ESS Portal: Functionality Map

A complete map of what the application does, how access is enforced, and where
each capability lives in the code. Every entry below was read from the source
rather than from design notes, so it reflects what is actually implemented.

**Stack:** SvelteKit 2 / Svelte 5 (runes) · PostgreSQL via Drizzle ORM ·
MongoDB (documents, audit log, images) · Redis (sessions, rate limiting) ·
deployed on Railway.

---

## 1. Roles

Four roles, defined in `src/lib/server/auth.ts` and enforced by
`src/lib/server/rbac.ts`.

| Role | Scope |
|---|---|
| `super_admin` | Everything, including Publish policies and Super Admin-only Design tweaks, record deletion and cleanup. |
| `admin` | Employee management, password resets, employee codes, pink-leave overrides. Publish policies requires an explicit `policies.publish` grant. No Design tweaks or deletion. |
| `team_lead` | Their own team: create employees, reset their passwords, approve their leave. |
| `employee` | Self-service only: own profile, own leave, own attendance. |

**Creation hierarchy** (`canCreateRole`): Super Admin creates anyone; Admin
creates Team Leads and Employees; Team Lead creates Employees only.

Publish policies is restricted to admin and super_admin base roles. Stored named-role
grants for employee and team_lead are ignored, not deleted. Design tweaks is not
grantable and is effective only for super_admin. Shared server guards enforce these
role limits independently of the supplied capability list. UI entries use the same
effective capabilities. Employee-facing `/policies` remains available.

**Acting on another user** (`canActOnUser`): permitted for yourself, any Super
Admin or Admin, or a Team Lead over someone in their own team.

Guards throw 401/403 server-side. Client-side role checks exist only to hide
controls — they are never the enforcement point.

---

## 2. Authentication & session

| Concern | Implementation |
|---|---|
| Password hashing | Argon2 (`@node-rs/argon2`) — one-way, so plaintext passwords are never recoverable |
| Tokens | JWT via `jose`: short-lived access token + rotating refresh token |
| Session storage | Refresh tokens in Redis, revocable server-side |
| Rate limiting | `isLoginRateLimited` in Redis, keyed per identifier |
| Cookie handling | httpOnly cookies, set/cleared in `auth.ts` |
| Request hook | `src/hooks.server.ts` verifies the access token, silently rotates the refresh token, and populates `event.locals.user` |
| Forced rotation | `mustChangePassword` on the user row redirects to `/change-password` |

Route protection lives on the `(app)` layout — anything inside it requires a
session. `/login` and `/change-password` sit outside it.

---

## 3. Pages

| Route | Who | What it does |
|---|---|---|
| `/login` | public | Sign in |
| `/change-password` | authenticated | Forced rotation on first login |
| `/dashboard` | all | KPI cards, pending approvals, quick actions |
| `/profile` | all | Own profile: view, self-service edit, photo upload |
| `/leave` | all | Balances, history, embedded leave calendar |
| `/leave/apply` | all | Submit a leave application |
| `/attendance` | all | Month calendar, per-day detail, attendance corrections. Read-only: punches come from the biometric terminals and ProHance, never from the portal |
| `/policies` | all | Read published leave policy and holiday calendar |
| `/hr-contacts` | all | Manager and HR contact cards |
| `/team` | lead+ | Roster, create employee, bulk import, password activity, delete |
| `/admin/policies` | super_admin, admin with `policies.publish` | Publish policy documents, archive/delete leave types |
| `/admin/tweaks` | super_admin | Preview and set design-system defaults |
| `/admin/cleanup` | super_admin | Bulk removal of seeded and test data |

---

## 4. API endpoints

Guards below are the actual `requireRole` / `requireUser` calls in each handler.

### Auth
| Endpoint | Method | Guard |
|---|---|---|
| `/api/auth/login` | POST | public (rate-limited) |
| `/api/auth/logout` | POST | public |
| `/api/auth/change-password` | POST | authenticated |

### Self-service
| Endpoint | Method | Guard |
|---|---|---|
| `/api/profile` | GET | authenticated |
| `/api/profile-picture` | POST, DELETE | authenticated (own picture) |
| `/api/profile-picture/[userId]` | GET | authenticated |
| `/api/leave` | GET, POST | authenticated |
| `/api/attendance/checkin` | POST | authenticated |
| `/api/attendance/checkout` | POST | authenticated |

### Management
| Endpoint | Method | Guard |
|---|---|---|
| `/api/users` | GET, POST | super_admin, admin, team_lead |
| `/api/leave/[id]/approve` | POST | team_lead, super_admin |
| `/api/admin/users/[id]/password` | PUT | super_admin, admin, team_lead |
| `/api/admin/users/[id]/employee-code` | PUT | super_admin, admin |
| `/api/admin/users/[id]/pink-leave` | PUT | super_admin, admin |

### Super Admin only
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/admin/users/[id]` | DELETE | Remove an employee (FK-safe) |
| `/api/admin/leave-types/[id]` | DELETE | Hard-delete a leave type |
| `/api/admin/leave-types/[id]/archive` | POST | Deactivate a leave type |
| `/api/admin/holiday-calendars/[id]/archive` | POST | Archive a calendar |
| `/api/admin/cleanup` | POST | Bulk data cleanup |
| `/api/admin/policy-documents` | POST | Upload a policy document |
| `/api/admin/policy-documents/[id]/publish-leave-policy` | POST | Publish extracted leave types |
| `/api/admin/policy-documents/[id]/publish-holiday-calendar` | POST | Publish extracted holidays |
| `/api/admin/bulk-imports/[id]` | GET | Review a staged import |
| `/api/admin/bulk-imports/[id]/rows/[rowId]` | PATCH | Correct a staged row |

### Machine integration
| Endpoint | Method | Auth |
|---|---|---|
| `/api/attendance/easytime-import` | POST | Bearer token from `attendance_import_tokens` — **not** session RBAC |

---

## 5. Feature areas

### 5.1 Employee identity — employee code

`employee_profiles.employee_code` (unique) is the portal's identity key. It ties
together the HR spreadsheets, the portal record, and EasyTime Pro (where it is
the device-side `emp_code`). Attendance ingestion joins on it. Surfaced on the
profile identity card and the Team roster.

### 5.2 Profile

- 81 profile columns: personal, contact, family, children, education,
  government IDs, bank, and HR-locked job fields.
- **Self-service allow-list** (`profile/+page.server.ts`): 23 fields an employee
  may edit. Read key-by-key, so a crafted POST cannot write HR-locked fields.
  Only fields present in the submission are written, so a partial form can't
  blank the rest.
- Aadhaar and bank account are masked to the last 4 digits in read view.
- Profile pictures: client-side canvas resize to 256px JPEG, stored in MongoDB,
  editable by every role for their own account.

### 5.3 Manager resolution — `Name(CODE)`

`src/lib/server/managers.ts` + `name-match.ts`.

- Prefers the real FK (`users.reports_to`, `employee_profiles.dotted_line_manager_id`).
- Falls back to matching the HR sheet's free-text name against the live roster,
  because only the bulk import ever writes those FKs.
- Handles spelling drift ("Deepak Gudur" → "Deepak Guduru") and word-order
  differences ("Santhosh Reddy S" → "S Santhosh Reddy").
- **Ambiguity resolves to nothing rather than guessing.** A tie is retried
  against accounts that have an employee code, since only those can be someone
  the HR sheet meant.
- Managers not in the portal (e.g. "Chief") render as a plain name with a
  "not in system" marker.
- The dotted line is hidden when it names the same person as the direct manager.

### 5.4 Leave

- **Policy-driven types.** A Super Admin uploads a policy document; an LLM
  extracts leave types with a stable `code` (EL, SL, MATERNITY, PINK…). Types
  published this way always carry a code — types without one are seed data.
- Accrual, carry-forward caps, encashment, eligibility, documentation
  requirements, and fixed-day event leave are all modelled.
- **Pink leave** (`leave-eligibility.ts`): 1 day per month for female employees
  after confirmation (or joining + 6 months). Monthly quota — it does not
  accumulate. An HR override exists because gender and dates are missing for
  most employees.
- Applications flow pending → approved/rejected/escalated, with a ledger.
- Half days are recorded as `days = 0.5`.

### 5.5 Attendance

- Portal check-in/check-out, plus biometric punches from EasyTime Pro.
- **Calendar cell layout:** date top-left, in-time and out-time on the next row
  (left/right), worked hours centred, status marker bottom-right.
- **Markers are policy-driven** (`src/lib/attendance-markers.ts`): `P` present,
  `H` half day, `A` absent, `HO` holiday, and each leave type's own code
  (`EL`, `SL`, `PI`, `MA`). Publishing a new leave type gives it a marker with
  no code change.
- Reserved letters `P`/`H`/`A` are padded if a policy code would collide;
  longer codes abbreviate to two characters so Maternity and Paternity stay
  distinct.
- Precedence: approved leave outranks a check-in; pending leave does not; a
  holiday only marks a day when nothing else happened.
- Responsive: the middle line drops at 760px, times at 700px, the marker
  survives to 360px.

### 5.6 Bulk import (spreadsheet onboarding)

`src/lib/server/bulk-import.ts` — the most defensive part of the system.

- Reads 58 fields from the HR Team Master Tracker, not just the login columns.
  Employees land with ~40 populated profile fields instead of 4.
- **Deterministic first, LLM second.** Every sheet is scanned against known
  header names across header rows 1–3; only if nothing matches does an LLM
  (OpenRouter) infer the mapping. Data cells are redacted before being sent.
  The known tracker resolves deterministically and never reaches the LLM, so
  the key matters only for unfamiliar spreadsheet layouts.
- **Column drift repair.** The tracker's headers do not line up with its data,
  and the drift differs per row. Government IDs, bank details and emergency
  contacts are rebuilt from *value shape* — a 12-digit number is Aadhaar, a
  fixed letter/digit pattern is PAN, `HDFC0004274` is an IFSC.
- Repairs are recorded per row and surfaced in the review screen, never applied
  silently.
- Duplicate headers ("Contact Number" appears twice) resolve to the first
  occurrence, so an employee's own number isn't overwritten by their emergency
  contact's.
- Placeholder cells (`-`, `NA`, `N/A`) become null rather than literal values.
- Duplicate detection by email and by name, with an explicit link/create-new
  decision before anything is written.
- Two-stage: upload → review (`bulk_import_rows`) → apply.

### 5.7 EasyTime Pro integration

- Scheduled 16-column tab-separated file export (per `image001.png`).
- Authenticated by bearer token from `attendance_import_tokens`.
- Joins device records to employees on employee code.
- Punch handling is idempotent: check-in only moves earlier, check-out only
  later, and explicit device status wins.
- Raw punches retained in `device_punches` alongside the derived `attendance` row.

### 5.8 Policy publishing

- Upload a JPEG/PNG/PDF; an LLM extracts either a leave policy or a holiday
  calendar; the Super Admin reviews and publishes. Unlike the spreadsheet
  parser this has no deterministic fallback — it always calls OpenRouter, so
  `OPENROUTER_API_KEY` is required for publishing to work at all.
- Holiday calendars are versioned per shift group and resolved per employee's
  shift assignment.
- Source documents stored in MongoDB, linked by `source_document_id`.

### 5.9 Deletion & cleanup

`src/lib/server/admin-cleanup.ts`. Every FK in the schema is
`ON DELETE NO ACTION`, so deletions clear inbound references first, inside a
transaction.

- **Team page:** delete an employee, two-step inline confirm. Refuses
  self-deletion and refuses to delete the last Super Admin.
- **Policies page:** hard-delete a leave type with its allocations,
  applications and ledger entries.
- **Cleanup page:** opt-in bulk removal (seeded leave types, leave/attendance
  records, other employees, import history) with a live preview and a typed
  `DELETE` confirmation. The signed-in account is always preserved.

### 5.10 Password management

- Employees change their own password.
- Team Leads reset their own and their employees'.
- Admins and Super Admins reset anyone's.
- Passwords are Argon2-hashed and **cannot be displayed**. The Team page shows a
  password *activity log* (who changed whose, and when) from MongoDB — that is
  the audit trail, not the values.

### 5.11 Design system

- Cosmic glassmorphism: `--acc`/`--acc2`/`--glow`/`--ring` tokens, Nebula
  (violet/cyan) and Onyx (steel blue) palettes via `data-ess-theme`.
- Light/dark toggle and a rail/sidebar shell switch in the nav.
- Design Tweaks page (Super Admin) previews card style, corner radius, density,
  glow, stars, depth and sparklines, and sets the defaults.

---

## 6. Data model

### PostgreSQL (17 tables)

**Org:** `shift_groups`, `departments`, `teams`, `users`, `employee_profiles`
**Leave:** `leave_types`, `leave_allocations`, `leave_applications`, `leave_ledger`
**Calendar:** `holiday_calendars`, `holidays`
**Attendance:** `attendance`, `device_punches`, `attendance_imports`, `attendance_import_tokens`
**Import:** `bulk_imports`, `bulk_import_rows`

### MongoDB (3 collections)

| Collection | Contents |
|---|---|
| `activity_log` | Audit trail — password changes, deletions, cleanups, profile edits |
| `policy_documents` | Uploaded policy source files and extraction results |
| `profile_pictures` | Resized profile images |

### Redis

Refresh tokens (revocable) and login rate-limit counters.

### Migrations

`0000` – `0009`. `0007` adds employee codes and EasyTime tables (with a
backfill), `0008` adds pink leave, `0009` adds the master-tracker fields.

---

## 7. Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection |
| `MONGO_URL` | MongoDB connection |
| `REDIS_URL` | Redis connection |
| `JWT_SECRET` | Access-token signing |
| `JWT_REFRESH_SECRET` | Refresh-token signing |
| `SUPER_ADMIN_EMAIL` | Bootstrap Super Admin identity |
| `SUPER_ADMIN_PASSWORD` | Bootstrap Super Admin password |
| `SUPER_ADMIN_FULL_NAME` | Bootstrap Super Admin name |
| `OPENROUTER_API_KEY` | LLM policy extraction and spreadsheet mapping — set in Railway |
| `OPENROUTER_MODEL` | Optional; defaults to `google/gemini-3.5-flash` |

`start.sh` runs `drizzle-kit migrate` on boot, so a deploy applies pending
migrations automatically.

---

## 8. Known gaps

Accurate as of this writing — these are real, not hypothetical.

1. **Sensitive-field role gate not built.** The agreed rule is that Aadhaar, PAN
   and bank details are visible only to the employee and Super Admin. Today
   those fields render only on your own profile, so nothing is over-exposed —
   but the gate must exist before any screen shows one person's profile to
   another.
2. **`reports_to` is resolved at display time, not stored.** Manager names
   resolve on page load, but the FK stays NULL for accounts not created by bulk
   import. Anything keyed on the real link (approval routing, hierarchy queries)
   still sees no manager. A one-off backfill would fix this properly.
3. **ProHance is not connected.** No data source exists. The attendance
   calendar's middle slot shows worked hours (out − in) in its place.
4. **Seed/placeholder accounts may still exist in production.** They collide
   with real employees during name matching. The Data Cleanup page removes them.
5. **No automated test suite.** Verification to date has been manual, against a
   real database and browser.
