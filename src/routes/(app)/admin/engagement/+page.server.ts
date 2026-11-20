import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { gateAdminPage } from '$lib/server/capabilities';
import { addReel, addTemplateReel, saveBrand, saveTemplate, setOverride, studioData, updateReel } from '$lib/server/engagement';
import { DEFAULT_BRAND, type BrandKit, type SlotValues } from '$lib/motion/templates';
import { deskStats } from '$lib/server/desk-stats';

/** Engagement studio (src/lib/server/engagement.ts). */
export const load: PageServerLoad = async ({ locals }) => {
	gateAdminPage(locals, ['engagement.studio']);
	const [studio, desk] = await Promise.all([studioData(), deskStats('engagement')]);
	return { ...studio, desk };
};

async function upload(form: FormData, key: string) {
	const f = form.get(key);
	if (!(f instanceof File) || f.size === 0) return null;
	return { name: f.name, type: f.type, size: f.size, bytes: new Uint8Array(await f.arrayBuffer()) };
}
const duration = (form: FormData) => {
	const n = Number(form.get('durationSec'));
	return Number.isFinite(n) && n > 0 ? n : null;
};
/** The template fields, sent as JSON by the studio's form. */
function slotsFrom(form: FormData): SlotValues | null {
	try {
		const v = JSON.parse(String(form.get('slotValues') ?? 'null'));
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as SlotValues) : null;
	} catch {
		return null;
	}
}
const dateOrNull = (v: FormDataEntryValue | null) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export const actions: Actions = {
	template: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['engagement.studio']);
		const form = await request.formData();
		const r = await saveTemplate(actor, {
			kind: String(form.get('kind') ?? ''),
			enabled: form.get('enabled') === 'on',
			headline: String(form.get('headline') ?? ''),
			message: String(form.get('message') ?? ''),
			theme: String(form.get('theme') ?? 'confetti'),
			motionTemplate: String(form.get('motionTemplate') ?? '') || null,
			slotValues: slotsFrom(form),
			video: await upload(form, 'video'),
			durationSec: duration(form),
			removeVideo: form.get('removeVideo') === 'on'
		});
		return r.ok ? { message: r.message, tab: 'celebrations' } : fail(400, { error: r.message, tab: 'celebrations' });
	},
	override: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['engagement.studio']);
		const form = await request.formData();
		const r = await setOverride(actor, {
			kind: String(form.get('kind') ?? ''),
			userId: String(form.get('userId') ?? ''),
			onDate: String(form.get('onDate') ?? ''),
			message: String(form.get('message') ?? '') || null,
			hidden: form.get('hidden') === 'on'
		});
		return r.ok ? { message: r.message } : fail(400, { error: r.message });
	},
	reel: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['engagement.studio']);
		const form = await request.formData();
		const r = await addReel(actor, {
			title: String(form.get('title') ?? ''),
			caption: String(form.get('caption') ?? ''),
			startsOn: dateOrNull(form.get('startsOn')),
			endsOn: dateOrNull(form.get('endsOn')),
			video: await upload(form, 'video'),
			durationSec: duration(form)
		});
		return r.ok ? { message: r.message, tab: 'reels' } : fail(400, { error: r.message, tab: 'reels' });
	},
	templateReel: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['engagement.studio']);
		const form = await request.formData();
		const r = await addTemplateReel(actor, {
			reelId: String(form.get('reelId') ?? '') || null,
			title: String(form.get('title') ?? ''),
			caption: String(form.get('caption') ?? ''),
			templateId: String(form.get('templateId') ?? ''),
			values: slotsFrom(form),
			startsOn: dateOrNull(form.get('startsOn')),
			endsOn: dateOrNull(form.get('endsOn')),
			video: await upload(form, 'video'),
			durationSec: duration(form)
		});
		return r.ok ? { message: r.message, tab: 'reels' } : fail(400, { error: r.message, tab: 'create' });
	},
	brand: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['engagement.studio']);
		const form = await request.formData();
		const color = (k: string, d: string) => String(form.get(k) ?? d);
		const kit: BrandKit = {
			name: String(form.get('name') ?? ''),
			colors: Object.fromEntries(Object.entries(DEFAULT_BRAND.colors).map(([k, d]) => [k, color(`c_${k}`, d)])) as BrandKit['colors'],
			gradient: [color('g0', DEFAULT_BRAND.gradient[0]), color('g1', DEFAULT_BRAND.gradient[1]), color('g2', DEFAULT_BRAND.gradient[2])]
		};
		const r = await saveBrand(actor, kit);
		return r.ok ? { message: r.message, tab: 'brand' } : fail(400, { error: r.message, tab: 'brand' });
	},
	reelUpdate: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['engagement.studio']);
		const form = await request.formData();
		const r = await updateReel(actor, String(form.get('id') ?? ''), {
			active: form.has('active') ? form.get('active') === 'true' : undefined,
			remove: form.get('remove') === 'true'
		});
		return r.ok ? { message: r.message, tab: 'reels' } : fail(400, { error: r.message, tab: 'reels' });
	}
};
