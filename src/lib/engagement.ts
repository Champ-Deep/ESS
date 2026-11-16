import { toIsoDate } from './alumni';

/**
 * Celebrations the portal shows by itself (Engagement studio; the Home reel).
 * Pure, so the rules for "whose day is it" and the template words are tested
 * without a database.
 */

export const CELEBRATION_KINDS = ['birthday', 'work_anniversary', 'wedding_anniversary'] as const;
export type CelebrationKind = (typeof CELEBRATION_KINDS)[number];

export const CELEBRATION_LABEL: Record<CelebrationKind, string> = {
	birthday: 'Birthday',
	work_anniversary: 'Work anniversary',
	wedding_anniversary: 'Wedding anniversary'
};

/** The placeholders a template may use, for the studio's hint line. */
export const TEMPLATE_PLACEHOLDERS = ['{first_name}', '{name}', '{years}', '{years_word}', '{team}', '{designation}'];

export type CelebrationPerson = {
	fullName: string;
	team?: string | null;
	designation?: string | null;
	dob?: string | null;
	dateOfJoining?: string | null;
	/** Free text in the HR sheet ("12-Feb-2015", "12/02"); read when it parses. */
	weddingAnniversary?: string | null;
};

export type Celebration = { kind: CelebrationKind; years: number | null };

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Same month and day; a 29 February date is celebrated on the 28th in other years. */
function sameDay(source: string, on: string): boolean {
	const md = source.slice(5, 10);
	const onMd = on.slice(5, 10);
	if (md === onMd) return true;
	return md === '02-29' && onMd === '02-28' && !isLeap(Number(on.slice(0, 4)));
}

/** Wedding anniversaries are free text; a day and month without a year also count. */
function anniversaryDate(text: string | null | undefined): string | null {
	if (!text) return null;
	const full = toIsoDate(text);
	if (full) return full;
	const m = text.trim().match(/^(\d{1,2})[/.\-\s]+(\d{1,2}|[a-z]{3})[a-z]*$/i);
	if (!m) return null;
	const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
	const month = /^\d+$/.test(m[2]) ? Number(m[2]) : months[m[2].toLowerCase()];
	const day = Number(m[1]);
	if (!month || month > 12 || day < 1 || day > 31) return null;
	return `2000-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** What `person` celebrates on `on` (YYYY-MM-DD). */
export function celebrationsOn(on: string, person: CelebrationPerson): Celebration[] {
	const out: Celebration[] = [];
	if (person.dob && sameDay(person.dob, on)) out.push({ kind: 'birthday', years: null });
	if (person.dateOfJoining && sameDay(person.dateOfJoining, on)) {
		const years = Number(on.slice(0, 4)) - Number(person.dateOfJoining.slice(0, 4));
		if (years >= 1) out.push({ kind: 'work_anniversary', years });
	}
	const wedding = anniversaryDate(person.weddingAnniversary);
	if (wedding && sameDay(wedding, on)) {
		const y = Number(wedding.slice(0, 4));
		out.push({ kind: 'wedding_anniversary', years: y > 2000 || (y < 2000 && y > 1900) ? Number(on.slice(0, 4)) - y : null });
	}
	return out;
}

/** Fills {first_name}, {name}, {years}, {years_word}, {team}, {designation}. */
export function renderTemplate(text: string, person: CelebrationPerson, years: number | null): string {
	const first = person.fullName.trim().split(/\s+/)[0] ?? person.fullName;
	const values: Record<string, string> = {
		first_name: first,
		name: person.fullName.trim(),
		years: years !== null ? String(years) : '',
		years_word: years === 1 ? 'year' : 'years',
		team: person.team?.trim() || 'the team',
		designation: person.designation?.trim() || ''
	};
	return text
		.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole))
		.replace(/\s{2,}/g, ' ')
		.trim();
}

/** Whether a reel runs on `today` (dates inclusive, open-ended when unset). */
export function reelRunsOn(reel: { active: boolean; startsOn: string | null; endsOn: string | null }, today: string): boolean {
	if (!reel.active) return false;
	if (reel.startsOn && today < reel.startsOn) return false;
	if (reel.endsOn && today > reel.endsOn) return false;
	return true;
}

/** Reels are meant to be short: the studio refuses anything longer. */
export const REEL_MAX_SECONDS = 30;
export const REEL_MAX_BYTES = 20 * 1024 * 1024;
export const REEL_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
