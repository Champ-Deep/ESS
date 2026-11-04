import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import * as schema from './schema';

const connectionString =
	process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/champ_hr';

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

const ARGON2_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

// Set these in Railway (or .env locally) before seeding — no default credential or PII
// ships in the repo. Whoever sets SUPER_ADMIN_EMAIL/PASSWORD owns first login; they fill
// in the rest of their own profile (designation, bank details, DOB, etc.) via the app's
// Profile page afterward, same as any other employee would.
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL;
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const SUPER_ADMIN_FULL_NAME = process.env.SUPER_ADMIN_FULL_NAME ?? 'Super Admin';

async function seed() {
	if (!SUPER_ADMIN_EMAIL || !SUPER_ADMIN_PASSWORD) {
		throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set to run the seed script');
	}

	console.log('Seeding Champ HR ESS Portal...');

	const [dept] = await db
		.insert(schema.departments)
		.values({ name: 'HR Team' })
		.returning();

	const [team] = await db
		.insert(schema.teams)
		.values({ name: 'HR Team', departmentId: dept.id })
		.returning();

	const superAdminPasswordHash = await hash(SUPER_ADMIN_PASSWORD, ARGON2_OPTS);
	const [superAdmin] = await db
		.insert(schema.users)
		.values({
			email: SUPER_ADMIN_EMAIL.toLowerCase(),
			passwordHash: superAdminPasswordHash,
			role: 'super_admin',
			fullName: SUPER_ADMIN_FULL_NAME,
			teamId: team.id,
			isActive: true,
			mustChangePassword: false
		})
		.returning();

	await db.update(schema.teams).set({ teamLeadId: superAdmin.id }).where(eq(schema.teams.id, team.id));

	await db.insert(schema.employeeProfiles).values({ userId: superAdmin.id });

	// No leave types or allocations are seeded. The real types come from the
	// leave policy document published via Admin → Publish Policies, and
	// balances accrue from those types automatically (see
	// $lib/server/leave-accrual). Seeding placeholders here once produced
	// fictional Casual/Sick/Earned 12-day balances that shadowed the policy.

	console.log('Seed complete:');
	console.log(`  Super Admin: ${SUPER_ADMIN_EMAIL} / ${SUPER_ADMIN_PASSWORD}`);

	await pool.end();
}

seed().catch((err) => {
	console.error(err);
	process.exit(1);
});
