import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCap } from '$lib/server/capabilities';
import { motionTemplate, type SlotValues } from '$lib/motion/templates';
import { fillTemplateFromBrief } from '$lib/server/ai/fill-template';

/** Engagement studio › Fill from a brief: { templateId, brief, current } → the template's fields. */
export const POST: RequestHandler = async (event) => {
	requireCap(event, 'engagement.studio');
	const body = (await event.request.json().catch(() => ({}))) as { templateId?: string; brief?: string; current?: SlotValues };
	const t = motionTemplate(body.templateId);
	if (!t) throw error(400, 'Pick a template');
	const brief = String(body.brief ?? '').trim().slice(0, 1500);
	if (brief.length < 5) throw error(400, 'Write a sentence or two about what it is for');
	try {
		return json({ values: await fillTemplateFromBrief(t, brief, body.current ?? {}) });
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'The AI could not fill it just now');
	}
};
