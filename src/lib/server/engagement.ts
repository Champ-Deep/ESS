import { db } from '$lib/server/db/postgres';
import {
	announcementReads,
	announcements,
	appSettings,
	employeeProfiles,
	engagementOverrides,
	engagementReels,
	engagementTemplates,
	engagementViews,
	teams,
	users
} from '$lib/server/db/schema';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { hasCap } from '$lib/server/capabilities';
import { notHidden } from '$lib/server/hidden-users';
import { deleteMedia, saveMedia } from '$lib/server/engagement-media';
import {
	CELEBRATION_KINDS,
	REEL_MAX_BYTES,
	REEL_MAX_SECONDS,
	REEL_TYPES,
	celebrationsOn,
	reelRunsOn,
	renderTemplate,
	type CelebrationKind
} from '$lib/engagement';
import type { SessionUser } from '$lib/server/auth';
import { CELEBRATION_TEMPLATE, DEFAULT_BRAND, motionTemplate, withDefaults, type BrandKit, type SlotValues } from '$lib/motion/templates';

/** A template's fields with the person's details filled in ({first_name}, {years}…). */
function personalise(values: SlotValues, person: Parameters<typeof renderTemplate>[1], years: number | null): SlotValues {
	const out: SlotValues = {};
	for (const [k, v] of Object.entries(values)) out[k] = Array.isArray(v) ? v.map((x) => renderTemplate(x, person, years)) : renderTemplate(v, person, years);
	return out;
}

export type MotionSpec = { templateId: string; values: SlotValues };

/**
 * Engagement studio and the Home reel. Celebrations come from the roster
 * (date of birth, joining date, wedding anniversary) and the studio's
 * templates; reels are short videos the Engagement team uploads. See
 * src/lib/engagement.ts for the rules and src/lib/server/engagement-media.ts
 * for where the videos live.
 */

type Fail = { ok: false; message: string };
type Ok = { ok: true; message: string };

export const istToday = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const mediaUrl = (id: string | null) => (id ? `/api/engagement/media/${id}` : null);

/* ---------------------------------------------------------------- roster */

type RosterPerson = { id: string; fullName: string; team: string | null; designation: string | null; dob: string | null; dateOfJoining: string | null; weddingAnniversary: string | null };

async function roster(): Promise<RosterPerson[]> {
	const rows = await db
		.select({
			id: users.id,
			fullName: users.fullName,
			email: users.email,
			team: teams.name,
			teamAndFloor: employeeProfiles.teamAndFloor,
			designation: employeeProfiles.designation,
			dobActual: employeeProfiles.dobActual,
			dobDocuments: employeeProfiles.dobDocuments,
			dateOfJoining: employeeProfiles.dateOfJoining,
			weddingAnniversary: employeeProfiles.anniversaryDate
		})
		.from(users)
		.innerJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.leftJoin(teams, eq(teams.id, users.teamId))
		.where(and(eq(users.isActive, true), notHidden));
	return rows.map((r) => ({
		id: r.id,
		fullName: r.fullName,
		team: r.team ?? r.teamAndFloor,
		designation: r.designation,
		// The day people actually celebrate; the documents' date is the fallback.
		dob: r.dobActual ?? r.dobDocuments,
		dateOfJoining: r.dateOfJoining,
		weddingAnniversary: r.weddingAnniversary
	}));
}

export type TemplateRow = typeof engagementTemplates.$inferSelect;

export async function loadTemplates(): Promise<Record<CelebrationKind, TemplateRow>> {
	const rows = await db.select().from(engagementTemplates);
	const out = {} as Record<CelebrationKind, TemplateRow>;
	for (const kind of CELEBRATION_KINDS) {
		out[kind] = rows.find((r) => r.kind === kind) ?? { kind, enabled: false, headline: '', message: '', theme: 'confetti', motionTemplate: CELEBRATION_TEMPLATE[kind], slotValues: null, mediaId: null, mediaMime: null, updatedBy: null, updatedAt: new Date(0) };
	}
	return out;
}

