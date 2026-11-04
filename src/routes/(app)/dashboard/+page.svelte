<script lang="ts">
	import '$lib/styles/disclosure.css';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Award from '@lucide/svelte/icons/award';
	import Activity from '@lucide/svelte/icons/activity';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Calendar from '@lucide/svelte/icons/calendar';
	import Clock from '@lucide/svelte/icons/clock';
	import Video from '@lucide/svelte/icons/video';
	import FileText from '@lucide/svelte/icons/file-text';
	import Plane from '@lucide/svelte/icons/plane';
	import Bell from '@lucide/svelte/icons/bell';
	import Megaphone from '@lucide/svelte/icons/megaphone';
	import User from '@lucide/svelte/icons/user';
	import BookOpen from '@lucide/svelte/icons/book-open';
	import Headset from '@lucide/svelte/icons/headset';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Info from '@lucide/svelte/icons/info';
	import Check from '@lucide/svelte/icons/check';
	import Avatar from '$lib/components/Avatar.svelte';
	import AbsencePlanner from '$lib/components/dashboard/AbsencePlanner.svelte';
	import AttendanceHeatmap from '$lib/components/dashboard/AttendanceHeatmap.svelte';
	import FutureEvents from '$lib/components/dashboard/FutureEvents.svelte';
	import OnboardingPanel from '$lib/components/dashboard/OnboardingPanel.svelte';
	import ChampCard from '$lib/components/dashboard/ChampCard.svelte';
	import QuickActionRow from '$lib/components/QuickActionRow.svelte';
	import { timeIst } from '$lib/hub/format';

	let { data } = $props();

	const firstName = $derived(data.user.fullName.split(' ')[0]);
	// Time of day comes from the viewer's clock, after hydration.
	let greeting = $state('Welcome back');
	$effect(() => {
		const h = new Date().getHours();
		greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
	});
	const fmtNum = (n: number) => String(+n.toFixed(1));

	// From the approval chain, not the role: an Employee-role manager or a
	// covering delegate gets the queue too.
	const canApprove = $derived(data.canApproveQueue);

	/* Two views of the home page: Today (planner and panels) and Timeline &
	   analytics (the day's timeline, what needs you, activity, request
	   progress, this month's hours and what's coming up). */
	let view = $state<'today' | 'insights'>('today');
	let moreOpen = $state(false);
	onMount(() => {
		try { moreOpen = localStorage.getItem('essHomeMore') === 'true'; } catch { /* Storage is optional. */ }
	});
	function saveMore(event: Event) {
		moreOpen = (event.currentTarget as HTMLDetailsElement).open;
		try { localStorage.setItem('essHomeMore', String(moreOpen)); } catch { /* Keep this visit usable. */ }
	}

	// Keep the figures fresh while the page stays open (every 5 minutes, and
	// when the tab comes back into view).
	onMount(() => {
		let busy = false;
		async function refresh() {
			if (document.visibilityState !== 'visible' || busy) return;
			busy = true;
			try {
				await invalidateAll();
			} catch {
				/* keep the last figures */
			} finally {
				busy = false;
			}
		}
		const timer = setInterval(refresh, 300000);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', refresh);
		};
	});

	// This month's recorded hours per day, for the small bar chart.
	const monthDays = $derived(
		data.analytics.heatmap
			.filter((c) => c.date.startsWith(data.analytics.today.slice(0, 7)))
			.map((c) => ({ ...c, future: c.date > data.analytics.today }))
	);
	const maxHours = $derived(Math.max(9, ...monthDays.map((d) => d.hours)));
	const upcomingMeetings = $derived(data.meetingsToday.filter((m) => m.state === 'upcoming'));

	const OFFICE_TZ = 'Asia/Kolkata';
	const now = new Date();
	const todayLine = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: OFFICE_TZ });

	/** Mon–Fri of the current week, today marked. */
	const week = (() => {
		const d = new Date(now);
		const dow = (d.getDay() + 6) % 7; // Monday = 0
		d.setDate(d.getDate() - dow);
		return Array.from({ length: 5 }, (_, i) => {
			const day = new Date(d);
			day.setDate(d.getDate() + i);
			return { label: day.toLocaleDateString('en-IN', { weekday: 'short' }), num: day.getDate(), isToday: day.toDateString() === now.toDateString() };
		});
	})();

	function fmtTime(value: string | null | undefined) {
		if (!value) return '—';
		return new Date(value).toLocaleTimeString('en-IN', { timeZone: OFFICE_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
	}
	function fmtDay(key: string) {
		return new Date(key + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
	}
	function fmtRange(a: string, b: string) {
		const s = new Date(a + 'T00:00:00');
		const e = new Date(b + 'T00:00:00');
		if (a === b) return s.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
		const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
		return `${s.toLocaleDateString('en-IN', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`;
	}
	function fmtHolidayDate(d: string) {
		return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
	}
	function activityWhen(iso: string) {
		const d = new Date(iso);
		return d.toDateString() === now.toDateString() ? timeIst(iso) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: OFFICE_TZ });
	}

	const STATUS_BADGE: Record<string, { label: string; tone: string }> = {
		pending: { label: 'Pending', tone: 'pending' },
		needs_manager_approval: { label: 'Needs manager', tone: 'pending' },
		manager_approved: { label: 'Under review', tone: 'pending' },
		escalated: { label: 'With HR', tone: 'info' },
		approved: { label: 'Approved', tone: 'approved' },
		rejected: { label: 'Rejected', tone: 'rejected' },
		cancelled: { label: 'Cancelled', tone: 'cancelled' },
		present: { label: 'On time', tone: 'present' }
	};
	const badge = (status: string) => STATUS_BADGE[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' };

	/** Submitted › Manager review › Decision, from the latest request's status. */
	const steps = $derived.by(() => {
		const r = data.latestRequest;
		if (!r) return [];
		const submitted = new Date(r.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: OFFICE_TZ });
		const decided = r.decidedAt ? new Date(r.decidedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: OFFICE_TZ }) : null;
		const s = r.status;
		return [
			{ label: 'Submitted', meta: submitted, state: 'done' },
			{ label: 'Manager review', meta: s === 'pending' ? 'In progress' : 'Done', state: s === 'pending' ? 'current' : 'done' },
			{
				label: s === 'escalated' ? 'HR decision' : 'Decision',
				meta: s === 'approved' ? `Approved${decided ? ` · ${decided}` : ''}` : s === 'rejected' ? `Rejected${decided ? ` · ${decided}` : ''}` : s === 'cancelled' ? 'Cancelled' : s === 'escalated' ? 'With HR' : 'Pending',
				state: s === 'approved' || s === 'rejected' || s === 'cancelled' ? 'done' : s === 'escalated' ? 'current' : 'todo'
			}
		];
	});

	async function decide(applicationId: string, decision: 'approve' | 'reject') {
		const res = await fetch(`/api/leave/${applicationId}/approve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ decision })
		});
		if (res.ok) {
			location.reload();
		} else {
			const body = await res.json().catch(() => ({}));
			alert(body.message ?? 'Could not process this request');
		}
	}

	const joins = (m: (typeof data.meetingsToday)[number]) => m.state === 'upcoming' && m.canJoin;
	const meetingHref = (m: (typeof data.meetingsToday)[number]) => (joins(m) ? `/hub/meetings/${m.id}/join` : m.isHost && m.state !== 'upcoming' ? `/hub/meetings/${m.id}` : '/hub/meetings');

	/** Everything on today's timeline, in time order. */
	const timeline = $derived.by(() => {
		type Entry = { key: string; at: number; time: string; tone: 'ok' | 'accent' | 'warn' | 'muted'; title: string; detail: string; badge?: { label: string; tone: string }; action?: { label: string; href: string; primary?: boolean; newTab?: boolean }; highlight?: boolean };
		const out: Entry[] = [];
		const a = data.todayAttendance;
		if (a?.checkInAt) {
			out.push({ key: 'in', at: Date.parse(a.checkInAt), time: fmtTime(a.checkInAt), tone: 'ok', title: 'Shift started', detail: `You checked in at ${fmtTime(a.checkInAt)}${a.source === 'biometric' ? ' at the biometric terminal' : ''}. Have a great day!`, badge: { label: 'Recorded', tone: 'present' } });
			if (a.checkOutAt) out.push({ key: 'out', at: Date.parse(a.checkOutAt), time: fmtTime(a.checkOutAt), tone: 'muted', title: 'Shift ended', detail: `Checked out at ${fmtTime(a.checkOutAt)}.`, badge: { label: 'Recorded', tone: 'neutral' } });
		} else {
			out.push({ key: 'in', at: 0, time: '—', tone: 'muted', title: 'No check-in recorded yet', detail: 'Attendance comes from your biometric punch. Nothing has arrived for today so far.', action: { label: 'Attendance', href: '/attendance' } });
		}
		for (const m of data.meetingsToday) {
			const upcoming = m.state === 'upcoming';
			out.push({
				key: `m-${m.id}`,
				at: Date.parse(m.startedAt),
				time: timeIst(m.startedAt),
				tone: upcoming ? 'accent' : 'muted',
				title: m.topic,
				detail: `${m.durationMin ?? 30} min · ${m.source === 'zoom' ? 'Zoom' : 'Notes'}${m.attendees.length ? ` · ${m.attendees.length + 1} people` : ''}`,
				badge: upcoming ? undefined : { label: m.state === 'ready' ? 'Minutes ready' : m.state === 'waiting' ? 'Summary pending' : m.state === 'published' ? 'Tasks published' : 'Ended', tone: m.state === 'ready' ? 'info' : 'neutral' },
				action: upcoming ? { label: m.canJoin ? (m.isHost ? 'Start meeting' : 'Join meeting') : 'Open', href: meetingHref(m), primary: true, newTab: joins(m) } : m.isHost ? { label: 'Review', href: meetingHref(m) } : undefined
			});
		}
		for (const mc of data.missingCheckOuts.slice(0, 2)) {
			out.push({ key: `mc-${mc.date}`, at: Date.now() + 1, time: '', tone: 'warn', title: 'Attendance correction needs review', detail: `Your ${fmtDay(mc.date)} check-out time seems to be missing.`, badge: { label: 'Action required', tone: 'pending' }, action: { label: 'Review', href: `/attendance?raise=${mc.date}` }, highlight: true });
		}
		return out.sort((x, y) => x.at - y.at);
	});
</script>

<svelte:head>
	<title>Today — Champ HR ESS Portal</title>
</svelte:head>

<!-- Laptop-sized, one screen: the title row with the figures people check
     most, the absence planner across the width, and three panels beneath.
     The day's timeline, request progress and analytics sit in the drawer
     below. -->
<div class="home">
	<header class="top">
		<div class="hello">
			<h1>{greeting}, {firstName}</h1>
		</div>
		<div class="ess-tabs view-tabs" role="tablist" aria-label="Home views">
			<button type="button" role="tab" class="ess-tab" aria-selected={view === 'today'} onclick={() => (view = 'today')}>Today</button>
			<button type="button" role="tab" class="ess-tab" aria-selected={view === 'insights'} onclick={() => (view = 'insights')}>Timeline &amp; analytics</button>
		</div>
		<div class="figures" class:hide={view === 'insights'} role="group" aria-label="At a glance">
			<a class="fig" href="/leave" title="{fmtNum(data.leaveAllocated)} days allocated this year">
				<span class="v"><b>{fmtNum(data.leaveBalance)}</b><span>days</span></span>
				<span class="k">Leave balance</span>
			</a>
			<a class="fig" href="/attendance" title="{data.daysWithCheckIn} of {data.businessDaysSoFar} days with a check-in">
				<span class="v"><b>{data.attendancePct}</b><span>%</span></span>
				<span class="k">Attendance</span>
			</a>
			<a class="fig" href="/leave">
				<span class="v"><b>{data.pendingCount}</b></span>
				<span class="k">Pending leave</span>
			</a>
			{#if data.toApprove > 0 || canApprove}
				<a class="fig" class:attn={data.toApprove > 0} href="/leave?tab=approvals">
					<span class="v"><b>{data.toApprove}</b></span>
					<span class="k">To approve</span>
				</a>
			{/if}
		</div>
		<a href="/leave/apply" class="ess-btn ess-btn--primary apply"><Calendar size={16} /> Apply leave</a>
	</header>

	{#if view === 'today'}
		<AbsencePlanner planner={data.planner} me={data.leaveOverview} />

	<div class="lower">
		<FutureEvents events={data.events} />
		<ChampCard {firstName} champ={data.champ} />
	</div>
	<details class="pref-group home-more" open={moreOpen} ontoggle={saveMore}>
		<summary>More on your month</summary>
		<div class="more-panels">
			<section aria-label="Attendance heatmap">
				<h2 class="ess-h2">Attendance heatmap</h2>
				<AttendanceHeatmap analytics={data.analytics} missingCheckOuts={data.missingCheckOuts.length} />
			</section>
			<section aria-label="New joiners">
				<h2 class="ess-h2">New joiners</h2>
				<OnboardingPanel people={data.planner.onboarding} mode={data.planner.onboardingMode} />
			</section>
		</div>
	</details>
	{:else}
		{@render insights()}
	{/if}
</div>

{#snippet insights()}
	<div class="insights">
		<div class="ess-figures ins-figs" role="group" aria-label="This month at a glance">
			<a class="ess-figure" href="/attendance">
				<span class="ess-tile ess-tile--sm ess-tile--ok"><Clock size={16} /></span>
				<div><div class="ess-figure__value">{data.attendancePct}<small>%</small></div><div class="ess-figure__label">Attendance · {data.daysWithCheckIn} of {data.businessDaysSoFar} days</div></div>
			</a>
			<a class="ess-figure" href="/attendance">
				<span class="ess-tile ess-tile--sm"><Activity size={16} /></span>
				<div><div class="ess-figure__value">{data.analytics.recordedHours}<small> hrs</small></div><div class="ess-figure__label">Recorded · {data.analytics.completeDays} complete days</div></div>
			</a>
			<a class="ess-figure" href="/leave">
				<span class="ess-tile ess-tile--sm"><Calendar size={16} /></span>
				<div><div class="ess-figure__value">{fmtNum(data.leaveBalance)}<small> days</small></div><div class="ess-figure__label">Leave balance{data.leaveAllocated ? ` · of ${fmtNum(data.leaveAllocated)}` : ''}</div></div>
			</a>
			<a class="ess-figure" href="/leave">
				<span class="ess-tile ess-tile--sm ess-tile--warn"><FileText size={16} /></span>
				<div><div class="ess-figure__value">{data.pendingCount}</div><div class="ess-figure__label">Pending · {data.approvedThisMonth} approved this month</div></div>
			</a>
			<a class="ess-figure" href="/profile">
				<span class="ess-tile ess-tile--sm"><Award size={16} /></span>
				<div><div class="ess-figure__value tenure">{data.analytics.tenure ?? 'Not set'}</div><div class="ess-figure__label">{data.analytics.joiningDate ? `Tenure · joined ${data.analytics.joiningDate}` : 'Tenure · joining date not on file'}</div></div>
			</a>
		</div>

		<div class="ins-grid">
			<section class="ess-card ins-card" aria-labelledby="tl-h">
				<div class="ess-card-head">
					<h2 id="tl-h" class="ess-h2">Today’s timeline</h2>
					<div class="week" aria-label="This week">
						{#each week as d (d.num)}
							<span class="wk" aria-current={d.isToday ? 'date' : undefined}><small>{d.label}</small>{d.num}</span>
						{/each}
					</div>
					<a class="ess-link" href="/hub">Full day <ChevronRight size={14} /></a>
				</div>
				<div class="ess-scroll ins-body">
					<ol class="timeline">
						{#each timeline as e (e.key)}
							<li class="tl" class:highlight={e.highlight} data-tone={e.tone}>
								<span class="tl-time">{e.time}</span>
								<span class="tl-dot" aria-hidden="true"></span>
								<div class="tl-body">
									<strong>{e.title}</strong>
									<span>{e.detail}</span>
								</div>
								<div class="tl-end">
									{#if e.badge}<span class="ess-badge ess-badge--{e.badge.tone}">{e.badge.label}</span>{/if}
									{#if e.action}
										<a class="ess-btn ess-btn--sm {e.action.primary ? 'ess-btn--primary' : 'ess-btn--secondary'}" href={e.action.href} target={e.action.newTab ? '_blank' : undefined} rel={e.action.newTab ? 'noopener' : undefined} data-sveltekit-reload={e.action.newTab ? true : undefined}>
											{#if e.action.primary}<Video size={14} />{/if}{e.action.label}
										</a>
									{/if}
								</div>
							</li>
						{/each}
					</ol>
				</div>
				<nav class="quick" aria-label="Quick actions">
					<QuickActionRow icon={Calendar} label="Apply leave" href="/leave/apply" />
					<QuickActionRow icon={Clock} label="My attendance" href="/attendance" />
					<QuickActionRow icon={User} label="Update profile" href="/profile" />
					<QuickActionRow icon={Megaphone} label="Company announcements" href="/chat?c=announcements" count={data.announcementBadge.count} urgent={data.announcementBadge.urgent} />
					<QuickActionRow icon={Bell} label="HR notifications" href="/hub/c/ess" />
					<QuickActionRow icon={BookOpen} label="Company policies" href="/policies" />
					<QuickActionRow icon={Headset} label="HR contacts" href="/hr-contacts" />
				</nav>
			</section>

			<div class="ins-col">
				<section class="ess-card ins-card" aria-labelledby="needs-h">
					<div class="ess-card-head">
						<h2 id="needs-h" class="ess-h2">Needs your attention</h2>
						<a class="ess-link" href="/leave">Leave <ChevronRight size={14} /></a>
					</div>
					<div class="ess-scroll ins-body ess-rows">
						{#each data.missingCheckOuts.slice(0, 3) as item (item.date)}
							<a class="ess-row" href={`/attendance?raise=${item.date}`}>
								<span class="ess-tile ess-tile--sm ess-tile--warn"><Clock size={16} /></span>
								<div class="ess-row__body"><span class="ess-row__title">Missing check-out</span><span class="ess-row__meta">{fmtDay(item.date)} · raise a correction</span></div>
								<div class="ess-row__end"><span class="ess-badge ess-badge--pending">Review</span></div>
							</a>
						{/each}
						{#if data.pendingCount > 0}
							<a class="ess-row" href="/leave">
								<span class="ess-tile ess-tile--sm"><FileText size={16} /></span>
								<div class="ess-row__body"><span class="ess-row__title">Your leave requests</span><span class="ess-row__meta">{data.pendingCount} awaiting approval</span></div>
								<div class="ess-row__end"><span class="ess-badge ess-badge--pending">Pending</span></div>
							</a>
						{/if}
						{#if canApprove}
							{#each data.approvalQueue as row (row.application.id)}
								<div class="ess-row">
									<Avatar userId={row.applicant.id} fullName={row.applicant.fullName} hasPicture={row.applicantHasPicture} size="md" />
									<div class="ess-row__body">
										<span class="ess-row__title">{row.applicant.fullName}</span>
										<span class="ess-row__meta">{row.type.name} · {fmtRange(String(row.application.startDate).slice(0, 10), String(row.application.endDate).slice(0, 10))} · {Number(row.application.days)} day{Number(row.application.days) === 1 ? '' : 's'}</span>
									</div>
									<div class="ess-row__end">
										<button class="ess-btn ess-btn--primary ess-btn--sm" onclick={() => decide(row.application.id, 'approve')}>Approve</button>
										<button class="ess-btn ess-btn--outline ess-btn--sm" onclick={() => decide(row.application.id, 'reject')}>Reject</button>
									</div>
								</div>
							{/each}
						{/if}
						{#if !data.missingCheckOuts.length && !data.pendingCount && !(canApprove && data.approvalQueue.length)}
							<p class="empty ok"><CircleCheck size={16} /> You’re all caught up.</p>
						{/if}
					</div>
				</section>

				<section class="ess-card ins-card" aria-labelledby="act-h">
					<div class="ess-card-head">
						<h2 id="act-h" class="ess-h2">Recent activity</h2>
						<a class="ess-link" href="/attendance">All <ChevronRight size={14} /></a>
					</div>
					<div class="ess-scroll ins-body ess-rows">
						{#each data.activity as a (a.key)}
							{@const b = badge(a.status)}
							<div class="ess-row activity">
								<span class="when">{activityWhen(a.at)}</span>
								<span class="ess-tile ess-tile--sm ess-tile--neutral">
									{#if a.kind === 'checkin'}<Clock size={16} />{:else if a.kind === 'leave'}<Plane size={16} />{:else}<FileText size={16} />{/if}
								</span>
								<div class="ess-row__body">
									<span class="ess-row__title">{a.title}</span>
									<span class="ess-row__meta">{a.detail}</span>
								</div>
								<div class="ess-row__end"><span class="ess-badge ess-badge--{b.tone}">{b.label}</span></div>
							</div>
						{:else}
							<p class="empty">Nothing yet. Your check-ins, leave requests and corrections appear here.</p>
						{/each}
					</div>
				</section>
			</div>

			<div class="ins-col">
				<section class="ess-card ins-card req-card" aria-labelledby="req-h">
					<div class="ess-card-head">
						<h2 id="req-h" class="ess-h2">Request progress</h2>
						<a class="ess-link" href="/leave" aria-label="All requests"><ChevronRight size={16} /></a>
					</div>
					<div class="ess-scroll ins-body">
						{#if data.latestRequest}
							{@const r = data.latestRequest}
							<div class="req">
								<span class="ess-tile"><Plane size={20} strokeWidth={1.75} /></span>
								<div class="req-body">
									<strong>{r.typeName}</strong>
									<span>{fmtRange(r.startDate, r.endDate)}</span>
								</div>
								<span class="ess-badge ess-badge--accent">{r.days} day{r.days === 1 ? '' : 's'}</span>
							</div>
							<ol class="ess-stepper">
								{#each steps as s (s.label)}
									<li class="ess-step" data-state={s.state}>
										<span class="ess-step__dot">{#if s.state === 'done'}<Check size={12} strokeWidth={3} />{/if}</span>
										<span class="ess-step__label">{s.label}</span>
										<span class="ess-step__meta">{s.meta}</span>
									</li>
								{/each}
							</ol>
							{#if r.status === 'pending'}
								<div class="ess-notice ess-notice--info">
									<span class="ess-notice__icon"><Info size={15} /></span>
									<div class="ess-notice__body"><strong>Your manager is reviewing your request.</strong>We’ll notify you as soon as there’s an update.</div>
								</div>
							{:else if r.status === 'escalated'}
								<div class="ess-notice ess-notice--info">
									<span class="ess-notice__icon"><Info size={15} /></span>
									<div class="ess-notice__body"><strong>Your manager approved it; HR decides next.</strong>We’ll notify you as soon as there’s an update.</div>
								</div>
							{/if}
						{:else}
							<p class="empty">No leave requests yet. <a href="/leave/apply">Apply for leave</a> and track it here.</p>
						{/if}
					</div>
				</section>

				<section class="ess-card ins-card" aria-labelledby="month-h">
					<div class="ess-card-head">
						<h2 id="month-h" class="ess-h2">Hours this month</h2>
						<span class="ess-caption">{data.analytics.recordedDays} days · {data.analytics.recordedHours} hrs</span>
					</div>
					<div class="bars" role="img" aria-label="Recorded hours per day this month: {data.analytics.recordedHours} hours over {data.analytics.recordedDays} days">
						{#each monthDays as d (d.date)}
							<span class="bar" class:future={d.future} class:open={d.recorded && !d.complete} style:--h="{Math.max(d.recorded ? 8 : 3, (d.hours / maxHours) * 100)}%" title="{d.label}: {d.future ? 'upcoming' : d.recorded ? (d.complete ? `${d.hours} hrs` : 'check-out missing') : 'no punch'}"></span>
						{/each}
					</div>
					<div class="bar-axis"><span>1</span><span>{monthDays.length}</span></div>
				</section>

				<section class="ess-card ins-card" aria-labelledby="up-h">
					<div class="ess-card-head">
						<h2 id="up-h" class="ess-h2">Coming up</h2>
						<a class="ess-link" href="/hub/meetings">Meetings <ChevronRight size={14} /></a>
					</div>
					<div class="ess-scroll ins-body ess-rows">
						{#each upcomingMeetings as m (m.id)}
							<a class="ess-row" href={meetingHref(m)}>
								<span class="ess-tile ess-tile--sm"><Video size={16} /></span>
								<div class="ess-row__body"><span class="ess-row__title">{m.topic}</span><span class="ess-row__meta">Today · {timeIst(m.startedAt)}</span></div>
							</a>
						{/each}
						{#each data.upcomingHolidays as holiday (holiday.id)}
							<a class="ess-row" href="/policies">
								<span class="ess-date-tile"><strong>{new Date(holiday.date + 'T00:00:00').getDate()}</strong><small>{new Date(holiday.date + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short' })}</small></span>
								<div class="ess-row__body"><span class="ess-row__title">{holiday.name}</span><span class="ess-row__meta">{fmtHolidayDate(holiday.date)} · {holiday.type.toLowerCase()} holiday</span></div>
							</a>
						{/each}
						{#if !upcomingMeetings.length && !data.upcomingHolidays.length}
							<p class="empty">No meetings later today and no published holidays ahead.</p>
						{/if}
					</div>
				</section>
			</div>
		</div>
	</div>
{/snippet}

<style>
	/* ---------- one-screen home ---------- */
	@media (min-width: 721px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			/* Fills the screen; if the panels truly can't fit, the page scrolls
			   rather than cutting them off. */
			:global(.ess-content:has(> .home)) { display:flex; flex-direction:column; overflow:auto; padding-bottom:12px; }
			/* Grows to fill the screen, never shrinks below what its cards need. */
			:global(.ess-content > .home) { flex:1 0 auto; }
		}
	}

	.home {
		display: grid;
		/* The planner's calendar scrolls inside a capped box, so the card stays
		   compact; the panels below take the rest. */
		grid-template-rows: auto max-content minmax(160px, 1fr) auto;
		gap: 14px;
		min-height: 0;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 10px 24px;
		padding: 0 2px;
	}
	.eyebrow {
		font-size: 13px;
		color: var(--ess-text-muted);
	}
	.hello h1 {
		margin: 2px 0 0;
		font-size: 30px;
		font-weight: 700;
		letter-spacing: -0.03em;
		line-height: 1.1;
	}
	.figures {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.fig {
		display: flex;
		flex-direction: column;
		min-width: 92px;
		padding: 6px 14px;
		border-radius: 14px;
		color: var(--ess-text);
		transition: background var(--ess-t-fast);
	}
	.fig:hover {
		background: var(--ess-surface);
		color: var(--ess-text);
	}
	.fig .v {
		display: flex;
		align-items: baseline;
		gap: 3px;
	}
	.fig b {
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
	}
	.fig .v span {
		font-size: 12px;
		font-weight: 700;
		color: var(--ess-text-secondary);
	}
	.fig .k {
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.fig.attn b {
		color: var(--ess-primary-text);
	}
	.apply {
		margin-left: 10px;
		border-radius: 12px;
	}

	.lower {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
		min-height: 0;
	}
	.lower > :global(*) {
		height: 100%;
	}

	/* Short laptop screens: the page holds the screen's height and the
	   panels below give way, so the whole home stays on one screen. Only
	   where the panels sit in one row — narrower layouts stack them and the
	   page scrolls. */
	@media (min-width: 1101px) and (min-height: 480px) and (max-height: 800px) {
		.home {
			grid-template-rows: auto max-content minmax(120px, 1fr) auto;
		}
		:global(.ess-content > .home) {
			flex: 1 1 auto;
			min-height: 0;
		}
	}

	/* Short laptop screens (about 1280×580): slimmer title row and panels,
	   the drawer link tighter. */
	@media (min-width: 721px) and (max-height: 760px) {
		.home {
			gap: 12px;
		}
		.lower > :global(*) {
			overflow-y: auto;
			scrollbar-width: thin;
		}
		.eyebrow {
			font-size: 11.5px;
		}
		.hello h1 {
			font-size: 22px;
		}
		.fig {
			min-width: 80px;
			padding: 3px 12px;
		}
		.fig b {
			font-size: 17px;
		}
		.fig .k {
			font-size: 11px;
		}
		.lower {
			gap: 12px;
		}
	}

	@media (max-width: 1100px) {
		.home {
			grid-template-rows: auto auto auto;
		}
		.lower {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.lower > :global(*) {
			height: auto;
		}
	}
	@media (max-width: 720px), (max-height: 479px) {
		.home {
			grid-template-rows: auto;
		}
		.lower {
			grid-template-columns: 1fr;
		}
		.lower > :global(*) {
			min-height: 230px;
		}
		.figures {
			flex-wrap: wrap;
		}
		.hello h1 {
			font-size: 24px;
		}
	}


	.empty {
		margin: 0;
		padding: 14px 0;
		font-size: 13.5px;
		color: var(--ess-text-muted);
	}

	/* ---------- timeline ---------- */
	.timeline {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}
	.tl {
		position: relative;
		display: grid;
		grid-template-columns: 52px 20px minmax(0, 1fr) auto;
		align-items: center;
		gap: 0 12px;
		padding: 14px 0;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.tl:last-child {
		border-bottom: none;
	}
	.tl::before {
		content: '';
		position: absolute;
		left: 73px;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--ess-border-subtle);
	}
	.tl:first-child::before {
		top: 50%;
	}
	.tl:last-child::before {
		bottom: 50%;
	}
	.tl-time {
		font-size: 13px;
		color: var(--ess-text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.tl-dot {
		position: relative;
		z-index: 1;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		justify-self: center;
		background: var(--ess-border-strong);
		box-shadow: 0 0 0 3px var(--ess-surface);
	}
	.tl[data-tone='ok'] .tl-dot {
		background: var(--ess-success);
	}
	.tl[data-tone='accent'] .tl-dot {
		background: var(--ess-primary);
	}
	.tl[data-tone='warn'] .tl-dot {
		background: var(--ess-warning);
	}
	.tl-body {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.tl-body strong {
		font-size: 15px;
		font-weight: 500;
	}
	.tl-body span {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.tl-end {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.tl.highlight {
		background: var(--ess-warning-bg);
		border-radius: var(--ess-radius-md);
		padding-left: 12px;
		padding-right: 12px;
		margin: 4px -12px;
		border-bottom: none;
	}
	.tl.highlight::before {
		left: 85px;
	}

	/* ---------- activity ---------- */
	.activity .when {
		min-width: 52px;
		font-size: 13px;
		color: var(--ess-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	/* ---------- HR summary ---------- */
	.s-label,

	/* ---------- request progress ---------- */
	.req {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		margin-bottom: 16px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-primary-softer);
	}
	.req-body {
		flex: 1;
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.req-body strong {
		font-size: 15px;
		font-weight: 500;
	}
	.req-body span {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.ess-stepper {
		margin-bottom: 16px;
	}


	@media (max-width: 720px) {
		.tl {
			grid-template-columns: 44px 20px minmax(0, 1fr);
		}
		.tl::before {
			left: 65px;
		}
		.tl-end {
			grid-column: 3;
			justify-content: flex-start;
			margin-top: 8px;
		}
	}

	/* Desktop: the greeting row shares its line with the floating top-bar
	   cluster on the right. */
	@media (min-width: 1101px) {
		@container ess-fill (min-width: 1075px) {
			.top {
				flex-wrap: nowrap;
				min-height: 38px;
				padding-right: calc(var(--topbar-w, 380px) + 14px);
			}
			.hello h1 {
				margin: 0;
				white-space: nowrap;
			}
		}
	}

	.home:has(.home-more[open]) { display: flex; flex-direction: column; }
	.home:has(.home-more[open]) > :global(*) { flex-shrink: 0; }
	.home:has(.home-more[open]) .lower { min-height: 160px; }
	/* The moved heatmap now sizes to its contents, not a fixed dashboard row. */
	.more-panels :global(.fit) { container-type: normal; overflow: visible; }
	.home-more { min-width: 0; }
	.more-panels { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
	.more-panels section { min-width: 0; }
	@media (max-width: 720px) { .more-panels { grid-template-columns: minmax(0, 1fr); } }

	/* ---------- header: view tabs ---------- */
	.view-tabs {
		flex: none;
	}
	.figures.hide {
		visibility: hidden;
	}

	/* ---------- Timeline & analytics ---------- */
	.insights {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-height: 0;
	}
	.ins-figs {
		flex: none;
		grid-auto-columns: minmax(0, 1fr);
	}
	.ins-figs .ess-figure {
		padding: 10px 14px;
		gap: 10px;
		color: inherit;
		text-decoration: none;
	}
	.ins-figs .ess-figure:hover {
		background: var(--ess-surface-hover);
	}
	.ins-figs .ess-figure__value {
		font-size: 19px;
	}
	.ins-figs .ess-figure__value small {
		font-size: 12px;
		font-weight: 500;
		color: var(--ess-text-muted);
	}
	.ins-figs .ess-figure__value.tenure {
		font-size: 15px;
	}
	.ins-figs .ess-figure__label {
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ins-figs .ess-figure > div {
		min-width: 0;
	}
	.ins-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr);
		gap: 14px;
		min-height: 0;
	}
	.ins-col {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
		min-height: 0;
	}
	.ins-card {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.ins-card > :global(.ess-card-head) {
		flex: none;
	}
	.ins-body {
		min-height: 0;
	}
	.ins-card .empty {
		margin: 6px 0 0;
	}
	.ins-card .empty.ok {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	/* The week, as small day pills in the timeline's header. */
	.week {
		display: flex;
		gap: 3px;
		margin-left: auto;
	}
	.wk {
		display: grid;
		justify-items: center;
		min-width: 28px;
		padding: 2px 4px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 600;
		line-height: 1.15;
		color: var(--ess-text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.wk small {
		font-size: 9.5px;
		font-weight: 500;
		color: var(--ess-text-muted);
	}
	.wk[aria-current='date'] {
		background: var(--ess-primary);
		color: var(--ess-text-on-primary);
	}
	.wk[aria-current='date'] small {
		color: inherit;
		opacity: 0.85;
	}
	/* Quick actions: a compact two-column list under the timeline. */
	.quick {
		flex: none;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 12px;
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.quick :global(.row) {
		padding: 3px 6px;
		gap: 8px;
		font-size: 13px;
	}
	.quick :global(.ess-tile) {
		width: 24px;
		height: 24px;
	}
	.quick :global(.ess-tile svg) {
		width: 14px;
		height: 14px;
	}
	/* Hours this month: one slim bar per day. */
	.bars {
		flex: 1 1 auto;
		min-height: 56px;
		display: flex;
		align-items: flex-end;
		gap: 3px;
	}
	.bar {
		flex: 1 1 0;
		height: var(--h);
		min-height: 3px;
		border-radius: 3px 3px 1px 1px;
		background: var(--ess-primary);
		opacity: 0.85;
	}
	.bar.open {
		background: var(--ess-warning);
	}
	.bar.future {
		background: var(--ess-border);
		opacity: 1;
	}
	.bar-axis {
		display: flex;
		justify-content: space-between;
		margin-top: 4px;
		font-size: 11px;
		color: var(--ess-text-muted);
	}

	/* Desktop: the view fills the screen; long lists scroll in their card. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.home:has(> .insights) {
				grid-template-rows: auto minmax(0, 1fr);
			}
			.insights {
				height: 100%;
			}
			.ins-grid {
				flex: 1 1 0%;
			}
			.ins-grid > .ins-card,
			.ins-col > .ins-card {
				flex: 1 1 0%;
			}
			.ins-col > .req-card {
				flex: 0 1 auto;
				max-height: 45%;
			}
			.ins-body {
				flex: 1 1 0%;
			}
		}
	}
	@media (min-width: 721px) and (max-height: 760px) {
		.insights,
		.ins-grid,
		.ins-col {
			gap: 12px;
		}
		.ins-figs .ess-figure {
			padding: 7px 12px;
		}
		.ins-figs .ess-figure__value {
			font-size: 17px;
		}
	}
	@media (max-width: 1100px) {
		.ins-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.ins-grid > .ins-card {
			grid-column: 1 / -1;
		}
		.ins-figs {
			grid-auto-flow: row;
			grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		}
	}
	@media (max-width: 720px) {
		.ins-grid {
			grid-template-columns: minmax(0, 1fr);
		}
		.week {
			display: none;
		}
	}

	/* The header row never widens the page; on narrower desktops the four
	   quick figures give way to the tabs (the same numbers are in Timeline &
	   analytics and the My attendance panel). */
	.home {
		grid-template-columns: minmax(0, 1fr);
	}
	.home > .top {
		min-width: 0;
	}
	/* Desktop: the figures take the room left in the row and show as many
	   as fit on one line; the rest wrap onto a hidden second line. */
	@media (min-width: 1101px) {
		@container ess-fill (min-width: 1075px) {
			.top .figures {
				flex: 1 1 auto;
				min-width: 0;
				flex-wrap: wrap;
				justify-content: flex-end;
				height: 58px;
				overflow: hidden;
				align-content: flex-start;
				align-items: center;
			}
		}
	}
	@media (min-width: 1101px) and (max-height: 760px) {
		@container ess-fill (min-width: 1075px) {
			.top .figures {
				height: 46px;
			}
			.top .apply {
				flex: none;
			}
		}
	}
</style>
