import cloudflare from '@sveltejs/adapter-cloudflare';
import node from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Cloudflare Workers is the default target (wrangler.jsonc). ADAPTER=node keeps
// the old Node build working for Docker/Railway (see Dockerfile).
const adapter =
	process.env.ADAPTER === 'node'
		? node()
		: cloudflare({
				config: 'cloudflare/adapter.wrangler.jsonc',
				platformProxy: { configPath: 'cloudflare/adapter.wrangler.jsonc' }
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
