import { defineConfig } from 'drizzle-kit';

// The database is Cloudflare D1 (SQLite). `npm run db:generate` writes a new
// migration into migrations/; `npm run d1:migrate` (or d1:migrate:local)
// applies it with wrangler.
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './migrations',
	dialect: 'sqlite'
});
