/**
 * Reading Zoom's API errors. Kept apart from the client (which needs the
 * environment and Redis) so it can be tested on its own.
 */
/** Zoom's "Invalid access token, does not contain scopes:[…]" (code 4711). */
export function isScopeError(text: string): boolean {
	return /"code"\s*:\s*4711\b/.test(text) || /does not contain scopes/i.test(text);
}

/** The scopes Zoom says the token lacks, e.g. ["meeting:write:meeting:admin"]. */
export function missingScopes(message: string): string[] {
	const m = /does not contain scopes?\s*:?\s*\[([^\]]*)\]/i.exec(message);
	return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}
