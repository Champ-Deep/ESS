# Moving the ESS portal to Cloudflare

Branch: `feat/cloudflare-migration`

The portal keeps **the same system design it has on Railway**: one API
container plus three databases (Postgres, MongoDB, Redis). The app code is
exactly what is on `main`. Only the place it runs changes.

> An earlier attempt rewrote the app for Cloudflare Workers, replacing Mongo
> with R2 and Redis with Durable Objects. It is kept on the branch
> `feat/cloudflare-workers-native` for reference. It is **not** what this guide
> deploys.

---

## 1. System design

```
                 Railway today                              Cloudflare after the move
  ┌───────────────────────────────────┐        ┌──────────────────────────────────────────┐
  │  champ-hr.com                     │        │  champ-hr.com                             │
  │        │                          │        │        │                                  │
  │        ▼                          │        │        ▼                                  │
  │  API container (Dockerfile)       │        │  Worker (cloudflare/src/index.ts)          │
  │   SvelteKit on Node, port 3000    │        │        │  forwards every request           │
  │   background jobs (setInterval)   │        │        ▼                                  │
  │        │                          │        │  API container: the SAME Dockerfile        │
  │        ├── Postgres               │        │   Cloudflare Containers, 1 instance,     │
  │        ├── MongoDB                │        │   always on                              │
  │        └── Redis                  │        └────────┼─────────────────────────────────┘
  └───────────────────────────────────┘                 │  DATABASE_URL / MONGO_URL / REDIS_URL
                                                        ▼
                                          Postgres · MongoDB · Redis
                                          (managed hosts or Railway, see 2.3)
```

| Railway service | On Cloudflare                                                        |
| --------------- | -------------------------------------------------------------------- |
| API container   | **Cloudflare Containers**, built from the same `Dockerfile`, with a small Worker in front |
| Postgres        | Stays a Postgres server. Cloudflare does not host Postgres.           |
| MongoDB         | Stays a MongoDB server. Cloudflare does not host MongoDB.             |
| Redis           | Stays a Redis server. Cloudflare does not host Redis.                 |

**Why the databases cannot run on Cloudflare:** a Cloudflare container's disk
is wiped every time it restarts, which happens on every deploy. A database
inside one would lose its data. So the three databases live on a host built
for them, and the API container connects to them over the internet, the same
way it does today through `DATABASE_URL`, `MONGO_URL` and `REDIS_URL`.

What lives in `cloudflare/` (its own small package, not part of the app image):

| File | What it does |
| ---- | ------------ |
| `wrangler.jsonc` | Builds `../Dockerfile`, runs **one** `standard-1` instance (½ vCPU, 4 GB), a cron every 5 minutes, and the plain settings (`ORIGIN`, `PORTAL_URL`) |
| `src/index.ts` | Forwards every request to the container. Passes every secret to it as an environment variable. Keeps it awake permanently. Restarts it within 5 minutes if it ever stops. |

Why exactly **one** instance: the background jobs (emails, reminders, Zoom,
ProHance, Clerk sync) run inside the app. Two copies would send every email
twice. This is the same as Railway's single service.

---

## 2. Before you start

### 2.1 Cloudflare account

- **Workers Paid plan** ($5/month). Containers are not available on the free plan.
- The **`champ-hr.com` domain added to the account** (nameservers pointed at
  Cloudflare). If DNS is somewhere else: Cloudflare Dashboard → *Add a domain*,
  then change the nameservers at your registrar.

### 2.2 Your PC

- **Docker Desktop running.** `wrangler deploy` builds the image locally and
  uploads it.
- In the repo:
  ```powershell
  git checkout feat/cloudflare-migration
  cd cloudflare
  npm install
  npx wrangler login
  ```

### 2.3 Where the three databases live

Each one needs a **public, password-protected URL** the container can reach.
Choose **Mumbai / ap-south-1** wherever possible, close to the users.

