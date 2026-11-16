<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick, untrack } from 'svelte';
	import Compass from '@lucide/svelte/icons/compass';
	import X from '@lucide/svelte/icons/x';
	import { stepsFor, type TourAccess, type TourStep } from '$lib/tour/steps';
	import { tour, hasSeen, markSeen } from '$lib/tour/tour.svelte';

	/**
	 * The guided tour (steps in src/lib/tour/steps.ts). Dims the screen,
	 * cuts a lit window around the element a step is about, and sets a card
	 * beside it; steps on other pages navigate there first. Clicks outside
	 * the card are held while it runs, so the presenter can't lose their
	 * place; arrow keys move, Esc leaves.
	 *
	 * First visit in a browser: a small invite on Today offers the tour.
	 * `?tour` in any URL starts it too.
	 */
	let { access }: { access: TourAccess } = $props();

	const steps = $derived(stepsFor(access));
	const step = $derived<TourStep | undefined>(tour.active ? steps[tour.index] : undefined);
	const last = $derived(tour.index >= steps.length - 1);

	type Box = { x: number; y: number; w: number; h: number };
	let target = $state<Box | null>(null);
	let ready = $state(false);
	let vw = $state(0);
	let vh = $state(0);
	let cardW = $state(360);
	let cardH = $state(200);
	let cardEl = $state<HTMLElement | null>(null);
	let nextBtn = $state<HTMLButtonElement | null>(null);

	let targetEl: Element | null = null;
	let targetSel = '';
	let seq = 0;
	let dir = 1;

	const PAD = 8; // lit margin around the element
	const GAP = 14; // between the lit window and the card
	const M = 16; // keep the card this far inside the screen

	function visible(el: Element | null): el is Element {
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	}

	function find(sel: string): Element | null {
		const all = document.querySelectorAll(sel);
		for (const el of all) if (visible(el)) return el;
		return null;
	}

	function onRoute(route: string) {
		const want = new URL(route, page.url.origin);
		if (want.pathname !== page.url.pathname) return false;
		// A route with a query (a tab) must match it as well.
		for (const [k, v] of want.searchParams) if (page.url.searchParams.get(k) !== v) return false;
		return true;
	}

	async function show(s: TourStep, my: number) {
		ready = false;
		targetEl = null;
		targetSel = s.target ? `[data-tour="${s.target}"]` : '';
		document.documentElement.toggleAttribute('data-ess-tour-dock', !!s.revealDock);

		if (s.route && !onRoute(s.route)) {
			try {
				await goto(s.route, { noScroll: true });
			} catch {
				/* a refused navigation: carry on where we are */
			}
			if (my !== seq) return;
		}

		if (targetSel) {
			// Pages load their parts as data arrives; give the anchor a moment.
			const until = performance.now() + 3500;
			let el = find(targetSel);
			while (!el && performance.now() < until) {
				await new Promise((r) => setTimeout(r, 80));
				if (my !== seq) return;
				el = find(targetSel);
			}
			if (!el && s.optional) {
				const to = tour.index + dir;
				if (to >= 0 && to < steps.length) tour.go(to);
				else end();
				return;
			}
			targetEl = el;
			if (el) {
				const r = el.getBoundingClientRect();
				if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
					el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
				}
			}
		}
		measure();
		ready = true;
		await tick();
		nextBtn?.focus({ preventScroll: true });
	}

	function measure() {
		vw = innerWidth;
		vh = innerHeight;
		if (targetSel && !targetEl?.isConnected) targetEl = find(targetSel);
		if (targetEl) {
			const r = targetEl.getBoundingClientRect();
			const next = { x: r.left, y: r.top, w: r.width, h: r.height };
			if (!target || Math.abs(target.x - next.x) + Math.abs(target.y - next.y) + Math.abs(target.w - next.w) + Math.abs(target.h - next.h) > 0.5) target = next;
		} else if (target) {
			target = null;
		}
		if (cardEl) {
			const c = cardEl.getBoundingClientRect();
			if (Math.abs(c.width - cardW) > 0.5) cardW = c.width;
			if (Math.abs(c.height - cardH) > 0.5) cardH = c.height;
		}
	}

	// Run a step whenever the tour starts or moves.
	$effect(() => {
		if (!tour.active) return;
		const s = steps[tour.index];
		if (!s) {
			end();
			return;
		}
		const my = ++seq;
		// Untracked: show() reads the URL, and the navigation it makes must
		// not restart the step.
		untrack(() => void show(s, my));
	});

	// Follow the element while the tour runs: pages animate, the dock
	// slides, cards grow as data arrives.
	$effect(() => {
		if (!tour.active) return;
		let raf = requestAnimationFrame(function loop() {
			measure();
			raf = requestAnimationFrame(loop);
		});
		return () => cancelAnimationFrame(raf);
	});

	// The lit window, kept on screen even for an element taller than it.
	const hole = $derived.by((): Box => {
		if (!target || !ready) return { x: vw / 2, y: vh / 2, w: 0, h: 0 };
		const x = Math.max(4, target.x - PAD);
		const y = Math.max(4, target.y - PAD);
		const r = Math.min(vw - 4, target.x + target.w + PAD);
		const b = Math.min(vh - 4, target.y + target.h + PAD);
		return { x, y, w: Math.max(0, r - x), h: Math.max(0, b - y) };
	});

	const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

	const cardPos = $derived.by(() => {
		const cw = cardW;
		const ch = cardH;
		if (!target || !ready || !step?.target) return { left: (vw - cw) / 2, top: (vh - ch) / 2 };
		const h = hole;
		const room = {
			bottom: vh - (h.y + h.h) - GAP - M >= ch,
			top: h.y - GAP - M >= ch,
			right: vw - (h.x + h.w) - GAP - M >= cw,
			left: h.x - GAP - M >= cw
		};
		const order = [step.placement, 'bottom', 'top', 'right', 'left'].filter(Boolean) as (keyof typeof room)[];
		const side = order.find((p) => room[p]);
		const midX = clamp(h.x + h.w / 2 - cw / 2, M, vw - cw - M);
		const midY = clamp(h.y + h.h / 2 - ch / 2, M, vh - ch - M);
		switch (side) {
			case 'bottom':
				return { left: midX, top: h.y + h.h + GAP };
			case 'top':
				return { left: midX, top: h.y - GAP - ch };
			case 'right':
				return { left: h.x + h.w + GAP, top: midY };
			case 'left':
				return { left: h.x - GAP - cw, top: midY };
			default:
				// No room beside it (a full-page element): sit inside its lower right.
				return { left: clamp(h.x + h.w - cw - M, M, vw - cw - M), top: clamp(h.y + h.h - ch - M, M, vh - ch - M) };
		}
	});

	function next() {
		dir = 1;
		if (last) end();
		else tour.go(tour.index + 1);
	}
	function back() {
		dir = -1;
		if (tour.index > 0) tour.go(tour.index - 1);
	}
	function end() {
		seq++;
		tour.stop();
		markSeen();
		target = null;
		ready = false;
		document.documentElement.removeAttribute('data-ess-tour-dock');
	}

	// Keys go to the tour while it runs (captured before page shortcuts
	// like Champ Hub's N or Ctrl K). Buttons in the card still work.
	$effect(() => {
		if (!tour.active) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === 'ArrowRight') {
				e.preventDefault();
				next();
			} else if (e.key === 'ArrowLeft') {
				e.preventDefault();
				back();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				end();
			} else if (e.key === 'Tab' && cardEl) {
				// Keep focus inside the card.
				e.preventDefault();
				const f = [...cardEl.querySelectorAll<HTMLElement>('button:not([disabled])')];
				if (f.length) {
					const i = f.indexOf(document.activeElement as HTMLElement);
					const to = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
					f[to].focus();
				}
			}
			// Enter and Space still press the focused card button (a default
			// action, not a listener); no other key reaches the page.
			e.stopImmediatePropagation();
		}
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});

	// ---------------------------------------------------------- invite
	let inviteOpen = $state(false);

	onMount(() => {
		const url = new URL(location.href);
		if (url.searchParams.has('tour')) {
			url.searchParams.delete('tour');
			// After the router is up; a leftover ?tour is harmless if this fails.
			setTimeout(() => {
				try {
					replaceState(url, page.state);
				} catch {
					/* keep the URL as it is */
				}
			});
			tour.start(0);
			return;
		}
		tour.restore();
		if (!tour.active && !hasSeen() && page.url.pathname === '/dashboard') {
			const t = setTimeout(() => (inviteOpen = !tour.active && !hasSeen()), 1500);
			return () => clearTimeout(t);
		}
	});

	// Leaving Today puts the invite away until next time.
	$effect(() => {
		if (page.url.pathname !== '/dashboard') inviteOpen = false;
	});

	function startFromInvite() {
		inviteOpen = false;
		tour.start(0);
	}
	function dismissInvite() {
		inviteOpen = false;
		markSeen();
	}
