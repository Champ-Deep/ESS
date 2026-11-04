import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/postgres';
import { announcementReads, announcements, shiftGroups, teams } from '$lib/server/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import {
	dispatchDueEmails,
	inAudience,
	loadAdminList,
	loadMembers,
	sendConfirmationReminder
} from '$lib/server/announcements';
import { insertAnnouncementFile } from '$lib/server/db/mongo';
import { isMailerConfigured } from '$lib/server/mailer';
import { hasCap } from '$lib/server/capabilities';

/**
 * Posting and managing announcements — the composer and "Posted" list shown
 * in Champ Chat's #announcements channel to anyone holding "Post
 * announcements". Every action re-checks that privilege.
 */
export async function loadAnnouncementAdmin() {
	const [members, teamRows, shiftRows, list] = await Promise.all([
		loadMembers(),
		db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(teams.name),
		db.select({ id: shiftGroups.id, name: shiftGroups.name }).from(shiftGroups).orderBy(shiftGroups.name),
		loadAdminList()
	]);

	return {
		now: new Date().toISOString(),
		mailerConfigured: isMailerConfigured(),
		teams: teamRows,
		shiftGroups: shiftRows,
		// Only what the reach counter needs — no names or emails to the page.
		membership: members.map((m) => ({ t: m.teamId, s: m.shiftGroupId })),
		posts: list.map(({ a, reads, acks }) => ({
			id: a.id,
			kind: a.kind,
			title: a.title,
			summary: a.summary,
			body: a.body,
			eventDate: a.eventDate,
			eventTime: a.eventTime,
			audienceAll: a.audienceAll,
			audienceTeamIds: a.audienceTeamIds,
			audienceShiftGroupIds: a.audienceShiftGroupIds,
			requiresAck: a.requiresAck,
			urgentDays: a.urgentDays,
			emailCopy: a.emailCopy,
			emailSentAt: a.emailSentAt?.toISOString() ?? null,
			attachmentName: a.attachmentName,
			status: a.status,
			publishAt: a.publishAt?.toISOString() ?? null,
			editedAt: a.editedAt?.toISOString() ?? null,
			audienceSize: members.filter((m) => inAudience(a, m)).length,
			reads: reads ?? 0,
			acks: acks ?? 0
		}))
	};
};

const MAX_FILE = 5 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const UUID = /^[0-9a-f-]{36}$/i;

function str(form: FormData, key: string): string {
	return String(form.get(key) ?? '').trim();
}

