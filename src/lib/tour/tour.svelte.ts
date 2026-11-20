/**
 * Whether the guided tour is running and which step it is on. Kept in
 * sessionStorage so a full page reload mid-tour picks up where it was.
 * ProductTour (mounted once in the app layout) plays it; anything can
 * start it (the avatar menu, the search palette, `?tour` in the URL).
 */
const KEY = 'essTour';
/** Set once the person has started or dismissed the tour in this browser. */
export const SEEN_KEY = 'essTourSeen';

class TourState {
	active = $state(false);
	index = $state(0);

	start(at = 0) {
		this.index = at;
		this.active = true;
		this.save();
		markSeen();
	}

	stop() {
		this.active = false;
		this.save();
	}

	go(i: number) {
		this.index = i;
		this.save();
	}

	/** Resume a tour a reload interrupted. */
	restore() {
		try {
			const raw = sessionStorage.getItem(KEY);
			if (!raw) return;
			const i = Number(raw);
			if (Number.isInteger(i) && i >= 0) {
				this.index = i;
				this.active = true;
			}
		} catch {
			/* storage blocked: the tour just doesn't resume */
		}
	}

	private save() {
		try {
			if (this.active) sessionStorage.setItem(KEY, String(this.index));
			else sessionStorage.removeItem(KEY);
		} catch {
			/* storage blocked */
		}
	}
}

export const tour = new TourState();

export function markSeen() {
	try {
		localStorage.setItem(SEEN_KEY, '1');
	} catch {
		/* storage blocked */
	}
}

export function hasSeen(): boolean {
	try {
		return localStorage.getItem(SEEN_KEY) === '1';
	} catch {
		// Storage blocked: never nag.
		return true;
	}
}
