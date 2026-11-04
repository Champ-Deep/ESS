// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { SessionUser } from '$lib/server/auth';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: SessionUser | null;
			/**
			 * Who is really signed in, while they have a blue-collar worker's
			 * portal open (src/lib/server/act-as.ts); `user` is then the worker.
			 */
			actingFor?: { id: string; fullName: string } | null;
			/** Set by Clerk's handler, only while AUTH_PROVIDER=clerk (src/hooks.server.ts). */
			auth?: (options?: import('@clerk/shared/types').PendingSessionOptions) => import('@clerk/backend').SessionAuthObject;
		}
		// interface PageData {}
		interface PageState {
			/** Champ Hub: the task open in the side sheet (shallow routing). */
			task?: string;
		}
		// interface Platform {}
	}
}

export {};