export type CelebrationItem = {
	key: string;
	kind: CelebrationKind;
	date: string;
	userId: string;
	fullName: string;
	team: string | null;
	years: number | null;
	headline: string;
	message: string;
	/** The template's message was replaced for this person on this day. */
	edited: boolean;
	hidden: boolean;
	theme: string;
	mediaUrl: string | null;
	/** The motion template, filled for this person; null keeps the simple card. */
	motion: MotionSpec | null;
};

/** Everyone's celebrations from `from` for `days` days, with any per-person changes. */
export async function celebrationsBetween(from: string, days: number): Promise<CelebrationItem[]> {
	const [people, templates, overrides] = await Promise.all([
		roster(),
		loadTemplates(),
		db
			.select()
			.from(engagementOverrides)
			.where(and(gte(engagementOverrides.onDate, from), sql`${engagementOverrides.onDate} < ${addDays(from, days)}`))
	]);
	const overrideBy = new Map(overrides.map((o) => [`${o.kind}|${o.userId}|${o.onDate}`, o]));
	const out: CelebrationItem[] = [];
	for (let i = 0; i < days; i++) {
		const date = addDays(from, i);
		for (const p of people) {
			for (const c of celebrationsOn(date, p)) {
				const t = templates[c.kind];
				if (!t.enabled) continue;
				const o = overrideBy.get(`${c.kind}|${p.id}|${date}`);
				const mt = motionTemplate(t.motionTemplate);
				// A per-person message replaces the template's message (or thank-you) slot.
				const personal: SlotValues = {};
				if (o?.message && mt) for (const k of ['message', 'story']) if (k in mt.slots) personal[k] = o.message;
				const slots = mt ? withDefaults(mt, { ...(t.slotValues ?? {}), ...personal }) : null;
				out.push({
					key: `${c.kind}:${p.id}:${date}`,
					kind: c.kind,
					date,
					userId: p.id,
					fullName: p.fullName,
					team: p.team,
					years: c.years,
					headline: renderTemplate(t.headline, p, c.years),
					message: renderTemplate(o?.message ?? t.message, p, c.years),
					edited: !!o?.message,
					hidden: !!o?.hidden,
					theme: t.theme,
					mediaUrl: mediaUrl(t.mediaId),
					motion: mt && slots ? { templateId: mt.id, values: personalise(slots, p, c.years) } : null
				});
			}
		}
	}
	return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.fullName.localeCompare(b.fullName));
}

/* ------------------------------------------------------------ Home reel */

export type HomeReelItem =
	| { key: string; type: 'celebration'; kind: CelebrationKind; headline: string; message: string; theme: string; mediaUrl: string | null; motion: MotionSpec | null; personId: string; isYou: boolean }
	| { key: string; type: 'reel'; title: string; caption: string; mediaUrl: string | null; motion: MotionSpec | null; durationSec: number | null };

/** What everyone's Home page plays today: today's celebrations, then the live reels. */
export async function homeReel(viewer: SessionUser): Promise<HomeReelItem[]> {
	const today = istToday();
	const [cels, reels] = await Promise.all([
		celebrationsBetween(today, 1),
		db.select().from(engagementReels).where(eq(engagementReels.active, true)).orderBy(asc(engagementReels.sortOrder), desc(engagementReels.createdAt))
	]);
	const items: HomeReelItem[] = [];
	// The person celebrating sees theirs first.
	for (const c of cels.filter((c) => !c.hidden).sort((a, b) => Number(b.userId === viewer.id) - Number(a.userId === viewer.id)).slice(0, 15)) {
		items.push({ key: c.key, type: 'celebration', kind: c.kind, headline: c.headline, message: c.message, theme: c.theme, mediaUrl: c.mediaUrl, motion: c.motion, personId: c.userId, isYou: c.userId === viewer.id });
	}
	for (const r of reels) {
		if (!reelRunsOn({ active: r.active, startsOn: r.startsOn, endsOn: r.endsOn }, today)) continue;
		const mt = r.kind === 'template' ? motionTemplate(r.motionTemplate) : null;
		if (r.kind === 'template' && !mt) continue;
		items.push({
			key: `reel:${r.id}`,
			type: 'reel',
			title: r.title,
			caption: r.caption,
			mediaUrl: mediaUrl(r.mediaId),
			motion: mt ? { templateId: mt.id, values: withDefaults(mt, r.slotValues) } : null,
			durationSec: r.durationSec ? Number(r.durationSec) : null
		});
	}
	return items;
}

