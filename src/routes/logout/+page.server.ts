import { redirect, type Actions } from '@sveltejs/kit';
import { clearAuthCookies, getRefreshTokenCookie, verifyAndRotateRefreshToken } from '$lib/server/auth';
import { clerk, clerkAuthActive } from '$lib/server/clerk';
import { stopActing } from '$lib/server/act-as';

export const actions: Actions = {
	default: async ({ cookies, locals }) => {
		// An open blue-collar portal closes with the session it rode on, as
		// /api/auth/logout already did; otherwise signing back in reopened it.
		stopActing(cookies);
		if (clerkAuthActive() && locals.auth) {
			// Revoking the session server-side signs this browser out of Clerk; the
			// sign-in page's Clerk script then sees no session.
			const { sessionId } = locals.auth();
			if (sessionId) await clerk().sessions.revokeSession(sessionId).catch(() => {});
			cookies.delete('__session', { path: '/' });
			throw redirect(303, '/login');
		}
		const refreshToken = getRefreshTokenCookie(cookies);
		if (refreshToken) {
			await verifyAndRotateRefreshToken(refreshToken);
		}
		clearAuthCookies(cookies);
		throw redirect(303, '/login');
	}
};