export const announcementActions = {
	saveAnnouncement: async ({ request, locals }: RequestEvent) => {
		if (!hasCap(locals.user, 'announcements.post')) return fail(403, { saveError: 'Only HR can post announcements' });
		const form = await request.formData();
		const id = str(form, 'id');
		const intent = str(form, 'intent'); // 'publish' | 'draft'
		const kind = str(form, 'kind');
		const title = str(form, 'title');
		const summary = str(form, 'summary');
		const body = str(form, 'body');
		const eventDate = str(form, 'eventDate');
		const eventTime = str(form, 'eventTime');
		const when = str(form, 'when'); // 'now' | 'later'
		const publishAtRaw = str(form, 'publishAt');
		const audienceAll = form.get('audienceAll') === 'on';
		const teamIds = form.getAll('teamIds').map(String).filter((v) => UUID.test(v));
		const shiftIds = form.getAll('shiftGroupIds').map(String).filter((v) => UUID.test(v));
		const urgentDays = Number(str(form, 'urgentDays')) || 3;

		const invalid = (message: string) => fail(400, { saveError: message });

		if (kind !== 'urgent' && kind !== 'event' && kind !== 'update') return invalid('Pick what kind of post it is.');
		if (!title) return invalid('Add a headline.');
		if (title.length > 120) return invalid('Keep the headline under 120 characters.');
		if (kind === 'event' && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return invalid('Pick the date of the event.');
		if (eventTime && !/^\d{2}:\d{2}$/.test(eventTime)) return invalid('The time must look like 16:00.');
		if (!summary && !body) return invalid('Add the one line employees see, or the details.');
		if (!audienceAll && teamIds.length === 0 && shiftIds.length === 0) return invalid('Pick who should see it.');
		if (![1, 3, 7].includes(urgentDays)) return invalid('Pick how long it stays urgent.');

		let publishAt: Date | null = null;
		if (intent === 'publish') {
			if (when === 'later') {
				// The picker has no time zone; the company's is IST.
				publishAt = new Date(`${publishAtRaw}:00+05:30`);
				if (Number.isNaN(publishAt.getTime())) return invalid('Pick when it should go out.');
				if (publishAt.getTime() < Date.now() - 60_000) return invalid('That time has passed. Pick a later one, or publish now.');
			} else {
				publishAt = new Date();
			}
		}

		const file = form.get('attachment');
		let attachment: { id: string; name: string } | null = null;
		if (file instanceof File && file.size > 0) {
			if (file.size > MAX_FILE) return invalid('The attachment is over 5 MB. Compress it or attach a smaller file.');
			if (!FILE_TYPES.includes(file.type)) return invalid('Attach a PDF, JPEG, PNG or WebP file.');
			const fileBase64 = Buffer.from(await file.arrayBuffer()).toString('base64');
			const fileId = await insertAnnouncementFile({
				filename: file.name,
				mimeType: file.type,
				fileBase64,
				byteSize: file.size,
				uploadedBy: locals.user!.id
			});
			attachment = { id: fileId, name: file.name };
		}
		const removeAttachment = form.get('removeAttachment') === 'on';

		const fields = {
			kind: kind as 'urgent' | 'event' | 'update',
			title,
			summary: summary || null,
			body,
			eventDate: kind === 'event' ? eventDate : null,
			eventTime: kind === 'event' && eventTime ? eventTime : null,
			audienceAll,
			audienceTeamIds: audienceAll ? [] : teamIds,
			audienceShiftGroupIds: audienceAll ? [] : shiftIds,
			requiresAck: form.get('requiresAck') === 'on',
			urgentDays,
			emailCopy: form.get('emailCopy') === 'on',
			updatedAt: new Date(),
			...(attachment
				? { attachmentId: attachment.id, attachmentName: attachment.name }
				: removeAttachment
					? { attachmentId: null, attachmentName: null }
					: {})
		};

		let savedId = id;
		if (id) {
			if (!UUID.test(id)) return invalid('That announcement no longer exists.');
			const [existing] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
			if (!existing) return invalid('That announcement no longer exists.');

			const wasLive = existing.status === 'published' && !!existing.publishAt && existing.publishAt <= new Date();
			const contentChanged =
				existing.title !== fields.title ||
				(existing.summary ?? '') !== (fields.summary ?? '') ||
				existing.body !== fields.body ||
				existing.eventDate !== fields.eventDate ||
				existing.eventTime !== fields.eventTime;

			await db
				.update(announcements)
				.set({
					...fields,
					// A live post keeps its original time, so it does not jump to the
					// top of Updates just because a typo was fixed.
					...(intent === 'draft'
						? { status: 'draft' as const, publishAt: null }
						: { status: 'published' as const, publishAt: wasLive ? existing.publishAt : publishAt }),
					...(wasLive && contentChanged ? { editedAt: new Date() } : {})
				})
				.where(eq(announcements.id, id));

			// People who opened the old wording see it as unread again. A
			// confirmation already given is kept: it is a record, not a view.
			if (wasLive && contentChanged) {
				await db
					.delete(announcementReads)
					.where(and(eq(announcementReads.announcementId, id), isNull(announcementReads.acknowledgedAt)));
			}
		} else {
			const [row] = await db
				.insert(announcements)
				.values({
					...fields,
					status: intent === 'draft' ? 'draft' : 'published',
					publishAt,
					createdBy: locals.user!.id
				})
				.returning({ id: announcements.id });
			savedId = row.id;
		}

		// Sending takes a while for a few hundred people; the page does not wait.
		if (intent === 'publish' && fields.emailCopy) {
			void dispatchDueEmails().catch((err) => console.error('[announcements] email dispatch failed:', err));
		}

		const scheduled = intent === 'publish' && when === 'later';
		return {
			saved: savedId,
			savedMessage:
				intent === 'draft'
					? 'Draft saved. Only admins can see it.'
					: scheduled
						? 'Scheduled.'
						: id
							? 'Saved.'
							: `Published.${fields.emailCopy ? ' The email copy is on its way.' : ''}`
		};
	},

	takeDown: async ({ request, locals }: RequestEvent) => {
		if (!hasCap(locals.user, 'announcements.post')) return fail(403, { saveError: 'Only HR can take announcements down' });
		const id = String((await request.formData()).get('id') ?? '');
		if (!UUID.test(id)) return fail(400, { saveError: 'That announcement no longer exists.' });
		await db.update(announcements).set({ status: 'taken_down', updatedAt: new Date() }).where(eq(announcements.id, id));
		return { savedMessage: 'Taken down. Employees no longer see it.' };
	},

	restore: async ({ request, locals }: RequestEvent) => {
		if (!hasCap(locals.user, 'announcements.post')) return fail(403, { saveError: 'Only HR can restore announcements' });
		const id = String((await request.formData()).get('id') ?? '');
		if (!UUID.test(id)) return fail(400, { saveError: 'That announcement no longer exists.' });
		const [row] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
		if (!row) return fail(400, { saveError: 'That announcement no longer exists.' });
		await db
			.update(announcements)
			.set({ status: 'published', publishAt: row.publishAt ?? new Date(), updatedAt: new Date() })
			.where(eq(announcements.id, id));
		return { savedMessage: 'Restored.' };
	},

	remind: async ({ request, locals }: RequestEvent) => {
		if (!hasCap(locals.user, 'announcements.post')) return fail(403, { saveError: 'Only HR can send reminders' });
		const id = String((await request.formData()).get('id') ?? '');
		if (!UUID.test(id)) return fail(400, { saveError: 'That announcement no longer exists.' });
		const result = await sendConfirmationReminder(id);
		if (!result.ok) return fail(400, { saveError: result.message });
		return {
			savedMessage:
				result.count === 0
					? 'Everyone has confirmed. No reminder was needed.'
					: `Reminder going out by email to ${result.count} ${result.count === 1 ? 'person' : 'people'}.`
		};
	}
};