export async function recordView(viewer: SessionUser, key: string): Promise<void> {
	if (!/^(reel:[0-9a-f-]{36}|(birthday|work_anniversary|wedding_anniversary):[0-9a-f-]{36}:\d{4}-\d{2}-\d{2})$/.test(key)) return;
	await db.insert(engagementViews).values({ itemKey: key, userId: viewer.id, day: istToday() }).onConflictDoNothing();
}

/* --------------------------------------------------------------- studio */

function studioActor(actor: SessionUser): Fail | null {
	return hasCap(actor, 'engagement.studio') ? null : { ok: false, message: 'Only the Engagement team can change the studio' };
}

type Upload = { name: string; type: string; size: number; bytes: Uint8Array };

function checkVideo(file: Upload, durationSec: number | null): Fail | null {
	if (!REEL_TYPES.includes(file.type)) return { ok: false, message: 'Upload an MP4 or WebM video' };
	if (file.size > REEL_MAX_BYTES) return { ok: false, message: `Keep videos under ${REEL_MAX_BYTES / 1024 / 1024} MB` };
	if (durationSec !== null && durationSec > REEL_MAX_SECONDS + 0.5) return { ok: false, message: `Keep it short: ${REEL_MAX_SECONDS} seconds at most (this one is ${Math.round(durationSec)})` };
	return null;
}

export async function saveTemplate(
	actor: SessionUser,
	input: { kind: string; enabled: boolean; headline: string; message: string; theme: string; motionTemplate: string | null; slotValues: SlotValues | null; video: Upload | null; durationSec: number | null; removeVideo: boolean }
): Promise<Ok | Fail> {
	const denied = studioActor(actor);
	if (denied) return denied;
	if (!(CELEBRATION_KINDS as readonly string[]).includes(input.kind)) return { ok: false, message: 'Unknown celebration' };
	const headline = input.headline.trim().slice(0, 140);
	if (!headline) return { ok: false, message: 'Write the headline people will see' };
	const [current] = await db.select().from(engagementTemplates).where(eq(engagementTemplates.kind, input.kind)).limit(1);

	let mediaId = current?.mediaId ?? null;
	let mediaMime = current?.mediaMime ?? null;
	if (input.video) {
		const bad = checkVideo(input.video, input.durationSec);
		if (bad) return bad;
		mediaId = await saveMedia(input.video, actor.id);
		mediaMime = input.video.type;
		await deleteMedia(current?.mediaId);
	} else if (input.removeVideo) {
		await deleteMedia(current?.mediaId);
		mediaId = null;
		mediaMime = null;
	}
	const chosen = motionTemplate(input.motionTemplate);
	const values = {
		kind: input.kind,
		enabled: input.enabled,
		headline,
		message: input.message.trim().slice(0, 400),
		theme: ['confetti', 'stars', 'hearts', 'calm'].includes(input.theme) ? input.theme : 'confetti',
		motionTemplate: chosen?.id ?? null,
		slotValues: chosen ? withDefaults(chosen, input.slotValues) : null,
		mediaId,
		mediaMime,
		updatedBy: actor.id,
		updatedAt: new Date()
	};
	await db.insert(engagementTemplates).values(values).onConflictDoUpdate({ target: engagementTemplates.kind, set: values });
	await logActivity({ actorUserId: actor.id, action: 'engagement.template', targetType: 'engagement_template', targetId: input.kind, details: { enabled: input.enabled, video: !!mediaId } });
	return { ok: true, message: 'Saved. The portal uses it from the next celebration on.' };
}

