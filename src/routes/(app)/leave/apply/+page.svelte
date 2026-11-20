<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Calendar from '@lucide/svelte/icons/calendar';
	import Layers from '@lucide/svelte/icons/layers';
	import ChartPie from '@lucide/svelte/icons/chart-pie';
	import Check from '@lucide/svelte/icons/check';
	import Info from '@lucide/svelte/icons/info';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Mail from '@lucide/svelte/icons/mail';
	import Avatar from '$lib/components/Avatar.svelte';
	import { makeWeekOffResolver, workingDaysInRange } from '$lib/week-off';

	let { data } = $props();

	// Pre-filled by Champ Chat's /leave command and Champ's leave card:
	// ?start=YYYY-MM-DD&end=…&type=<code or id>&reason=…
	const q = page.url.searchParams;
	const askedType = q.get('type');
	// svelte-ignore state_referenced_locally
	let leaveTypeId = $state(
		data.types.find((t) => askedType && (t.id === askedType || t.code === askedType))?.id ?? data.types[0]?.id ?? ''
	);
	let startDate = $state(q.get('start') ?? '');
	let endDate = $state(q.get('end') ?? q.get('start') ?? '');
	let reason = $state(q.get('reason') ?? '');
	let error = $state('');
	let submitting = $state(false);

	// Details → Review → Submit. The request is only sent from Review, so
	// nobody books leave on a mistyped date.
	let step = $state<0 | 1>(0);

	const type = $derived(data.types.find((t) => t.id === leaveTypeId) ?? null);
	const balance = $derived(type ? (data.available[type.id] ?? null) : null);

	// Working days are counted against this person's own week-off roster, the
	// same way the API charges them.
	const isWeekOff = $derived(makeWeekOffResolver(data.weekOffRosters, data.weekOffAssignments));
	const validRange = $derived(/^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate >= startDate);
	const requested = $derived(validRange ? workingDaysInRange(startDate, endDate, isWeekOff) : 0);
	const remaining = $derived(balance ? Math.round((balance.remaining - requested) * 100) / 100 : null);

	const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const parse = (s: string) => {
		const [y, m, d] = s.split('-').map(Number);
		return new Date(y, m - 1, d);
	};
	const fmt = (s: string) => {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
		const d = parse(s);
		return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()} (${WD[d.getDay()]})`;
	};
	const fmtRange = () => {
		if (!validRange) return 'Pick your dates';
		const a = parse(startDate);
		const b = parse(endDate);
		if (startDate === endDate) return `${a.getDate()} ${MONTH_SHORT[a.getMonth()]} ${a.getFullYear()}`;
		if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${a.getDate()} – ${b.getDate()} ${MONTH_SHORT[b.getMonth()]} ${b.getFullYear()}`;
		return `${a.getDate()} ${MONTH_SHORT[a.getMonth()]} – ${b.getDate()} ${MONTH_SHORT[b.getMonth()]} ${b.getFullYear()}`;
	};
	const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
	const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

	function toReview(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (!validRange) {
			error = 'The end date cannot be before the start date';
			return;
		}
		step = 1;
	}

	async function submit() {
		if (submitting) return;
		error = '';
		submitting = true;
		try {
			const res = await fetch('/api/leave', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ leaveTypeId, startDate, endDate, reason })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				error = body.message ?? 'Could not submit leave application';
				step = 0;
				return;
			}
			await goto('/leave');
		} catch {
			error = 'Could not confirm submission. Check your leave requests before trying again.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Apply for leave — Champ HR</title>
</svelte:head>

<PageHeader crumb={[{ label: 'Leave', href: '/leave' }, 'Apply for leave']} title="Plan your time away." sub="Submit a leave request and we’ll take care of the rest." />

<div class="ess-split ess-fill apply">
	<div class="fill-col">
		<ol class="ess-stepper ess-stepper--center steps">
			<li class="ess-step" data-state={step > 0 ? 'done' : 'current'}>
				<span class="ess-step__dot">{#if step > 0}<Check size={13} strokeWidth={3} />{:else}1{/if}</span>
				<span class="ess-step__label">Details</span>
				<span class="ess-step__meta">Enter your leave details</span>
			</li>
			<li class="ess-step" data-state={step === 1 ? 'current' : 'todo'}>
				<span class="ess-step__dot">2</span>
				<span class="ess-step__label">Review</span>
				<span class="ess-step__meta">Check and confirm</span>
			</li>
			<li class="ess-step" data-state="todo">
				<span class="ess-step__dot">3</span>
				<span class="ess-step__label">Submit</span>
				<span class="ess-step__meta">Request for approval</span>
			</li>
		</ol>

		{#if step === 0}
			<form class="ess-card ess-fill-card form grow" onsubmit={toReview}>
				<div class="form-head">
					<h2 class="ess-h2">Leave details</h2>
					<p>Tell us about your leave request.</p>
				</div>

				<div class="form-body ess-scroll">

				<label class="ess-field">
					<span class="ess-label">Leave type <i class="req">*</i></span>
					<span class="with-icon">
						<Calendar size={17} strokeWidth={1.75} />
						<select class="ess-select" bind:value={leaveTypeId} required>
							{#each data.types as t (t.id)}
								<option value={t.id}>{t.name}</option>
							{/each}
						</select>
					</span>
					{#if type}
						<span class="ess-help">
							{#if type.monthlyQuotaDays != null}
								{Number(type.monthlyQuotaDays)} {Number(type.monthlyQuotaDays) === 1 ? 'day' : 'days'} each month; it does not carry over.
							{:else if type.fixedDays}
								A fixed {type.fixedDays}-day entitlement.
							{:else if balance}
								Use your {type.name.toLowerCase()} balance for planned time away.
							{:else}
								Counts against your {type.name.toLowerCase()} entitlement.
							{/if}
							{#if type.requiresDocumentation && type.documentationNote}{type.documentationNote}{/if}
						</span>
					{/if}
				</label>

				<div class="date-row">
					<label class="ess-field">
						<span class="ess-label">Start date <i class="req">*</i></span>
						<span class="with-icon">
							<Calendar size={17} strokeWidth={1.75} />
							<input class="ess-input" type="date" bind:value={startDate} required />
						</span>
					</label>
					<label class="ess-field">
						<span class="ess-label">End date <i class="req">*</i></span>
						<span class="with-icon">
							<Calendar size={17} strokeWidth={1.75} />
							<input class="ess-input" type="date" bind:value={endDate} min={startDate || undefined} required />
						</span>
					</label>
				</div>

				<label class="ess-field reason-field">
					<span class="ess-label">Reason for leave</span>
					<textarea class="ess-textarea" bind:value={reason} rows="4" maxlength="500" placeholder="Add any context for your manager"></textarea>
					<span class="help-row"><span class="ess-help">This will be visible to your manager.</span><span class="ess-help">{reason.length}/500</span></span>
				</label>

				{#if error}
					<p class="ess-error" role="alert">{error}</p>
				{/if}
				</div>

				<div class="actions">
					<a href="/leave" class="ess-btn ess-btn--secondary">Cancel</a>
					<button type="submit" class="ess-btn ess-btn--primary" disabled={!leaveTypeId}>
						Continue to review <ArrowRight size={17} />
					</button>
				</div>
			</form>
		{:else}
			<section class="ess-card ess-fill-card form grow">
				<div class="form-head">
					<h2 class="ess-h2">Review your request</h2>
					<p>Check the details, then send it for approval.</p>
				</div>

				<div class="form-body ess-scroll">
				<dl class="ess-kv review">
					<dt>Leave type</dt>
					<dd>{type?.name ?? '—'}</dd>
					<dt>Start date</dt>
					<dd>{fmt(startDate)}</dd>
					<dt>End date</dt>
					<dd>{fmt(endDate)}</dd>
					<dt>Working days</dt>
					<dd>{days(requested)}</dd>
					<dt>Reason</dt>
					<dd>{reason.trim() || 'No reason given'}</dd>
					<dt>Goes to</dt>
					<dd>{data.manager ? `${data.manager.fullName} for manager review, then HR` : 'HR'}</dd>
				</dl>

				{#if error}
					<p class="ess-error" role="alert">{error}</p>
				{/if}
				</div>

				<div class="actions">
					<button type="button" class="ess-btn ess-btn--secondary" onclick={() => (step = 0)} disabled={submitting}><ArrowLeft size={17} /> Edit details</button>
					<button type="button" class="ess-btn ess-btn--primary" onclick={submit} disabled={submitting}>
						{submitting ? 'Submitting…' : 'Submit request'}
						{#if !submitting}<ArrowRight size={17} />{/if}
					</button>
				</div>
			</section>
		{/if}
	</div>

	<aside class="fill-col">
		<section class="ess-card impact grow">
			<div class="form-head">
				<h2 class="ess-h2">Leave impact summary</h2>
				<p>Here’s how this request affects your balance.</p>
			</div>

			<div class="impact-grid">
				<div class="impact-cell">
					<span class="ess-tile"><Calendar size={20} strokeWidth={1.75} /></span>
					<span class="impact-label">Requested</span>
					<strong>{requested} working {requested === 1 ? 'day' : 'days'}</strong>
					<small>{fmtRange()}</small>
				</div>
				<div class="impact-cell">
					<span class="ess-tile"><Layers size={20} strokeWidth={1.75} /></span>
					<span class="impact-label">Available</span>
					<strong>{balance ? days(balance.remaining) : '—'}</strong>
					<small>{balance ? (balance.monthly ? 'This month' : `As of ${today}`) : 'No balance tracked'}</small>
				</div>
				<div class="impact-cell">
					<span class="ess-tile"><ChartPie size={20} strokeWidth={1.75} /></span>
					<span class="impact-label">Remaining</span>
					<strong class:over={remaining != null && remaining < 0}>{remaining != null ? days(remaining) : '—'}</strong>
					<small>After this request</small>
				</div>
			</div>

			{#if remaining != null && remaining < 0}
				<div class="ess-notice">
					<span class="ess-notice__icon"><Info size={16} /></span>
					<div class="ess-notice__body"><strong>More than {balance!.monthly ? 'this month’s leave' : 'your balance'}</strong>This request asks for {days(requested)} but only {days(balance!.remaining)} {balance!.monthly ? 'are left this month' : 'are available'}.</div>
				</div>
			{/if}

			<div class="impact-section">
				<span class="impact-label">Approval manager</span>
				{#if data.manager}
					<div class="manager">
						<Avatar userId={data.manager.userId} fullName={data.manager.fullName} size="lg" />
						<div class="manager-text">
							<strong>{data.manager.fullName}</strong>
							<small>Reviews first, then HR</small>
						</div>
					</div>
				{:else}
					<p class="quiet"><Mail size={14} /> No reporting manager is set, so this goes straight to HR.</p>
				{/if}
			</div>

			<div class="ess-notice ess-notice--info policy-note">
				<span class="ess-notice__icon"><Info size={16} /></span>
				<div class="ess-notice__body">
					Leave requests are subject to your company’s leave policy.
					<a href="/policies" class="policy-link">View leave policy <ExternalLink size={13} /></a>
				</div>
			</div>
		</section>
	</aside>
</div>

<style>
	.apply {
		--ess-aside-width: 400px;
	}

	/* ---------- fit-to-screen layout ---------- */
	.fill-col {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.apply {
				grid-template-rows: minmax(0, 1fr);
			}
			.fill-col {
				min-height: 0;
			}
			.fill-col > .grow {
				flex: 1 1 0%;
				min-height: 0;
			}
			.fill-col > :not(.grow) {
				flex: none;
			}
			.impact {
				overflow: auto;
				scrollbar-width: thin;
			}
			/* The reason box takes whatever height the form has spare. */
			.form .form-body {
				display: flex;
				flex-direction: column;
			}
			.reason-field {
				flex: 1 0 auto;
				display: flex;
				flex-direction: column;
			}
			.reason-field .ess-textarea {
				flex: 1 1 auto;
				min-height: 64px;
			}
		}
	}

	.steps {
		padding: 0 24px;
	}
	.steps .ess-step {
		gap: 3px;
	}
	.steps .ess-step__label {
		font-size: 13px;
	}
	.steps .ess-step__meta {
		font-size: 11.5px;
		margin-top: -2px;
	}

	.form {
		gap: 12px;
	}
	.form-body {
		display: grid;
		gap: 12px;
		align-content: start;
	}
	.form-head {
		display: grid;
		gap: 2px;
	}
	.form-head p {
		color: var(--ess-text-secondary);
		font-size: 13px;
	}

	.req {
		color: var(--ess-danger);
		font-style: normal;
		margin-left: 2px;
	}

	.with-icon {
		position: relative;
		display: flex;
		align-items: center;
	}
	.with-icon > :global(svg) {
		position: absolute;
		left: 12px;
		color: var(--ess-text-secondary);
		pointer-events: none;
	}
	.with-icon .ess-select,
	.with-icon .ess-input {
		padding-left: 38px;
		padding-top: 8px;
		padding-bottom: 8px;
		font-size: 14px;
	}

	.date-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
		gap: 14px;
	}
	.date-row > * {
		min-width: 0;
	}

	.ess-textarea {
		resize: vertical;
		min-height: 80px;
		font-size: 14px;
	}
	.help-row {
		display: flex;
		justify-content: space-between;
	}

	.policy-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin-left: 8px;
		text-decoration: underline;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding-top: 12px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.actions .ess-btn {
		padding: 0 18px;
	}

	.review dd {
		font-size: 14px;
	}

	.impact {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.impact-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
	.impact-cell {
		display: grid;
		gap: 2px;
		align-content: start;
		padding: 0 12px;
		border-right: 1px solid var(--ess-border-subtle);
	}
	.impact-cell:first-child {
		padding-left: 0;
	}
	.impact-cell:last-child {
		border-right: none;
		padding-right: 0;
	}
	.impact-cell .ess-tile {
		width: 34px;
		height: 34px;
		margin-bottom: 6px;
	}
	.impact-label {
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}
	.impact-cell strong {
		font-family: var(--ess-font-display);
		font-size: 18px;
		font-weight: 600;
		line-height: 1.15;
	}
	.impact-cell strong.over {
		color: var(--ess-danger);
	}
	.impact-cell small {
		font-size: 12px;
		color: var(--ess-text-muted);
	}

	.impact-section {
		display: grid;
		gap: 8px;
		padding-top: 14px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.manager {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.manager-text {
		display: grid;
		gap: 2px;
	}
	.manager-text strong {
		font-size: 14px;
		font-weight: 500;
	}
	.manager-text small {
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}
	.quiet {
		display: flex;
		gap: 8px;
		align-items: center;
		color: var(--ess-text-secondary);
		font-size: 13px;
	}
	/* Sits at the foot of the summary card. */
	.policy-note {
		margin-top: auto;
		padding: 10px 12px;
		font-size: 13px;
	}

	@media (max-width: 720px) {
		.impact-grid {
			grid-template-columns: 1fr;
			gap: 16px;
		}
		.impact-cell {
			padding: 0;
			border-right: none;
		}
		.actions {
			flex-direction: column-reverse;
		}
	}
</style>
