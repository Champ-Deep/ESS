/**
 * Motion templates for the Engagement studio, after Champ Studio's template
 * format (github.com/developer00777/Champ-studio, engine/champstudio/assets/templates):
 * named slots with length limits, timed scenes, and layers placed on the
 * frame with in/out animations, all coloured from a brand kit rather than
 * fixed colours. Simplified to what celebrations and Home reels need: one
 * vertical 9:16 frame, text, shapes and confetti, and an optional uploaded
 * video behind a scene. Rendered in the browser (src/lib/motion/render.ts),
 * so nothing is rendered or fetched from anywhere else.
 */

export type Fill = 'primary' | 'accent' | 'dark' | 'light' | 'text' | 'muted';
export type AnimType = 'fade' | 'pop' | 'slide-up' | 'slide-left' | 'slide-right' | 'zoom-in' | 'wipe';
export type Anim = { type: AnimType; sec: number };
/** x, y, width, height as fractions of the frame. */
export type Box = [number, number, number, number];
export type TextStyle = 'eyebrow' | 'title' | 'subtitle' | 'stat' | 'body' | 'button';

export type TextLayer = { type: 'text'; text: string; style: TextStyle; box: Box; align?: 'left' | 'center'; color?: Fill; start: number; end?: number; in?: Anim; out?: Anim };
export type ShapeLayer = { type: 'shape'; shape: 'ellipse' | 'rect' | 'pill'; fill: Fill; box: Box; opacity?: number; start: number; end?: number; in?: Anim; out?: Anim };
export type ConfettiLayer = { type: 'confetti'; palette: Fill[]; count: number; start: number; end?: number };
export type Layer = TextLayer | ShapeLayer | ConfettiLayer;

export type Background = { kind: 'gradient' } | { kind: 'solid'; fill: Fill } | { kind: 'media' };
export type Scene = { id: string; sec: number; background: Background; layers: Layer[] };

export type SlotSpec = {
	label: string;
	kind: 'text' | 'list';
	maxLength: number;
	/** For a list: how many lines. */
	items?: number;
	hint?: string;
};

export type MotionTemplate = {
	id: string;
	name: string;
	category: 'Celebrations' | 'Events' | 'People' | 'Company news';
	description: string;
	/** Celebration templates the portal fills per person: {first_name}, {years}… */
	celebration?: 'birthday' | 'work_anniversary' | 'wedding_anniversary';
	slots: Record<string, SlotSpec>;
	defaults: Record<string, string | string[]>;
	scenes: Scene[];
};

export type BrandKit = {
	name: string;
	colors: Record<Fill, string>;
	/** The hero gradient, top-left to bottom-right. */
	gradient: [string, string, string];
};

export const DEFAULT_BRAND: BrandKit = {
	name: 'Champions',
	colors: { primary: '#0071e3', accent: '#ffca20', dark: '#14163a', light: '#ffffff', text: '#ffffff', muted: '#c9cbe8' },
	gradient: ['#ff7a59', '#ff3d7f', '#7b5cff']
};

const IN = (type: AnimType, sec = 0.5): Anim => ({ type, sec });
const confetti = (start = 0.1): ConfettiLayer => ({ type: 'confetti', palette: ['accent', 'light', 'primary'], count: 34, start });

