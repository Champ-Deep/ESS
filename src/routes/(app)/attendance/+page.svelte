<script lang="ts">
	import { page } from '$app/state';
	import CalendarCheck from '@lucide/svelte/icons/calendar-check';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import BarChart3 from '@lucide/svelte/icons/bar-chart-3';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Inbox from '@lucide/svelte/icons/inbox';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import AttendanceCalendar from '$lib/components/AttendanceCalendar.svelte';
	import CompOffClaim from '$lib/components/CompOffClaim.svelte';
	import DeviationRequest from '$lib/components/DeviationRequest.svelte';
	import SopReviewQueue from '$lib/components/SopReviewQueue.svelte';

	let { data } = $props();

	const today = $derived(data.today);

	const monthLabel = $derived(
		new Date(Number(data.viewMonth.slice(0, 4)), Number(data.viewMonth.slice(5, 7)) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
	);
	const statPeriod = $derived(data.isCurrentMonth ? 'this month' : `in ${monthLabel}`);

	const OFFICE_TZ = 'Asia/Kolkata';
	function formatTime(value: string | Date | null | undefined) {
		if (!value) return '—';
		return new Date(value).toLocaleTimeString('en-IN', { timeZone: OFFICE_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
	}

	function formatHours(hrs: number) {
		const h = Math.floor(hrs);
		const m = Math.round((hrs - h) * 60);
		return `${h}h ${m}m`;
	}

	function fmtDay(d: string) {
		return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
	}

	/* ---------- tabs, selection, drawers ---------- */

	let view = $state<'calendar' | 'records' | 'review'>('calendar');
	// The reviewer's queue gets its own tab (rather than sitting below the
	// calendar) so the page still fits the screen; the tab only appears
	// when there is something to decide.
	const reviewCount = $derived(data.canReview ? data.deviationQueue.length + data.compOffQueue.length : 0);
	$effect(() => {
		if (view === 'review' && reviewCount === 0) view = 'calendar';
	});
	let selectedKey = $state<string | null>(null);

	let raiseOpen = $state(false);
	let raiseDate = $state('');
	let compOffOpen = $state(false);

	function raise(date: string) {
		raiseDate = date;
		raiseOpen = true;
	}

	// /attendance?raise=YYYY-MM-DD (from Today's "Review") opens the drawer on that day.
	$effect(() => {
		const r = page.url.searchParams.get('raise');
		if (r && /^\d{4}-\d{2}-\d{2}$/.test(r)) {
			selectedKey = r;
			raise(r);
		}
	});

	// The shift credited to a day, so a night shift's check-out after midnight
	// shows against the day the shift started.
	const shiftsByDate = $derived(new Map(data.shifts.map((s) => [s.date, s])));
	function recordFor(date: string) {
		const s = shiftsByDate.get(date);
		if (!s) return null;
		return { checkIn: s.checkInAt ? formatTime(s.checkInAt) : null, checkOut: s.checkOutAt ? formatTime(s.checkOutAt) : null };
	}

	const DEVIATION_STATUS: Record<string, { label: string; tone: string; dot: string }> = {
		pending: { label: 'Pending', tone: 'pending', dot: 'warn' },
		needs_manager_approval: { label: 'Needs manager', tone: 'pending', dot: 'warn' },
		manager_approved: { label: 'With HR', tone: 'info', dot: 'info' },
		approved: { label: 'Approved', tone: 'approved', dot: 'ok' },
		rejected: { label: 'Rejected', tone: 'rejected', dot: 'bad' }
	};
	const devStatus = (s: string) => DEVIATION_STATUS[s] ?? { label: s.replace(/_/g, ' '), tone: 'neutral', dot: 'neutral' };
	const reasonLabel = (r: string) => {
		const t = r.replace(/_/g, ' ');
		return t.charAt(0).toUpperCase() + t.slice(1);
	};
</script>

<svelte:head>
	<title>Attendance — Champ HR ESS Portal</title>
</svelte:head>

<PageHeader crumb={['Attendance']} title="Attendance, made clear." sub="Track your attendance, view your records and raise corrections when needed." compact>
	{#snippet tabs()}
		<div class="ess-tabs tabs" role="tablist" aria-label="Attendance views">
			<button type="button" role="tab" class="ess-tab" aria-selected={view === 'calendar'} onclick={() => (view = 'calendar')}><CalendarDays size={16} strokeWidth={1.75} /> Calendar</button>
			<button type="button" role="tab" class="ess-tab" aria-selected={view === 'records'} onclick={() => (view = 'records')}><BarChart3 size={16} strokeWidth={1.75} /> Records</button>
			{#if reviewCount > 0}
				<button type="button" role="tab" class="ess-tab" aria-selected={view === 'review'} onclick={() => (view = 'review')}><Inbox size={16} strokeWidth={1.75} /> To review <span class="ess-count">{reviewCount}</span></button>
			{/if}
		</div>
	{/snippet}
</PageHeader>

<!-- The month's figures, as a slim strip above the calendar. -->
{#if view === 'calendar'}
<div class="topbar">
		<div class="metrics">
			<!--
				Read-only. Attendance is recorded by the biometric terminals and ProHance,
				never typed in here — a self-service button is a second, unverified source
				for the same fact. A missed or mis-read punch is raised as an attendance
				correction, which HR approves, rather than overwritten by hand.
			-->
			<div class="ess-metric">
				<span class="ess-tile" class:ess-tile--ok={!!today?.checkInAt} class:ess-tile--neutral={!today?.checkInAt}><CalendarCheck size={20} strokeWidth={1.75} /></span>
				<div class="ess-metric__body">
					<span class="ess-metric__label">Today’s check-in</span>
					<span class="ess-metric__value">{today?.checkInAt ? formatTime(today.checkInAt) : '—'}</span>
					<span class="ess-metric__meta">
						{#if today?.checkOutAt}Checked out {formatTime(today.checkOutAt)}{:else if today?.checkInAt}{today.source === 'biometric' ? 'Biometric check-in recorded' : 'Recorded in the portal'}{:else}No punch recorded yet today{/if}
					</span>
				</div>
			</div>
			<div class="ess-metric">
				<span class="ess-tile"><CalendarDays size={20} strokeWidth={1.75} /></span>
				<div class="ess-metric__body">
					<span class="ess-metric__label">Present</span>
					<span class="ess-metric__value">{data.presentDays}{#if data.businessDaysSoFar > 0} <small>of {data.businessDaysSoFar}</small>{/if}</span>
					<!-- Names the denominator and says week offs are in it: "23 of 23" is
					     otherwise puzzling for someone who only worked the weekdays. -->
					<span class="ess-metric__meta">{#if data.businessDaysSoFar > 0}Eligible days {statPeriod} · week offs included{:else}{statPeriod}{/if}</span>
				</div>
			</div>
			<div class="ess-metric">
				<span class="ess-tile ess-tile--ok"><BarChart3 size={20} strokeWidth={1.75} /></span>
				<div class="ess-metric__body">
					<span class="ess-metric__label">Average shift</span>
					<span class="ess-metric__value">{formatHours(data.avgHours)}</span>
					<span class="ess-metric__meta">Per completed shift {statPeriod}</span>
				</div>
			</div>
		</div>
</div>
{/if}

<div class="ess-split ess-fill layout">
	<div class="fill-col main-col" data-tour="attendance-calendar">
		{#if view === 'calendar'}
			<AttendanceCalendar
				mode="grid"
				bind:selectedKey
				month={data.viewMonth}
				records={data.records}
				punchDays={data.punchDays}
				holidays={data.monthHolidays}
				leaves={data.monthLeaves}
				prohanceDays={data.monthProhance}
				prohanceEnabled={data.prohanceEnabled}
				shifts={data.shifts}
				weekOffRosters={data.weekOffRosters}
				weekOffAssignments={data.weekOffAssignments}
			/>
		{:else if view === 'review'}
			<!-- SOP: the reviewer's queue — corrections and comp-off claims from
			     the people who report to the viewer. -->
			<SopReviewQueue deviations={data.deviationQueue} compOffs={data.compOffQueue} />
		{:else}
			<AttendanceCalendar
				mode="records"
				bind:selectedKey
				onraise={raise}
				month={data.viewMonth}
				records={data.records}
				punchDays={data.punchDays}
				holidays={data.monthHolidays}
				leaves={data.monthLeaves}
				prohanceDays={data.monthProhance}
				prohanceEnabled={data.prohanceEnabled}
				shifts={data.shifts}
				weekOffRosters={data.weekOffRosters}
				weekOffAssignments={data.weekOffAssignments}
			/>
		{/if}
	</div>

	<aside class="fill-col side-col" data-tour="attendance-side">
		<AttendanceCalendar
			mode="detail"
			bind:selectedKey
			onraise={raise}
			month={data.viewMonth}
			records={data.records}
			punchDays={data.punchDays}
			holidays={data.monthHolidays}
			leaves={data.monthLeaves}
			prohanceDays={data.monthProhance}
			prohanceEnabled={data.prohanceEnabled}
			shifts={data.shifts}
			weekOffRosters={data.weekOffRosters}
			weekOffAssignments={data.weekOffAssignments}
		/>

		<CompOffClaim credits={data.compOffCredits} bind:open={compOffOpen} />

		<section class="ess-card ess-fill-card dev-card" aria-labelledby="dev-h">
			<div class="ess-card-head">
				<h2 id="dev-h" class="ess-h2">Recent deviations</h2>
				<button type="button" class="ess-link as-btn" onclick={() => (view = 'records')}>View all records <ChevronRight size={14} /></button>
			</div>
			<div class="allowance-row">
				<p class="allowance">Corrections allowance · <strong>{data.deviationMonthlyUsed} of {data.deviationMonthlyCap}</strong> used this month</p>
				<button type="button" class="ess-btn ess-btn--outline ess-btn--sm raise-any" onclick={() => raise(selectedKey ?? '')}>Raise correction</button>
			</div>
			<div class="ess-rows ess-scroll dev-list">
				{#each data.myDeviations.slice(0, 5) as d (d.id)}
					{@const s = devStatus(d.status)}
					<div class="ess-row dev">
						<span class="dev-date">{fmtDay(d.date)}</span>
						<i class="dev-dot" data-tone={s.dot}></i>
						<div class="ess-row__body">
							<span class="ess-row__title">{reasonLabel(d.reason)}</span>
							<span class="ess-row__meta">{d.claimedCheckIn || d.claimedCheckOut ? `Reported ${d.claimedCheckIn ?? '—'} → ${d.claimedCheckOut ?? '—'}` : d.description}</span>
						</div>
						<span class="ess-badge ess-badge--{s.tone}">{s.label}</span>
					</div>
				{:else}
					<p class="empty">No correction requests raised yet. Pick a day with a missing punch and raise one from there.</p>
				{/each}
			</div>
		</section>
	</aside>
</div>

<DeviationRequest
	bind:open={raiseOpen}
	initialDate={raiseDate}
	monthlyUsed={data.deviationMonthlyUsed}
	monthlyCap={data.deviationMonthlyCap}
	{recordFor}
	oncompoff={() => (compOffOpen = true)}
/>

<style>
	.topbar {
		display: flex;
		align-items: center;
		gap: 10px 12px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	.tabs {
		flex: none;
	}
	.layout {
		--ess-aside-width: 360px;
	}

	/* ---------- fit-to-screen layout ----------
	   Two flex columns. The calendar / records table / review queue takes
	   the main column's spare height; in the aside the day detail and
	   comp-off cards keep their height and the deviations list takes the
	   rest, scrolling inside. */
	.fill-col {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.layout {
				grid-template-rows: minmax(0, 1fr);
			}
			.fill-col {
				min-height: 0;
			}
			.fill-col > :global(*) {
				flex: none;
			}
			.main-col > :global(.calendar-box),
			.main-col > :global(.records-box),
			.main-col > :global(.queue) {
				flex: 1 1 0%;
				min-height: 0;
			}
			.main-col > :global(.queue) {
				overflow: auto;
				overscroll-behavior: contain;
				scrollbar-width: thin;
			}
			.side-col {
				overflow-y: auto;
				overscroll-behavior: contain;
				scrollbar-width: thin;
			}
			.side-col > .dev-card {
				flex: 1 1 0%;
				min-height: 140px;
			}
		}
	}
	/* Short laptop screens (about 1280x580): the aside's cards tighten so
	   the day detail, comp-off balance and deviations all fit. */
	@media (min-width: 1101px) and (min-height: 480px) and (max-height: 760px) {
		@container ess-fill (min-width: 0px) {
			.fill-col {
				gap: 8px;
			}
			.side-col > .dev-card {
				min-height: 112px;
			}
			.dev {
				padding-top: 6px;
				padding-bottom: 6px;
			}
			.allowance {
				font-size: 12px;
			}
			.side-col {
				gap: 6px;
			}
			.dev-card .ess-card-head {
				margin-bottom: 6px;
			}
			.allowance-row {
				margin-bottom: 4px;
			}
			.metrics .ess-metric {
				padding-top: 3px;
				padding-bottom: 3px;
			}
			.metrics .ess-tile {
				width: 28px;
				height: 28px;
			}
		}
	}

	.metrics {
		flex: 1 1 640px;
		min-width: 0;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}
	/* A slim strip: figure and label on one line, the caption below. */
	.metrics .ess-metric {
		padding: 4px 12px;
		gap: 10px;
		align-items: center;
	}
	.metrics .ess-tile {
		width: 30px;
		height: 30px;
	}
	.metrics .ess-metric__body {
		grid-template-columns: auto minmax(0, 1fr);
		align-items: baseline;
		column-gap: 8px;
		row-gap: 1px;
	}
	.metrics .ess-metric__value {
		grid-row: 1;
		grid-column: 1;
		font-size: 16px;
	}
	.metrics .ess-metric__label {
		grid-row: 1;
		grid-column: 2;
		font-size: 12.5px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.metrics .ess-metric__meta {
		grid-column: 1 / -1;
		line-height: 1.25;
		font-size: 11.5px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ess-metric__value small {
		font-size: 13px;
		font-weight: 500;
		color: var(--ess-text-secondary);
	}

	.as-btn {
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
	}

	/* The allowance and the raise button share a line above the list. */
	.allowance-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: -4px 0 6px;
		flex: none;
	}
	.allowance {
		flex: 1 1 0%;
		min-width: 0;
		font-size: 12.5px;
		line-height: 1.35;
		color: var(--ess-text-secondary);
		margin: 0;
	}
	.allowance strong {
		color: var(--ess-text);
		font-weight: 500;
	}

	.dev {
		gap: 10px;
		padding-top: 8px;
		padding-bottom: 8px;
	}
	.dev-list .ess-row__title {
		font-size: 13.5px;
	}
	.dev-list .ess-row__meta {
		font-size: 12px;
	}
	.dev-date {
		min-width: 76px;
		font-size: 12px;
		color: var(--ess-text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.dev-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex: none;
		background: var(--ess-border-strong);
	}
	.dev-dot[data-tone='ok'] {
		background: var(--ess-success);
	}
	.dev-dot[data-tone='warn'] {
		background: var(--ess-warning);
	}
	.dev-dot[data-tone='bad'] {
		background: var(--ess-danger);
	}
	.dev-dot[data-tone='info'] {
		background: var(--ess-info);
	}

	.empty {
		margin: 0;
		padding: 2px 0;
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}
	.raise-any {
		flex: none;
	}

	@media (max-width: 980px) {
		.metrics {
			grid-template-columns: 1fr;
		}
	}
</style>
