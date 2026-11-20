<script lang="ts">
	/**
	 * The dashboard's absence planner: one row per person the viewer may see
	 * (see dashboard/planner.server.ts), one column per day of the month.
	 * Bars are real leave applications — approved solid, pending outlined —
	 * over the person's own week offs and holiday calendar.
	 *
	 * Selecting a bar opens its details in a side sheet; when the request is
	 * in the viewer's queue they can approve or reject it right there, through
	 * the same /api/leave/[id]/approve endpoint the Leave page uses.
	 *
	 * Under the grid sits the viewer's own leave (MyLeaveRail), and dragging
	 * across your own row opens a plan for those days (PlanLeaveSheet).
	 */
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import PanelBottom from '@lucide/svelte/icons/panel-bottom';
	import { goto, invalidateAll } from '$app/navigation';
	import Avatar from '$lib/components/Avatar.svelte';
	import SideSheet from '$lib/components/hub/SideSheet.svelte';
	import MyLeaveRail from './MyLeaveRail.svelte';
	import PlanLeaveSheet from './PlanLeaveSheet.svelte';
	import type { MyLeave } from '$lib/leave-planning';

	type Tone = 'blue' | 'purple' | 'green' | 'yellow' | 'pink';
	type Person = {
		id: string;
		fullName: string;
		designation: string | null;
		hasPicture: boolean;
		isMe: boolean;
		offDays: string;
		holidays: { day: number; name: string }[];
	};
	type Leave = {
		id: string;
		userId: string;
		typeName: string;
		tone: Tone;
		start: string;
		end: string;
		days: number;
		status: 'approved' | 'pending';
		stage: 'Manager review' | 'HR review' | null;
		reviewable: boolean;
		reason: string | null;
	};

	interface Props {
		planner: {
			month: { key: string; year: number; month: number; days: number };
			people: Person[];
			leaves: Leave[];
			legend: { name: string; tone: Tone }[];
		};
		me?: MyLeave;
	}

	let { planner, me }: Props = $props();

	const pad = (n: number) => String(n).padStart(2, '0');

	// The viewer's own clock decides "today", after hydration.
	let todayKey = $state('');
	$effect(() => {
		const d = new Date();
		todayKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	});

	const monthLabel = $derived(
		new Date(planner.month.year, planner.month.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
	);

	const days = $derived(
		Array.from({ length: planner.month.days }, (_, i) => {
			const d = new Date(planner.month.year, planner.month.month, i + 1);
			const key = `${planner.month.key}-${pad(i + 1)}`;
			return {
				n: i + 1,
				key,
				dow: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
				weekend: d.getDay() === 0 || d.getDay() === 6
			};
		})
	);
	const todayIndex = $derived(todayKey.startsWith(planner.month.key) ? Number(todayKey.slice(8, 10)) : 0);

	/* ---------- month navigation ---------- */
	function shiftMonth(delta: number) {
		const d = new Date(planner.month.year, planner.month.month + delta, 1);
		void goto(`?m=${d.getFullYear()}-${pad(d.getMonth() + 1)}`, { noScroll: true, keepFocus: true });
	}
	function thisMonth() {
		void goto('?', { noScroll: true, keepFocus: true });
	}
	const isCurrentMonth = $derived(todayKey === '' || todayKey.startsWith(planner.month.key));

	/* ---------- filters ---------- */
	let status = $state<'all' | 'approved' | 'pending'>('all');
	let awayOnly = $state(false);
	let query = $state('');
	let hiddenTypes = $state<string[]>([]);

	function toggleType(name: string) {
		hiddenTypes = hiddenTypes.includes(name) ? hiddenTypes.filter((t) => t !== name) : [...hiddenTypes, name];
	}

	const visibleLeaves = $derived(
		planner.leaves.filter((l) => (status === 'all' || l.status === status) && !hiddenTypes.includes(l.typeName))
	);

	const leavesByUser = $derived.by(() => {
		const map = new Map<string, Leave[]>();
		for (const l of visibleLeaves) {
			const list = map.get(l.userId) ?? [];
			list.push(l);
			map.set(l.userId, list);
		}
		return map;
	});

	const rows = $derived(
		planner.people.filter((p) => {
			if (awayOnly && !leavesByUser.has(p.id)) return false;
			const q = query.trim().toLowerCase();
			return !q || p.fullName.toLowerCase().includes(q) || (p.designation ?? '').toLowerCase().includes(q);
		})
	);

	const awayToday = $derived(
		todayIndex
			? new Set(planner.leaves.filter((l) => l.status === 'approved' && l.start <= todayKey && l.end >= todayKey).map((l) => l.userId)).size
			: 0
	);
	const pendingCount = $derived(planner.leaves.filter((l) => l.status === 'pending').length);

	/** Grid columns a leave covers in this month (1-based, end exclusive). */
	function span(l: Leave) {
		const first = `${planner.month.key}-01`;
		const s = l.start < first ? 1 : Number(l.start.slice(8, 10));
		const e = l.end.slice(0, 7) > planner.month.key ? planner.month.days : Number(l.end.slice(8, 10));
		return { s, e: e + 1, len: e - s + 1, clipStart: l.start < first, clipEnd: l.end.slice(0, 7) > planner.month.key };
	}

	/* ---------- my leave ---------- */
	// Open unless this browser closed it last time.
	const RAIL_KEY = 'ess.planner.myLeave';
	let showRail = $state(true);
	$effect(() => {
		try {
			showRail = localStorage.getItem(RAIL_KEY) !== '0';
		} catch {
			/* storage blocked: keep it open */
		}
	});
	function toggleRail() {
		showRail = !showRail;
		try {
			localStorage.setItem(RAIL_KEY, showRail ? '1' : '0');
		} catch {
			/* not remembered, still toggled */
		}
	}

	/* ---------- planning on your own row ---------- */
	// Press a day on your own row and drag; letting go opens the plan sheet.
	let dragFrom = $state<number | null>(null);
	let dragTo = $state<number | null>(null);
	let plan = $state<{ start: string; end: string; typeId?: string } | null>(null);
	const selLo = $derived(dragFrom !== null && dragTo !== null ? Math.min(dragFrom, dragTo) : 0);
	const selHi = $derived(dragFrom !== null && dragTo !== null ? Math.max(dragFrom, dragTo) : 0);

	function openPlan(start: string, end: string, typeId?: string) {
		plan = { start, end, typeId };
	}
	function pickStart(n: number, e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		dragFrom = dragTo = n;
	}
	function pickOver(n: number) {
		if (dragFrom !== null) dragTo = n;
	}
	function pickEnd() {
		if (dragFrom === null || dragTo === null) return;
		openPlan(days[selLo - 1].key, days[selHi - 1].key);
		dragFrom = dragTo = null;
	}

	/** Your month at a glance, in the subtitle when your row is the only one. */
	const myMonth = $derived.by(() => {
		const meRow = planner.people.length === 1 ? planner.people[0] : null;
		if (!meRow?.isMe) return null;
		const offs = [...meRow.offDays].filter((c) => c === '1').length;
		const hols = meRow.holidays.filter((h) => meRow.offDays[h.day - 1] !== '1');
		let leave = 0;
		for (const l of planner.leaves) {
			const sp = span(l);
			for (let n = sp.s; n < sp.e; n++) if (meRow.offDays[n - 1] !== '1') leave++;
		}
		return { working: planner.month.days - offs - hols.length, offs, hols, leave };
	});

	/** Everyone else's leave on the planner, for "also away" in the plan sheet. */
	const othersAway = $derived(
		planner.leaves
			.filter((l) => !planner.people.find((p) => p.id === l.userId)?.isMe)
			.map((l) => ({ name: nameOf(l.userId), start: l.start, end: l.end, status: l.status }))
	);

	/** Overlapping requests for one person go on separate lines of their row. */
	function lanesFor(list: Leave[]) {
		const ends: string[] = [];
		const lane = new Map<string, number>();
		for (const l of [...list].sort((a, b) => a.start.localeCompare(b.start))) {
			let i = ends.findIndex((e) => e < l.start);
			if (i === -1) i = ends.push(l.end) - 1;
			else ends[i] = l.end;
			lane.set(l.id, i + 1);
		}
		return { lane, count: Math.max(1, ends.length) };
	}

	/** "Earned Leave" → "EL", for bars too short for the full name. */
	const shortName = (name: string) =>
		name
			.split(/\s+/)
			.filter(Boolean)
			.map((w) => w[0])
			.join('')
			.slice(0, 3)
			.toUpperCase();

	/* ---------- detail + decisions ---------- */
	const nameOf = (id: string) => planner.people.find((p) => p.id === id)?.fullName ?? 'Someone';
	let selected = $state<Leave | null>(null);
	let busy = $state<'approve' | 'reject' | null>(null);
	let rejecting = $state(false);
	let note = $state('');
	let error = $state('');
	let done = $state('');

	function open(l: Leave) {
		selected = l;
		rejecting = false;
		note = '';
		error = '';
		done = '';
	}
	function close() {
		selected = null;
	}

	function fmtDay(iso: string) {
		return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
	}
	function fmtRange(l: Leave) {
		return l.start === l.end ? fmtDay(l.start) : `${fmtDay(l.start)} – ${fmtDay(l.end)}`;
	}
	function fmtDays(n: number) {
		return `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? 'day' : 'days'}`;
	}

	async function decide(decision: 'approve' | 'reject') {
		const l = selected;
		if (!l || busy) return;
		busy = decision;
		error = '';
		try {
			const trimmed = note.trim();
			const res = await fetch(`/api/leave/${l.id}/approve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(decision === 'reject' && trimmed ? { decision, note: trimmed } : { decision })
			});
			const body: { status?: string; message?: string } = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = body.message ?? (res.status === 403 ? 'This request is no longer yours to decide.' : 'Could not record your decision.');
				return;
			}
			done =
				decision === 'reject'
					? `Rejected ${nameOf(l.userId)}'s leave.`
					: body.status === 'escalated'
						? 'Approved — sent on to HR review.'
						: `Approved ${nameOf(l.userId)}'s leave.`;
			await invalidateAll();
		} catch {
			error = 'Could not reach the server. Check your connection and try again.';
		} finally {
			busy = null;
		}
	}
</script>

<svelte:window onpointerup={pickEnd} />

<section class="planner ess-card" aria-labelledby="planner-h" data-tour="planner">
	<header class="head">
		<div class="title">
			<h2 id="planner-h">Absence planner</h2>
			<p>
				{#if myMonth}
					{myMonth.working} working days · {myMonth.offs} week offs · {myMonth.leave} on leave · {myMonth.hols.length}
					{myMonth.hols.length === 1 ? 'holiday' : 'holidays'}
				{:else}
					{#if todayIndex}{awayToday} away today ·{/if}
					{pendingCount} pending
					{#if planner.people.length > 1}· {planner.people.length} people{/if}
				{/if}
			</p>
		</div>

		<div class="month" role="group" aria-label="Month">
			<button type="button" class="nav-btn" onclick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
			<span class="month-label" aria-live="polite">{monthLabel}</span>
			<button type="button" class="nav-btn" onclick={() => shiftMonth(1)} aria-label="Next month"><ChevronRight size={16} /></button>
			{#if !isCurrentMonth}
				<button type="button" class="today-btn" onclick={thisMonth}>Today</button>
			{/if}
		</div>

		<div class="controls">
			{#if planner.people.length > 6}
				<label class="find">
					<Search size={14} aria-hidden="true" />
					<span class="ess-sr-only">Find a person</span>
					<input type="search" placeholder="Find a person" bind:value={query} />
				</label>
			{/if}
			<div class="seg" role="group" aria-label="Status">
				{#each [['all', 'All'], ['approved', 'Approved'], ['pending', 'Pending']] as [v, label] (v)}
					<button type="button" aria-pressed={status === v} onclick={() => (status = v as typeof status)}>{label}</button>
				{/each}
			</div>
			{#if planner.people.length > 1}
				<button type="button" class="chip" aria-pressed={awayOnly} onclick={() => (awayOnly = !awayOnly)}>Away only</button>
			{/if}
			{#if me}
				<button type="button" class="chip with-ic" aria-pressed={showRail} onclick={toggleRail} title={showRail ? 'Hide my leave' : 'Show my leave'}>
					<PanelBottom size={14} /> My leave
				</button>
			{/if}
		</div>
	</header>

	<div class="body">
		<div class="scroller" role="region" aria-label="Absences in {monthLabel}" tabindex="-1">
			<div class="grid" style="--days: {planner.month.days}">
				<div class="row hrow">
					<div class="who who-h">Employee</div>
					{#each days as d (d.key)}
						<div class="dh" class:weekend={d.weekend} class:today={d.n === todayIndex} aria-hidden="true">
							<span class="dow">{d.dow}</span>
							<span class="dn">{d.n}</span>
						</div>
					{/each}
				</div>

				{#each rows as p (p.id)}
					{@const mine = leavesByUser.get(p.id) ?? []}
					{@const lanes = lanesFor(mine)}
					<div class="row" style="--lanes: {lanes.count}">
						<div class="who">
							<Avatar userId={p.id} fullName={p.fullName} hasPicture={p.hasPicture} size="sm" />
							<span class="who-text">
								<span class="name">{p.fullName}{#if p.isMe}<span class="me">&nbsp;· You</span>{/if}</span>
								<span class="role">{p.designation ?? '—'}</span>
							</span>
						</div>
						{#each days as d, i (d.key)}
							{@const hol = p.holidays.find((h) => h.day === d.n)}
							{#if p.isMe && me}
								<button
									type="button"
									class="cell pick"
									class:off={p.offDays[i] === '1'}
									class:hol={!!hol}
									class:today={d.n === todayIndex}
									class:sel={selLo > 0 && d.n >= selLo && d.n <= selHi}
									style="grid-column: {i + 2}"
									title={hol ? `${hol.name} · drag to plan` : p.offDays[i] === '1' ? 'Week off' : 'Drag to plan time off'}
									aria-label="Plan time off from {fmtDay(d.key)}{hol ? ` (${hol.name})` : ''}"
									onpointerdown={(e) => pickStart(d.n, e)}
									onpointerenter={() => pickOver(d.n)}
									onclick={(e) => e.detail === 0 && openPlan(d.key, d.key)}
								></button>
							{:else}
								<span
									class="cell"
									class:off={p.offDays[i] === '1'}
									class:hol={!!hol}
									class:today={d.n === todayIndex}
									style="grid-column: {i + 2}"
									title={hol ? hol.name : p.offDays[i] === '1' ? 'Week off' : undefined}
								></span>
							{/if}
						{/each}
						{#each mine as l (l.id)}
							{@const sp = span(l)}
							<button
								type="button"
								class="bar"
								data-tone={l.tone}
								class:pending={l.status === 'pending'}
								class:clip-s={sp.clipStart}
								class:clip-e={sp.clipEnd}
								class:act={l.reviewable}
								style="grid-column: {sp.s + 1} / {sp.e + 1}; grid-row: {lanes.lane.get(l.id)}"
								title="{l.typeName} · {fmtRange(l)} · {l.status === 'pending' ? 'Pending' : 'Approved'}"
								onclick={() => open(l)}
								aria-label="{p.fullName}: {l.typeName}, {fmtRange(l)}, {l.status === 'pending' ? 'pending' : 'approved'}{l.reviewable
									? ', waiting on you'
									: ''}"
							>
								<!-- Which label shows depends on the bar's own width (see .bar). -->
								<span class="bar-name full">{l.typeName}</span>
								<span class="bar-name short" aria-hidden="true">{shortName(l.typeName)}</span>
								{#if l.status === 'pending'}<span class="bar-status">Pending</span>{/if}
							</button>
						{/each}
					</div>
				{:else}
					<p class="none">
						{planner.people.length === 0 ? 'No one to show yet.' : 'No one matches these filters.'}
					</p>
				{/each}
			</div>
		</div>
		{#if me && showRail}
			<MyLeaveRail {me} onplan={openPlan} />
		{/if}
	</div>

	<footer class="legend" aria-label="Legend">
		{#each planner.legend as t (t.name)}
			<button
				type="button"
				class="key"
				data-tone={t.tone}
				aria-pressed={!hiddenTypes.includes(t.name)}
				onclick={() => toggleType(t.name)}
				title={hiddenTypes.includes(t.name) ? `Show ${t.name}` : `Hide ${t.name}`}
			>
				<span class="swatch"></span>{t.name}
			</button>
		{:else}
			<span class="key-note">No leave this month.</span>
		{/each}
		<span class="key static"><span class="swatch pending-sw"></span>Pending</span>
		<span class="key static"><span class="swatch off-sw"></span>Week off</span>
		<span class="key static"><span class="swatch hol-sw"></span>Holiday</span>
		{#if me}<span class="hint">Drag across your row to plan time off</span>{/if}
	</footer>
</section>

{#if plan && me}
	<PlanLeaveSheet {me} start={plan.start} end={plan.end} typeId={plan.typeId} others={othersAway} onclose={() => (plan = null)} />
{/if}

{#if selected}
	<SideSheet label="Leave details" onclose={close}>
		<div class="sheet">
			<header class="sheet-head">
				<div>
					<h2>{nameOf(selected.userId)}</h2>
					<p>{selected.typeName}</p>
				</div>
				<button type="button" class="ess-icon-btn" onclick={close} aria-label="Close"><X size={18} /></button>
			</header>

			<dl class="facts">
				<div><dt>Dates</dt><dd>{fmtRange(selected)}</dd></div>
				<div><dt>Length</dt><dd>{fmtDays(selected.days)}</dd></div>
				<div>
					<dt>Status</dt>
					<dd>
						{#if selected.status === 'approved'}
							<span class="ess-badge ess-badge--approved">Approved</span>
						{:else}
							<span class="ess-badge ess-badge--pending">Pending</span>
							<span class="stage">{selected.stage}</span>
						{/if}
					</dd>
				</div>
				{#if selected.reason}
					<div><dt>Reason</dt><dd>{selected.reason}</dd></div>
				{/if}
			</dl>

			{#if done}
				<p class="ok" role="status">{done}</p>
				<div class="actions"><button type="button" class="ess-btn ess-btn--primary" onclick={close}>Done</button></div>
			{:else if selected.reviewable}
				{#if rejecting}
					<label class="note">
						<span>Reason for rejecting (optional, shared with {nameOf(selected.userId).split(' ')[0]})</span>
						<textarea class="ess-textarea" rows="3" bind:value={note} maxlength="500"></textarea>
					</label>
				{/if}
				{#if error}<p class="err" role="alert">{error}</p>{/if}
				<div class="actions">
					{#if rejecting}
						<button type="button" class="ess-btn ess-btn--secondary" disabled={!!busy} onclick={() => (rejecting = false)}>Back</button>
						<button type="button" class="ess-btn ess-btn--danger" disabled={!!busy} onclick={() => decide('reject')}>
							{busy === 'reject' ? 'Rejecting…' : 'Reject leave'}
						</button>
					{:else}
						<button type="button" class="ess-btn ess-btn--secondary" disabled={!!busy} onclick={() => (rejecting = true)}>Reject</button>
						<button type="button" class="ess-btn ess-btn--primary" disabled={!!busy} onclick={() => decide('approve')}>
							{busy === 'approve' ? 'Approving…' : 'Approve'}
						</button>
					{/if}
				</div>
			{:else}
				<div class="actions"><a class="ess-btn ess-btn--secondary" href="/leave">Open Leave</a></div>
			{/if}
		</div>
	</SideSheet>
{/if}

<style>
	.planner {
		display: flex;
		flex-direction: column;
		min-height: 0;
		padding: 10px 16px 8px;
		gap: 8px;
	}

	/* ---------- head ---------- */
	.head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px 18px;
	}
	.title h2 {
		margin: 0;
		font-size: 17px;
		font-weight: 650;
		letter-spacing: -0.015em;
	}
	.title p {
		margin: 1px 0 0;
		font-size: 12px;
		color: var(--ess-text-muted);
	}

	.month {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px;
		border-radius: 999px;
		background: var(--ess-sunken);
	}
	.month-label {
		min-width: 118px;
		text-align: center;
		font-size: 13px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.nav-btn,
	.today-btn {
		display: grid;
		place-items: center;
		height: 28px;
		min-width: 28px;
		border: 0;
		border-radius: 999px;
		background: var(--ess-surface);
		color: var(--ess-text-secondary);
		box-shadow: 0 1px 2px rgba(20, 22, 40, 0.06);
		cursor: pointer;
	}
	.today-btn {
		padding: 0 10px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ess-primary-text);
	}
	.nav-btn:hover,
	.today-btn:hover {
		color: var(--ess-text);
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
		flex-wrap: wrap;
	}

	.find {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 32px;
		padding: 0 12px;
		border-radius: 999px;
		background: var(--ess-sunken);
		color: var(--ess-text-muted);
	}
	.find input {
		width: 120px;
		border: 0;
		background: none;
		font: inherit;
		font-size: 12.5px;
		color: var(--ess-text);
		outline: none;
	}

	.seg {
		display: flex;
		padding: 3px;
		border-radius: 999px;
		background: var(--ess-sunken);
	}
	.seg button,
	.chip {
		height: 26px;
		padding: 0 11px;
		border: 0;
		border-radius: 999px;
		background: none;
		color: var(--ess-text-muted);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}
	.seg button[aria-pressed='true'] {
		background: var(--ess-surface);
		color: var(--ess-text);
		box-shadow: 0 1px 2px rgba(20, 22, 40, 0.08);
	}
	.chip {
		height: 32px;
		padding: 0 12px;
		background: var(--ess-sunken);
	}
	.chip.with-ic {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.chip[aria-pressed='true'] {
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	/* ---------- grid + my leave ---------- */
	/* Two areas, one above the other and never layered: the calendar in its
	   own height-capped scroll box (day header pinned inside it), and My
	   leave always in full below it. The cap is what keeps the card small. */
	.body {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.scroller {
		min-width: 0;
		/* Down through people past the cap; sideways when the month is wider
		   than the screen. */
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		margin: 0 -4px;
		padding: 0 4px;
		outline: none;
	}
	/* Laptops: six or so rows show, the rest scroll. Phones and tablets:
	   half the screen. */
	@media (min-width: 1101px) {
		.scroller {
			max-height: clamp(180px, calc(58vh - 230px), 420px);
		}
	}
	@media (min-width: 1101px) and (max-height: 800px) {
		.scroller {
			max-height: 170px;
		}
	}
	@media (max-width: 1100px) {
		.scroller {
			max-height: 50vh;
		}
	}

	.grid {
		--who: 210px;
		--cell-min: 26px;
		--lane-h: 26px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: calc(var(--who) + var(--days) * (var(--cell-min) + 3px));
	}

	/* One line per lane: a person with overlapping requests gets a taller
	   row rather than bars drawn over each other. Names and day cells span
	   every lane; each bar sits on its own (set inline). */
	.row {
		display: grid;
		grid-template-columns: var(--who) repeat(var(--days), minmax(var(--cell-min), 1fr));
		grid-template-rows: repeat(var(--lanes, 1), var(--lane-h));
		gap: 3px;
		padding: 2px 0;
	}
	.row > :global(*) {
		grid-row: 1 / -1;
	}

	.hrow {
		position: sticky;
		top: 0;
		z-index: 3;
		grid-template-rows: 1fr;
		align-items: center;
		height: 34px;
		padding: 0;
		/* Solid: rows scrolling under it are hidden, not seen through. */
		background: var(--ess-surface);
		-webkit-backdrop-filter: blur(16px) saturate(160%);
		backdrop-filter: blur(16px) saturate(160%);
	}

	.who {
		grid-column: 1;
		position: sticky;
		left: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 9px;
		min-width: 0;
		height: 100%;
		padding-right: 10px;
		background: transparent;
	}
	/* Narrow screens scroll the grid sideways under the names: back them
	   solid so bars pass behind rather than through. */
	@media (max-width: 1100px) {
		.who {
			background: var(--ess-surface);
			-webkit-backdrop-filter: blur(16px) saturate(160%);
			backdrop-filter: blur(16px) saturate(160%);
		}
	}
	.who-h {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--ess-text-muted);
	}
	.who-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.25;
	}
	.name {
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.me {
		font-weight: 500;
		color: var(--ess-primary-text);
	}
	.role {
		font-size: 11.5px;
		color: var(--ess-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dh {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 32px;
		border-radius: 10px;
		line-height: 1.15;
		font-variant-numeric: tabular-nums;
	}
	.dow {
		font-size: 10.5px;
		color: var(--ess-text-muted);
	}
	.dn {
		font-size: 12.5px;
		font-weight: 600;
	}
	.dh.weekend .dn,
	.dh.weekend .dow {
		color: var(--ess-text-muted);
		font-weight: 500;
	}
	.dh.today {
		background: var(--ess-primary);
		box-shadow: var(--ess-primary-shadow);
	}
	.dh.today .dn,
	.dh.today .dow {
		color: var(--ess-text-on-primary);
	}

	.cell {
		border-radius: 7px;
		background: var(--ess-cell);
	}
	.cell.off {
		background: repeating-linear-gradient(
			-45deg,
			var(--ess-cell-off),
			var(--ess-cell-off) 3px,
			var(--ess-cell) 3px,
			var(--ess-cell) 6px
		);
	}
	.cell.hol {
		background: var(--ess-ev-yellow-bg);
		box-shadow: inset 0 0 0 1px var(--ess-ev-yellow-line);
	}
	.cell.today {
		box-shadow: inset 0 0 0 1.5px var(--ess-primary-ring);
	}
	.cell.pick {
		display: block;
		padding: 0;
		border: 0;
		cursor: cell;
		touch-action: none;
		transition:
			box-shadow var(--ess-t-fast),
			background var(--ess-t-fast);
	}
	.cell.pick:hover {
		box-shadow: inset 0 0 0 1.5px var(--ess-primary);
	}
	.cell.sel {
		background: var(--ess-primary-soft);
		box-shadow: inset 0 0 0 1.5px var(--ess-primary);
	}

	/* ---------- bars ---------- */
	.bar {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding: 0 3px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--fill);
		color: var(--ink);
		font: inherit;
		font-size: 11.5px;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
		overflow: hidden;
		/* The labels below answer to the bar's width, at any text size. */
		container-type: inline-size;
		transition:
			transform var(--ess-t-fast),
			box-shadow var(--ess-t-fast);
	}
	.bar:hover {
		box-shadow: 0 4px 10px -4px rgba(20, 22, 40, 0.25);
	}
	.bar[data-tone='blue'],
	.key[data-tone='blue'] {
		--fill: var(--ess-ev-blue-bg);
		--line: var(--ess-ev-blue-line);
		--ink: var(--ess-ev-blue);
	}
	.bar[data-tone='purple'],
	.key[data-tone='purple'] {
		--fill: var(--ess-ev-purple-bg);
		--line: var(--ess-ev-purple-line);
		--ink: var(--ess-ev-purple);
	}
	.bar[data-tone='green'],
	.key[data-tone='green'] {
		--fill: var(--ess-ev-green-bg);
		--line: var(--ess-ev-green-line);
		--ink: var(--ess-ev-green);
	}
	.bar[data-tone='yellow'],
	.key[data-tone='yellow'] {
		--fill: var(--ess-ev-yellow-bg);
		--line: var(--ess-ev-yellow-line);
		--ink: var(--ess-ev-yellow);
	}
	.bar[data-tone='pink'],
	.key[data-tone='pink'] {
		--fill: var(--ess-ev-pink-bg);
		--line: var(--ess-ev-pink-line);
		--ink: var(--ess-ev-pink);
	}
	.bar.pending {
		background: var(--ess-surface);
		border-style: dashed;
		border-width: 1.5px;
	}
	.bar.act {
		box-shadow: 0 0 0 2px var(--ess-surface), 0 0 0 3.5px var(--ess-warning);
	}
	.bar.clip-s {
		border-top-left-radius: 2px;
		border-bottom-left-radius: 2px;
	}
	.bar.clip-e {
		border-top-right-radius: 2px;
		border-bottom-right-radius: 2px;
	}
	.bar-name {
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.bar-name.full {
		padding-left: 4px;
	}
	.bar-name.short,
	.bar-status {
		display: none;
	}
	/* Too narrow for "Earned Leave": show "EL", centred. */
	@container (max-width: 84px) {
		.bar-name.full {
			display: none;
		}
		.bar-name.short {
			display: inline;
			margin: 0 auto;
		}
	}
	/* A single day on a narrow grid. */
	@container (max-width: 22px) {
		.bar-name.short {
			font-size: 9.5px;
			letter-spacing: -0.03em;
		}
	}
	/* Wide enough for the name and a "Pending" tag side by side. */
	@container (min-width: 170px) {
		.bar-status {
			display: inline;
		}
	}
	.bar-status {
		flex-shrink: 0;
		margin: 0 1px 0 auto;
		padding: 1px 6px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--ess-surface) 70%, transparent);
		font-size: 10.5px;
		font-weight: 600;
	}

	.none {
		margin: 0;
		padding: 18px 4px;
		color: var(--ess-text-muted);
		font-size: 13px;
	}

	/* ---------- legend ---------- */
	.legend {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px 14px;
		font-size: 11.5px;
		color: var(--ess-text-secondary);
	}
	.key {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.key.static {
		cursor: default;
		color: var(--ess-text-muted);
	}
	.key[aria-pressed='false'] {
		opacity: 0.45;
		text-decoration: line-through;
	}
	.key-note {
		color: var(--ess-text-muted);
	}
	.hint {
		margin-left: auto;
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
	.swatch {
		width: 14px;
		height: 10px;
		border-radius: 3px;
		background: var(--fill, var(--ess-cell));
		border: 1px solid var(--line, var(--ess-border));
	}
	.pending-sw {
		background: var(--ess-surface);
		border: 1.5px dashed var(--ess-text-muted);
	}
	.off-sw {
		background: repeating-linear-gradient(-45deg, var(--ess-cell-off), var(--ess-cell-off) 2px, var(--ess-cell) 2px, var(--ess-cell) 4px);
	}
	.hol-sw {
		background: var(--ess-ev-yellow-bg);
		border-color: var(--ess-ev-yellow-line);
	}

	/* ---------- detail sheet ---------- */
	.sheet {
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 20px 22px;
	}
	.sheet-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}
	.sheet-head h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 650;
	}
	.sheet-head p {
		margin: 2px 0 0;
		color: var(--ess-text-muted);
	}
	.note {
		display: grid;
		gap: 6px;
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.ok {
		margin: 0;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--ess-success-bg);
		color: var(--ess-success);
	}
	.err {
		margin: 0;
		color: var(--ess-danger);
		font-size: 13px;
	}
	.facts {
		display: grid;
		gap: 10px;
		margin: 0;
	}
	.facts div {
		display: grid;
		grid-template-columns: 90px 1fr;
		gap: 8px;
	}
	.facts dt {
		color: var(--ess-text-muted);
	}
	.facts dd {
		margin: 0;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.stage {
		color: var(--ess-text-muted);
		font-size: 12px;
	}

	@media (max-width: 720px) {
		.planner {
			padding: 14px 12px 10px;
		}
		.grid {
			--who: 150px;
		}
		.controls {
			margin-left: 0;
		}
	}

	/* Short laptop screens (about 1280×580): tighter so the dashboard fits. */
	@media (min-width: 721px) and (max-height: 760px) {
		.planner {
			padding: 10px 14px 8px;
			gap: 6px;
		}
		.title h2 {
			font-size: 15px;
		}
		.title p {
			font-size: 11.5px;
		}
		.nav-btn,
		.today-btn {
			height: 24px;
			min-width: 24px;
		}
		.month-label {
			font-size: 12.5px;
		}
		.seg button {
			height: 24px;
		}
		.chip,
		.find {
			height: 28px;
		}
		.grid {
			--who: 170px;
			--cell-min: 24px;
			--lane-h: 24px;
			gap: 3px;
		}
		.row {
			padding: 3px 0;
		}
		.hrow {
			height: 32px;
		}
		.dh {
			height: 30px;
			border-radius: 8px;
		}
		.dow {
			font-size: 9.5px;
		}
		.dn {
			font-size: 11.5px;
		}
		.cell {
			border-radius: 6px;
		}
	}
</style>
