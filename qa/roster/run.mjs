import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import pg from 'pg';
import { SignJWT } from 'jose';

// Dedicated loopback synthetic database. No production credentials or integrations.
const connectionString = 'postgres://postgres@127.0.0.1:55439/champhr_roster';
const port = 3208;
const pool = new pg.Pool({ connectionString });
const secret = randomBytes(32).toString('hex');
const team = (await pool.query("INSERT INTO teams(name) SELECT 'Roster QA' WHERE NOT EXISTS (SELECT 1 FROM teams WHERE name='Roster QA') RETURNING id")).rows[0] ?? (await pool.query("SELECT id FROM teams WHERE name='Roster QA'")).rows[0];
const emptyTeam = (await pool.query("INSERT INTO teams(name) SELECT 'Roster QA Empty' WHERE NOT EXISTS (SELECT 1 FROM teams WHERE name='Roster QA Empty') RETURNING id")).rows[0] ?? (await pool.query("SELECT id FROM teams WHERE name='Roster QA Empty'")).rows[0];
const managerTeam = (await pool.query("INSERT INTO teams(name) SELECT 'Roster QA Manager' WHERE NOT EXISTS (SELECT 1 FROM teams WHERE name='Roster QA Manager') RETURNING id")).rows[0] ?? (await pool.query("SELECT id FROM teams WHERE name='Roster QA Manager'")).rows[0];
const fixtures = [
  ['admin', 'admin', team.id, null],
  ['lead', 'team_lead', team.id, 'admin'],
  ['employee', 'employee', team.id, 'lead'],
  ['orphan', 'employee', null, null],
  ['empty', 'team_lead', emptyTeam.id, null],
  ['manager', 'employee', managerTeam.id, 'admin'],
  ['report', 'employee', null, 'manager'],
  ...Array.from({ length: 4 }, (_, i) => [`member${i}`, 'employee', team.id, 'lead'])
];
const users = {};
const cookies = {};
try {
  for (const [name, role, teamId, manager] of fixtures) {
    const { rows: [user] } = await pool.query("INSERT INTO users(email,password_hash,role,full_name,team_id,reports_to,must_change_password) VALUES ($1,'no-password-local-fixture',$2,$3,$4,$5,false) ON CONFLICT(email) DO UPDATE SET role=EXCLUDED.role,team_id=EXCLUDED.team_id,reports_to=EXCLUDED.reports_to RETURNING id,email,full_name", [`roster-${name}@example.invalid`, role, `Roster QA ${name}`, teamId, manager ? users[manager].id : null]);
    users[name] = user;
    await pool.query('INSERT INTO employee_profiles(user_id,employee_code,date_of_joining) VALUES ($1,$2,CURRENT_DATE) ON CONFLICT(user_id) DO NOTHING', [user.id, `QA${Object.keys(users).length}`]);
    cookies[name] = await new SignJWT({ email: user.email, role, fullName: user.full_name, teamId, mustChangePassword: false }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('20m').sign(new TextEncoder().encode(secret));
  }
} finally { await pool.end(); }
mkdirSync('qa/roster/results', { recursive: true });
const log = createWriteStream('qa/roster/results/server.log');
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), ORIGIN: `http://127.0.0.1:${port}`, DATABASE_URL: connectionString, MONGO_URL: 'mongodb://127.0.0.1:27029/champhr_roster', REDIS_URL: 'redis://127.0.0.1:6389', JWT_SECRET: secret, JWT_REFRESH_SECRET: randomBytes(32).toString('hex') };
const server = spawn(process.execPath, ['build/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${env.ORIGIN}/login`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Production build did not start');
  const qa = spawnSync('python3', ['qa/roster/verify.py'], { env: { ...env, QA_COOKIES: JSON.stringify(cookies) }, stdio: 'inherit' });
  process.exitCode = qa.status ?? 1;
} finally {
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 2000);
  server.once('exit', () => { clearTimeout(force); log.end(); });
}
