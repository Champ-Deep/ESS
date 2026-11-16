<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Calendar from '@lucide/svelte/icons/calendar';
	import Heart from '@lucide/svelte/icons/heart';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import Clock from '@lucide/svelte/icons/clock';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import Mail from '@lucide/svelte/icons/mail';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import User from '@lucide/svelte/icons/user';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import LeaveCalendar from '$lib/components/LeaveCalendar.svelte';

	let { data } = $props();

	// From what the calendar actually holds (the org scope), not the role: an
	// Employee-role manager, concerned HR or a covering delegate sees names too.
	const canSeeNames = $derived(Boolean(data.calendarShowsOthers));
	// Approving is decided by assignment, not role: someone named as a colleague's
	// concerned HR may hold no admin role at all, and gating the tab on role hid
	// their queue entirely. The server builds the queue, so it decides.
	const canApprove = $derived(data.canApprove);

	const calendarLeaveEvents = $derived(data.leaveEvents.map((row) => ({
		id: row.application.id,
		startDate: row.application.startDate,
		endDate: row.application.endDate,
		status: row.application.status,
		applicantName: row.applicant.fullName,
		typeName: row.type.name
	})));

	type Tab = 'mine' | 'calendar' | 'approvals';
	let tab = $state<Tab>('mine');

	/* ---------- formatting ---------- */

	const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const parse = (s: string) => {
		const [y, m, d] = s.slice(0, 10).split('-').map(Number);
		return new Date(y, m - 1, d);
	};
	const fmtDate = (s: string) => {
		const d = parse(s);
		return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
	};
	/** "12 – 14 Oct 2026", or "21 Sep 2026" for a single day. */
	function fmtRange(start: string, end: string) {
		if (start === end) return fmtDate(start);
		const a = parse(start);
		const b = parse(end);
		if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${a.getDate()} – ${b.getDate()} ${MONTH_SHORT[b.getMonth()]} ${b.getFullYear()}`;
		return `${fmtDate(start)} – ${fmtDate(end)}`;
	}
	function fmtWeekdays(start: string, end: string) {
		const a = WD[parse(start).getDay()];
		const b = WD[parse(end).getDay()];
		return start === end ? a : `${a} – ${b}`;
	}
	const fmtDays = (n: string | number) => {
		const v = Number(n);
		return `${v} ${v === 1 ? 'day' : 'days'}`;
	};
	const fmtDateTime = (d: Date | string | null | undefined) =>
		d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
	function ageLabel(d: Date | string) {
		const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
		if (days <= 0) return 'Today';
		if (days === 1) return '1 day ago';
		return `${days} days ago`;
	}
	const statusLabel = (s: string) => (s === 'escalated' ? 'HR review' : s);

	/* ---------- leave type look ---------- */

	type LeaveTypeShape = { code?: string | null; name: string; monthlyQuotaDays?: string | null };
	function typeLook(t: LeaveTypeShape): { icon: typeof Calendar; tone: string } {
		const key = `${t.code ?? ''} ${t.name}`.toLowerCase();
		if (t.monthlyQuotaDays != null) return { icon: Heart, tone: 'ess-tile--pink' };
		if (/\bsl\b|sick/.test(key)) return { icon: HeartPulse, tone: 'ess-tile--pink' };
		if (/comp|co\b/.test(key)) return { icon: Clock, tone: '' };
		return { icon: Calendar, tone: '' };
	}

	/* ---------- my leave ---------- */

	type Filter = 'all' | 'pending' | 'approved' | 'rejected';
	let filter = $state<Filter>('all');
	const visibleApplications = $derived(
		data.myApplications.filter((r) =>
			filter === 'all' ? true : filter === 'pending' ? r.application.status === 'pending' || r.application.status === 'escalated' : r.application.status === filter
		)
	);

	// The request the progress panel follows: whichever the person clicks,
	// otherwise the newest one that is still live, otherwise the newest.
	let pickedId = $state<string | null>(null);
	const selected = $derived(
		(pickedId && data.myApplications.find((r) => r.application.id === pickedId)) ||
			data.myApplications.find((r) => r.application.status === 'pending' || r.application.status === 'escalated') ||
			data.myApplications[0] ||
			null
	);

	// Withdraw a request still waiting on a decision (api/leave/[id]/withdraw).
	let withdrawing = $state(false);
	let withdrawError = $state('');
	async function withdraw(id: string) {
		if (!confirm('Withdraw this leave request? Your approvers will no longer see it.')) return;
		withdrawing = true;
		withdrawError = '';
		try {
			const res = await fetch(`/api/leave/${id}/withdraw`, { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				withdrawError = body.message ?? 'The request could not be withdrawn. Try again.';
				return;
			}
			await invalidateAll();
		} finally {
			withdrawing = false;
		}
	}

	type StepState = 'done' | 'current' | 'todo';
	const progress = $derived.by((): { label: string; meta: string; state: StepState }[] => {
		if (!selected) return [];
		const s = selected.application.status;
		const decided = s === 'approved' || s === 'rejected';
		const steps: { label: string; meta: string; state: StepState }[] = [
			{ label: 'Submitted', meta: fmtDateTime(selected.application.createdAt), state: 'done' },
			{
				label: 'Manager review',
				meta: s === 'pending' ? 'In progress' : s === 'cancelled' ? 'Withdrawn' : 'Signed off',
				state: s === 'pending' ? 'current' : s === 'cancelled' ? 'todo' : 'done'
			}
		];
		if (s === 'escalated') steps.push({ label: 'HR review', meta: 'In progress', state: 'current' });
		steps.push({
			label: 'Decision',
			meta: decided ? `${s === 'approved' ? 'Approved' : 'Rejected'} · ${fmtDateTime(selected.application.decidedAt)}` : s === 'cancelled' ? 'Cancelled' : 'Pending',
			state: decided ? 'done' : 'todo'
		});
		return steps;
	});

	const today = new Date().toISOString().slice(0, 10);
	const upcomingHolidays = $derived(
		[...data.calendarHolidays]
			.filter((h) => h.date.slice(0, 10) >= today)
			.sort((a, b) => a.date.localeCompare(b.date))
			.slice(0, 4)
	);

	/* ---------- approvals ---------- */

	let queuePickedId = $state<string | null>(null);
	const queueSorted = $derived([...data.approvalQueue].sort((a, b) => new Date(a.application.createdAt).getTime() - new Date(b.application.createdAt).getTime()));
	const queueSelected = $derived((queuePickedId && queueSorted.find((r) => r.application.id === queuePickedId)) || queueSorted[0] || null);
	const oldestAge = $derived(queueSorted.length ? ageLabel(queueSorted[0].application.createdAt) : null);

	let rejectNote = $state('');
	let showReject = $state(false);
	let deciding = $state(false);

	async function decide(applicationId: string, decision: 'approve' | 'reject') {
		deciding = true;
		try {
			const res = await fetch(`/api/leave/${applicationId}/approve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ decision, note: decision === 'reject' && rejectNote.trim() ? rejectNote.trim() : undefined })
			});
			if (res.ok) {
				location.reload();
			} else {
				const body = await res.json().catch(() => ({}));
				alert(body.message ?? 'Could not process this request');
			}
		} finally {
			deciding = false;
		}
	}

	/* Overturning a decision that has already been communicated is not a routine
	   click, so it takes a second deliberate one — and the balance effect is
	   spelled out before it happens rather than after. */
	let confirmingReversal = $state<string | null>(null);
	let reversingId = $state<string | null>(null);
	let reversalError = $state('');

	async function reverse(applicationId: string, currentStatus: string) {
		reversalError = '';
		reversingId = applicationId;
		try {
			const res = await fetch(`/api/leave/${applicationId}/approve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// Flip to the opposite of where it stands now.
				body: JSON.stringify({ decision: currentStatus === 'approved' ? 'reject' : 'approve' })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				reversalError = body.message ?? 'Could not reverse this decision';
				return;
			}
			location.reload();
		} finally {
			reversingId = null;
		}
	}
</script>

<svelte:head>
	<title>Leave — Champ HR</title>
</svelte:head>

<PageHeader
	crumb={['Leave', tab === 'mine' ? 'My leave' : tab === 'calendar' ? (canSeeNames ? 'Team calendar' : 'Calendar') : 'Approvals']}
	title={tab === 'approvals' ? 'Review requests with context.' : 'Make time for yourself.'}
	sub={tab === 'approvals' ? 'Each request with the balance, the reason and the dates around it.' : 'Manage your leave, view balances and track requests.'}
	compact
>
	{#snippet actions()}
		<a href="/leave/apply" class="ess-btn ess-btn--primary">
			<Calendar size={17} strokeWidth={1.75} />
			Apply leave
		</a>
	{/snippet}
	{#snippet tabs()}
		<div class="ess-tabs page-tabs" role="tablist">
			<button type="button" class="ess-tab" role="tab" aria-selected={tab === 'mine'} onclick={() => (tab = 'mine')}>My leave</button>
			<button type="button" class="ess-tab" role="tab" aria-selected={tab === 'calendar'} onclick={() => (tab = 'calendar')}>
				{canSeeNames ? 'Team calendar' : 'Calendar'}
			</button>
			{#if canApprove}
				<button type="button" class="ess-tab" role="tab" aria-selected={tab === 'approvals'} onclick={() => (tab = 'approvals')}>
					Approvals
					{#if data.approvalQueue.length > 0}<span class="ess-count">{data.approvalQueue.length}</span>{/if}
				</button>
			{/if}
		</div>
	{/snippet}
</PageHeader>

{#if tab === 'mine'}
	<div class="ess-split ess-fill fill-split">
		<div class="fill-col">
			<!-- Balances -->
			{#if data.allocations.length > 0 || data.monthlyBalances.length > 0}
				<div class="balances">
					{#each data.allocations as row (row.allocation.id)}
						{@const remaining = row.month.left}
						{@const look = typeLook(row.type)}
						<div class="ess-metric">
							<span class="ess-tile {look.tone}"><look.icon size={20} strokeWidth={1.75} /></span>
							<div class="ess-metric__body">
								<span class="ess-metric__label">{row.type.name}</span>
								<span class="ess-metric__value">{fmtDays(remaining)}</span>
								<span class="ess-metric__meta">out of {fmtDays(row.month.credited)} this month</span>
							</div>
						</div>
					{/each}
					{#each data.monthlyBalances as row (row.typeId)}
						<div class="ess-metric ess-pink-wash">
							<span class="ess-tile ess-tile--pink"><Heart size={20} strokeWidth={1.75} /></span>
							<div class="ess-metric__body">
								<span class="ess-metric__label">{row.name}</span>
								<span class="ess-metric__value">{fmtDays(row.remaining)}</span>
								<span class="ess-metric__meta">out of {fmtDays(row.quota)} this month · resets monthly</span>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<!-- Requests -->
			<section class="ess-card ess-fill-card grow">
				<div class="ess-card-head">
					<h2 class="ess-h2">Leave requests</h2>
					<select class="ess-select filter" bind:value={filter} aria-label="Filter requests">
						<option value="all">All leaves</option>
						<option value="pending">Pending</option>
						<option value="approved">Approved</option>
						<option value="rejected">Rejected</option>
					</select>
				</div>
				{#if visibleApplications.length > 0}
					<div class="table-wrap ess-scroll">
						<table class="ess-table requests">
							<thead>
								<tr>
									<th>Type</th>
									<th>Dates</th>
									<th>Days</th>
									<th>Status</th>
									<th><span class="ess-sr-only">Open</span></th>
								</tr>
							</thead>
							<tbody>
								{#each visibleApplications as row (row.application.id)}
									{@const look = typeLook(row.type)}
									<tr class:is-selected={selected?.application.id === row.application.id} onclick={() => (pickedId = row.application.id)}>
										<td>
											<span class="type-cell">
												<span class="ess-tile ess-tile--sm {look.tone}"><look.icon size={17} strokeWidth={1.75} /></span>
												<strong>{row.type.name}</strong>
											</span>
										</td>
										<td>
											<span class="stack"><strong>{fmtRange(row.application.startDate, row.application.endDate)}</strong><small>{fmtWeekdays(row.application.startDate, row.application.endDate)}</small></span>
										</td>
										<td>{fmtDays(row.application.days)}</td>
										<td><span class="ess-badge ess-badge--{row.application.status}">{statusLabel(row.application.status)}</span></td>
										<td class="chev"><ChevronRight size={16} /></td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<div class="ess-empty fill-empty">
						<span class="ess-empty__icon"><Calendar size={22} strokeWidth={1.75} /></span>
						<span class="ess-empty__title">{filter === 'all' ? 'No leave requests yet' : 'Nothing here'}</span>
						<span>{filter === 'all' ? 'Requests you submit appear here with their progress.' : 'No requests match this filter.'}</span>
					</div>
				{/if}
			</section>

			<!-- Holidays -->
			<section class="ess-card holidays">
				<div class="ess-card-head">
					<h2 class="ess-h2">Upcoming holidays</h2>
					<button type="button" class="ess-link" onclick={() => (tab = 'calendar')}>View calendar <ChevronRight size={15} /></button>
				</div>
				<div class="ess-rows holiday-strip">
					{#each upcomingHolidays as h (h.id)}
						{@const d = parse(h.date)}
						<div class="ess-row">
							<span class="ess-date-tile"><strong>{d.getDate()}</strong><small>{MONTH_SHORT[d.getMonth()]}</small></span>
							<div class="ess-row__body">
								<span class="ess-row__title">{h.name}</span>
								<span class="ess-row__meta">{d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
								<span class="hol-type"><span class="ess-badge {h.type === 'restricted' ? 'ess-badge--info' : 'ess-badge--accent'}">{h.type} holiday</span></span>
							</div>
						</div>
					{:else}
						<p class="quiet">No holidays published for the rest of the year.</p>
					{/each}
				</div>
			</section>
		</div>

		<aside class="fill-col">
			<!-- Progress -->
			<section class="ess-card ess-fill-card grow">
				<div class="ess-card-head">
					<h2 class="ess-h2">Request progress</h2>
				</div>
				<div class="ess-scroll">
				{#if selected}
					<ol class="ess-stepper progress">
						{#each progress as step (step.label)}
							<li class="ess-step" data-state={step.state}>
								<span class="ess-step__dot">{#if step.state === 'done'}<Check size={13} strokeWidth={3} />{/if}</span>
								<span class="ess-step__label">{step.label}</span>
								<span class="ess-step__meta">{step.meta}</span>
							</li>
						{/each}
					</ol>

					<div class="selected-head">
						<h3 class="ess-h3">Selected request</h3>
						<span class="ess-badge ess-badge--{selected.application.status}">{statusLabel(selected.application.status)}</span>
					</div>
					{@const look = typeLook(selected.type)}
					<div class="selected-summary">
						<span class="ess-tile {look.tone}"><look.icon size={20} strokeWidth={1.75} /></span>
						<div>
							<strong>{selected.type.name}</strong>
							<span>{fmtRange(selected.application.startDate, selected.application.endDate)} ({fmtWeekdays(selected.application.startDate, selected.application.endDate)})</span>
						</div>
					</div>
					<dl class="ess-kv">
						<dt>Total days</dt>
						<dd>{fmtDays(selected.application.days)}</dd>
						<dt>Reason</dt>
						<dd>{selected.application.reason || '—'}</dd>
						<dt>Applied on</dt>
						<dd>{fmtDateTime(selected.application.createdAt)}</dd>
						<dt>Reviewer</dt>
						<dd>{data.manager ? `${data.manager.fullName} (Manager)` : 'HR'}</dd>
						{#if selected.application.decisionNote}
							<dt>Note</dt>
							<dd>{selected.application.decisionNote}</dd>
						{/if}
					</dl>
					{#if selected.application.status === 'pending' || selected.application.status === 'escalated'}
						<div class="withdraw">
							{#if withdrawError}<p class="ess-alert ess-alert--danger" role="alert">{withdrawError}</p>{/if}
							<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" disabled={withdrawing} onclick={() => withdraw(selected.application.id)}>
								{withdrawing ? 'Withdrawing…' : 'Withdraw request'}
							</button>
						</div>
					{/if}
				{:else}
					<div class="ess-empty fill-empty">
						<span class="ess-empty__icon"><Clock size={20} strokeWidth={1.75} /></span>
						<span>Once you apply for leave, its progress from submission to decision shows here.</span>
					</div>
				{/if}
				</div>
			</section>

			<!-- Usage -->
			{#if data.allocations.length > 0 || data.monthlyBalances.length > 0}
				<section class="ess-card usage-card">
					<div class="ess-card-head">
						<h2 class="ess-h2">Leave usage · this month</h2>
					</div>
					<div class="usage">
						{#each data.allocations as row (row.allocation.id)}
							{@const total = row.month.credited}
							{@const used = row.month.used}
							{@const look = typeLook(row.type)}
							<div class="usage-row">
								<span class="ess-tile ess-tile--sm {look.tone}"><look.icon size={17} strokeWidth={1.75} /></span>
								<div class="usage-body">
									<span class="usage-label">{row.type.name}</span>
									<div class="ess-meter" class:ess-meter--pink={look.tone.includes('pink')}><span style="width:{total > 0 ? Math.min(100, (used / total) * 100) : 0}%"></span></div>
								</div>
								<span class="usage-count">{used} / {total} days</span>
							</div>
						{/each}
						{#each data.monthlyBalances as row (row.typeId)}
							<div class="usage-row">
								<span class="ess-tile ess-tile--sm ess-tile--pink"><Heart size={17} strokeWidth={1.75} /></span>
								<div class="usage-body">
									<span class="usage-label">{row.name}</span>
									<div class="ess-meter ess-meter--pink"><span style="width:{row.quota > 0 ? Math.min(100, (row.used / row.quota) * 100) : 0}%"></span></div>
								</div>
								<span class="usage-count">{row.used} / {row.quota} days</span>
							</div>
						{/each}
					</div>
				</section>
			{/if}
		</aside>
	</div>
{:else if tab === 'calendar'}
	<section class="calendar-section ess-fill">
		<LeaveCalendar
			holidays={data.calendarHolidays}
			leaveEvents={calendarLeaveEvents}
			showNames={canSeeNames}
			size="large"
			weekOffRosters={data.weekOffRosters}
			weekOffAssignments={data.weekOffAssignments}
			weekOffLabel={data.myWeekOff?.summary ?? null}
		/>
	</section>
{:else if tab === 'approvals'}
	<div class="ess-split ess-split--wide ess-fill fill-split approvals">
		<div class="fill-col">
			<section class="ess-card ess-fill-card grow">
				<div class="ess-card-head">
					<div>
						<h2 class="ess-h2">Awaiting your review</h2>
						<p class="quiet small">
							{queueSorted.length} {queueSorted.length === 1 ? 'request' : 'requests'}{#if oldestAge} · Oldest {oldestAge.toLowerCase()}{/if}
						</p>
					</div>
				</div>
				<div class="ess-rows ess-scroll queue-list">
					{#each queueSorted as row (row.application.id)}
						<button type="button" class="ess-row queue-row" class:ess-row--selected={queueSelected?.application.id === row.application.id} onclick={() => { queuePickedId = row.application.id; showReject = false; rejectNote = ''; }}>
							<Avatar userId={row.applicant.id} fullName={row.applicant.fullName} hasPicture={row.applicantHasPicture} size="md" />
							<div class="ess-row__body">
								<span class="ess-row__title">{row.applicant.fullName}</span>
								<span class="ess-row__meta">{row.type.name}{#if row.application.status === 'escalated'} · HR stage{/if}</span>
							</div>
							<div class="ess-row__body dates">
								<span class="ess-row__title">{fmtRange(row.application.startDate, row.application.endDate)}</span>
								<span class="ess-row__meta">{fmtDays(row.application.days)}</span>
							</div>
							<span class="ess-row__end">
								<span class="ess-badge ess-badge--pending">{ageLabel(row.application.createdAt)}</span>
								<ChevronRight size={16} class="chev-icon" />
							</span>
						</button>
					{:else}
						<div class="ess-empty fill-empty">
							<span class="ess-empty__icon"><CircleCheck size={22} strokeWidth={1.75} /></span>
							<span class="ess-empty__title">Nothing waiting</span>
							<span>Requests from the people you review will appear here.</span>
						</div>
					{/each}
				</div>
			</section>

			{#if data.canReverseDecisions}
				<section class="ess-card ess-fill-card grow">
					<div class="ess-card-head">
						<h2 class="ess-h2">Recent decisions</h2>
					</div>
					<p class="quiet small reverse-note">
						A decision can be overturned here. Reversing an approval returns the days to the employee's balance; re-approving spends them again, so it is refused if the balance no longer covers it.
					</p>
					{#if reversalError}
						<p class="ess-error">{reversalError}</p>
					{/if}
					<div class="ess-rows ess-scroll">
						{#each data.decidedQueue as row (row.application.id)}
							{@const status = row.application.status}
							<div class="ess-row">
								<span class="decision-icon" data-status={status}>
									{#if status === 'approved'}<CircleCheck size={22} strokeWidth={1.75} />{:else}<CircleX size={22} strokeWidth={1.75} />{/if}
								</span>
								<div class="ess-row__body">
									<span class="ess-row__title">{row.applicant.fullName}</span>
									<span class="ess-row__meta">{fmtRange(row.application.startDate, row.application.endDate)}</span>
								</div>
								<div class="ess-row__body dates">
									<span class="ess-row__title">{fmtDays(row.application.days)}</span>
									<span class="ess-row__meta">{row.type.name}</span>
								</div>
								<span class="ess-row__end">
									<span class="ess-badge ess-badge--{status}">{status === 'rejected' ? 'Declined' : status}</span>
									{#if confirmingReversal === row.application.id}
										<button class="ess-btn ess-btn--sm ess-btn--danger" onclick={() => reverse(row.application.id, status)} disabled={reversingId === row.application.id}>
											{reversingId === row.application.id ? 'Reversing…' : status === 'approved' ? 'Confirm reject' : 'Confirm approve'}
										</button>
										<button class="ess-btn ess-btn--sm ess-btn--ghost" onclick={() => (confirmingReversal = null)} disabled={reversingId === row.application.id}>Cancel</button>
									{:else}
										<button class="ess-btn ess-btn--sm ess-btn--ghost" onclick={() => (confirmingReversal = row.application.id)}>
											{status === 'approved' ? 'Reverse to rejected' : 'Reverse to approved'}
										</button>
									{/if}
								</span>
							</div>
						{:else}
							<p class="quiet fill-empty">Nothing decided yet.</p>
						{/each}
					</div>
				</section>
			{/if}
		</div>

		<aside class="fill-col">
			<section class="ess-card ess-fill-card grow detail-card">
				<div class="ess-scroll detail">
				{#if queueSelected}
					{@const r = queueSelected}
					{@const after = r.balanceBefore != null ? Math.round((r.balanceBefore - Number(r.application.days)) * 100) / 100 : null}
					<div class="detail-head">
						<Avatar userId={r.applicant.id} fullName={r.applicant.fullName} hasPicture={r.applicantHasPicture} size="lg" />
						<div class="detail-name">
							<h2 class="ess-h2">{r.applicant.fullName}</h2>
							<span class="quiet small"><Mail size={14} /> {r.applicant.email}</span>
						</div>
					</div>

					<div class="facts">
						<div class="fact">
							<span class="fact-label"><Calendar size={14} /> Leave type</span>
							<strong>{r.type.name}</strong>
						</div>
						<div class="fact">
							<span class="fact-label"><Calendar size={14} /> Dates</span>
							<strong>{fmtRange(r.application.startDate, r.application.endDate)}</strong>
							<small>{fmtWeekdays(r.application.startDate, r.application.endDate)}</small>
						</div>
						<div class="fact">
							<span class="fact-label"><Clock size={14} /> Duration</span>
							<strong>{fmtDays(r.application.days)}</strong>
						</div>
						<div class="fact">
							<span class="fact-label"><ArrowRight size={14} /> Requested</span>
							<strong>{fmtDate(new Date(r.application.createdAt).toISOString())}</strong>
							<small>{ageLabel(r.application.createdAt)}</small>
						</div>
					</div>

					<div class="panels">
						{#if r.balanceBefore != null && after != null}
							<div class="panel">
								<span class="panel-title">Leave balance · this month</span>
								<div class="balance-flow">
									<div><strong class="big">{fmtDays(r.balanceBefore)}</strong><small>Before this request</small></div>
									<ArrowRight size={18} class="flow-arrow" />
									<div><strong class="big" class:negative={after < 0}>{fmtDays(after)}</strong><small>After this request</small></div>
								</div>
							</div>
						{/if}
						<div class="panel">
							<span class="panel-title">Reason for leave</span>
							<p class="reason">{r.application.reason || 'No reason given.'}</p>
						</div>
					</div>

					<div class="stage">
						<span class="fact-label"><User size={14} /> {r.application.status === 'escalated' ? 'HR review' : 'Manager review'}</span>
						<span class="quiet small">{r.application.status === 'escalated' ? 'The manager has signed off; your decision completes it.' : 'Your decision moves it to HR, or closes it when you also stand in for HR.'}</span>
					</div>

					<div class="decide">
						<button type="button" class="ess-btn ess-btn--primary" disabled={deciding} onclick={() => decide(r.application.id, 'approve')}>
							<Check size={17} strokeWidth={2.2} /> Approve leave
						</button>
						<button type="button" class="ess-btn ess-btn--outline" disabled={deciding} onclick={() => (showReject ? decide(r.application.id, 'reject') : (showReject = true))}>
							<X size={17} strokeWidth={2.2} /> {showReject ? 'Confirm reject' : 'Reject'}
						</button>
						{#if showReject}
							<button type="button" class="ess-btn ess-btn--ghost" disabled={deciding} onclick={() => { showReject = false; rejectNote = ''; }}>Cancel</button>
						{/if}
					</div>
					{#if showReject}
						<label class="ess-field">
							<span class="ess-label">Rejection reason (optional)</span>
							<textarea class="ess-textarea" rows="3" bind:value={rejectNote} placeholder="Tell {r.applicant.fullName.split(' ')[0]} why"></textarea>
						</label>
					{/if}
				{:else}
					<div class="ess-empty fill-empty">
						<span class="ess-empty__icon"><User size={22} strokeWidth={1.75} /></span>
						<span class="ess-empty__title">Pick a request</span>
						<span>Its balance, reason and dates show here.</span>
					</div>
				{/if}
				</div>
			</section>
		</aside>
	</div>
{/if}

<style>
	.page-tabs {
		margin-bottom: 12px;
		align-self: flex-start;
	}
	.holiday-strip > .quiet {
		grid-column: 1 / -1;
	}
	p.fill-empty {
		text-align: center;
	}

	/* ---------- fit-to-screen layout ----------
	   Each column is a flex stack: natural-height cards, plus one .grow card
	   that takes the rest of the height and scrolls its list inside. */
	.fill-col {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}
	.fill-empty {
		padding: 20px 16px;
	}
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.fill-split {
				grid-template-rows: minmax(0, 1fr);
			}
			.fill-col {
				min-height: 0;
			}
			.fill-col > .grow {
				flex: 1 1 0%;
				min-height: 150px;
			}
			.fill-col > :not(.grow) {
				flex: none;
			}
			/* An empty list centres its message in the space it was given. */
			.grow .ess-scroll:not(.table-wrap):not(.detail) {
				display: flex;
				flex-direction: column;
			}
			.grow .fill-empty {
				margin: auto 0;
			}
			.calendar-section {
				display: flex;
				flex-direction: column;
				min-height: 0;
			}
		}
	}

	.balances {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 10px;
	}
	.balances .ess-metric {
		padding: 10px 14px;
		gap: 12px;
		align-items: center;
	}
	.balances .ess-tile {
		width: 36px;
		height: 36px;
	}
	.balances .ess-metric__value {
		font-size: 19px;
	}
	.balances .ess-metric__label {
		font-size: 12.5px;
	}
	.balances .ess-metric__meta {
		font-size: 11.5px;
	}

	.filter {
		width: auto;
		min-width: 130px;
		padding-top: 5px;
		padding-bottom: 5px;
		font-size: 13px;
	}
	.requests th,
	.requests td {
		padding-top: 8px;
		padding-bottom: 8px;
	}
	.requests thead th {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--ess-glass-solid);
		-webkit-backdrop-filter: blur(16px) saturate(160%);
		backdrop-filter: blur(16px) saturate(160%);
	}
	.type-cell .ess-tile--sm {
		width: 30px;
		height: 30px;
	}

	/* Up to four upcoming holidays sit side by side rather than stacking. */
	.holiday-strip {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
		gap: 8px;
	}
	.holiday-strip .ess-row {
		padding: 6px 8px;
		gap: 10px;
		border: 1px solid var(--ess-border-subtle);
		border-radius: var(--ess-radius-md);
	}
	.holiday-strip .ess-row:last-child {
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.holiday-strip .ess-date-tile {
		width: 42px;
		padding: 4px 0;
	}
	.holiday-strip .ess-date-tile strong {
		font-size: 16px;
	}
	.holiday-strip .ess-row__title {
		font-size: 13.5px;
	}
	.holiday-strip .ess-row__meta {
		font-size: 12px;
	}
	.hol-type {
		display: flex;
		margin-top: 2px;
	}
	.hol-type .ess-badge {
		text-transform: capitalize;
	}

	.table-wrap {
		margin: 0 calc(-1 * var(--ess-space-5));
		overflow-x: auto;
	}
	.requests th:first-child,
	.requests td:first-child {
		padding-left: var(--ess-space-5);
	}
	.requests th:last-child,
	.requests td:last-child {
		padding-right: var(--ess-space-5);
	}
	.requests tbody tr {
		cursor: pointer;
	}
	.requests tbody tr.is-selected td {
		background: var(--ess-primary-softer);
	}
	.type-cell {
		display: inline-flex;
		align-items: center;
		gap: 12px;
	}
	.stack {
		display: grid;
		line-height: 1.3;
	}
	.stack small {
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}
	.chev {
		width: 36px;
		color: var(--ess-text-muted);
		text-align: right;
	}

	.quiet {
		color: var(--ess-text-secondary);
		margin: 0;
	}
	.small {
		font-size: 13px;
	}
	.quiet.small :global(svg) {
		vertical-align: -2px;
		margin-right: 4px;
	}

	.progress {
		margin: 2px 0 14px;
	}
	.withdraw {
		display: grid;
		gap: 8px;
		justify-items: start;
		margin-top: 12px;
	}
	.selected-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 10px;
		padding-top: 12px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.selected-head .ess-h3 {
		font-family: var(--ess-font-display);
		font-size: 15px;
	}
	.selected-summary {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-primary-softer);
		margin-bottom: 12px;
	}
	.selected-summary .ess-tile {
		width: 36px;
		height: 36px;
	}
	.progress + .selected-head + .selected-summary + :global(.ess-kv) {
		row-gap: 7px;
		font-size: 13px;
	}
	.selected-summary > div {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.selected-summary strong {
		font-size: 15px;
	}
	.selected-summary span {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}

	.usage {
		display: grid;
		gap: 10px;
	}
	.usage-row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.usage-row .ess-tile--sm {
		width: 30px;
		height: 30px;
	}
	.usage-body {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 5px;
	}
	.usage-label {
		font-size: 13px;
		font-weight: 500;
	}
	.usage-card {
		max-height: 40%;
		overflow: auto;
	}
	.usage-count {
		flex: none;
		font-size: 13px;
		color: var(--ess-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.calendar-section {
		min-width: 0;
	}

	/* ---------- approvals ---------- */

	.queue-row {
		padding-left: 12px;
		padding-right: 12px;
		margin: 0 -12px;
		width: calc(100% + 24px);
		border-radius: var(--ess-radius-md);
	}
	.queue-row.ess-row--selected {
		box-shadow: inset 3px 0 0 var(--ess-primary);
	}
	.dates {
		flex: 0 0 170px;
	}
	.queue-list .queue-row,
	.approvals .ess-row {
		padding-top: 9px;
		padding-bottom: 9px;
	}
	.queue-list {
		margin: 0 -12px;
		padding: 0 12px;
	}
	.queue-row :global(.chev-icon) {
		color: var(--ess-text-muted);
	}
	.reverse-note {
		max-width: 78ch;
		margin-bottom: 10px;
	}
	.decision-icon {
		display: grid;
		place-items: center;
		color: var(--ess-success);
	}
	.decision-icon[data-status='rejected'] {
		color: var(--ess-danger);
	}

	.detail {
		display: grid;
		gap: 12px;
		align-content: start;
	}
	.detail:has(> .fill-empty) {
		display: flex;
		flex-direction: column;
	}
	.detail-head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.detail-name {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.detail-name .ess-h2 {
		font-size: 18px;
	}

	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 10px;
	}
	.fact {
		display: grid;
		gap: 3px;
		padding-right: 12px;
		border-right: 1px solid var(--ess-border-subtle);
	}
	.fact:last-child {
		border-right: none;
	}
	.fact strong {
		font-size: 13.5px;
		font-weight: 500;
	}
	.fact small {
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}
	.fact-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		color: var(--ess-text-secondary);
	}

	.panels {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 10px;
	}
	.panel {
		padding: 10px 12px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-sunken);
		display: grid;
		gap: 6px;
		align-content: start;
	}
	.panel-title {
		font-size: 13px;
		font-weight: 500;
	}
	.balance-flow {
		display: flex;
		align-items: center;
		gap: 18px;
	}
	.balance-flow > div {
		display: grid;
		gap: 2px;
	}
	.balance-flow :global(.flow-arrow) {
		color: var(--ess-text-muted);
	}
	.big {
		font-family: var(--ess-font-display);
		font-size: 19px;
		font-weight: 600;
		line-height: 1.1;
	}
	.big.negative {
		color: var(--ess-danger);
	}
	.balance-flow small {
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}
	.reason {
		font-size: 13px;
		color: var(--ess-text-secondary);
		line-height: 1.5;
	}

	.stage {
		display: grid;
		gap: 4px;
		padding: 10px 0;
		border-top: 1px solid var(--ess-border-subtle);
		border-bottom: 1px solid var(--ess-border-subtle);
	}

	.decide {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}
	.decide .ess-btn {
		padding: 0 18px;
	}

	@media (max-width: 720px) {
		.dates {
			display: none;
		}
		.decide .ess-btn {
			flex: 1;
		}
	}
</style>
