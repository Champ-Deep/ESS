<script lang="ts">
	/**
	 * The strip under the planner grid: the viewer's own leave at a glance —
	 * what is free to plan, what is spent or booked, the holidays ahead, the
	 * next time away and long weekends worth taking. Figures come from
	 * dashboard/my-leave.server.ts and are only ever the viewer's own.
	 *
	 * Kept to one short row of equal blocks so the dashboard fits a laptop
	 * screen; the finer figures (accrual, carry-forward, expiry) sit in each
	 * line's tooltip.
	 */
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import Plane from '@lucide/svelte/icons/plane';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type { MyBalance, MyLeave } from '$lib/leave-planning';

	interface Props {
		me: MyLeave;
		onplan: (start: string, end: string, typeId?: string) => void;
	}

	let { me, onplan }: Props = $props();

	const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
	const plural = (n: number, one: string, many = one + 's') => `${fmtNum(n)} ${n === 1 ? one : many}`;
	const parse = (k: string) => new Date(k + 'T00:00:00');
	const fmtDay = (k: string) => parse(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
	const fmtShort = (k: string) => parse(k).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	const fmtRange = (s: string, e: string) => (s === e ? fmtDay(s) : `${fmtDay(s)} – ${fmtDay(e)}`);
	const daysAway = (k: string) => Math.round((parse(k).getTime() - parse(me.today).getTime()) / 86_400_000);
	function when(k: string) {
		const n = daysAway(k);
		return n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 7 ? `In ${n} days` : n < 60 ? `In ${Math.round(n / 7)} wk` : `In ${Math.round(n / 30)} mo`;
	}

	const t = $derived(me.totals);
	/** Share of what has accrued, for the stacked meter. */
	const seg = $derived.by(() => {
		const whole = Math.max(t.allocated, t.taken + t.scheduled + t.pending + Math.max(0, t.free)) || 1;
		const pct = (n: number) => `${Math.max(0, (n / whole) * 100)}%`;
		return { taken: pct(t.taken), scheduled: pct(t.scheduled), pending: pct(t.pending), free: pct(Math.max(0, t.free)) };
	});
	const lapsing = $derived(me.balances.filter((b) => b.lapsing > 0));
	const yearEnd = '31 Dec';

	/** Everything about one type that doesn't fit its line. */
	function typeDetail(b: MyBalance) {
		const parts = [`${fmtNum(b.taken + b.scheduled)} used`];
		if (b.pending) parts.push(`${fmtNum(b.pending)} pending`);
		if (b.accrualPerMonth > 0) parts.push(`+${fmtNum(b.accrualPerMonth)}/mo → ${fmtNum(b.yearEnd)} by ${yearEnd}`);
		if (b.lapsing > 0) parts.push(`${plural(b.lapsing, 'day')} won't carry over unless ${b.encashable ? 'used or encashed' : 'used'} by ${yearEnd}`);
		else if (b.carryForwardCap === 0 && b.accrualPerMonth > 0) parts.push(`doesn't carry into next year`);
		return `${b.name}: ${parts.join(' · ')}`;
	}
	const used = (b: MyBalance) => {
		const whole = Math.max(b.allocated, b.taken + b.scheduled + b.pending + Math.max(0, b.free)) || 1;
		return { done: ((b.taken + b.scheduled) / whole) * 100, pending: (b.pending / whole) * 100 };
	};

	/** Opens a plan starting tomorrow, to adjust from there. */
	function planNext() {
		const d = parse(me.today);
		d.setDate(d.getDate() + 1);
		const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		onplan(k, k);
	}
</script>

<aside class="rail" aria-label="My leave">
	<!-- ---------- balance ---------- -->
	<section class="blk hero" aria-labelledby="ml-bal">
		<div class="blk-head">
			<h3 id="ml-bal" class="eyebrow">Earned leave · {new Date(`${me.today}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</h3>
			<button type="button" class="plan-btn" onclick={planNext}><CalendarPlus size={13} /> Plan</button>
		</div>
		{#if me.balances.length}
			<p class="big"><b class:neg={t.free < 0}>{fmtNum(t.free)}</b> <span>days free · of {fmtNum(t.allocated)} accrued</span></p>
			<div class="stack" role="img" aria-label="{fmtNum(t.taken)} taken, {fmtNum(t.scheduled)} upcoming, {fmtNum(t.pending)} pending, {fmtNum(Math.max(0, t.free))} free, of {fmtNum(t.allocated)} accrued">
				<span class="s-taken" style="width: {seg.taken}"></span>
				<span class="s-sched" style="width: {seg.scheduled}"></span>
				<span class="s-pend" style="width: {seg.pending}"></span>
				<span class="s-free" style="width: {seg.free}"></span>
			</div>
			<dl class="tally">
				<div><dt><i class="k-taken"></i>Taken</dt><dd>{fmtNum(t.taken)}</dd></div>
				<div><dt><i class="k-sched"></i>Upcoming</dt><dd>{fmtNum(t.scheduled)}</dd></div>
				<div><dt><i class="k-pend"></i>Pending</dt><dd>{fmtNum(t.pending)}</dd></div>
				<div><dt><i class="k-free"></i>Free</dt><dd>{fmtNum(Math.max(0, t.free))}</dd></div>
			</dl>
		{:else}
			<p class="muted">No leave balance on file yet. HR sets it up from your joining and confirmation dates.</p>
		{/if}
	</section>

	<!-- ---------- by type ---------- -->
	{#if me.balances.length || me.monthly.length || me.compOff.available}
		<section class="blk" aria-labelledby="ml-types">
			<h3 id="ml-types" class="eyebrow">Free by type</h3>
			<ul class="lines">
				{#each me.balances as b (b.typeId)}
					{@const u = used(b)}
					<li class="type" data-tone={b.tone} title={typeDetail(b)}>
						<span class="dot"></span>
						<span class="type-name">{b.name}</span>
						{#if b.lapsing > 0}<span class="lapse" aria-label="Some days won't carry over"><TriangleAlert size={11} /></span>{/if}
						<span class="meter" aria-hidden="true"><span style="width: {u.done}%"></span><span class="p" style="width: {u.pending}%"></span></span>
						<b class="num">{fmtNum(b.free)}</b>
					</li>
				{/each}
				{#each me.monthly as m (m.typeId)}
					<li class="type" data-tone="pink" title="{m.name}: this month's quota, resets on the 1st">
						<span class="dot"></span>
						<span class="type-name">{m.name}</span>
						<b class="num">{fmtNum(m.remaining)}<small>/{fmtNum(m.quota)} mo</small></b>
					</li>
				{/each}
				{#if me.compOff.available}
					<li class="type" data-tone="green" title={me.compOff.nextExpiry ? `Comp-off: next credit expires ${fmtShort(me.compOff.nextExpiry)}` : 'Comp-off credits'}>
						<span class="dot"></span>
						<span class="type-name">Comp-off</span>
						{#if me.compOff.expiringSoon}<span class="lapse" aria-label="Expiring soon"><TriangleAlert size={11} /></span>{/if}
						<b class="num">{me.compOff.available}<small> cr</small></b>
					</li>
				{/if}
			</ul>
			{#if lapsing.length}
				<p class="warn"><TriangleAlert size={11} /> {plural(lapsing.reduce((s, b) => s + b.lapsing, 0), 'day')} won't carry over — use by {yearEnd}</p>
			{/if}
		</section>
	{/if}

	<!-- ---------- next time away ---------- -->
	<section class="blk" aria-labelledby="ml-next">
		<h3 id="ml-next" class="eyebrow">Next time off</h3>
		{#if me.next}
			<div class="next">
				<span class="next-ic"><Plane size={15} /></span>
				<div class="next-body">
					<strong>{fmtRange(me.next.start, me.next.end)}</strong>
					<span>{me.next.typeName} · {plural(me.next.days, 'day')}</span>
				</div>
			</div>
			<div class="next-foot">
				<span class="ess-badge {me.next.status === 'approved' ? 'ess-badge--approved' : 'ess-badge--pending'}">{me.next.status === 'approved' ? 'Approved' : 'Pending'}</span>
				<span class="when">{me.next.inDays === 0 ? 'Now' : when(me.next.start)}</span>
			</div>
			{#if me.upcomingCount > 1}<p class="sub">+{me.upcomingCount - 1} more booked · <a href="/leave">See all</a></p>{/if}
		{:else}
			<p class="muted">Nothing booked. {lapsing.length ? "Some days won't carry over — plan a break." : 'Drag across your row to plan one.'}</p>
		{/if}
	</section>

	<!-- ---------- long weekends ---------- -->
	<section class="blk" aria-labelledby="ml-ideas">
		<h3 id="ml-ideas" class="eyebrow"><Sparkles size={11} /> Long weekends</h3>
		{#if me.ideas.length}
			<ul class="lines ideas">
				{#each me.ideas.slice(0, 2) as idea (idea.breakStart)}
					<li title="{idea.holiday}: {fmtShort(idea.breakStart)} – {fmtShort(idea.breakEnd)}">
						<div class="idea-main">
							<strong>{plural(idea.breakDays, 'day')} · {idea.holiday}</strong>
							<span>
								{#if idea.leaveDays === 0}{fmtShort(idea.breakStart)} – {fmtShort(idea.breakEnd)} · no leave needed{:else}Take {idea.apply.map((r) => fmtRange(r.start, r.end)).join(' + ')}{/if}
							</span>
						</div>
						{#if idea.apply.length}
							<button type="button" class="mini-btn" onclick={() => onplan(idea.apply[0].start, idea.apply[0].end)}>Plan</button>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">{me.holidays.hasCalendar ? 'No holiday breaks coming up in the next six months.' : 'Appears once your holiday calendar is published.'}</p>
		{/if}
	</section>

	<!-- ---------- holidays ---------- -->
	<section class="blk" aria-labelledby="ml-hol">
		<div class="blk-head">
			<h3 id="ml-hol" class="eyebrow">Holidays</h3>
			{#if me.holidays.totalThisYear}<span class="meta">{me.holidays.leftThisYear} of {me.holidays.totalThisYear} left</span>{/if}
		</div>
		{#if me.holidays.upcoming.length}
			<ul class="lines">
				{#each me.holidays.upcoming.slice(0, 3) as h (h.date)}
					<li class="hol" title="{h.name} · {fmtDay(h.date)}{h.type !== 'PUBLIC' ? ` · ${h.type.toLowerCase()}` : ''}">
						<span class="hol-date">{fmtShort(h.date)}</span>
						<span class="hol-name">{h.name}</span>
						<span class="when">{when(h.date)}</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">{me.holidays.hasCalendar ? 'No more holidays this year.' : 'No holiday calendar is published for your shift yet.'}</p>
		{/if}
	</section>
</aside>

<style>
	/* One row of equal blocks on a laptop; they wrap two or one to a row on
	   narrower screens, each still the height of the tallest beside it. */
	.rail {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
		gap: 10px;
	}
	/* Laptops: all five in one row, so the strip stays one block tall. */
	@media (min-width: 1101px) {
		.rail {
			grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
		}
	}
	.blk {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
		padding: 8px 11px;
		border-radius: 14px;
		background: var(--ess-sunken);
	}
	.blk-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 22px;
	}
	.eyebrow {
		display: flex;
		align-items: center;
		gap: 5px;
		margin: 0;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--ess-text-muted);
	}
	.meta {
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
	.muted,
	.sub {
		margin: 0;
		font-size: 12px;
		color: var(--ess-text-muted);
		line-height: 1.4;
	}

	/* ---------- balance ---------- */
	.hero {
		background: linear-gradient(160deg, var(--ess-primary-softer), var(--ess-sunken) 70%);
	}
	.plan-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 22px;
		padding: 0 9px;
		border: 0;
		border-radius: 999px;
		background: var(--ess-primary);
		color: var(--ess-text-on-primary);
		font: inherit;
		font-size: 11.5px;
		font-weight: 600;
		cursor: pointer;
		box-shadow: var(--ess-primary-shadow);
	}
	.plan-btn:hover {
		background: var(--ess-primary-hover);
	}
	.big {
		display: flex;
		align-items: baseline;
		gap: 6px;
		margin: 0;
	}
	.big b {
		font-size: 22px;
		font-weight: 700;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
		line-height: 1;
	}
	.big b.neg {
		color: var(--ess-danger);
	}
	.big span {
		font-size: 12px;
		color: var(--ess-text-secondary);
	}
	.stack {
		display: flex;
		height: 7px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--ess-cell);
	}
	.stack span {
		transition: width var(--ess-t-slow);
	}
	.s-taken,
	.k-taken {
		background: var(--ess-text-secondary);
	}
	.s-sched,
	.k-sched {
		background: var(--ess-ev-blue);
	}
	.s-pend,
	.k-pend {
		background: var(--ess-warning);
	}
	.s-free,
	.k-free {
		background: var(--ess-primary);
	}
	.tally {
		display: grid;
		grid-template-columns: repeat(4, auto);
		justify-content: space-between;
		gap: 6px;
		margin: 0;
	}
	.tally div {
		display: flex;
		flex-direction: column-reverse;
	}
	.tally dt {
		display: flex;
		align-items: center;
		gap: 3px;
		font-size: 10.5px;
		color: var(--ess-text-muted);
		white-space: nowrap;
	}
	.tally dt i {
		width: 6px;
		height: 6px;
		border-radius: 2px;
		flex-shrink: 0;
	}
	.tally dd {
		margin: 0;
		font-size: 13.5px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}

	/* ---------- one-line lists ---------- */
	.lines {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.type {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
	}
	.type[data-tone='blue'] {
		--tone: var(--ess-ev-blue);
	}
	.type[data-tone='purple'] {
		--tone: var(--ess-ev-purple);
	}
	.type[data-tone='green'] {
		--tone: var(--ess-ev-green);
	}
	.type[data-tone='yellow'] {
		--tone: var(--ess-ev-yellow);
	}
	.type[data-tone='pink'] {
		--tone: var(--ess-ev-pink);
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 2px;
		background: var(--tone);
		flex-shrink: 0;
	}
	.type-name {
		flex: 1;
		min-width: 0;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.lapse {
		display: inline-flex;
		color: var(--ess-warning);
	}
	.meter {
		display: flex;
		width: 44px;
		height: 4px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--ess-cell);
		flex-shrink: 0;
	}
	.meter span {
		background: var(--tone);
	}
	.meter span.p {
		background: color-mix(in srgb, var(--tone) 40%, transparent);
	}
	.num {
		min-width: 22px;
		text-align: right;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.num small {
		font-size: 10.5px;
		font-weight: 500;
		color: var(--ess-text-muted);
	}
	.warn {
		display: flex;
		align-items: center;
		gap: 4px;
		margin: auto 0 0;
		font-size: 11px;
		font-weight: 500;
		color: var(--ess-warning);
	}

	/* ---------- next ---------- */
	.next {
		display: flex;
		align-items: center;
		gap: 9px;
	}
	.next-ic {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 8px;
		background: var(--ess-surface);
		color: var(--ess-primary-text);
		flex-shrink: 0;
	}
	.next-body {
		display: flex;
		flex-direction: column;
		min-width: 0;
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
	.next-body strong {
		font-size: 12.5px;
		color: var(--ess-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.next-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.when {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ess-primary-text);
		white-space: nowrap;
	}

	/* ---------- ideas ---------- */
	.ideas li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 7px;
		border-radius: 9px;
		background: var(--ess-surface);
	}
	.idea-main {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		font-size: 11.5px;
		color: var(--ess-text-muted);
		line-height: 1.3;
	}
	.idea-main strong,
	.idea-main span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.idea-main strong {
		font-size: 12.5px;
		color: var(--ess-text);
	}
	.mini-btn {
		height: 24px;
		padding: 0 9px;
		border: 0;
		border-radius: 999px;
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
		font: inherit;
		font-size: 11.5px;
		font-weight: 600;
		cursor: pointer;
		flex-shrink: 0;
	}
	.mini-btn:hover {
		background: var(--ess-primary);
		color: var(--ess-text-on-primary);
	}

	/* ---------- holidays ---------- */
	.hol {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
	}
	.hol-date {
		flex-shrink: 0;
		min-width: 48px;
		padding: 2px 0;
		border-radius: 6px;
		background: var(--ess-ev-yellow-bg);
		box-shadow: inset 0 0 0 1px var(--ess-ev-yellow-line);
		color: var(--ess-ev-yellow);
		font-size: 11px;
		font-weight: 600;
		text-align: center;
	}
	.hol-name {
		flex: 1;
		min-width: 0;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
