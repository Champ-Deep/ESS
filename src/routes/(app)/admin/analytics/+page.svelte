<script lang="ts">
	/**
	 * Admin → HR analytics. Every figure comes from $lib/server/hr-analytics,
	 * with the definitions in $lib/hr-analytics. The filters above scope every
	 * card below them; each card can switch to a table of the same numbers.
	 *
	 * Each card leads with the answer — a number and its change — and the
	 * chart shows the shape behind it. Colours: four categorical slots
	 * validated (dataviz validator) against the ESS card surfaces in both
	 * themes and assigned by meaning, never rank; counts on a grid use one
	 * blue ramp; overdue work uses the warning colour with an icon.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Users from '@lucide/svelte/icons/users';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ChartCard from '$lib/components/analytics/ChartCard.svelte';
	import DeskStatsCard from '$lib/components/DeskStatsCard.svelte';
	import LineChart from '$lib/components/analytics/LineChart.svelte';
	import ColumnChart from '$lib/components/analytics/ColumnChart.svelte';
	import BarList from '$lib/components/analytics/BarList.svelte';
	import ShareBars from '$lib/components/analytics/ShareBars.svelte';
	import Sparkline from '$lib/components/analytics/Sparkline.svelte';
	import Delta from '$lib/components/analytics/Delta.svelte';
	import DivergingColumns from '$lib/components/analytics/DivergingColumns.svelte';
	import Donut from '$lib/components/analytics/Donut.svelte';
	import Pyramid from '$lib/components/analytics/Pyramid.svelte';
	import CalendarHeatmap from '$lib/components/analytics/CalendarHeatmap.svelte';
	import MatrixHeatmap from '$lib/components/analytics/MatrixHeatmap.svelte';

	let { data } = $props();
	const a = $derived(data.analytics);

	const S1 = 'var(--hra-1)';
	const S2 = 'var(--hra-2)';
	const S3 = 'var(--hra-3)';
	const S4 = 'var(--hra-4)';
	const NONE = 'var(--hra-none)';

	/* ---------- filters (in the URL, so a view can be shared) ---------- */
	function setFilter(key: 'months' | 'dept', value: string | null) {
		const q = new URLSearchParams(page.url.searchParams);
		if (value) q.set(key, value);
		else q.delete(key);
		void goto(`?${q}`, { keepFocus: true, noScroll: true });
	}

	/* ---------- helpers ---------- */
	const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));
	const pctFmt = (n: number | null) => (n === null ? '—' : `${fmt(n)}%`);
	const labels = $derived(a.headcount.map((h) => h.label));
	const shortMonth = (label: string) => label.split(' ')[0];

	/** The latest month with a value, and the change from the one before it that has one. */
	function latest<T extends { label: string }>(list: T[], pick: (x: T) => number | null) {
		const known = list.map((x) => ({ v: pick(x), label: x.label })).filter((x): x is { v: number; label: string } => x.v !== null);
		const now = known.at(-1);
		const before = known.at(-2);
		return now ? { value: now.v, label: now.label, delta: before ? Math.round((now.v - before.v) * 10) / 10 : null, vs: before ? shortMonth(before.label) : '' } : null;
	}

	/* ---------- headline figures ---------- */
	const ratio = $derived(a.totals.exits ? `${fmt(Math.round((a.totals.hires / a.totals.exits) * 10) / 10)} : 1` : a.totals.hires ? `${a.totals.hires} : 0` : '—');
	const period = $derived(`last ${a.months} months`);

	/* ---------- engagement ---------- */
	const eng = $derived(latest(a.engagement, (e) => e.score));
	const engNow = $derived(a.engagement.findLast((e) => e.score !== null) ?? null);
	const DRIVERS = [
		{ key: 'attendance', name: 'Turned up when expected' },
		{ key: 'chat', name: 'Posted in chat' },
		{ key: 'reads', name: 'Read announcements' },
		{ key: 'tasksOnTime', name: 'Tasks done on time' }
	] as const;

	/* ---------- headcount & movement ---------- */
	const net = $derived(a.totals.hires - a.totals.exits);

	/* ---------- absence ---------- */
	const unplanned = $derived(latest(a.absence, (x) => x.unplanned));

	/* ---------- headcount grouping ---------- */
	type GroupBy = keyof typeof a.groups;
	let groupBy = $state<GroupBy>('department');
	const GROUPS: { id: GroupBy; label: string }[] = [
		{ id: 'department', label: 'Department' },
		{ id: 'team', label: 'Team' },
		{ id: 'designation', label: 'Designation' },
		{ id: 'shift', label: 'Shift' }
	];
	// Inside one department, "by department" is a single bar: show designations.
	const groupOptions = $derived(a.department ? GROUPS.filter((g) => g.id !== 'department') : GROUPS);
	const shownGroup = $derived(groupOptions.some((g) => g.id === groupBy) ? groupBy : 'designation');
	const grouped = $derived(a.groups[shownGroup]);

	/* ---------- gender ---------- */
	const GENDER_KEYS = [
		{ name: 'Female', color: S1, ink: '#fff' },
		{ name: 'Male', color: S2, ink: '#1d1d1f' },
		{ name: 'Other', color: S3, ink: '#1d1d1f' },
		{ name: 'Not recorded', color: NONE, ink: 'var(--ess-text-secondary)' }
	];
	const genderItems = $derived(GENDER_KEYS.map((k) => ({ name: k.name, color: k.color, count: a.gender.overall.find((g) => g.name === k.name)?.count ?? 0 })));
	const deptGenderRows: { name: string; counts: Record<string, number>; total: number }[] = $derived(a.department ? [] : a.gender.byGroup);
	const femaleShare = $derived(a.totals.active ? Math.round(((a.gender.overall.find((g) => g.name === 'Female')?.count ?? 0) / a.totals.active) * 100) : 0);

	/* ---------- leave by type ---------- */
	const LEAVE_COLORS = [S1, S2, S3, S4];
	const leaveSeries = $derived(
		a.leaveByType.types.map((t, i) => ({ name: t, color: t === 'Other' ? NONE : LEAVE_COLORS[i] ?? NONE, values: a.leaveByType.months.map((m) => m.days[t] ?? 0) }))
	);
	const leaveTotal = $derived(leaveSeries.reduce((s, x) => s + x.values.reduce((t, v) => t + v, 0), 0));
	const topLeave = $derived([...leaveSeries].filter((s) => s.name !== 'Other').sort((x, y) => y.values.reduce((t, v) => t + v, 0) - x.values.reduce((t, v) => t + v, 0))[0]);

	/* ---------- attrition ---------- */
	const attritionRows = $derived(a.attrition.map((r) => ({ name: r.name, cells: r.cells.map((c) => ({ value: c.exits, detail: `${c.rate}% of the department` })) })));
	const hotDept = $derived([...a.attrition].map((r) => ({ name: r.name, exits: r.cells.reduce((s, c) => s + c.exits, 0) })).sort((x, y) => y.exits - x.exits)[0]);

	/* ---------- tasks & meetings ---------- */
	const STAGES = [
		{ name: 'To do', color: 'var(--hra-o1)', ink: '#1d1d1f' },
		{ name: 'In progress', color: 'var(--hra-o2)', ink: '#fff' },
		{ name: 'In review', color: 'var(--hra-o3)', ink: '#fff' }
	];
	const openTotal = $derived(a.status.todo + a.status.inProgress + a.status.inReview);
	const stageRow = $derived([{ name: 'Open tasks', counts: { 'To do': a.status.todo, 'In progress': a.status.inProgress, 'In review': a.status.inReview }, total: openTotal }]);
	const maxOpen = $derived(Math.max(1, ...a.workload.map((w) => w.open)));
	const assignedTotal = $derived(a.work.reduce((s, w) => s + w.assigned, 0));
	const completedTotal = $derived(a.work.reduce((s, w) => s + w.completed, 0));
	const meetingsTotal = $derived(a.meetingDays.reduce((s, d) => s + d.count, 0));
	const busiestDay = $derived.by(() => {
		const byDow = [0, 0, 0, 0, 0, 0, 0];
		for (const d of a.meetingDays) byDow[(new Date(d.date + 'T00:00:00').getDay() + 6) % 7] += d.count;
		const i = byDow.indexOf(Math.max(...byDow));
		return byDow[i] ? ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][i] : null;
	});