export async function setOverride(actor: SessionUser, input: { kind: string; userId: string; onDate: string; message: string | null; hidden: boolean }): Promise<Ok | Fail> {
	const denied = studioActor(actor);
	if (denied) return denied;
	if (!(CELEBRATION_KINDS as readonly string[]).includes(input.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(input.onDate)) return { ok: false, message: 'That celebration was not found' };
	const message = input.message?.trim().slice(0, 400) || null;
	if (!message && !input.hidden) {
		await db.delete(engagementOverrides).where(and(eq(engagementOverrides.kind, input.kind), eq(engagementOverrides.userId, input.userId), eq(engagementOverrides.onDate, input.onDate)));
		return { ok: true, message: 'Back to the template.' };
	}
	const values = { kind: input.kind, userId: input.userId, onDate: input.onDate, message, hidden: input.hidden, updatedBy: actor.id, updatedAt: new Date() };
	await db
		.insert(engagementOverrides)
		.values(values)
		.onConflictDoUpdate({ target: [engagementOverrides.kind, engagementOverrides.userId, engagementOverrides.onDate], set: values });
	return { ok: true, message: input.hidden ? 'Skipped: it will not be shown.' : 'Saved for this person.' };
}

export async function addReel(actor: SessionUser, input: { title: string; caption: string; startsOn: string | null; endsOn: string | null; video: Upload | null; durationSec: number | null }): Promise<Ok | Fail> {
	const denied = studioActor(actor);
	if (denied) return denied;
	if (!input.video) return { ok: false, message: 'Choose a short video' };
	const bad = checkVideo(input.video, input.durationSec);
	if (bad) return bad;
	const title = input.title.trim().slice(0, 80);
	if (!title) return { ok: false, message: 'Give the reel a title' };
	if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) return { ok: false, message: 'The end date is before the start date' };
	const mediaId = await saveMedia(input.video, actor.id);
	const [r] = await db
		.insert(engagementReels)
		.values({
			title,
			caption: input.caption.trim().slice(0, 200),
			kind: 'video',
			mediaId,
			mediaMime: input.video.type,
			byteSize: input.video.size,
			durationSec: input.durationSec !== null ? input.durationSec.toFixed(2) : null,
			startsOn: input.startsOn,
			endsOn: input.endsOn,
			createdBy: actor.id
		})
		.returning();
	await logActivity({ actorUserId: actor.id, action: 'engagement.reel_add', targetType: 'engagement_reel', targetId: r.id, details: { title } });
	return { ok: true, message: `“${title}” is on everyone’s Home page${input.startsOn && input.startsOn > istToday() ? ` from ${input.startsOn}` : ' now'}.` };
}

/** A reel made from a motion template, played live on Home (a background video is optional). */
export async function addTemplateReel(
	actor: SessionUser,
	input: { reelId?: string | null; title: string; caption: string; templateId: string; values: SlotValues | null; startsOn: string | null; endsOn: string | null; video: Upload | null; durationSec: number | null }
): Promise<Ok | Fail> {
	const denied = studioActor(actor);
	if (denied) return denied;
	const mt = motionTemplate(input.templateId);
	if (!mt) return { ok: false, message: 'Pick a template' };
	const title = input.title.trim().slice(0, 80);
	if (!title) return { ok: false, message: 'Give the reel a title' };
	if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) return { ok: false, message: 'The end date is before the start date' };
	// The words on screen are the template's fields, not the title or caption:
	// a reel still showing the sample text would announce the wrong thing.
	const filled = withDefaults(mt, input.values);
	if (stillSample(mt, filled)) {
		return { ok: false, message: `The template still shows its sample words (“${String(mt.defaults[Object.keys(mt.slots)[0]])}”…). Change the fields on the left, or use Fill with AI. The title and caption only name the reel in the list.` };
	}
	if (input.reelId) {
		const [prev] = await db.select().from(engagementReels).where(eq(engagementReels.id, input.reelId)).limit(1);
		if (!prev || prev.kind !== 'template') return { ok: false, message: 'That reel is gone' };
		let mediaPatch = {};
		if (input.video) {
			const bad = checkVideo(input.video, input.durationSec);
			if (bad) return bad;
			mediaPatch = { mediaId: await saveMedia(input.video, actor.id), mediaMime: input.video.type, byteSize: input.video.size };
			await deleteMedia(prev.mediaId);
		}
		await db
			.update(engagementReels)
			.set({ title, caption: input.caption.trim().slice(0, 200), motionTemplate: mt.id, slotValues: filled, startsOn: input.startsOn, endsOn: input.endsOn, ...mediaPatch })
			.where(eq(engagementReels.id, prev.id));
		await logActivity({ actorUserId: actor.id, action: 'engagement.reel_edit', targetType: 'engagement_reel', targetId: prev.id, details: { title } });
		return { ok: true, message: `Updated “${title}”. Home shows the new version straight away.` };
	}
	let mediaId: string | null = null;
	if (input.video) {
		const bad = checkVideo(input.video, input.durationSec);
		if (bad) return bad;
		mediaId = await saveMedia(input.video, actor.id);
	}
	const [r] = await db
		.insert(engagementReels)
		.values({
			title,
			caption: input.caption.trim().slice(0, 200),
			kind: 'template',
			motionTemplate: mt.id,
			slotValues: withDefaults(mt, input.values),
			mediaId,
			mediaMime: input.video?.type ?? null,
			byteSize: input.video?.size ?? 0,
			startsOn: input.startsOn,
			endsOn: input.endsOn,
			createdBy: actor.id
		})
		.returning();
	await logActivity({ actorUserId: actor.id, action: 'engagement.reel_add', targetType: 'engagement_reel', targetId: r.id, details: { title, template: mt.id } });
	return { ok: true, message: `“${title}” is on everyone’s Home page${input.startsOn && input.startsOn > istToday() ? ` from ${input.startsOn}` : ' now'}.` };
}