| Database | Option A: keep on Railway (no data move) | Option B: managed host |
| -------- | ----------------------------------------- | ---------------------- |
| Postgres | Railway → Postgres → *Settings → Networking → Public Networking* | Neon or Supabase |
| MongoDB  | Railway → MongoDB → *Public Networking*  | MongoDB Atlas          |
| Redis    | Railway → Redis → *Public Networking*    | Upstash Redis (`rediss://` URL) or Redis Cloud |

- **Option A** is the least work: nothing moves, and only the API container
  leaves Railway. Railway keeps billing for the three databases.
- **Option B** moves everything off Railway. Copy the data once (section 5).

You can mix: e.g. keep Postgres on Railway and move Mongo to Atlas.

> Use the **public** URLs. The `*.railway.internal` addresses only work inside Railway.

---

## 3. Settings and secrets

Plain settings are in `cloudflare/wrangler.jsonc` → `vars`. Check that
`ORIGIN` and `PORTAL_URL` say `https://champ-hr.com`.

Everything else is a secret. Run each one from the `cloudflare/` folder:
`npx wrangler secret put NAME` asks for the value. Copy the values from
Railway → app service → *Variables*. Every secret is handed to the container
as an environment variable, exactly like Railway's variables.

**Required**

```
DATABASE_URL     MONGO_URL     REDIS_URL           (the public URLs from 2.3)
JWT_SECRET       JWT_REFRESH_SECRET
SUPER_ADMIN_EMAIL   SUPER_ADMIN_PASSWORD   SUPER_ADMIN_FULL_NAME
```

**The ones you use today** (skip any that are empty on Railway)

```
RESEND_API_KEY  RESEND_WEBHOOK_SECRET  RESEND_FROM
AUTH_PROVIDER   PUBLIC_CLERK_PUBLISHABLE_KEY  CLERK_SECRET_KEY
CLERK_WEBHOOK_SIGNING_SECRET  CLERK_AUTHORIZED_PARTIES
ZOOM_ACCOUNT_ID  ZOOM_CLIENT_ID  ZOOM_CLIENT_SECRET  ZOOM_WEBHOOK_SECRET  ZOOM_DEFAULT_HOST
OPENROUTER_API_KEY  OPENROUTER_MODEL
EASYTIME_IMPORT_TOKEN
PROHANCE_BASE_URL  PROHANCE_WS_USER  PROHANCE_WS_PASSWORD  Prohance_API_KEY  PROHANCE_POLL_MINUTES
DEVELOPER_EMAIL  DEVELOPER_PASSWORD  DEVELOPER_FULL_NAME
VAPID_PUBLIC_KEY  VAPID_PRIVATE_KEY
```

> **Many at once:** put them in a JSON file **outside the repo**
> (`{"JWT_SECRET": "...", ...}`), run `npx wrangler secret bulk C:\path\secrets.json`,
> then delete the file.

Leave `PROHANCE_POLL_MINUTES` set to `0` for now (see section 8).

---

## 4. Deploy and test on the workers.dev address

From `cloudflare/`:

```powershell
npm run deploy
```

This builds the Docker image, uploads it, and prints a URL like
`https://champ-hr-ess.<your-subdomain>.workers.dev`. The **first start takes a
minute or two**: `start.sh` runs the migrations and the seed check, just as on Railway.

To test on that URL, **temporarily** set `ORIGIN` and `PORTAL_URL` in
`wrangler.jsonc` to it and deploy again. Otherwise sign-in and form posts are
refused. If Clerk is on, also add the URL to Clerk's allowed origins and to
`CLERK_AUTHORIZED_PARTIES`.

> **Careful:** if the databases are the live ones, this test portal sends real
> emails and runs the real background jobs **alongside Railway**. Either test
> against a copy of the databases, or keep the test short. For a short test, you
> can also leave `RESEND_API_KEY` unset until the switch.

Check:

- [ ] Sign in; open Dashboard, Leave, Attendance, Team, Admin, Payroll, Hub
- [ ] Apply for leave, then approve it from a second login
- [ ] Chat: a message appears live in another browser
- [ ] Profile picture upload; an old announcement attachment / policy document opens (Mongo)
- [ ] Payroll export downloads an .xlsx; a biometric / leave-balance upload previews
- [ ] Logs: `npm run tail` shows the app's normal output and no crash loop

