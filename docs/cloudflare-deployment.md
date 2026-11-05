# Moving the ESS portal to Cloudflare

This guide takes the portal from Railway (Node + Postgres + MongoDB + Redis) to
**Cloudflare Workers**. Follow the steps in order. Nothing changes for employees:
same address (`champ-hr.com`), same logins, same data.

Branch: `feat/cloudflare-migration`

---

## 1. What runs where after the move

| Before (Railway)                         | After (Cloudflare)                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Node server (`adapter-node`, Docker)     | **Worker** (`adapter-cloudflare`), entry `cloudflare/worker.ts`                    |
| Postgres                                 | **Postgres stays** (Cloudflare has no Postgres). The Worker reaches it through **Hyperdrive** |
| MongoDB: activity log                    | Postgres table `activity_log`                                                      |
| MongoDB: uploaded files                  | **R2** bucket `champ-hr-files` (metadata in Postgres `stored_files`, `policy_documents`) |
| Redis: rate limits, refresh tokens, presence, Zoom cache | **Durable Object** `KvStore`                                       |
| Redis pub/sub + in-process chat streams  | **Durable Object** `ChatHub` (holds every open chat tab's live stream)             |
| `setInterval` background jobs            | **Cron Trigger**, once a minute → `/api/internal/cron` → `src/lib/server/cron.ts`  |
| `start.sh` (migrate + seed on boot)      | Run once from your PC: `npm run db:migrate`, `npm run db:seed` (step 5)            |

What changed in the code:

- **Passwords**: the native `@node-rs/argon2` was replaced with a pure-JS argon2
  (`src/lib/server/password-hash.ts`). Existing password hashes verify unchanged.
  This was tested both ways against the old library.
- **Web push**: the `web-push` package was replaced with a Web Crypto version
  (`src/lib/server/webpush.ts`). The VAPID keys already in `app_settings` keep
  working, so browsers do **not** need to re-subscribe.
- **Announcement emails** now go through Resend's batch endpoint (100 per call)
  instead of one every 550 ms.
- **Background work** after a response (chat cards, notifications, Zoom webhook
  follow-ups) is handed to `waitUntil` so it is not cut off.
- The **Node/Docker build still works** (`ADAPTER=node`, used by the Dockerfile).
  Railway can stay up as the fallback until you are happy.

---

## 2. Before you start

1. **A Cloudflare account on the Workers Paid plan** ($5/month).
   This is required: on the free plan a request gets 10 ms of CPU, and one password
   check alone takes about 450 ms. Durable Objects and Hyperdrive are included.
2. **The `champ-hr.com` domain added to that Cloudflare account** (nameservers
   pointed at Cloudflare). If DNS is somewhere else, do that first: Cloudflare
   Dashboard → *Add a domain*, then change the nameservers at your registrar.
3. **A Postgres the Worker can reach from the internet.** Pick one:
   - **Keep the Railway Postgres** (least work, no data move): Railway → Postgres
     service → *Settings → Networking → enable Public Networking*. Copy the
     public `DATABASE_URL` (host like `xxx.proxy.rlwy.net:PORT`).
   - **Move to Neon / Supabase** (if Railway goes away entirely): create the
     database, then `pg_dump` from Railway → `pg_restore` into it. Choose the
     **Mumbai / ap-south-1** region, close to the users.
4. On your PC, in the repo: `git checkout feat/cloudflare-migration` then `npm install`.
5. Log in to Cloudflare from the terminal: `npx wrangler login`

---

## 3. Create the Cloudflare resources (one time)

```bash
# R2 bucket for uploaded files
npx wrangler r2 bucket create champ-hr-files

# Hyperdrive in front of Postgres. Caching MUST be off: the portal reads
# right after it writes (apply leave → see it in the list).
npx wrangler hyperdrive create champ-hr-db \
  --connection-string="postgres://USER:PASSWORD@HOST:PORT/DBNAME" \
  --caching-disabled
```

The second command prints an `id`. Open `wrangler.jsonc` and replace
`REPLACE_WITH_HYPERDRIVE_ID` with it.

Then check the `vars` block in `wrangler.jsonc` (`ORIGIN`, `PORTAL_URL`,
`AUTH_PROVIDER`, ...). These should match what Railway has today.

---

## 4. Secrets

Each one is entered with `npx wrangler secret put NAME`, which asks for the value.
Copy the values from Railway → service → *Variables*.

**Required**

```
JWT_SECRET
JWT_REFRESH_SECRET
SUPER_ADMIN_EMAIL
```

**Use the ones you use today** (leave out any that are empty on Railway)

```
RESEND_API_KEY            RESEND_WEBHOOK_SECRET     RESEND_FROM
CLERK_SECRET_KEY          PUBLIC_CLERK_PUBLISHABLE_KEY   CLERK_WEBHOOK_SIGNING_SECRET
CLERK_AUTHORIZED_PARTIES
ZOOM_ACCOUNT_ID  ZOOM_CLIENT_ID  ZOOM_CLIENT_SECRET  ZOOM_WEBHOOK_SECRET  ZOOM_DEFAULT_HOST
OPENROUTER_API_KEY        OPENROUTER_MODEL
EASYTIME_IMPORT_TOKEN
PROHANCE_BASE_URL  PROHANCE_WS_USER  PROHANCE_WS_PASSWORD  Prohance_API_KEY
DEVELOPER_EMAIL  DEVELOPER_PASSWORD  DEVELOPER_FULL_NAME
VAPID_PUBLIC_KEY  VAPID_PRIVATE_KEY      (only if they were set as variables on Railway)
```

**No longer needed**: `DATABASE_URL`, `MONGO_URL`, `REDIS_URL`. Postgres comes
through Hyperdrive, and Mongo and Redis are gone.

> PowerShell shortcut for many at once: write them to a JSON file (never commit
> it), run `npx wrangler secret bulk secrets.json`, then delete the file.

---

## 5. Prepare the database

Run these from your PC, with `DATABASE_URL` set to the **direct** Postgres URL
(not Hyperdrive):

```powershell
$env:DATABASE_URL = "postgres://USER:PASSWORD@HOST:PORT/DBNAME"
npm run db:migrate          # adds activity_log, stored_files, policy_documents (migration 0035)
```

Only for a **brand-new, empty** database (skip this when keeping Railway's):

```powershell
$env:SUPER_ADMIN_EMAIL = "..."; $env:SUPER_ADMIN_PASSWORD = "..."; $env:SUPER_ADMIN_FULL_NAME = "..."
npm run db:seed
```

---

## 6. Copy the MongoDB data into Postgres

This moves the activity log, policy documents, profile pictures, announcement
attachments and chat files. Ids are kept, so every existing link still works.
The script is safe to run again: rows it already copied are skipped.

```powershell
$env:MONGO_URL    = "<Railway Mongo public URL>"
$env:DATABASE_URL = "<direct Postgres URL>"
npm run migrate:mongo -- --dry-run   # counts only
npm run migrate:mongo                # copies
```

The file bytes go into Postgres first. Once the Worker is live, the minute cron
moves them into R2, 25 a minute, and any file someone opens before then is moved
right away. Nothing needs doing by hand. When this finishes, the following
returns `0`:

```sql
select count(*) from stored_files where data is not null;
```

> Run the copy **again just before the DNS switch** (step 8) to pick up anything
> uploaded on Railway in the meantime.

---

## 7. Deploy and test on the workers.dev address

```bash
npm run cf:deploy
```

This prints a URL like `https://champ-hr-ess.<your-subdomain>.workers.dev`.
Before testing there, temporarily set `ORIGIN`/`PORTAL_URL` in `wrangler.jsonc`
to that URL and deploy again, otherwise form posts are refused. If Clerk is on,
also add the URL to Clerk's allowed origins and to `CLERK_AUTHORIZED_PARTIES`.

Check:

- [ ] Sign in, open Dashboard, Leave, Attendance, Team, Admin, Payroll, Hub
- [ ] Apply for leave, approve it from a second login
- [ ] Chat: send a message, and it appears live in another browser
- [ ] Upload a profile picture, open an old announcement attachment / policy document
- [ ] Payroll export downloads an .xlsx; a biometric / leave-balance upload previews
- [ ] Watch the logs for a few minutes: `npm run cf:tail` shows each cron tick; no `[cron] ... failed`

---

## 8. Switch `champ-hr.com` over

1. Set `ORIGIN` and `PORTAL_URL` back to `https://champ-hr.com` in `wrangler.jsonc`.
2. Add the custom domain: Cloudflare Dashboard → *Workers & Pages* →
   `champ-hr-ess` → *Settings → Domains & Routes → Add → Custom domain* →
   `champ-hr.com`. Cloudflare replaces the DNS record pointing at Railway.
   (Or add `"routes": [{ "pattern": "champ-hr.com", "custom_domain": true }]`
   to `wrangler.jsonc`.)
3. Run step 6 once more, then `npm run cf:deploy`.
4. **Stop the Railway app service**, so its schedulers do not run as well and
   send emails twice. Keep its Postgres if that is your database.

Webhook URLs (Clerk `/api/clerk/webhook`, Zoom `/api/zoom/webhook`, Resend) and
the EasyTime Chrome bridge all use `champ-hr.com`, so they keep working
unchanged.

**What people notice:** everyone is signed out once, because refresh tokens
lived in Redis and were not copied. They sign in again with the same password.

**Rollback:** remove the custom domain from the Worker, point the DNS record
back at Railway, and start the Railway service. Postgres is shared, so no data
is lost. Files uploaded on Cloudflare in the meantime are in R2, not Mongo.

---

## 9. ⚠ ProHance needs attention

ProHance only accepts calls from **whitelisted IP addresses**, and a Worker has
no fixed outgoing IP. The ProHance poll would fail with `401 Invalid credentials`,
so it ships **switched off**: `PROHANCE_POLL_MINUTES` is `"0"` in `wrangler.jsonc`.
Everything else works.

**Plan:** buy a dedicated egress (static) IP from Cloudflare, then:

1. When talking to Cloudflare sales, confirm that the IP applies to **outgoing
   `fetch()` calls from Workers**, not only to Zero Trust / Gateway traffic.
2. Ask the ProHance team to whitelist that IP.
3. Set `PROHANCE_POLL_MINUTES` back to `"30"` in `wrangler.jsonc` and run `npm run cf:deploy`.
4. Watch `npm run cf:tail` for the next `[cron] prohance` run.

Nothing is lost while it is off. Each run re-pulls from the 25th of the previous
month, so the first run after it is switched on fills in the gap. (If the gap
crosses a payroll cycle, run a manual sync from Admin for the older days.)

EasyTime is not affected: its bridge pushes **to** the portal.

---

## 10. Day-to-day after the move

| Task                         | Command                                              |
| ---------------------------- | ---------------------------------------------------- |
| Deploy                       | `npm run cf:deploy`                                  |
| Live logs                    | `npm run cf:tail`                                    |
| New DB migration             | `npm run db:generate`, then `npm run db:migrate` with the direct `DATABASE_URL`, **before** deploying |
| Change a secret              | `npx wrangler secret put NAME`, which takes effect immediately |
| Local dev (fast, Node)       | `npm run dev` (needs local Postgres; chat/KV/files use in-process fallbacks) |
| Local dev (real Workers runtime) | copy `.dev.vars.example` to `.dev.vars`, then `npm run cf:dev` |
| Old Docker build             | `docker compose up` (unchanged)                      |

### Limits worth knowing

- Cron runs once a minute. Jobs that ran every 30 s under Node (chat
  reminders) now fire within a minute. Login emails still respect the cadence HR set.
- One cron invocation should finish in about 30 s. If the logs show a job regularly
  taking longer (`[cron] X took N ms`), split it.
- Request bodies are limited to 100 MB, well above the portal's 10 MB file limit.

### Rough monthly cost (a few hundred employees)

Workers Paid **$5** (includes 10 M requests, Durable Objects and Hyperdrive at this scale)
plus R2 (the first 10 GB is free) plus your Postgres host. About **$5–10** plus the database.