/** Every field is still the template's own sample text. */
function stillSample(mt: NonNullable<ReturnType<typeof motionTemplate>>, values: SlotValues): boolean {
	return Object.keys(mt.slots).every((k) => JSON.stringify(values[k]) === JSON.stringify(withDefaults(mt, null)[k]));
}

/* ------------------------------------------------------------ brand kit */

const BRAND_KEY = 'engagement.brand';
const HEX = /^#[0-9a-f]{6}$/i;

export async function loadBrand(): Promise<BrandKit> {
	const [row] = await db.select().from(appSettings).where(eq(appSettings.key, BRAND_KEY)).limit(1);
	const v = (row?.value ?? {}) as Partial<BrandKit>;
	const colors = { ...DEFAULT_BRAND.colors };
	for (const k of Object.keys(colors) as (keyof BrandKit['colors'])[]) {
		const c = v.colors?.[k];
		if (typeof c === 'string' && HEX.test(c)) colors[k] = c;
	}
	const gradient = Array.isArray(v.gradient) && v.gradient.length === 3 && v.gradient.every((c) => typeof c === 'string' && HEX.test(c)) ? (v.gradient as BrandKit['gradient']) : DEFAULT_BRAND.gradient;
	return { name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 40) : DEFAULT_BRAND.name, colors, gradient };
}

export async function saveBrand(actor: SessionUser, kit: BrandKit): Promise<Ok | Fail> {
	const denied = studioActor(actor);
	if (denied) return denied;
	const clean: BrandKit = { name: kit.name.trim().slice(0, 40) || DEFAULT_BRAND.name, colors: kit.colors, gradient: kit.gradient };
	for (const c of [...Object.values(clean.colors), ...clean.gradient]) if (!HEX.test(c)) return { ok: false, message: 'Colours must be hex, like #0071e3' };
	await db.insert(appSettings).values({ key: BRAND_KEY, value: clean }).onConflictDoUpdate({ target: appSettings.key, set: { value: clean, updatedAt: new Date() } });
	await logActivity({ actorUserId: actor.id, action: 'engagement.brand', targetType: 'app_settings', targetId: BRAND_KEY, details: { name: clean.name } });
	return { ok: true, message: 'Brand kit saved. Every template uses it from now on.' };
}

export async function updateReel(actor: SessionUser, id: string, patch: { active?: boolean; remove?: boolean }): Promise<Ok | Fail> {
	const denied = studioActor(actor);
	if (denied) return denied;
	const [r] = await db.select().from(engagementReels).where(eq(engagementReels.id, id)).limit(1);
	if (!r) return { ok: false, message: 'That reel is gone' };
	if (patch.remove) {
		await db.delete(engagementReels).where(eq(engagementReels.id, id));
		await deleteMedia(r.mediaId);
		await logActivity({ actorUserId: actor.id, action: 'engagement.reel_delete', targetType: 'engagement_reel', targetId: id, details: { title: r.title } });
		return { ok: true, message: `Deleted “${r.title}”.` };
	}
	if (patch.active !== undefined) await db.update(engagementReels).set({ active: patch.active }).where(eq(engagementReels.id, id));
	return { ok: true, message: patch.active ? `“${r.title}” is showing again.` : `“${r.title}” is paused.` };
}

