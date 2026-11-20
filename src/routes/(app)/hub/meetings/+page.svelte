<script lang="ts">
	import { page } from '$app/state';
	import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
	import Video from '@lucide/svelte/icons/video';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Avatar from '$lib/components/Avatar.svelte';
	import PasteNotesDialog from '$lib/components/hub/PasteNotesDialog.svelte';
	import ScheduleMeetingDialog from '$lib/components/hub/ScheduleMeetingDialog.svelte';
	import { api, hub } from '$lib/hub/client.svelte';
	import { longDay, timeIst, todayKey } from '$lib/hub/format';
	import { istDateKey } from '$lib/chat/rules';
	import type { MeetingRowView } from '$lib/tasks/types';

	let { data } = $props();

	let pasteFor = $state<{ id: string | null; topic: string } | null>(null);
	// ?schedule=1 (from Today's quick actions) opens the dialog straight away.
	let scheduling = $state(page.url.searchParams.has('schedule'));
	let cancelling = $state<string | null>(null);

	/* ---------- the week strip ---------- */

	const today = todayKey();
	let selected = $state(todayKey());
	const dayOf = (iso: string) => istDateKey(new Date(iso));
	const keyPlus = (key: string, days: number) => new Date(Date.parse(key + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
	const weekday = (key: string) => (new Date(key + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon = 0
	const week = $derived.by(() => {
		const mon = keyPlus(selected, -weekday(selected));
		return Array.from({ length: 7 }, (_, i) => keyPlus(mon, i));
	});
	const fmtDay = (key: string, opts: Intl.DateTimeFormatOptions) => new Date(key + 'T00:00:00Z').toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });

	const live = $derived(data.meetings.filter((m) => m.state !== 'cancelled'));
	const onDay = $derived(live.filter((m) => dayOf(m.startedAt) === selected).sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
	const hasMeetings = (key: string) => live.some((m) => dayOf(m.startedAt) === key);
	// Everything still to come on other days, soonest first, so nothing is hidden behind the strip.
	const laterUpcoming = $derived(live.filter((m) => m.state === 'upcoming' && dayOf(m.startedAt) !== selected).sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
	// Newest first for what is done.
	const past = $derived(data.meetings.filter((m) => m.state !== 'upcoming'));
	const todays = $derived(live.filter((m) => dayOf(m.startedAt) === today).sort((a, b) => a.startedAt.localeCompare(b.startedAt)));

	async function cancel(id: string) {
		const r = await api(`/api/meetings/${id}/cancel`, 'POST', {});
		cancelling = null;
		if (!r.ok) return hub.say(r.message, { tone: 'bad' });
		hub.say('Cancelled. Everyone invited was told.');
		hub.changed(0);
	}

	const MINUTES: Record<MeetingRowView['state'], { label: string; tone: string }> = {
		upcoming: { label: 'Not yet held', tone: 'neutral' },
		waiting: { label: 'Waiting for summary', tone: 'warn' },
		ready: { label: 'Ready', tone: 'ok' },
		published: { label: 'Published', tone: 'ok' },
		no_summary: { label: 'Not available', tone: 'neutral' },
		cancelled: { label: 'Cancelled', tone: 'neutral' }
	};
	const endOf = (m: MeetingRowView) => timeIst(new Date(Date.parse(m.startedAt) + (m.durationMin ?? 30) * 60_000).toISOString());
</script>

<svelte:head><title>Meetings · Champ Hub — Champ HR ESS Portal</title></svelte:head>

{#snippet agendaRow(m: MeetingRowView)}
	<article class="m">
		<div class="when">
			<strong>{timeIst(m.startedAt)}</strong>
			<span>{m.durationMin ? `${m.durationMin} min` : longDay(m.startedAt)}</span>
		</div>
		<div class="main">
			<h3 class="topic">{m.topic}</h3>
			{#if m.state === 'upcoming' && m.agenda}<p class="agenda">{m.agenda}</p>{/if}
			<div class="meta">
				{#if m.attendees.length}
					<span class="stack">{#each m.attendees.slice(0, 4) as p (p.id)}<Avatar userId={p.id} fullName={p.fullName} size="sm" />{/each}</span>
					{#if m.attendees.length + m.guestCount > 4}<span class="more">+{m.attendees.length + m.guestCount - 4} {m.attendees.length + m.guestCount - 4 === 1 ? 'other' : 'others'}</span>{/if}
				{:else if m.guestCount}
					<span class="more">{m.guestCount} {m.guestCount === 1 ? 'guest' : 'guests'}</span>
				{/if}
				{#if m.source === 'pasted'}<span class="more">From notes</span>{/if}
				{#if m.state === 'upcoming'}
					<span class="ess-badge ess-badge--accent">{m.isHost ? 'You scheduled this' : `From ${m.host?.fullName ?? 'a colleague'}`}</span>
				{:else if m.state === 'waiting'}
					<span class="ess-badge ess-badge--warn"><span class="pulse"></span>Waiting for the summary</span>
				{:else if m.state === 'ready' && m.isHost}
					<span class="ess-badge ess-badge--info"><Sparkles size={12} />{m.itemCount} action {m.itemCount === 1 ? 'item' : 'items'} to review{m.itemsNeedingOwner ? `, ${m.itemsNeedingOwner} without an owner` : ''}</span>
				{:else if m.state === 'ready'}
					<span class="ess-badge ess-badge--warn">{m.host?.fullName.split(' ')[0] ?? 'The host'} is reviewing the minutes</span>
				{:else if m.state === 'published'}
					<span class="ess-badge ess-badge--ok"><CircleCheck size={12} />{m.isHost ? `${m.publishedCount} tasks published` : `${m.mine.length} ${m.mine.length === 1 ? 'task' : 'tasks'} for you`}</span>
				{:else}
					<span class="ess-badge">No summary for this meeting</span>
				{/if}
			</div>
		</div>
		<div class="acts">
			{#if m.state === 'upcoming'}
				{#if m.canJoin}<a class="ess-btn ess-btn--primary" href="/hub/meetings/{m.id}/join" target="_blank" rel="noopener" data-sveltekit-reload><Video size={16} /> {m.isHost ? 'Start' : 'Join'}{data.hub.zoom ? ' Zoom' : ''}</a>{/if}
				<!-- Started with no call to join (no Zoom, or the call has closed):
				     nothing will move it on by itself, so the host adds the minutes. -->
				{#if m.isHost && !m.canJoin && Date.parse(m.startedAt) <= Date.now()}
					<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={() => (pasteFor = { id: m.id, topic: m.topic })}><ClipboardPaste size={14} /> Paste notes</button>
				{/if}
				{#if m.isHost}
					{#if cancelling === m.id}
						<button type="button" class="ess-btn ess-btn--danger ess-btn--sm" onclick={() => cancel(m.id)}>Cancel meeting</button>
						<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (cancelling = null)}>Keep</button>
					{:else}
						<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (cancelling = m.id)}>Cancel</button>
					{/if}
				{/if}
			{:else if m.isHost && m.state === 'ready'}
				<a class="ess-btn ess-btn--primary ess-btn--sm" href="/hub/meetings/{m.id}">Review minutes</a>
			{:else if m.isHost && m.state === 'published'}
				<a class="ess-btn ess-btn--secondary ess-btn--sm" href="/hub/meetings/{m.id}">View summary</a>
			{:else if m.isHost && (m.state === 'no_summary' || m.state === 'waiting')}
				<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={() => (pasteFor = { id: m.id, topic: m.topic })}><ClipboardPaste size={14} /> Paste notes</button>
			{:else if m.mine.length}
				<a class="ess-btn ess-btn--secondary ess-btn--sm" href="/hub/tasks?task={m.mine[0].taskId}">Open my task</a>
			{/if}
		</div>
	</article>
{/snippet}

<div class="page hub-fill">
	<div class="top">
		<div class="ess-daystrip strip" aria-label="Week">
			<button type="button" class="ess-daystrip__nav" onclick={() => (selected = keyPlus(selected, -7))} aria-label="Previous week"><ChevronLeft size={18} /></button>
			<div class="ess-daystrip__days">
				{#each week as key (key)}
					<button type="button" class="ess-day" aria-pressed={key === selected} aria-current={key === today ? 'date' : undefined} onclick={() => (selected = key)}>
						<span>{fmtDay(key, { weekday: 'short' })}</span>
						<strong>{fmtDay(key, { day: 'numeric' })}</strong>
						<i class="mark" class:on={hasMeetings(key)} aria-hidden="true"></i>
					</button>
				{/each}
			</div>
			<button type="button" class="ess-daystrip__nav" onclick={() => (selected = keyPlus(selected, 7))} aria-label="Next week"><ChevronRight size={18} /></button>
		</div>
		<div class="picked">
			<span class="picked-day">{fmtDay(selected, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
			{#if selected !== today}<button type="button" class="ess-link" onclick={() => (selected = today)}>Today</button>{/if}
		</div>
		<div class="tools">
			<button type="button" class="ess-btn ess-btn--primary" onclick={() => (scheduling = true)}><CalendarPlus size={16} /> Schedule meeting</button>
			<button type="button" class="ess-btn ess-btn--secondary" onclick={() => (pasteFor = { id: null, topic: '' })}><ClipboardPaste size={16} /> Paste notes</button>
		</div>
	</div>

	{#if !data.hub.zoom}
		<p class="ess-alert ess-alert--info">Video calls are not switched on yet, so meetings are listed without a call to join and minutes come from pasted notes. HR can switch them on in Admin Controls.</p>
	{/if}

	<div class="ess-split main-split">
		<div class="ess-stack">
			<section class="ess-card ess-fill-card day-card" aria-labelledby="day-h">
				<div class="ess-card-head">
					<h2 id="day-h" class="ess-h2">{selected === today ? 'Today’s meetings' : selected > today ? 'Upcoming meetings' : 'Meetings that day'}</h2>
					<span class="ess-caption">{onDay.length ? `${onDay.length} ${onDay.length === 1 ? 'meeting' : 'meetings'}` : ''}</span>
				</div>
				<div class="ess-scroll day-body">
				<div class="rows">
					{#each onDay as m (m.id)}
						{@render agendaRow(m)}
					{:else}
						<p class="empty">Nothing on {fmtDay(selected, { weekday: 'long', day: 'numeric', month: 'short' })}. Schedule a meeting, or pick another day above.</p>
					{/each}
				</div>
				{#if laterUpcoming.length}
					<div class="later">
						<h3 class="later-h">Also coming up</h3>
						{#each laterUpcoming.slice(0, 6) as m (m.id)}
							<button type="button" class="ess-row later-row" onclick={() => (selected = dayOf(m.startedAt))}>
								<span class="ess-row__body">
									<span class="ess-row__title">{m.topic}</span>
									<span class="ess-row__meta">{longDay(m.startedAt)}, {timeIst(m.startedAt)}{m.durationMin ? ` · ${m.durationMin} min` : ''}</span>
								</span>
								<span class="ess-row__end"><ChevronRight size={16} /></span>
							</button>
						{/each}
					</div>
				{/if}
				</div>
			</section>

			<section class="ess-card ess-fill-card past-card" aria-labelledby="past-h">
				<div class="ess-card-head">
					<h2 id="past-h" class="ess-h2">Past meetings</h2>
					<span class="ess-caption">Last 45 days</span>
				</div>
				{#if past.length}
					<div class="table-wrap ess-scroll">
						<table class="ess-table past">
							<thead>
								<tr><th>Topic</th><th>Date</th><th>Minutes status</th><th>Action</th></tr>
							</thead>
							<tbody>
								{#each past as m (m.id)}
									{@const s = MINUTES[m.state]}
									<tr>
										<td>
											<div class="t-topic">{m.topic}</div>
											<div class="t-sub">{m.source === 'pasted' ? 'From notes' : m.isHost ? 'You hosted' : `Hosted by ${m.host?.fullName ?? 'a colleague'}`}{m.attendees.length ? ` · ${m.attendees.length + m.guestCount} attendees` : ''}</div>
										</td>
										<td>
											<div>{longDay(m.startedAt)}</div>
											<div class="t-sub">{timeIst(m.startedAt)}{m.durationMin ? ` · ${m.durationMin} min` : ''}</div>
										</td>
										<td><span class="ess-badge ess-badge--{s.tone}"><span class="sdot"></span>{m.state === 'ready' && m.isHost && m.itemsNeedingOwner ? `${s.label}, ${m.itemsNeedingOwner} without owner` : s.label}</span></td>
										<td>
											<div class="t-acts">
												{#if m.isHost && m.state === 'ready'}
													<a class="ess-btn ess-btn--outline ess-btn--sm" href="/hub/meetings/{m.id}">Review minutes</a>
												{:else if m.isHost && m.state === 'published'}
													<a class="ess-btn ess-btn--secondary ess-btn--sm" href="/hub/meetings/{m.id}">View summary</a>
												{:else if m.isHost}
													<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={() => (pasteFor = { id: m.id, topic: m.topic })}><ClipboardPaste size={14} /> Paste notes</button>
												{:else if m.mine.length}
													<a class="ess-btn ess-btn--secondary ess-btn--sm" href="/hub/tasks?task={m.mine[0].taskId}">Open my task</a>
												{:else if m.state === 'published'}
													<a class="ess-btn ess-btn--secondary ess-btn--sm" href="/hub/meetings/{m.id}">View summary</a>
												{:else}
													<span class="t-sub">{m.state === 'ready' ? `${m.host?.fullName.split(' ')[0] ?? 'The host'} is reviewing` : '—'}</span>
												{/if}
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="empty ess-scroll">No meetings yet. Schedule one, or use Paste notes to turn a meeting into tasks.</p>
				{/if}
			</section>
		</div>

		<aside class="ess-card ess-fill-card sched" aria-labelledby="sched-h">
			<div class="ess-card-head">
				<h2 id="sched-h" class="ess-h2">Today’s schedule</h2>
			</div>
			<ol class="tl ess-scroll">
				{#each todays as m (m.id)}
					{@const live = m.state === 'upcoming'}
					<li class="tl-i" class:live>
						<span class="tl-t">{timeIst(m.startedAt)}</span>
						<span class="tl-dot" aria-hidden="true"></span>
						<div class="tl-b">
							<strong>{m.topic}</strong>
							<small>{timeIst(m.startedAt)} – {endOf(m)}{m.durationMin ? ` · ${m.durationMin} min` : ''}{m.source === 'zoom' && data.hub.zoom ? ' · Zoom' : ''}</small>
							{#if m.attendees.length}
								<span class="stack sm">{#each m.attendees.slice(0, 4) as p (p.id)}<Avatar userId={p.id} fullName={p.fullName} size="sm" />{/each}{#if m.attendees.length > 4}<span class="more">+{m.attendees.length - 4}</span>{/if}</span>
							{/if}
							{#if live && m.canJoin}
								<a class="ess-link" href="/hub/meetings/{m.id}/join" target="_blank" rel="noopener" data-sveltekit-reload><Video size={13} /> {m.isHost ? 'Start' : 'Join'}</a>
							{:else if m.isHost && (m.state === 'ready' || m.state === 'published')}
								<a class="ess-link" href="/hub/meetings/{m.id}">{m.state === 'ready' ? 'Review minutes' : 'View summary'} <ChevronRight size={13} /></a>
							{/if}
						</div>
					</li>
				{:else}
					<li class="empty">No meetings today.</li>
				{/each}
			</ol>
		</aside>
	</div>
</div>

{#if scheduling}
	<ScheduleMeetingDialog meId={data.hubMe.id} onclose={() => (scheduling = false)} />
{/if}
{#if pasteFor}
	<PasteNotesDialog meetingId={pasteFor.id} topic={pasteFor.topic} onclose={() => (pasteFor = null)} />
{/if}

<style>
	.page {
		display: grid;
		gap: 12px;
		min-width: 0;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 12px 16px;
		flex-wrap: wrap;
	}
	/* Compact week strip. */
	.strip :global(.ess-day) {
		padding-top: 5px;
		padding-bottom: 5px;
	}
	.strip :global(.ess-day strong) {
		font-size: 16px;
	}
	/* Desktop: the split fills the rest of the screen. Today's meetings
	   take what they need (up to about half), past meetings the rest, and
	   each scrolls inside its card. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.page {
				display: flex;
				flex-direction: column;
			}
			.main-split {
				flex: 1 1 0%;
				min-height: 0;
			}
			.main-split .ess-stack {
				overflow: hidden;
			}
			.main-split .ess-stack > .day-card {
				flex: 0 1 auto;
				max-height: 55%;
			}
			.main-split .ess-stack > .past-card {
				flex: 1 1 0%;
				min-height: 120px;
			}
			.sched {
				position: static;
			}
			.past-card .table-wrap {
				margin: 0;
				padding: 0;
			}
			.past thead th {
				position: sticky;
				top: 0;
				z-index: 1;
			}
			.past-card .empty,
			.day-body:has(.rows > .empty:only-child):not(:has(.later)),
			.tl:has(> .empty:only-child) {
				display: grid;
				align-content: center;
			}
		}
	}
	.strip {
		flex: 1 1 520px;
		min-width: 0;
	}
	.ess-day {
		position: relative;
	}
	.mark {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: transparent;
		margin-top: 2px;
	}
	.mark.on {
		background: var(--ess-primary);
	}
	.picked {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}
	.picked-day {
		font-family: var(--ess-font-display);
		font-size: 16px;
		font-weight: 500;
		color: var(--ess-text);
	}
	.picked .ess-link {
		border: 0;
		background: none;
		padding: 0;
		cursor: pointer;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
	}
	.tools {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		margin-left: auto;
	}
	.rows {
		display: grid;
	}
	.m {
		display: grid;
		grid-template-columns: 96px minmax(0, 1fr) auto;
		gap: 14px;
		align-items: center;
		padding: 10px 0;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.m:last-child {
		border-bottom: none;
	}
	.when {
		display: grid;
		gap: 2px;
		padding-right: 14px;
		border-right: 1px solid var(--ess-border);
		align-self: stretch;
		align-content: center;
	}
	.when strong {
		font-size: 15px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
	.when span {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.main {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.topic {
		margin: 0;
		font-family: var(--ess-font-display);
		font-size: 15px;
		font-weight: 600;
		line-height: 1.25;
	}
	.agenda {
		margin: 0;
		font-size: 13.5px;
		color: var(--ess-text-secondary);
		white-space: pre-line;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 12px;
		align-items: center;
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.stack {
		display: inline-flex;
	}
	.stack :global(> *:not(:first-child)) {
		margin-left: -6px;
	}
	.stack :global(.avatar) {
		box-shadow: 0 0 0 2px var(--ess-surface);
	}
	.more {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.pulse {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
		animation: pulse 1.6s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
	.acts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
	}
	.later {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--ess-border);
	}
	.later-h {
		margin: 0 0 4px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ess-text-muted);
	}
	.later-row {
		padding: 7px 0;
		cursor: pointer;
	}
	.later-row:hover {
		background: transparent;
	}
	.later-row:hover .ess-row__title {
		color: var(--ess-primary-text);
	}
	.table-wrap {
		overflow-x: auto;
		margin: 0 calc(-1 * var(--ess-space-5));
		padding: 0 var(--ess-space-5);
	}
	.past th:first-child,
	.past td:first-child {
		padding-left: 0;
	}
	.past th:last-child,
	.past td:last-child {
		padding-right: 0;
	}
	.past th {
		background: var(--ess-sunken);
		padding-top: 10px;
		padding-bottom: 10px;
	}
	.past th:first-child {
		padding-left: 12px;
		border-radius: var(--ess-radius-sm) 0 0 var(--ess-radius-sm);
	}
	.past th:last-child {
		padding-right: 12px;
		border-radius: 0 var(--ess-radius-sm) var(--ess-radius-sm) 0;
	}
	.past td:first-child {
		padding-left: 12px;
	}
	.past td:last-child {
		padding-right: 12px;
	}
	.past tbody tr:hover td {
		background: transparent;
	}
	.t-topic {
		font-weight: 500;
		font-size: 14.5px;
	}
	.t-sub {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.t-acts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.sdot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
	}
	.empty {
		margin: 0;
		padding: 14px 0;
		text-align: center;
		color: var(--ess-text-muted);
		font-size: 13.5px;
		list-style: none;
	}
	/* ---------- today's schedule ---------- */
	.sched {
		position: sticky;
		top: 16px;
	}
	.tl {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}
	.tl-i {
		position: relative;
		display: grid;
		grid-template-columns: 48px 20px minmax(0, 1fr);
		gap: 0 10px;
		padding: 8px 6px;
		border-radius: var(--ess-radius-md);
	}
	.tl-i::before {
		content: '';
		position: absolute;
		left: 75px;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--ess-border-subtle);
	}
	.tl-i:first-child::before {
		top: 22px;
	}
	.tl-i:last-child::before {
		bottom: calc(100% - 22px);
	}
	.tl-i.live {
		background: var(--ess-primary-softer);
	}
	.tl-t {
		font-size: 13px;
		color: var(--ess-text-secondary);
		font-variant-numeric: tabular-nums;
		padding-top: 2px;
	}
	.tl-i.live .tl-t {
		color: var(--ess-primary-text);
		font-weight: 500;
	}
	.tl-dot {
		position: relative;
		z-index: 1;
		width: 12px;
		height: 12px;
		margin-top: 4px;
		border-radius: 50%;
		background: var(--ess-border-strong);
		justify-self: center;
		box-shadow: 0 0 0 3px var(--ess-surface);
	}
	.tl-i.live .tl-dot {
		background: var(--ess-primary);
		box-shadow: 0 0 0 3px var(--ess-primary-softer);
	}
	.tl-b {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.tl-b strong {
		font-size: 14.5px;
		font-weight: 500;
	}
	.tl-b small {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.stack.sm {
		margin-top: 2px;
	}
	@media (max-width: 1100px) {
		.sched {
			position: static;
		}
	}
	@media (max-width: 720px) {
		.m {
			grid-template-columns: minmax(0, 1fr);
			gap: 10px;
		}
		.when {
			border-right: none;
			padding-right: 0;
			grid-auto-flow: column;
			justify-content: start;
			gap: 10px;
		}
		.acts {
			justify-content: flex-start;
		}
		.tools {
			margin-left: 0;
			width: 100%;
		}
		.tools .ess-btn {
			flex: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
		}
	}
</style>
