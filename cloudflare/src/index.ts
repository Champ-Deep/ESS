/**
 * Runs the portal's existing Docker image (../Dockerfile) on Cloudflare
 * Containers. The app inside is exactly what Railway runs: Node, plus
 * Postgres, MongoDB and Redis reached through DATABASE_URL, MONGO_URL and
 * REDIS_URL.
 *
 *   browser → this Worker → the one "app" container → Postgres / Mongo / Redis
 *
 * There is a single, always-on instance, like the one Railway service:
 *   - the app's background jobs (setInterval) run inside it, so a second copy
 *     would send every email twice;
 *   - live chat keeps its open streams in memory.
 */
import { Container, getContainer } from '@cloudflare/containers';

interface Env {
	APP: DurableObjectNamespace<AppContainer>;
	/** Every var and secret, passed through to the container as environment variables. */
	[key: string]: unknown;
}

/** The container sees the visitor's IP in this header; the login rate limit keys on it. */
const CLIENT_IP_HEADER = 'x-portal-client-ip';

export class AppContainer extends Container<Env> {
	defaultPort = 3000;
	sleepAfter = '1h';
	enableInternet = true; // the databases, Resend, Zoom, Clerk, ProHance are all outside

	constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
		super(ctx, env);
		const vars: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) {
			if (typeof value === 'string') vars[key] = value;
		}
		this.envVars = { ...vars, ADDRESS_HEADER: CLIENT_IP_HEADER, PORT: '3000', HOST: '0.0.0.0' };
	}

	/** Never go to sleep: the background jobs must keep running with nobody on the site. */
	override async onActivityExpired() {
		this.renewActivityTimeout();
	}

	override onStart() {
		console.log('[app] container started');
	}

	override onStop(params: { exitCode?: number; reason?: string }) {
		console.log(`[app] container stopped (exit ${params.exitCode}, ${params.reason})`);
	}

	override onError(error: unknown) {
		console.error('[app] container error', error);
		throw error;
	}
}

function app(env: Env) {
	return getContainer(env.APP, 'main');
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Overwrite whatever the visitor sent, so the header cannot be spoofed.
		const headers = new Headers(request.headers);
		headers.set(CLIENT_IP_HEADER, request.headers.get('cf-connecting-ip') ?? '0.0.0.0');
		return app(env).fetch(new Request(request, { headers }));
	},

	/**
	 * Every 5 minutes: make sure the container is up. After a deploy, a crash
	 * or a Cloudflare host move, this starts it again even if nobody visits,
	 * so the background jobs resume within minutes.
	 */
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		const res = await app(env).fetch(new Request('http://app/login'));
		if (!res.ok) console.error(`[keep-alive] /login returned ${res.status}`);
	}
} satisfies ExportedHandler<Env>;
