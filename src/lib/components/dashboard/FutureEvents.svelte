<script lang="ts">
	/**
	 * What's coming: today's meetings still to start (with who is invited),
	 * then event announcements and holidays from the feed's "Coming up" list.
	 * The first is the highlighted card; the rest are rows.
	 */
	import Clock from '@lucide/svelte/icons/clock';
	import PartyPopper from '@lucide/svelte/icons/party-popper';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import Video from '@lucide/svelte/icons/video';
	import Avatar from '$lib/components/Avatar.svelte';
	import HomeReel from '$lib/components/engagement/HomeReel.svelte';

	type Ev = {
		id: string;
		kind: 'meeting' | 'event' | 'holiday';
		title: string;
		summary: string | null;
		date: string;
		time: string | null;
		read: boolean;
		href: string;
		newTab: boolean;
		people: { id: string; fullName: string; hasPicture: boolean }[];
	};

	let { events }: { events: Ev[] } = $props();

	const lead = $derived(events[0]);
	const rest = $derived(events.slice(1, 3));

	const day = (iso: string) => new Date(iso + 'T00:00:00');
	function when(e: Ev) {
		const d = day(e.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
		return e.time ? `${d} · ${e.time}` : d;
	}
	function inDays(iso: string) {
		const now = new Date();
		const t = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const n = Math.round((day(iso).getTime() - t) / 86_400_000);
		return n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`;
	}
	// Relative labels depend on the viewer's clock, so they appear after hydration.
	let mounted = $state(false);
	$effect(() => {
		mounted = true;
	});
	const tagOf = (e: Ev) => (e.kind === 'meeting' ? 'Meeting' : e.kind === 'holiday' ? 'Holiday' : 'Event');
</script>

<section class="ess-card panel" aria-labelledby="events-h">
	<header class="p-head">
		<div>
			<h2 id="events-h">Future events</h2>
			<p>Meetings, events and holidays ahead</p>
		</div>
		<a class="more" href="/chat?c=announcements" aria-label="All announcements"><ArrowUpRight size={16} /></a>
	</header>

	{#if !lead}
		<p class="quiet">Nothing scheduled yet. Meetings, event announcements and holidays will appear here.</p>
	{:else}
		<a
			class="lead"
			href={lead.href}
			target={lead.newTab ? '_blank' : undefined}
			rel={lead.newTab ? 'noopener' : undefined}
			data-sveltekit-reload={lead.newTab ? true : undefined}
		>
			<span class="lead-top">
				<span class="tag">{#if lead.kind === 'meeting'}<Video size={11} aria-hidden="true" />{/if}{tagOf(lead)}</span>
				{#if mounted}<span class="soon">{inDays(lead.date)}</span>{/if}
			</span>
			<strong class="lead-title">{lead.title}</strong>
			{#if lead.summary}<span class="lead-sum">{lead.summary}</span>{/if}
			<span class="lead-foot">
				<span class="lead-when"><Clock size={13} aria-hidden="true" />{when(lead)}</span>
				{#if lead.people.length}
					<span class="faces" aria-label="{lead.people.length} invited">
						{#each lead.people.slice(0, 4) as p (p.id)}
							<span class="face" title={p.fullName}><Avatar userId={p.id} fullName={p.fullName} hasPicture={p.hasPicture} size="sm" /></span>
						{/each}
						{#if lead.people.length > 4}<span class="face more">+{lead.people.length - 4}</span>{/if}
					</span>
				{/if}
			</span>
		</a>

		{#if rest.length}
			<ul class="rows">
				{#each rest as e (e.id)}
					{@const d = day(e.date)}
					<li>
						<a
							class="row"
							href={e.href}
							target={e.newTab ? '_blank' : undefined}
							rel={e.newTab ? 'noopener' : undefined}
							data-sveltekit-reload={e.newTab ? true : undefined}
						>
							<span class="tile" aria-hidden="true">
								<b>{d.getDate()}</b>{d.toLocaleDateString(undefined, { month: 'short' })}
							</span>
							<span class="row-text">
								<span class="row-title">
									{#if e.kind === 'holiday'}<PartyPopper size={13} aria-hidden="true" />{:else if e.kind === 'meeting'}<Video size={13} aria-hidden="true" />{/if}{e.title}
									{#if !e.read}<span class="unread" title="Unread"></span>{/if}
								</span>
								<span class="row-meta">{e.kind === 'meeting' ? `${e.time} · ${e.summary}` : (e.summary ?? when(e))}</span>
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	<!-- Today's celebrations and reels: plays over this card while new, then
	     a small LIVE button in the header to watch again. -->
	<HomeReel variant="card" />
</section>

<style>
	.panel {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-height: 0;
		overflow: hidden;
		padding: 16px 18px;
	}
	.p-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}
	.p-head h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 650;
		letter-spacing: -0.01em;
	}
	.p-head p {
		margin: 1px 0 0;
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.more {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--ess-sunken);
		color: var(--ess-text-secondary);
	}
	.more:hover {
		color: var(--ess-text);
	}

	.lead {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px 14px;
		border-radius: 14px;
		background: var(--ess-primary);
		color: var(--ess-text-on-primary);
		text-decoration: none;
		box-shadow: var(--ess-primary-shadow);
	}
	.lead:hover {
		color: var(--ess-text-on-primary);
		background: var(--ess-primary-hover);
	}
	.lead-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 11px;
	}
	.tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.2);
		font-weight: 600;
	}
	.soon {
		opacity: 0.85;
	}
	.lead-title {
		font-size: 14px;
		font-weight: 650;
		line-height: 1.3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.lead-sum {
		font-size: 12px;
		opacity: 0.85;
		display: -webkit-box;
		-webkit-line-clamp: 1;
		line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.lead-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-top: 2px;
	}
	.lead-when {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		opacity: 0.9;
	}
	.faces {
		display: flex;
	}
	.face {
		display: grid;
		border-radius: 50%;
		box-shadow: 0 0 0 2px var(--ess-primary);
	}
	.face + .face {
		margin-left: -7px;
	}
	.face.more {
		place-items: center;
		min-width: 28px;
		height: 28px;
		padding: 0 4px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.22);
		font-size: 10.5px;
		font-weight: 600;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 4px;
		border-radius: 10px;
		color: var(--ess-text);
		text-decoration: none;
	}
	.row:hover {
		background: var(--ess-surface-hover);
		color: var(--ess-text);
	}
	.tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		flex-shrink: 0;
		border-radius: 10px;
		background: var(--ess-sunken);
		font-size: 10px;
		color: var(--ess-text-muted);
		line-height: 1.1;
	}
	.tile b {
		font-size: 14px;
		color: var(--ess-text);
	}
	.row-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.row-title {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row-meta {
		font-size: 12px;
		color: var(--ess-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.unread {
		width: 6px;
		height: 6px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--ess-primary);
	}
	.quiet {
		margin: 0;
		color: var(--ess-text-muted);
		font-size: 13px;
	}

	/* Short laptop screens (about 1280×580): tighter so the dashboard fits. */
	@media (min-width: 721px) and (max-height: 760px) {
		.panel {
			padding: 10px 14px;
			gap: 8px;
		}
		.p-head p {
			display: none;
		}
		.more {
			width: 26px;
			height: 26px;
		}
	}
</style>
