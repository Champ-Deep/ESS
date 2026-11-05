/**
 * Runs the portal AND its databases on Cloudflare Containers. The image
 * (cloudflare/Dockerfile) holds the app plus Postgres, MongoDB and Redis on
 * localhost; cloudflare/ess-box.sh starts them and keeps the data in R2.
 *
 *   browser → this Worker → the one container (app + Postgres + Mongo + Redis)
 *                                   │ http://198.51.100.7/… (intercepted)
 *                                   ▼
 *                     r2Bridge() below → BACKUPS R2 binding
 *
 * There is a single, always-on instance, like the one Railway service:
 *   - the app's background jobs (setInterval) run inside it, so a second copy
 *     would send every email twice;
 *   - live chat keeps its open streams in memory.
 */
import { Container, getContainer } from '@cloudflare/containers';

// The containers library routes intercepted container traffic through this entrypoint.
export { ContainerProxy } from '@cloudflare/containers';

interface Env {
	APP: DurableObjectNamespace<AppContainer>;
	/** Database backups (Postgres + Mongo dumps), written by ess-box.sh through r2Bridge. */
	BACKUPS: R2Bucket;
	/** Which Worker version is live; a change means vars/secrets may have changed. */
	CF_VERSION_METADATA: WorkerVersionMetadata;
	/** Every var and secret, passed through to the container as environment variables. */
	[key: string]: unknown;
}

/** The container sees the visitor's IP in this header; the login rate limit keys on it. */
const CLIENT_IP_HEADER = 'x-portal-client-ip';

/** Durable Object storage key: the Worker version the running container was started with. */
const STARTED_VERSION_KEY = 'startedWithVersion';

/**
 * Plain-HTTP requests from the container to this address never leave
 * Cloudflare: they are handed to r2Bridge. It is a reserved documentation
 * address (TEST-NET-2), so it can never collide with a real host.
 */
const R2_BRIDGE_HOST = '198.51.100.7';
const R2_PREFIX = 'ess/';
const SAFE_KEY = /^[A-Za-z0-9._\-\/]+$/;

/**
 * Key-less R2 access for the container, reachable only from inside it:
 *   GET /_ping        → 200 when the bucket answers
 *   HEAD/GET /<key>   → read  ess/<key>
 *   PUT /<key>        → write ess/<key> (needs Content-Length)
 */
async function r2Bridge(req: Request, env: Env): Promise<Response> {
	const path = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
	if (path === '_ping') {
		await env.BACKUPS.list({ limit: 1 });
		return new Response('ok');
	}
	if (!path || !SAFE_KEY.test(path) || path.split('/').includes('..')) {
		return new Response('bad key', { status: 400 });
	}
	const key = R2_PREFIX + path;

	if (req.method === 'HEAD') {
		const head = await env.BACKUPS.head(key);
		return new Response(null, { status: head ? 200 : 404 });
	}
	if (req.method === 'GET') {
		const obj = await env.BACKUPS.get(key);
		if (!obj) return new Response('not found', { status: 404 });
		return new Response(obj.body, { headers: { 'content-length': String(obj.size) } });
	}
	if (req.method === 'PUT') {
		const length = Number(req.headers.get('content-length'));
		if (!req.body || !Number.isFinite(length) || length <= 0) {
			return new Response('content-length required', { status: 411 });
		}
		// Stream straight into R2 without buffering the dump in memory.
		const { readable, writable } = new FixedLengthStream(length);
		const [, put] = await Promise.all([req.body.pipeTo(writable), env.BACKUPS.put(key, readable)]);
		return new Response(put?.etag ?? 'ok', { status: 201 });
	}
	return new Response('method not allowed', { status: 405 });
}

export class AppContainer extends Container<Env> {
	defaultPort = 3000;
	sleepAfter = '1h';
	enableInternet = true; // Resend, Zoom, Clerk, ProHance, OpenRouter are all outside


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

	override async onStart() {
		console.log('[app] container started');
		await this.ctx.storage.put(STARTED_VERSION_KEY, this.currentVersion());
	}

	private restarting: Promise<void> | null = null;

	private currentVersion(): string {
		return (this.env as Env).CF_VERSION_METADATA?.id ?? 'unknown';
	}

	/**
	 * The container only reads its env vars when it starts, and it never sleeps.
	 * So after a deploy or a dashboard var/secret edit (= a new Worker version),
	 * restart it once so the new settings actually take effect. SIGTERM lets
	 * ess-box.sh take its final R2 backup before the databases go down.
	 */
	private async restartIfStale(): Promise<void> {
		const started = await this.ctx.storage.get<string>(STARTED_VERSION_KEY);
		if (started === this.currentVersion()) return;
		const { status } = await this.getState();
		if (status === 'running' || status === 'healthy') {
			console.log(`[app] worker version changed (${started ?? 'none'} -> ${this.currentVersion()}), restarting container`);
			await this.stop();
			for (let i = 0; i < 120; i++) {
				const s = (await this.getState()).status;
				if (s === 'stopped' || s === 'stopped_with_code') break;
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
		// Record now so a slow start can't trigger a second restart; onStart re-records.
		await this.ctx.storage.put(STARTED_VERSION_KEY, this.currentVersion());
	}

	override async fetch(request: Request): Promise<Response> {
		this.restarting ??= this.restartIfStale().finally(() => (this.restarting = null));
		await this.restarting;
		return super.fetch(request);
	}

	override onStop(params: { exitCode?: number; reason?: string }) {
		console.log(`[app] container stopped (exit ${params.exitCode}, ${params.reason})`);
	}

	override onError(error: unknown) {
		console.error('[app] container error', error);
		throw error;
	}
}

// Route the container's requests to R2_BRIDGE_HOST into r2Bridge.
// This must be an ASSIGNMENT, not a `static outboundByHost = …` class field:
// with target es2022 a class field defines its own property and skips the
// library's static setter, so the handler never gets registered and the
// request falls through to the internet (403 "direct IP access").
AppContainer.outboundByHost = {
	[R2_BRIDGE_HOST]: (req, env) => r2Bridge(req, env as unknown as Env)
};

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
