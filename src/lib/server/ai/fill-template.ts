import { env } from '$env/dynamic/private';
import type { MotionTemplate, SlotValues } from '$lib/motion/templates';

/**
 * "Fill from a brief" for the Engagement studio: the AI writes a motion
 * template's fields from a short description, the way Champ Studio's
 * templates.ai_fill does (a JSON schema built from the slots, each limit
 * respected). Same AI as the rest of the portal: OPENROUTER_API_KEY and
 * OPENROUTER_MODEL, as Champ uses.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM = `You fill a short vertical video template's fields from a brief, for an employee engagement team at Champions Group (an Indian company).

- Respect every maxLength strictly; on-screen text is short and warm (headlines of at most 7 words).
- Write for colleagues: friendly, inclusive, never salesy. No hashtags, no emoji.
- Use only facts given in the brief; never invent dates, numbers, names or places. If a field needs a fact the brief does not give, write a general phrase that still fits.
- Keep placeholders such as {first_name}, {years} or {team} exactly as written when the brief or the current values use them.
- Lists have exactly the number of items asked for.`;

function schemaFor(t: MotionTemplate) {
	const properties: Record<string, unknown> = {};
	for (const [key, spec] of Object.entries(t.slots)) {
		properties[key] =
			spec.kind === 'list'
				? { type: 'array', minItems: spec.items ?? 3, maxItems: spec.items ?? 3, items: { type: 'string', maxLength: spec.maxLength }, description: spec.label }
				: { type: 'string', maxLength: spec.maxLength, description: spec.label + (spec.hint ? ` (${spec.hint})` : '') };
	}
	return { type: 'object', additionalProperties: false, required: Object.keys(t.slots), properties };
}

/** Keeps only the template's fields, each within its limit. */
export function cleanFill(t: MotionTemplate, raw: unknown): SlotValues {
	const out: SlotValues = {};
	const r = (raw ?? {}) as Record<string, unknown>;
	for (const [key, spec] of Object.entries(t.slots)) {
		const v = r[key];
		if (spec.kind === 'list') {
			const items = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, spec.maxLength)) : [];
			if (items.length) out[key] = items.slice(0, spec.items ?? 3);
		} else if (typeof v === 'string' && v.trim()) {
			out[key] = v.trim().slice(0, spec.maxLength);
		}
	}
	return out;
}

export async function fillTemplateFromBrief(t: MotionTemplate, brief: string, current: SlotValues): Promise<SlotValues> {
	const apiKey = env.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error('AI is not set up on this server (OPENROUTER_API_KEY is missing)');
	const user = `Template: ${t.name}: ${t.description}\nScenes: ${t.scenes.map((s) => s.id).join(', ')}\nCurrent values: ${JSON.stringify(current)}\n\nBrief:\n${brief}`;
	const res = await fetch(OPENROUTER_URL, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: env.OPENROUTER_MODEL || 'google/gemini-3.5-flash',
			temperature: 0.6,
			messages: [
				{ role: 'system', content: SYSTEM },
				{ role: 'user', content: user }
			],
			response_format: { type: 'json_schema', json_schema: { name: 'template_slots', strict: true, schema: schemaFor(t) } }
		})
	});
	if (!res.ok) throw new Error(`The AI could not fill it just now (${res.status})`);
	const data = await res.json();
	const content: string = data?.choices?.[0]?.message?.content ?? '';
	const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		throw new Error('The AI answered with something other than the fields; try again');
	}
	return cleanFill(t, parsed);
}
