import cloudflare from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The portal runs on Cloudflare Workers (wrangler.jsonc). `npm run dev` gets
// local D1 and R2 from the same on-disk state `wrangler dev` uses.
const adapter = cloudflare({
	config: 'cloudflare/adapter.wrangler.jsonc',
	platformProxy: {
		configPath: 'cloudflare/adapter.wrangler.jsonc',
		persist: { path: '.wrangler/state/v3' }
	}
});

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter
		})
	]
});