export const MOTION_TEMPLATES: MotionTemplate[] = [
	{
		id: 'birthday-burst',
		name: 'Birthday burst',
		category: 'Celebrations',
		celebration: 'birthday',
		description: 'Confetti, their name big and bright, then a warm message and the company sign-off.',
		slots: {
			name: { label: 'Name', kind: 'text', maxLength: 24, hint: 'Filled in for each person: {first_name}' },
			message: { label: 'Message', kind: 'text', maxLength: 110 },
			signoff: { label: 'Sign-off', kind: 'text', maxLength: 40 }
		},
		defaults: { name: '{first_name}', message: 'Wishing you a wonderful year ahead, full of good things.', signoff: 'From all of us at Champions' },
		scenes: [
			{
				id: 'hello',
				sec: 3.6,
				background: { kind: 'gradient' },
				layers: [
					confetti(),
					{ type: 'text', text: 'Today we celebrate', style: 'eyebrow', box: [0.1, 0.3, 0.8, 0.05], align: 'center', start: 0.2, in: IN('fade') },
					{ type: 'text', text: 'Happy birthday,', style: 'title', box: [0.08, 0.38, 0.84, 0.09], align: 'center', start: 0.4, in: IN('slide-up') },
					{ type: 'text', text: '{name}!', style: 'stat', box: [0.06, 0.47, 0.88, 0.16], align: 'center', start: 0.7, in: IN('pop', 0.6) }
				]
			},
			{
				id: 'wish',
				sec: 4,
				background: { kind: 'solid', fill: 'dark' },
				layers: [
					confetti(0),
					{ type: 'shape', shape: 'pill', fill: 'accent', box: [0.1, 0.36, 0.14, 0.008], start: 0.1, in: IN('wipe', 0.5) },
					{ type: 'text', text: '{message}', style: 'subtitle', box: [0.1, 0.39, 0.8, 0.22], start: 0.2, in: IN('slide-up') },
					{ type: 'text', text: '{signoff}', style: 'body', color: 'muted', box: [0.1, 0.66, 0.8, 0.06], start: 0.9, in: IN('fade') }
				]
			}
		]
	},
	{
		id: 'milestone-years',
		name: 'Milestone years',
		category: 'Celebrations',
		celebration: 'work_anniversary',
		description: 'From Champ Studio’s Milestone Celebration: a giant number with confetti, then the thanks and a sign-off.',
		slots: {
			number: { label: 'Number', kind: 'text', maxLength: 6, hint: '{years} for each person' },
			unit: { label: 'What it counts', kind: 'text', maxLength: 28 },
			name: { label: 'Name', kind: 'text', maxLength: 24, hint: '{first_name}' },
			story: { label: 'Thank-you line', kind: 'text', maxLength: 90 },
			signoff: { label: 'Sign-off', kind: 'text', maxLength: 40 }
		},
		defaults: { number: '{years}', unit: '{years_word} at Champions', name: '{first_name}', story: 'Thank you for everything you bring to {team}.', signoff: 'Here’s to many more' },
		scenes: [
			{
				id: 'number',
				sec: 3.4,
				background: { kind: 'solid', fill: 'dark' },
				layers: [
					confetti(0.3),
					{ type: 'text', text: '{number}', style: 'stat', color: 'accent', box: [0.1, 0.3, 0.8, 0.2], align: 'center', start: 0.2, in: IN('zoom-in', 0.7) },
					{ type: 'text', text: '{unit}', style: 'title', box: [0.08, 0.5, 0.84, 0.1], align: 'center', start: 0.7, in: IN('slide-up') },
					{ type: 'text', text: '{name}', style: 'subtitle', color: 'muted', box: [0.1, 0.62, 0.8, 0.06], align: 'center', start: 1.1, in: IN('fade') }
				]
			},
			{
				id: 'thanks',
				sec: 4,
				background: { kind: 'gradient' },
				layers: [
					{ type: 'text', text: 'Thank you, {name}', style: 'title', box: [0.1, 0.32, 0.8, 0.12], start: 0.1, in: IN('slide-left') },
					{ type: 'text', text: '{story}', style: 'subtitle', box: [0.1, 0.46, 0.8, 0.18], start: 0.5, in: IN('slide-up') },
					{ type: 'shape', shape: 'pill', fill: 'light', box: [0.1, 0.7, 0.62, 0.065], opacity: 0.18, start: 1.1, in: IN('wipe', 0.5) },
					{ type: 'text', text: '{signoff}', style: 'button', box: [0.13, 0.7, 0.58, 0.065], start: 1.3, in: IN('fade') }
				]
			}
		]
	},
	{
		id: 'anniversary-hearts',
		name: 'Anniversary hearts',
		category: 'Celebrations',
		celebration: 'wedding_anniversary',
		description: 'A soft, warm wish for a wedding anniversary.',
		slots: {
			name: { label: 'Name', kind: 'text', maxLength: 24, hint: '{first_name}' },
			message: { label: 'Message', kind: 'text', maxLength: 100 }
		},
		defaults: { name: '{first_name}', message: 'Wishing you and your family a lovely day together.' },
		scenes: [
			{
				id: 'wish',
				sec: 5,
				background: { kind: 'gradient' },
				layers: [
					{ type: 'shape', shape: 'ellipse', fill: 'light', opacity: 0.12, box: [0.55, 0.12, 0.6, 0.34], start: 0, in: IN('zoom-in', 1.2) },
					{ type: 'shape', shape: 'ellipse', fill: 'light', opacity: 0.1, box: [-0.15, 0.62, 0.55, 0.31], start: 0.2, in: IN('zoom-in', 1.2) },
					{ type: 'text', text: 'Happy anniversary', style: 'title', box: [0.08, 0.36, 0.84, 0.1], align: 'center', start: 0.3, in: IN('slide-up') },
					{ type: 'text', text: '{name}', style: 'stat', box: [0.06, 0.46, 0.88, 0.13], align: 'center', start: 0.7, in: IN('pop', 0.6) },
					{ type: 'text', text: '{message}', style: 'body', box: [0.12, 0.62, 0.76, 0.12], align: 'center', start: 1.3, in: IN('fade') }
				]
			}
		]
	},
	{
		id: 'employee-spotlight',
		name: 'Employee spotlight',
		category: 'People',
		description: 'From Champ Studio’s Employee Spotlight: name and role, their words, and three fun facts.',
		slots: {
			name: { label: 'Name', kind: 'text', maxLength: 26 },
			role: { label: 'Role and team', kind: 'text', maxLength: 40 },
			quote: { label: 'In their words', kind: 'text', maxLength: 110 },
			facts: { label: 'Three fun facts', kind: 'list', items: 3, maxLength: 34 }
		},
		defaults: { name: 'Priya Sharma', role: 'Data Analyst · Data Team', quote: 'I love that every day here brings a new problem to solve with great people.', facts: ['Runs half-marathons', 'Bakes on Sundays', 'Speaks four languages'] },
		scenes: [
			{
				id: 'who',
				sec: 3.2,
				background: { kind: 'gradient' },
				layers: [
					{ type: 'text', text: 'Spotlight', style: 'eyebrow', box: [0.1, 0.34, 0.8, 0.05], start: 0.1, in: IN('fade') },
					{ type: 'text', text: '{name}', style: 'title', box: [0.1, 0.4, 0.8, 0.12], start: 0.3, in: IN('slide-left') },
					{ type: 'shape', shape: 'pill', fill: 'accent', box: [0.1, 0.53, 0.18, 0.008], start: 0.6, in: IN('wipe') },
					{ type: 'text', text: '{role}', style: 'subtitle', box: [0.1, 0.56, 0.8, 0.07], start: 0.8, in: IN('fade') }
				]
			},
			{
				id: 'quote',
				sec: 3.6,
				background: { kind: 'solid', fill: 'dark' },
				layers: [
					{ type: 'text', text: '“', style: 'stat', color: 'accent', box: [0.08, 0.24, 0.3, 0.14], start: 0, in: IN('pop') },
					{ type: 'text', text: '{quote}', style: 'subtitle', box: [0.1, 0.36, 0.8, 0.28], start: 0.3, in: IN('slide-up') }
				]
			},
			{
				id: 'facts',
				sec: 3.8,
				background: { kind: 'gradient' },
				layers: [
					{ type: 'text', text: 'Fun facts', style: 'eyebrow', box: [0.1, 0.3, 0.8, 0.05], start: 0, in: IN('fade') },
					{ type: 'text', text: '{facts.0}', style: 'title', box: [0.1, 0.37, 0.8, 0.09], start: 0.3, in: IN('slide-right') },
					{ type: 'text', text: '{facts.1}', style: 'title', box: [0.1, 0.47, 0.8, 0.09], start: 0.8, in: IN('slide-right') },
					{ type: 'text', text: '{facts.2}', style: 'title', box: [0.1, 0.57, 0.8, 0.09], start: 1.3, in: IN('slide-right') }
				]
			}
		]
	},
	{
		id: 'event-countdown',
		name: 'Event countdown',
		category: 'Events',
		description: 'From Champ Studio’s Event Countdown: a giant number of days to go, the event, then where and when.',
		slots: {
			days: { label: 'Days to go', kind: 'text', maxLength: 4 },
			days_label: { label: 'Under the number', kind: 'text', maxLength: 20 },
			event: { label: 'Event', kind: 'text', maxLength: 40 },
			details: { label: 'When and where', kind: 'text', maxLength: 60 },
			cta: { label: 'Call to action', kind: 'text', maxLength: 26 }
		},
		defaults: { days: '3', days_label: 'days to go', event: 'Annual Day 2026', details: 'Friday, 4 pm · The terrace', cta: 'See you there' },
		scenes: [
			{
				id: 'count',
				sec: 3,
				background: { kind: 'solid', fill: 'dark' },
				layers: [
					{ type: 'text', text: '{days}', style: 'stat', color: 'accent', box: [0.1, 0.32, 0.8, 0.2], align: 'center', start: 0.1, in: IN('zoom-in', 0.6) },
					{ type: 'text', text: '{days_label}', style: 'title', box: [0.1, 0.52, 0.8, 0.08], align: 'center', start: 0.5, in: IN('slide-up') }
				]
			},
			{
				id: 'event',
				sec: 4,
				background: { kind: 'media' },
				layers: [
					{ type: 'text', text: '{event}', style: 'title', box: [0.08, 0.56, 0.84, 0.13], start: 0.2, in: IN('slide-up') },
					{ type: 'text', text: '{details}', style: 'subtitle', box: [0.08, 0.69, 0.84, 0.07], start: 0.6, in: IN('fade') },
					{ type: 'shape', shape: 'pill', fill: 'accent', box: [0.08, 0.79, 0.5, 0.06], start: 1, in: IN('pop') },
					{ type: 'text', text: '{cta}', style: 'button', color: 'dark', box: [0.1, 0.79, 0.46, 0.06], align: 'center', start: 1.2, in: IN('fade') }
				]
			}
		]
	},
	{
		id: 'holiday-greeting',
		name: 'Festive greeting',
		category: 'Events',
		description: 'From Champ Studio’s Holiday Greeting: a greeting over a festive backdrop, a short message and the sign-off.',
		slots: {
			greeting: { label: 'Greeting', kind: 'text', maxLength: 30 },
			message: { label: 'Message', kind: 'text', maxLength: 100 },
			signoff: { label: 'Sign-off', kind: 'text', maxLength: 40 }
		},
		defaults: { greeting: 'Happy Diwali!', message: 'May the festival of lights bring joy, health and success to you and your family.', signoff: 'Team Champions' },
		scenes: [
			{
				id: 'greet',
				sec: 5,
				background: { kind: 'media' },
				layers: [
					confetti(0.4),
					{ type: 'text', text: '{greeting}', style: 'stat', box: [0.06, 0.36, 0.88, 0.16], align: 'center', start: 0.2, in: IN('pop', 0.7) },
					{ type: 'text', text: '{message}', style: 'subtitle', box: [0.1, 0.54, 0.8, 0.16], align: 'center', start: 0.9, in: IN('fade') },
					{ type: 'text', text: '{signoff}', style: 'eyebrow', box: [0.1, 0.74, 0.8, 0.05], align: 'center', start: 1.5, in: IN('fade') }
				]
			}
		]
	},
	{
		id: 'company-news',
		name: 'Company news',
		category: 'Company news',
		description: 'A headline and three points, closing on what to do next: policy updates, launches, wins.',
		slots: {
			eyebrow: { label: 'Label', kind: 'text', maxLength: 22 },
			headline: { label: 'Headline', kind: 'text', maxLength: 50 },
			points: { label: 'Three points', kind: 'list', items: 3, maxLength: 44 },
			cta: { label: 'Call to action', kind: 'text', maxLength: 30 }
		},
		defaults: { eyebrow: 'What’s new', headline: 'Leave and attendance in one place', points: ['Apply leave from the portal', 'See your balance any time', 'Managers approve in a click'], cta: 'Open Champ HR' },
		scenes: [
			{
				id: 'headline',
				sec: 3.2,
				background: { kind: 'gradient' },
				layers: [
					{ type: 'text', text: '{eyebrow}', style: 'eyebrow', box: [0.1, 0.33, 0.8, 0.05], start: 0, in: IN('fade') },
					{ type: 'text', text: '{headline}', style: 'title', box: [0.1, 0.39, 0.8, 0.22], start: 0.3, in: IN('slide-up') }
				]
			},
			{
				id: 'points',
				sec: 4.2,
				background: { kind: 'solid', fill: 'dark' },
				layers: [
					{ type: 'shape', shape: 'ellipse', fill: 'accent', box: [0.1, 0.355, 0.03, 0.017], start: 0.2, in: IN('pop') },
					{ type: 'text', text: '{points.0}', style: 'subtitle', box: [0.16, 0.33, 0.74, 0.08], start: 0.2, in: IN('slide-left') },
					{ type: 'shape', shape: 'ellipse', fill: 'accent', box: [0.1, 0.455, 0.03, 0.017], start: 0.7, in: IN('pop') },
					{ type: 'text', text: '{points.1}', style: 'subtitle', box: [0.16, 0.43, 0.74, 0.08], start: 0.7, in: IN('slide-left') },
					{ type: 'shape', shape: 'ellipse', fill: 'accent', box: [0.1, 0.555, 0.03, 0.017], start: 1.2, in: IN('pop') },
					{ type: 'text', text: '{points.2}', style: 'subtitle', box: [0.16, 0.53, 0.74, 0.08], start: 1.2, in: IN('slide-left') },
					{ type: 'shape', shape: 'pill', fill: 'primary', box: [0.1, 0.7, 0.6, 0.065], start: 1.8, in: IN('wipe') },
					{ type: 'text', text: '{cta}', style: 'button', box: [0.12, 0.7, 0.56, 0.065], align: 'center', start: 2, in: IN('fade') }
				]
			}
		]
	}
];

