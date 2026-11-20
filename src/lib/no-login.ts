/**
 * People on the roster who have no login — blue-collar staff (drivers,
 * housekeeping, kitchen) who have no work email but do have a reporting
 * manager. They are real employees: on the org chart, in attendance and
 * payroll, under their manager. They just never sign in, so their reporting
 * manager (and HR) keeps their details for them on the Team page.
 *
 * `users.email` is the unique login id, so each is given a placeholder address
 * on the reserved `.invalid` top-level domain (RFC 2606): it can never receive
 * mail or a Clerk sign-in code. That address is the marker everything else
 * checks — no Clerk account, no emails, no password reset. Giving the person a
 * real login later is a matter of replacing it with their actual address.
 */

export const NO_LOGIN_DOMAIN = 'no-login.invalid';

export function isNoLoginEmail(email: string | null | undefined): boolean {
	return Boolean(email) && email!.trim().toLowerCase().endsWith(`@${NO_LOGIN_DOMAIN}`);
}

/**
 * The placeholder address for someone with no work email: their employee code
 * when they have one (unique, and readable on the roster), else their name.
 */
export function noLoginEmail(employeeCode: string | null | undefined, fullName: string): string {
	const local = (employeeCode?.trim() || fullName)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '.')
		.replace(/^\.+|\.+$/g, '');
	return `${local || 'employee'}@${NO_LOGIN_DOMAIN}`;
}
