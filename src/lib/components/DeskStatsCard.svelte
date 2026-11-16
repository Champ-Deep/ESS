<script lang="ts">
	import Headset from '@lucide/svelte/icons/headset';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	/**
	 * A support desk's numbers and its waiting questions (src/lib/server/desk-stats.ts),
	 * on the HR, IT and Engagement dashboards.
	 */
	type Stats = {
		open: number;
		askedThisWeek: number;
		resolvedThisWeek: number;
		medianReplyMinutes: number | null;
		waiting: { channelId: string; fullName: string; preview: string; since: string }[];
	};
	let { title, stats }: { title: string; stats: Stats } = $props();

	const reply = (m: number | null) => (m === null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);
	const ago = (iso: string) => {
		const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
		return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
	};
</script>

<section class="ess-card desk" aria-label={title}>
	<div class="ess-card-head">
		<h2 class="ess-h2"><Headset size={16} /> {title}</h2>
		<a class="ess-link" href="/hub/chats">Open chats <ChevronRight size={14} /></a>
	</div>
	<div class="nums">
		<div><b class:warn={stats.open > 0}>{stats.open}</b><span>Waiting</span></div>
		<div><b>{stats.askedThisWeek}</b><span>Asked this week</span></div>
		<div><b>{stats.resolvedThisWeek}</b><span>Resolved this week</span></div>
		<div><b>{reply(stats.medianReplyMinutes)}</b><span>Typical first reply</span></div>
	</div>
	{#if stats.waiting.length}
		<ul class="waiting">
			{#each stats.waiting as w (w.channelId)}
				<li>
					<a href="/hub/c/{w.channelId}">
						<span class="who"><strong>{w.fullName}</strong><small>{w.preview || 'No text'}</small></span>
						<span class="since">{ago(w.since)}</span>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="ess-caption">No one is waiting.</p>
	{/if}
</section>

<style>
	.desk {
		display: grid;
		gap: 10px;
		align-content: start;
	}
	.ess-h2 {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.nums {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 8px;
	}
	.nums div {
		display: grid;
		gap: 2px;
		padding: 8px 10px;
		border-radius: 10px;
		background: var(--ess-sunken);
	}
	.nums b {
		font-size: 18px;
		font-variant-numeric: tabular-nums;
	}
	.nums b.warn {
		color: var(--ess-warning-text, #b45309);
	}
	.nums span {
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
	.waiting {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.waiting a {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 4px;
		border-bottom: 1px solid var(--ess-border-subtle);
		color: inherit;
		text-decoration: none;
	}
	.waiting a:hover {
		background: var(--ess-surface-hover);
	}
	.who {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.who small {
		color: var(--ess-text-muted);
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.since {
		font-size: 12px;
		color: var(--ess-text-muted);
		white-space: nowrap;
	}
</style>
