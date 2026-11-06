import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import pg from 'pg';
import { SignJWT } from 'jose';

// Synthetic local fixtures only. Integration credentials are deliberately not inherited.
const database = 'postgres://postgres@127.0.0.1:55440/champhr_gates';
const port = 3197;
const secret = randomBytes(32).toString('hex');
const pool = new pg.Pool({ connectionString: database });
const cookies = {};
for (const name of ['super_admin', 'admin', 'admin_granted', 'employee', 'employee_granted', 'team_lead_granted']) {
  const role = name.replace('_granted', '');
  const delegated = name.endsWith('_granted');
  const custom = delegated ? (await pool.query("INSERT INTO custom_roles(name, capabilities) VALUES ('Legacy restricted QA', ARRAY['policies.publish','system.design_tweaks','chat.manage_rules']) ON CONFLICT(name) DO UPDATE SET capabilities=EXCLUDED.capabilities RETURNING id")).rows[0].id : null;
  const { rows: [user] } = await pool.query("INSERT INTO users(email,password_hash,role,full_name,must_change_password,custom_role_id) VALUES ($1,'no-password-local-fixture',$2,$3,false,$4) ON CONFLICT(email) DO UPDATE SET role=EXCLUDED.role,custom_role_id=EXCLUDED.custom_role_id RETURNING id,email,full_name", [`gates-${name}@example.invalid`, role, `Gates QA ${name}`, custom]);
  await pool.query('INSERT INTO employee_profiles(user_id,date_of_joining) VALUES ($1,CURRENT_DATE) ON CONFLICT(user_id) DO NOTHING', [user.id]);
  cookies[name] = await new SignJWT({ email:user.email,role,fullName:user.full_name,teamId:null,mustChangePassword:false }).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('20m').sign(new TextEncoder().encode(secret));
}
await pool.end();
mkdirSync('qa/admin-gates/results', {recursive:true});
const log = createWriteStream('qa/admin-gates/results/server.log');
const env = {PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),ORIGIN:`http://127.0.0.1:${port}`,DATABASE_URL:database,MONGO_URL:'mongodb://127.0.0.1:27030/champhr_gates',REDIS_URL:'redis://127.0.0.1:6390',JWT_SECRET:secret,JWT_REFRESH_SECRET:randomBytes(32).toString('hex')};
const baseline = process.argv.includes('--baseline');
const server = spawn(process.execPath,[baseline ? 'qa/admin-gates/baseline/build/index.js' : 'build/index.js'],{env,stdio:['ignore','pipe','pipe']});
server.stdout.pipe(log); server.stderr.pipe(log);
try {
  let ready = false;
  for (let i=0;i<100;i++) {
    try { if ((await fetch(`${env.ORIGIN}/login`)).ok) {ready=true;break;} } catch {}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if (!ready) throw new Error('Production build did not start');
  const result = spawnSync('python3',[baseline ? 'qa/admin-gates/baseline-audit.py' : 'qa/admin-gates/verify.py'],{env:{...env,QA_COOKIES:JSON.stringify(cookies)},stdio:'inherit'});
  process.exitCode = result.status ?? 1;
} finally {
  server.kill('SIGTERM');
  const force=setTimeout(()=>server.kill('SIGKILL'),2000);
  server.once('exit',()=>{clearTimeout(force);log.end();});
}