/* ---------------------------------------------------------- studio data */

export async function studioData() {
	const today = istToday();
	const weekAgo = addDays(today, -6);
	const monthAgo = new Date(Date.now() - 30 * 86_400_000);
	const [templates, upcoming, reels, views, people, posts, reads, chat, brand] = await Promise.all([
		loadTemplates(),
		celebrationsBetween(today, 14),
		db.select().from(engagementReels).orderBy(asc(engagementReels.sortOrder), desc(engagementReels.createdAt)),
		db
			.select({ key: engagementViews.itemKey, n: sql<number>`count(*)::int`, people: sql<number>`count(distinct ${engagementViews.userId})::int` })
			.from(engagementViews)
			.where(gte(engagementViews.day, weekAgo))
			.groupBy(engagementViews.itemKey),
		db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.isActive, true), notHidden)),
		db.select({ n: sql<number>`count(*)::int` }).from(announcements).where(and(eq(announcements.status, 'published'), gte(announcements.createdAt, monthAgo))),
		db
			.select({ n: sql<number>`count(*)::int` })
			.from(announcementReads)
			.innerJoin(announcements, eq(announcements.id, announcementReads.announcementId))
			.where(gte(announcements.createdAt, monthAgo)),
		db.execute(sql`
			select count(distinct author_id)::int as people, count(*)::int as messages
			from chat_messages where created_at > now() - interval '7 days' and author_id is not null
		`),
		loadBrand()
	]);
	const thisMonth = today.slice(0, 7);
	const monthCels = await celebrationsBetween(`${thisMonth}-01`, 31);
	const inMonth = monthCels.filter((c) => c.date.startsWith(thisMonth));
	const viewBy = new Map(views.map((v) => [v.key, v]));
	const reelViews = views.filter((v) => v.key.startsWith('reel:'));
	const c = (chat.rows[0] ?? {}) as { people?: number; messages?: number };
	const headcount = people[0]?.n ?? 0;
	return {
		today,
		templates: Object.fromEntries(
			Object.entries(templates).map(([k, t]) => [
				k,
				{ kind: k, enabled: t.enabled, headline: t.headline, message: t.message, theme: t.theme, motionTemplate: t.motionTemplate, slotValues: t.slotValues, mediaUrl: mediaUrl(t.mediaId), updatedAt: t.updatedAt.toISOString() }
			])
		) as Record<CelebrationKind, { kind: string; enabled: boolean; headline: string; message: string; theme: string; motionTemplate: string | null; slotValues: SlotValues | null; mediaUrl: string | null; updatedAt: string }>,
		brand,
		upcoming,
		reels: reels.map((r) => ({
			id: r.id,
			title: r.title,
			caption: r.caption,
			kind: r.kind,
			motionTemplate: r.motionTemplate,
			slotValues: r.slotValues,
			mediaUrl: mediaUrl(r.mediaId),
			sizeMb: Math.round((r.byteSize / 1024 / 1024) * 10) / 10,
			durationSec: r.durationSec ? Number(r.durationSec) : null,
			startsOn: r.startsOn,
			endsOn: r.endsOn,
			active: r.active,
			live: reelRunsOn({ active: r.active, startsOn: r.startsOn, endsOn: r.endsOn }, today),
			views7d: viewBy.get(`reel:${r.id}`)?.people ?? 0
		})),
		stats: {
			headcount,
			birthdaysThisMonth: inMonth.filter((x) => x.kind === 'birthday').length,
			workAnniversariesThisMonth: inMonth.filter((x) => x.kind === 'work_anniversary').length,
			weddingAnniversariesThisMonth: inMonth.filter((x) => x.kind === 'wedding_anniversary').length,
			reelViews7d: reelViews.reduce((s, v) => s + v.people, 0),
			celebrationViews7d: views.filter((v) => !v.key.startsWith('reel:')).reduce((s, v) => s + v.n, 0),
			announcements30d: posts[0]?.n ?? 0,
			announcementReads30d: reads[0]?.n ?? 0,
			chatPeople7d: c.people ?? 0,
			chatMessages7d: c.messages ?? 0
		}
	};
}
