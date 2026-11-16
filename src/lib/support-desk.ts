import type { SupportTeamKey } from './capabilities';

/**
 * Who answers a desk thread (Ask HR, Ask IT, Ask Engagement).
 *
 * - The team's members, all of them, so a question reaches whoever is free.
 * - For Ask HR, also the person's concerned HR when one is set.
 * - With nobody found that way (an empty team, and for Ask HR no concerned
 *   HR), the fallback (`fallbackIds`: HR admins for HR, Super Admins
 *   otherwise), so a question is never left unread. Ask HR therefore works
 *   exactly as before until someone is put in the HR team.
 *
 * The person asking is never their own responder.
 */
export function deskResponderIds(
	team: SupportTeamKey,
	owner: { id: string; hrUserId?: string | null },
	teamMemberIds: readonly string[],
	fallbackIds: readonly string[]
): string[] {
	const out = new Set<string>();
	if (team === 'hr' && owner.hrUserId) out.add(owner.hrUserId);
	for (const id of teamMemberIds) out.add(id);
	out.delete(owner.id);
	if (out.size === 0) for (const id of fallbackIds) if (id !== owner.id) out.add(id);
	return [...out];
}

/** The desk thread's key. Ask HR keeps the key it always had. */
export function deskUniqueKey(team: SupportTeamKey, ownerId: string): string {
	return team === 'hr' ? `desk:${ownerId}` : `desk:${team}:${ownerId}`;
}

/** Older desk threads have no team recorded: they are Ask HR. */
export function deskTeamOf(value: string | null | undefined): SupportTeamKey {
	return value === 'it' || value === 'engagement' ? value : 'hr';
}