</script>

<div class="hra">
	<!-- ---------- filters: one row, scoping everything below ---------- -->
	<div class="filters" role="group" aria-label="Filters">
		<div class="seg" role="group" aria-label="Period">
			{#each data.rangeOptions as m (m)}
				<button type="button" aria-pressed={a.months === m} onclick={() => setFilter('months', m === 12 ? null : String(m))}>{m} months</button>
			{/each}
		</div>
		<label class="dept">
			<span class="ess-sr-only">Department</span>
			<select class="ess-select" value={a.department ?? ''} onchange={(e) => setFilter('dept', e.currentTarget.value || null)}>
				<option value="">All departments</option>
				{#each a.departments as d (d)}<option value={d}>{d}</option>{/each}
			</select>
		</label>
		<span class="asof">{a.from.slice(0, 7)} to {a.today} · live data</span>
	</div>

	<!-- ---------- headline figures ---------- -->
	<div class="kpis">
		<div class="kpi hero">
			<span class="k-label"><Users size={14} /> Active headcount</span>
			<div class="k-row">
				<b class="k-value">{fmt(a.totals.active)}</b>
				<div class="k-spark"><Sparkline values={a.headcount.map((h) => h.headcount)} color={S1} height={34} /></div>
			</div>
			<span class="k-sub">+{a.totals.hires} joined · −{a.totals.exits} left, {period}</span>
		</div>
		<div class="kpi">
			<span class="k-label">Hire : exit ratio</span>
			<b class="k-value">{ratio}</b>
			<span class="k-sub">{a.totals.exits ? `${a.totals.hires} ${a.totals.hires === 1 ? 'hire' : 'hires'} for ${a.totals.exits} ${a.totals.exits === 1 ? 'exit' : 'exits'}` : 'No exits in this period'}</span>
		</div>
		<div class="kpi">
			<span class="k-label">Unplanned absence</span>
			<b class="k-value">{unplanned ? `${fmt(unplanned.value)}%` : '—'}</b>
			{#if unplanned?.delta != null}<Delta value={unplanned.delta} unit=" pts" vs={unplanned.vs} upIsGood={false} />{:else}<span class="k-sub">{unplanned ? unplanned.label : 'No attendance feed yet'}</span>{/if}
		</div>
		<div class="kpi">
			<span class="k-label">Engagement</span>
			<b class="k-value">{eng ? fmt(eng.value) : '—'}<small>/100</small></b>
			{#if eng?.delta != null}<Delta value={eng.delta} unit=" pts" vs={eng.vs} />{:else}<span class="k-sub">{eng ? eng.label : 'Not enough activity yet'}</span>{/if}
		</div>
		<div class="kpi">
			<span class="k-label">Median age</span>
			<b class="k-value">{a.totals.medianAge ?? '—'}</b>
			<span class="k-sub">{a.age.known} of {a.totals.active} with a date of birth</span>
		</div>
	</div>

	<div class="cards">
		<!-- ---------- engagement: the score, its direction, what drives it ---------- -->
		<ChartCard title="Employee engagement" sub="Score out of 100 from portal activity, and what drives it" note="The score is the average of the four parts below, for the latest month with data.">
			{#snippet chart()}
				<div class="lead">
					<div class="lead-num">
						<b>{eng ? fmt(eng.value) : '—'}</b>
						<span>{eng ? eng.label : 'No data yet'}</span>
						{#if eng?.delta != null}<Delta value={eng.delta} unit=" pts" vs={eng.vs} />{/if}
					</div>
					<div class="lead-spark"><Sparkline values={a.engagement.map((e) => e.score)} color={S1} height={64} /></div>
				</div>
				<ul class="drivers">
					{#each DRIVERS as d (d.key)}
						{@const v = engNow ? engNow[d.key] : null}
						<li>
							<span class="d-name">{d.name}</span>
							<span class="d-track"><span class="d-fill" style="width: {v ?? 0}%; background: {S1}"></span></span>
							<b>{v === null ? '—' : `${Math.round(v)}%`}</b>
						</li>
					{/each}
				</ul>
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Month</th><th>Score</th><th>Turned up</th><th>Chat</th><th>Read</th><th>On time</th></tr></thead>
					<tbody>
						{#each a.engagement as e (e.key)}
							<tr><td>{e.label}</td><td>{e.score ?? '—'}</td><td>{pctFmt(e.attendance)}</td><td>{pctFmt(e.chat)}</td><td>{pctFmt(e.reads)}</td><td>{pctFmt(e.tasksOnTime)}</td></tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- hires vs exits: growth up, loss down ---------- -->
		<ChartCard title="Hires vs exits" sub="Joined above the line, left below it" note="An exit counts on the person’s last working day (from Alumni or payroll), else in the month their login was closed.">
			{#snippet chart()}
				<div class="lead compact">
					<div class="lead-num">
						<b class:up={net > 0} class:down={net < 0}>{net > 0 ? '+' : ''}{net}</b>
						<span>net change · {a.totals.hires} in, {a.totals.exits} out · ratio {ratio}</span>
					</div>
				</div>
				<DivergingColumns label="Hires and exits by month" {labels} up={{ name: 'Hires', color: S1, values: a.headcount.map((h) => h.hires) }} down={{ name: 'Exits', color: S2, values: a.headcount.map((h) => h.exits) }} height={196} />
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Month</th><th>Hires</th><th>Exits</th><th>Net</th><th>Headcount</th></tr></thead>
					<tbody>
						{#each a.headcount as h (h.key)}
							<tr><td>{h.label}</td><td>{h.hires}</td><td>{h.exits}</td><td>{h.hires - h.exits > 0 ? '+' : ''}{h.hires - h.exits}</td><td>{h.headcount}</td></tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- absenteeism ---------- -->
		<ChartCard title="Absenteeism" sub="Each month, as a share of scheduled working days" note="Unplanned: no punch and no approved leave, on days the attendance feed has data. On leave: approved leave days.">
			{#snippet chart()}
				<div class="minis">
					<div class="mini-chart">
						<div class="mini-head">
							<span class="mini-title">Absence</span>
							<b>{unplanned ? `${fmt(unplanned.value)}%` : '—'}</b>
							{#if unplanned?.delta != null}<Delta value={unplanned.delta} unit=" pts" vs={unplanned.vs} upIsGood={false} />{/if}
							<span class="mini-keys"><span><i class="ln" style="background: {S1}"></i>Unplanned</span><span><i class="ln" style="background: {S2}"></i>On leave</span></span>
						</div>
						<LineChart
							label="Unplanned absence and leave by month, in percent"
							{labels}
							unit="%"
							height={150}
							series={[
								{ name: 'Unplanned', color: S1, values: a.absence.map((x) => x.unplanned) },
								{ name: 'On leave', color: S2, values: a.absence.map((x) => x.leave) }
							]}
						/>
					</div>
				</div>
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Month</th><th>Unplanned</th><th>On leave</th><th>Scheduled days</th></tr></thead>
					<tbody>
						{#each a.absence as x (x.key)}
							<tr><td>{x.label}</td><td>{pctFmt(x.unplanned)}</td><td>{x.leave}%</td><td>{x.scheduled.toLocaleString()}</td></tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- headcount by group ---------- -->
		<ChartCard title="Headcount by {GROUPS.find((g) => g.id === shownGroup)!.label.toLowerCase()}" sub="{a.totals.active} active{a.department ? ` in ${a.department}` : ''}">
			{#snippet tools()}
				<label class="mini">
					<span class="ess-sr-only">Group by</span>
					<select value={shownGroup} onchange={(e) => (groupBy = e.currentTarget.value as GroupBy)}>
						{#each groupOptions as g (g.id)}<option value={g.id}>{g.label}</option>{/each}
					</select>
				</label>
			{/snippet}
			{#snippet chart()}
				<BarList items={grouped} color={S1} />
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>{GROUPS.find((g) => g.id === shownGroup)!.label}</th><th>People</th><th>Share</th></tr></thead>
					<tbody>
						{#each grouped as g (g.name)}
							<tr><td>{g.name}</td><td>{g.count}</td><td>{a.totals.active ? Math.round((g.count / a.totals.active) * 100) : 0}%</td></tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- gender: the whole, then by department ---------- -->
		<ChartCard title="Gender diversity" sub="{femaleShare}% women among active people">
			{#snippet chart()}
				<Donut items={genderItems} centre="active" size={112} />
				{#if deptGenderRows.length > 1}
					<p class="sub-h">By department</p>
					<div class="fill-list"><ShareBars keys={GENDER_KEYS} rows={deptGenderRows} totalFirst={false} /></div>
				{/if}
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Group</th>{#each GENDER_KEYS as k (k.name)}<th>{k.name}</th>{/each}<th>Total</th></tr></thead>
					<tbody>
						<tr><td>All active</td>{#each genderItems as g (g.name)}<td>{g.count}</td>{/each}<td>{a.totals.active}</td></tr>
						{#each deptGenderRows as r (r.name)}
							<tr><td>{r.name}</td>{#each GENDER_KEYS as k (k.name)}<td>{r.counts[k.name] ?? 0}</td>{/each}<td>{r.total}</td></tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- age: a population pyramid ---------- -->
		<ChartCard
			title="Age group distribution"
			sub="Women and men in each age band{a.totals.medianAge ? ` · median age ${a.totals.medianAge}` : ''}"
			note={a.age.unknown || a.age.pyramidOther
				? `Not shown: ${[a.age.unknown ? `${a.age.unknown} without a date of birth` : '', a.age.pyramidOther ? `${a.age.pyramidOther} with another or no recorded gender` : ''].filter(Boolean).join(', ')}.`
				: undefined}
		>
			{#snippet chart()}
				<Pyramid rows={a.age.pyramid.map((r) => ({ band: r.band, left: r.female, right: r.male }))} left={{ name: 'Women', color: S1 }} right={{ name: 'Men', color: S2 }} />
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Age group</th><th>Women</th><th>Men</th><th>All</th></tr></thead>
					<tbody>
						{#each a.age.pyramid as r, i (r.band)}
							<tr><td>{r.band}</td><td>{r.female}</td><td>{r.male}</td><td>{a.age.bands[i].count}</td></tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- attrition by department ---------- -->
		<ChartCard title="Attrition by department" sub={hotDept?.exits ? `Most exits: ${hotDept.name} (${hotDept.exits})` : 'Exits by department and month'} note="Darker means more exits that month. Hover for the share of the department.">
			{#snippet chart()}
				<MatrixHeatmap rows={attritionRows} labels={labels.map(shortMonth)} noun="exit" />
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Department</th>{#each labels as l (l)}<th>{shortMonth(l)}</th>{/each}</tr></thead>
					<tbody>
						{#each a.attrition as r (r.name)}
							<tr><td>{r.name}</td>{#each r.cells as c, i (i)}<td>{c.exits}</td>{/each}</tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- leave by type ---------- -->
		<ChartCard title="Leave by type" sub={leaveTotal ? `${fmt(leaveTotal)} approved leave days${topLeave ? ` · most used: ${topLeave.name}` : ''}` : 'Approved leave days by type'} note="Working days only — week offs and holidays inside a leave aren't counted.">
			{#snippet legend()}
				<div class="legend">{#each leaveSeries as s (s.name)}<span><i class="sw" style="background: {s.color}"></i>{s.name}</span>{/each}</div>
			{/snippet}
			{#snippet chart()}
				<ColumnChart label="Approved leave days by type and month" {labels} series={leaveSeries} stacked height={150} />
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Month</th>{#each leaveSeries as s (s.name)}<th>{s.name}</th>{/each}</tr></thead>
					<tbody>
						{#each labels as l, i (l)}
							<tr><td>{l}</td>{#each leaveSeries as s (s.name)}<td>{s.values[i]}</td>{/each}</tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- workload ---------- -->
		<ChartCard cls="span-2-at-laptop" title="Who's carrying the work" sub="Open tasks per person right now · {a.status.overdue} overdue overall">
			{#snippet legend()}
				<div class="legend">
					<span><i class="sw" style="background: {S1}"></i>Open, on track</span>
					<span><TriangleAlert size={11} class="warn-ic" /><i class="sw" style="background: var(--ess-warning)"></i>Overdue</span>
				</div>
			{/snippet}
			{#snippet chart()}
				{#if a.workload.length}
					<ul class="load">
						{#each a.workload as w (w.id)}
							<li title="{w.name}: {w.open} open, {w.overdue} overdue, {w.done} done, {w.meetings} meetings">
								<span class="l-name">{w.name}</span>
								<span class="l-track">
									{#if w.overdue}<span class="l-over" style="width: {(w.overdue / maxOpen) * 100}%"></span>{/if}
									{#if w.open - w.overdue}<span class="l-ok" style="width: {((w.open - w.overdue) / maxOpen) * 100}%; background: {S1}"></span>{/if}
								</span>
								<b>{w.open}</b>
								<span class="l-meta">{w.meetings} mtgs</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="hint">No open tasks or meetings in this period.</p>
				{/if}
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Person</th><th>Open</th><th>Overdue</th><th>Done</th><th>Meetings</th></tr></thead>
					<tbody>
						{#each a.workload as w (w.id)}
							<tr><td>{w.name}</td><td>{w.open}</td><td>{w.overdue}</td><td>{w.done}</td><td>{w.meetings}</td></tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>

		<!-- ---------- meetings & tasks ---------- -->
		<ChartCard wide title="Meetings & task assignments" sub="Work given out and finished, when meetings happen, and where open work stands">
			{#snippet chart()}
				<div class="work">
					<div class="work-col">
						<h3>Tasks assigned vs completed</h3>
						<div class="legend"><span><i class="sw" style="background: {S1}"></i>Assigned</span><span><i class="sw" style="background: {S4}"></i>Completed</span></div>
						<ColumnChart
							label="Tasks assigned and completed by month"
							{labels}
							height={140}
							series={[
								{ name: 'Assigned', color: S1, values: a.work.map((w) => w.assigned) },
								{ name: 'Completed', color: S4, values: a.work.map((w) => w.completed) }
							]}
						/>
					</div>
					<div class="work-col">
						<h3>Meetings, day by day</h3>
						<p class="hint">{meetingsTotal} in the last 26 weeks{busiestDay ? ` · busiest on ${busiestDay}` : ''}</p>
						<CalendarHeatmap days={a.meetingDays} />
					</div>
					<div class="work-col">
						<h3>Open tasks by stage</h3>
						<div class="legend">{#each STAGES as k (k.name)}<span><i class="sw" style="background: {k.color}"></i>{k.name}</span>{/each}</div>
						<ShareBars keys={STAGES} rows={stageRow} />
						<p class="overdue" class:has={a.status.overdue > 0}>
							{#if a.status.overdue > 0}<TriangleAlert size={14} />{/if}
							<b>{a.status.overdue}</b> of {openTotal} open tasks are past their due date
						</p>
						<dl class="figs">
							<div><dt>Assigned</dt><dd>{assignedTotal}</dd></div>
							<div><dt>Completed</dt><dd>{completedTotal}</dd></div>
							<div><dt>Completion rate</dt><dd>{assignedTotal ? `${Math.round((completedTotal / assignedTotal) * 100)}%` : '—'}</dd></div>
							<div><dt>Meetings per person</dt><dd>{a.totals.active ? fmt(Math.round((a.work.reduce((s, w) => s + w.attendance, 0) / a.totals.active) * 10) / 10) : '—'}</dd></div>
						</dl>
					</div>
				</div>
			{/snippet}
			{#snippet table()}
				<table>
					<thead><tr><th>Month</th><th>Tasks assigned</th><th>Tasks completed</th><th>Meetings</th><th>Seats filled</th></tr></thead>
					<tbody>
						{#each a.work as w (w.key)}
							<tr><td>{w.label}</td><td>{w.assigned}</td><td>{w.completed}</td><td>{w.meetings}</td><td>{w.attendance}</td></tr>
						{/each}
					</tbody>
				</table>
			{/snippet}
		</ChartCard>
	</div>
	{#if data.hrDesk}
		<div class="desk-row"><DeskStatsCard title="Ask HR desk" stats={data.hrDesk} /></div>
	{/if}
</div>

<style>
	.desk-row {
		grid-column: 1 / -1;
	}
	/* Chart colours, each stepped separately for the dark theme:
	   - categorical slots 1–4 and a neutral for "not recorded";
	   - a blue ramp for task stages (o1–o3);
	   - a blue ramp for counts on a grid (q1–q4), with the ink that reads on each. */
	.hra {
		--hra-1: #2a78d6;
		--hra-2: #eb6834;
		--hra-3: #1baf7a;
		--hra-4: #eda100;
		--hra-none: #d2d2d8;
		--hra-o1: #86b6ef;
		--hra-o2: #3987e5;
		--hra-o3: #1c5cab;
		--hra-q1: #86b6ef;
		--hra-q2: #5598e7;
		--hra-q3: #2a78d6;
		--hra-q4: #184f95;
		--hra-q-ink-12: #0d366b;
		--hra-q-ink-34: #ffffff;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-bottom: 16px;
	}
	:global([data-ess-theme='dark']) .hra {
		--hra-1: #3987e5;
		--hra-2: #d95926;
		--hra-3: #199e70;
		--hra-4: #c98500;
		--hra-none: #3a3e57;
		--hra-o1: #5598e7;
		--hra-o2: #2a78d6;
		--hra-o3: #184f95;
		--hra-q1: #184f95;
		--hra-q2: #256abf;
		--hra-q3: #5598e7;
		--hra-q4: #9ec5f4;
		--hra-q-ink-12: #ffffff;
		--hra-q-ink-34: #0b1020;
	}

	/* ---------- filters ---------- */
	.filters {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
	}
	.seg {
		display: flex;
		padding: 3px;
		border-radius: 999px;
		background: var(--ess-sunken);
	}
	.seg button {
		height: 26px;
		padding: 0 12px;
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
	.dept select {
		min-width: 180px;
		height: 32px;
		font-size: 12.5px;
	}
	.asof {
		margin-left: auto;
		font-size: 12px;
		color: var(--ess-text-muted);
	}

	/* ---------- headline figures ---------- */
	.kpis {
		display: grid;
		grid-template-columns: 1.4fr repeat(4, minmax(0, 1fr));
		gap: 10px;
	}
	.kpi {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		padding: 9px 12px;
		border-radius: 14px;
		background: var(--ess-surface);
		box-shadow: 0 0 0 1px var(--ess-border-subtle);
	}
	.kpi.hero {
		background: linear-gradient(150deg, var(--ess-primary-softer), var(--ess-surface) 75%);
	}
	.k-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
	.k-row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.k-spark {
		flex: 1;
		min-width: 0;
	}
	.k-value {
		font-size: 21px;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.15;
	}
	.hero .k-value {
		font-size: 30px;
		line-height: 1.05;
	}
	.k-value small {
		font-size: 12px;
		font-weight: 500;
		color: var(--ess-text-muted);
	}
	.k-sub {
		font-size: 11px;
		color: var(--ess-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* ---------- cards ---------- */
	.cards {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 12px;
		font-size: 11px;
		color: var(--ess-text-secondary);
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.legend :global(.warn-ic) {
		color: var(--ess-warning);
	}
	.sw {
		width: 9px;
		height: 9px;
		border-radius: 3px;
	}
	.ln {
		width: 12px;
		height: 2px;
		border-radius: 1px;
	}
	.mini select {
		height: 26px;
		padding: 0 8px;
		border: 0;
		border-radius: 999px;
		background: var(--ess-sunken);
		color: var(--ess-text);
		font: inherit;
		font-size: 11.5px;
	}
	.hint,
	.sub-h {
		margin: 0;
		font-size: 11px;
		color: var(--ess-text-muted);
	}
	.sub-h {
		margin-top: 4px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		font-size: 10px;
	}

	/* ---------- lead number + spark ---------- */
	.lead {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.lead-num {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex-shrink: 0;
	}
	.lead-num b {
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.03em;
		line-height: 1;
	}
	.lead.compact .lead-num {
		flex-direction: row;
		align-items: baseline;
		gap: 8px;
	}
	.lead.compact .lead-num b {
		font-size: 24px;
	}
	.lead-num b.up {
		color: var(--ess-success);
	}
	.lead-num b.down {
		color: var(--ess-danger);
	}
	.lead-num span {
		font-size: 11px;
		color: var(--ess-text-muted);
	}
	.lead-spark {
		flex: 1;
		min-width: 0;
	}

	/* ---------- engagement drivers ---------- */
	.drivers {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		justify-content: space-evenly;
		gap: 9px;
		margin: 8px 0 0;
		padding: 0;
		list-style: none;
	}
	.drivers li {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) 1fr 34px;
		align-items: center;
		gap: 8px;
		font-size: 11.5px;
	}
	.d-name {
		color: var(--ess-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.d-track {
		height: 6px;
		border-radius: 999px;
		background: var(--ess-sunken);
		overflow: hidden;
	}
	.d-fill {
		display: block;
		height: 100%;
		border-radius: 999px;
		transition: width var(--ess-t-slow);
	}
	.drivers b {
		text-align: right;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
	}

	/* ---------- absence ---------- */
	.minis {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 6px;
	}
	.mini-chart {
		display: flex;
		flex: 1 1 0;
		flex-direction: column;
	}
	.mini-head {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 4px 8px;
	}
	.mini-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--ess-text-secondary);
	}
	.mini-head b {
		font-size: 17px;
		font-weight: 700;
	}
	.mini-keys {
		display: inline-flex;
		gap: 10px;
		margin-left: auto;
		font-size: 10.5px;
		color: var(--ess-text-muted);
	}
	.mini-keys span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	/* ---------- workload ---------- */
	.load {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		justify-content: space-evenly;
		gap: 5px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.load li {
		display: grid;
		flex: 1 1 auto;
		max-height: 38px;
		grid-template-columns: minmax(80px, 32%) 1fr 20px 48px;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	.l-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ess-text-secondary);
	}
	.l-track {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 100%;
	}
	.l-over,
	.l-ok {
		height: 55%;
		min-height: 12px;
		max-height: 18px;
	}
	.l-over {
		background: var(--ess-warning);
		border-radius: 0;
	}
	.l-track > :last-child {
		border-radius: 0 4px 4px 0;
	}
	.load b {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.l-meta {
		font-size: 10.5px;
		color: var(--ess-text-muted);
		text-align: right;
		white-space: nowrap;
	}

	.fill-list {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
	}
	.fill-list :global(.share) {
		flex: 1 1 auto;
		justify-content: space-evenly;
	}

	/* ---------- meetings & tasks ---------- */
	.figs {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
		margin: auto 0 0;
	}
	.figs div {
		padding: 7px 10px;
		border-radius: 10px;
		background: var(--ess-sunken);
	}
	.figs dt {
		font-size: 10.5px;
		color: var(--ess-text-muted);
	}
	.figs dd {
		margin: 0;
		font-size: 16px;
		font-weight: 700;
	}
	.work {
		flex: 1 1 auto;
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(240px, 0.8fr);
		gap: 18px;
	}
	.work-col {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}
	h3 {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ess-text-secondary);
	}
	.overdue {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 4px 0 0;
		font-size: 12px;
		color: var(--ess-text-secondary);
	}
	.overdue.has {
		color: var(--ess-warning);
	}

	@media (max-width: 1280px) {
		.kpis {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.cards {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		/* Nine cards two across leaves this one alone: give it the row. */
		.cards > :global(.span-2-at-laptop) {
			grid-column: 1 / -1;
		}
		.work {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.work-col:last-child {
			grid-column: 1 / -1;
		}
	}
	@media (max-width: 900px) {
		.cards {
			grid-template-columns: minmax(0, 1fr);
		}
		.cards > :global(.span-2-at-laptop) {
			grid-column: auto;
		}
	}
	@media (max-width: 720px) {
		.kpis {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.hero {
			grid-column: 1 / -1;
		}
		.work {
			grid-template-columns: minmax(0, 1fr);
		}
		.asof {
			margin-left: 0;
		}
		.dept select {
			min-width: 0;
			width: 100%;
		}
	}
</style>
