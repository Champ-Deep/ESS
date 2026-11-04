import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { SignJWT } from 'jose';

// Isolated synthetic fixtures only. Never point this runner at a shared database.
const connectionString = 'postgres://postgres@127.0.0.1:55438/champhr_dropdowns';
const mongoUrl = 'mongodb://127.0.0.1:27028/champhr_dropdowns';
const port = 3198;
const baseline = process.argv.includes('--baseline');
const pool = new pg.Pool({ connectionString });
const mongo = new MongoClient(mongoUrl);
const secret = randomBytes(32).toString('hex');
const roles = ['super_admin', 'admin', 'chat'];
const cookies = {};
for (const name of roles) {
  const role = name === 'chat' ? 'employee' : name;
  const custom = name === 'chat' ? (await pool.query("INSERT INTO custom_roles(name, capabilities) VALUES ('Dropdown QA Chat', ARRAY['chat.manage_rules']) ON CONFLICT(name) DO UPDATE SET capabilities=EXCLUDED.capabilities RETURNING id")).rows[0].id : null;
  const { rows: [user] } = await pool.query("INSERT INTO users(email, password_hash, role, full_name, must_change_password, custom_role_id) VALUES ($1, 'no-password-local-fixture', $2, $3, false, $4) ON CONFLICT(email) DO UPDATE SET custom_role_id=EXCLUDED.custom_role_id RETURNING id, email, full_name", [`dropdown-${name}@example.invalid`, role, `Dropdown QA ${name}`, custom]);
  await pool.query('INSERT INTO employee_profiles(user_id, date_of_joining) VALUES ($1, CURRENT_DATE) ON CONFLICT(user_id) DO NOTHING', [user.id]);
  cookies[name] = await new SignJWT({ email: user.email, role, fullName: user.full_name, teamId: null, mustChangePassword: false }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(secret));
  if (name === 'super_admin') await mongo.db().collection('activity_log').updateOne({ 'details.qa': 'dropdowns' }, { $set: { actorUserId: user.id, action: 'user.create', targetType: 'user', details: { qa: 'dropdowns', fullName: 'Synthetic dropdown fixture' }, createdAt: new Date() } }, { upsert: true });
}
await pool.end();
await mongo.close();
mkdirSync('qa/dropdowns/results', { recursive: true });
const log = createWriteStream('qa/dropdowns/results/server.log');
// An allowlist prevents worker integrations from sending anything during QA.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), ORIGIN: `http://127.0.0.1:${port}`, DATABASE_URL: connectionString, MONGO_URL: mongoUrl, REDIS_URL: 'redis://127.0.0.1:6388', JWT_SECRET: secret, JWT_REFRESH_SECRET: randomBytes(32).toString('hex') };
const server = spawn(process.execPath, [baseline ? 'qa/dropdowns/baseline/build/index.js' : 'build/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.pipe(log); server.stderr.pipe(log);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${env.ORIGIN}/login`)).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Local app did not start');
  const qa = spawnSync('python3', [baseline ? 'qa/dropdowns/baseline-audit.py' : 'qa/dropdowns/verify.py'], { env: { ...env, QA_COOKIES: JSON.stringify(cookies) }, stdio: 'inherit' });
  process.exitCode = qa.status ?? 1;
} finally {
  server.kill('SIGTERM');
  const force = setTimeout(() => server.kill('SIGKILL'), 2000);
  server.once('exit', () => { clearTimeout(force); log.end(); });
}