---

## 5. Copying the data (only if the databases move, Option B)

Do this in a quiet hour, **right before** the switch in section 6, with the
Railway app stopped so nothing changes during the copy.

```powershell
# Postgres
pg_dump  --format=custom --no-owner "<Railway Postgres public URL>" -f ess.dump
pg_restore --no-owner --dbname "<new Postgres URL>" ess.dump

# MongoDB
mongodump    --uri "<Railway Mongo public URL>" --archive=ess.mongo.gz --gzip
mongorestore --uri "<Atlas URL>"                --archive=ess.mongo.gz --gzip
```

Redis does not need copying. It only holds sign-in sessions, login rate limits
and short-lived caches. The cost is that everyone signs in once more after the
switch. Delete the dump files afterwards: they contain employee data.

---

## 6. Switch `champ-hr.com` over

1. Put `ORIGIN` and `PORTAL_URL` back to `https://champ-hr.com` in `wrangler.jsonc`.
2. **Stop the Railway app service** (not the databases if you kept them),
   so two copies never run the background jobs at once.
3. Option B only: do the copy in section 5 and update the three URL secrets.
4. `npm run deploy`
5. Attach the domain: Cloudflare Dashboard → *Workers & Pages* → `champ-hr-ess`
   → *Settings → Domains & Routes → Add → Custom domain* → `champ-hr.com`.
   Cloudflare replaces the DNS record that pointed at Railway.

Webhooks (Clerk `/api/clerk/webhook`, Zoom `/api/zoom/webhook`, Resend) and the
EasyTime bridge all use `champ-hr.com`, so they need no change.

**Rollback:** remove the custom domain from the Worker, point DNS back at
Railway, and start the Railway app service. If the databases stayed on Railway
(Option A), nothing else is needed.

---

## 7. Day-to-day

Run these from `cloudflare/`:

| Task                    | How |
| ----------------------- | --- |
| Deploy app changes      | `npm run deploy` (rebuilds the Docker image from the repo) |
| Live logs               | `npm run tail` |
| Change a secret         | `npx wrangler secret put NAME`, then `npm run deploy` so the container restarts with it |
| Restart the app         | `npm run deploy` |
| New DB migration        | Nothing extra: `start.sh` runs it when the container starts, as on Railway |
| Local development       | Unchanged: `docker compose up` in the repo root |
| Run the Cloudflare setup locally | Put test values in `cloudflare/.dev.vars` (gitignored), then `npm run dev` |

**Downtime on deploy:** with a single instance, each deploy restarts the
container. Expect up to a minute of errors while `start.sh` runs, the same as
a Railway redeploy.

**Cost (check Cloudflare's current price list):** Workers Paid $5/month,
plus Containers usage for one always-on `standard-1` instance (billed mainly
for its memory, roughly $20–30/month), plus the database hosts. If the app's
memory use stays well under 1 GB (watch it in the dashboard), `instance_type`
`"basic"` (1 GB) costs much less.

---

## 8. ⚠ ProHance

ProHance only accepts calls from **whitelisted IP addresses**, and Cloudflare
containers have no fixed outgoing IP. Until a static IP is in place, keep
`PROHANCE_POLL_MINUTES=0`. Everything else works.

**Plan:** buy a dedicated egress (static) IP from Cloudflare.

1. Confirm with Cloudflare sales that it covers outgoing traffic from
   **Containers** (not only Zero Trust / Gateway traffic).
2. Ask ProHance to whitelist that IP.
3. `npx wrangler secret put PROHANCE_POLL_MINUTES` → `30`, then `npm run deploy`.

Nothing is lost while it is off. Each sync re-pulls from the 25th of the
previous month, so the first run fills the gap. Use Admin → manual sync for
anything older.

EasyTime is not affected: its bridge pushes **to** the portal.