</script>

<svelte:window onresize={measure} />

{#if tour.active && step}
	<!-- Holds clicks outside the card so the tour keeps its place. -->
	<div class="tour-block" aria-hidden="true"></div>
	<div
		class="tour-hole"
		class:lit={!!target && ready}
		aria-hidden="true"
		style:left="{hole.x}px"
		style:top="{hole.y}px"
		style:width="{hole.w}px"
		style:height="{hole.h}px"
	></div>
	<div
		class="tour-card"
		class:waiting={!ready}
		role="dialog"
		aria-modal="true"
		aria-labelledby="tour-title"
		aria-describedby="tour-body"
		bind:this={cardEl}
		style:left="{cardPos.left}px"
		style:top="{cardPos.top}px"
	>
		<div class="tour-meta">
			<span class="tour-chapter">{step.chapter}</span>
			<span class="tour-count">{tour.index + 1} of {steps.length}</span>
			<button type="button" class="tour-x" onclick={end} aria-label="Close the tour"><X size={16} /></button>
		</div>
		<h2 id="tour-title" class="tour-title">{step.title}</h2>
		<p id="tour-body" class="tour-body">{step.body}</p>
		<div class="tour-progress" aria-hidden="true"><span style:width="{((tour.index + 1) / steps.length) * 100}%"></span></div>
		<div class="tour-actions">
			{#if !last}
				<button type="button" class="tour-skip" onclick={end}>Skip tour</button>
			{/if}
			<span class="tour-spacer"></span>
			{#if tour.index > 0}
				<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={back}>Back</button>
			{/if}
			<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" onclick={next} bind:this={nextBtn}>
				{tour.index === 0 ? 'Start the tour' : last ? 'Finish' : 'Next'}
			</button>
		</div>
	</div>
{/if}

{#if inviteOpen && !tour.active}
	<div class="tour-invite" role="dialog" aria-labelledby="tour-invite-title">
		<span class="invite-icon" aria-hidden="true"><Compass size={20} /></span>
		<div class="invite-text">
			<strong id="tour-invite-title">New to Champ HR?</strong>
			<span>Take a two-minute tour of the portal.</span>
		</div>
		<div class="invite-actions">
			<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={dismissInvite}>Not now</button>
			<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" onclick={startFromInvite}>Take the tour</button>
		</div>
	</div>
{/if}

<style>
	.tour-block {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: transparent;
	}
	/* The dim is this box's shadow, so the box itself is the lit window. */
	.tour-hole {
		position: fixed;
		z-index: 1001;
		pointer-events: none;
		border-radius: 14px;
		box-shadow: 0 0 0 200vmax rgba(12, 14, 28, 0.55);
		transition:
			left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
			top 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
			width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
			height 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.tour-hole.lit {
		outline: 2px solid var(--ess-primary);
		outline-offset: 0;
	}
	.tour-card {
		position: fixed;
		z-index: 1002;
		width: min(360px, calc(100vw - 32px));
		padding: 16px 18px 14px;
		background: var(--ess-modal-bg);
		color: var(--ess-text);
		border: 1px solid var(--ess-border);
		border-radius: 16px;
		box-shadow: 0 24px 60px -18px rgba(12, 14, 28, 0.45);
		font-family: var(--ess-font-sans);
		transition:
			left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
			top 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
			opacity 0.18s ease;
	}
	.tour-card.waiting {
		opacity: 0;
		pointer-events: none;
	}
	.tour-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
		font-size: 12px;
	}
	.tour-chapter {
		color: var(--ess-primary-text);
		font-weight: 600;
		letter-spacing: 0.01em;
	}
	.tour-count {
		color: var(--ess-text-muted);
		font-variant-numeric: tabular-nums;
	}
	.tour-x {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		margin: -4px -6px -4px auto;
		padding: 0;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--ess-text-muted);
		cursor: pointer;
	}
	.tour-x:hover {
		background: var(--ess-surface-hover);
		color: var(--ess-text);
	}
	.tour-title {
		margin: 0 0 6px;
		font-size: 17px;
		font-weight: 650;
		line-height: 1.3;
		letter-spacing: -0.01em;
	}
	.tour-body {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--ess-text-secondary);
	}
	.tour-progress {
		height: 3px;
		margin: 14px 0 12px;
		border-radius: 3px;
		background: var(--ess-sunken);
		overflow: hidden;
	}
	.tour-progress span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--ess-primary);
		transition: width 0.32s ease;
	}
	.tour-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.tour-spacer {
		flex: 1;
	}
	.tour-skip {
		padding: 4px 2px;
		border: none;
		background: transparent;
		color: var(--ess-text-muted);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.tour-skip:hover {
		color: var(--ess-text);
		text-decoration: underline;
	}

	/* ---------- first-visit invite, bottom right ---------- */
	.tour-invite {
		position: fixed;
		left: 50%;
		bottom: 24px;
		transform: translateX(-50%);
		z-index: 70;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 10px 12px;
		align-items: center;
		width: min(340px, calc(100vw - 32px));
		padding: 14px 16px;
		background: var(--ess-modal-bg);
		color: var(--ess-text);
		border: 1px solid var(--ess-border);
		border-radius: 16px;
		box-shadow: var(--ess-elev-3);
		animation: invite-in 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.invite-icon {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		border-radius: 12px;
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	.invite-text {
		display: grid;
		gap: 2px;
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.invite-text strong {
		font-size: 14px;
		color: var(--ess-text);
	}
	.invite-actions {
		grid-column: 1 / -1;
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	@keyframes invite-in {
		from {
			opacity: 0;
			transform: translate(-50%, 10px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.tour-hole,
		.tour-card,
		.tour-progress span {
			transition: none;
		}
		.tour-invite {
			animation: none;
		}
	}
</style>