export function motionTemplate(id: string | null | undefined): MotionTemplate | null {
	return MOTION_TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The default template for each celebration. */
export const CELEBRATION_TEMPLATE: Record<'birthday' | 'work_anniversary' | 'wedding_anniversary', string> = {
	birthday: 'birthday-burst',
	work_anniversary: 'milestone-years',
	wedding_anniversary: 'anniversary-hearts'
};

export type SlotValues = Record<string, string | string[]>;

/** A template's defaults overlaid with what was filled in, lists kept at their length. */
export function withDefaults(t: MotionTemplate, values: SlotValues | null | undefined): SlotValues {
	const out: SlotValues = { ...t.defaults };
	for (const [key, spec] of Object.entries(t.slots)) {
		const v = values?.[key];
		if (spec.kind === 'list') {
			const base = (Array.isArray(out[key]) ? (out[key] as string[]) : []).slice();
			if (Array.isArray(v)) v.forEach((item, i) => { if (typeof item === 'string' && item.trim()) base[i] = item; });
			out[key] = Array.from({ length: spec.items ?? base.length }, (_, i) => (base[i] ?? '').slice(0, spec.maxLength));
		} else if (typeof v === 'string' && v.trim()) {
			out[key] = v.slice(0, spec.maxLength + 40); // room for {placeholders} before they are filled
		}
	}
	return out;
}

export function totalSeconds(t: MotionTemplate): number {
	return t.scenes.reduce((s, sc) => s + sc.sec, 0);
}
