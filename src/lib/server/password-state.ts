/**
 * `users.password_hash` of a login whose owner has not chosen a password yet.
 *
 * While Clerk is the sign-in, a new login (bulk import, People form, Champ) is
 * not given a made-up password. The person opens the portal, enters their work
 * email, types the code Clerk emails them, and is then asked to choose their
 * own password (/change-password, which mirrors it into Clerk).
 *
 * Not an Argon2 hash, so no password ever matches it. Kept free of imports so
 * the boot scripts in ./db can use it too.
 */
export const NO_PASSWORD_YET = '!no-password-yet';

/**
 * `users.password_hash` of someone who has no login at all (src/lib/no-login.ts):
 * blue-collar staff kept on the roster by their manager. Like NO_PASSWORD_YET
 * it is not an Argon2 hash, so no password ever matches it.
 */
export const NO_LOGIN = '!no-login';

export function hasPassword(passwordHash: string | null | undefined): boolean {
	return Boolean(passwordHash) && passwordHash !== NO_PASSWORD_YET && passwordHash !== NO_LOGIN;
}
