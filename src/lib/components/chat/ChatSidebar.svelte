<script lang="ts">
	import { SUPPORT_TEAMS } from '$lib/capabilities';
	import Megaphone from '@lucide/svelte/icons/megaphone';
	import Hash from '@lucide/svelte/icons/hash';
	import Lock from '@lucide/svelte/icons/lock';
	import Bell from '@lucide/svelte/icons/bell';
	import Headset from '@lucide/svelte/icons/headset';
	import Users from '@lucide/svelte/icons/users';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Bookmark from '@lucide/svelte/icons/bookmark';
	import Settings from '@lucide/svelte/icons/settings';
	import BellOff from '@lucide/svelte/icons/bell-off';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Avatar from '$lib/components/Avatar.svelte';
	import { channelLabel, type SidebarChannel } from '$lib/chat/client.svelte';

	/** The narrow conversation list beside an open conversation. */
	let {
		channels,
		activeId,
		meId,
		isHr,
		desks: answering = undefined,
		presence,
		champWaiting = 0,
		onselect,
		onnew,
		onfind,
		onsettings
	}: {
		channels: SidebarChannel[];
		activeId: string | null;
		meId: string;
		isHr: boolean;
		/** The desks this person answers ('hr' | 'engagement' | 'it'). */
		desks?: string[];
		presence: Map<string, { state: string; online: boolean; label: string }>;
		/** Approvals and tasks waiting in Champ's Requests tab. */
		champWaiting?: number;
		onselect: (id: string) => void;
		onnew: () => void;
		onfind: (mode: 'search' | 'saved') => void;
		onsettings: () => void;
	} = $props();

	let filter = $state('');
	let searching = $state(false);

	const labelOf = channelLabel;

	const q = $derived(filter.trim().toLowerCase());
	const match = (c: SidebarChannel) => !q || labelOf(c, meId).toLowerCase().includes(q);
	const byRecent = (a: SidebarChannel, b: SidebarChannel) => b.lastMessageAt.localeCompare(a.lastMessageAt);

	const top = $derived(channels.filter((c) => (c.kind === 'announcements' || c.kind === 'system') && match(c)).sort((a) => (a.kind === 'announcements' ? -1 : 1)));
	const chans = $derived(
		channels
			.filter((c) => c.kind === 'channel' && match(c))
			.sort((a, b) => Number(a.source === 'manual') - Number(b.source === 'manual') || a.name.localeCompare(b.name))
	);
	const dms = $derived(
		channels
			.filter((c) => (c.kind === 'dm' || c.kind === 'group') && match(c))
			.sort((a, b) => Number(!!b.pinnedAs) - Number(!!a.pinnedAs) || byRecent(a, b))
	);
	const desks = $derived(channels.filter((c) => c.kind === 'desk' && match(c)).sort((a, b) => Number(a.deskStatus === 'resolved') - Number(b.deskStatus === 'resolved') || byRecent(a, b)));
	// Your own Ask HR / Ask IT / Ask Engagement threads, in that order.
	const myDesks = $derived(
		desks
			.filter((d) => d.deskOwnerId === meId)
			.sort((a, b) => SUPPORT_TEAMS.findIndex((t) => t.key === (a.deskTeam ?? 'hr')) - SUPPORT_TEAMS.findIndex((t) => t.key === (b.deskTeam ?? 'hr')))
	);
	// Questions you answer, per team; threads nobody has written in stay out.
	const answerDesks = $derived(
		SUPPORT_TEAMS.map((t) => {
			const list = desks.filter((d) => d.deskOwnerId !== meId && (d.deskTeam ?? 'hr') === t.key && !d.deskEmpty);
			return { team: t, list, open: list.filter((d) => d.deskStatus !== 'resolved').length };
		}).filter((g) => g.list.length > 0 || (answering ?? (isHr ? ['hr'] : [])).includes(g.team.key))
	);
</script>

{#snippet row(c: SidebarChannel)}
	{@const other = c.kind === 'dm' ? c.others[0] : null}
	{@const st = other ? presence.get(other.id) : null}
	<button
		type="button"
		class="row"
		class:on={c.id === activeId}
		class:unread={c.unread > 0 && !c.muted}
		class:left={other && !other.isActive}
		onclick={() => onselect(c.id)}
		aria-current={c.id === activeId ? 'page' : undefined}
	>
		<span class="ic" class:ess-tile={!other} class:ess-tile--sm={!other} class:ess-tile--round={!other} class:ess-tile--neutral={!other && c.kind !== 'announcements'}>
			{#if c.kind === 'announcements'}<Megaphone size={16} strokeWidth={1.75} />
			{:else if c.kind === 'system'}<Bell size={16} strokeWidth={1.75} />
			{:else if c.kind === 'desk'}<Headset size={16} strokeWidth={1.75} />
			{:else if c.kind === 'group'}<Users size={16} strokeWidth={1.75} />
			{:else if other}
				<span class="av-wrap">
					<Avatar userId={other.id} fullName={other.fullName} size="md" />
					{#if st}<span class="dot" data-state={st.state} class:online={st.online}></span>{/if}
				</span>
			{:else if c.isPrivate}<Lock size={15} strokeWidth={1.75} />
			{:else}<Hash size={16} strokeWidth={1.75} />{/if}
		</span>
		<span class="name">
			<span class="label">{labelOf(c, meId)}</span>
			<span class="sub">
				{#if c.pinnedAs}{c.pinnedAs === 'manager' ? 'Your manager' : 'Your HR'}
				{:else if other && !other.isActive}Left
				{:else if c.kind === 'desk'}{c.deskStatus === 'resolved' ? 'Resolved' : 'Open'}
				{:else if c.kind === 'channel' && c.source === 'team'}Team channel
				{:else if c.kind === 'channel' && c.source === 'shift'}Shift channel
				{:else if c.kind === 'announcements'}From HR
				{:else if c.kind === 'system'}Your ESS feed
				{:else if c.topic}{c.topic}
				{:else if st}{st.label}{/if}
			</span>
		</span>
		{#if c.muted}<BellOff size={12} class="muted-ic" />{/if}
		{#if !c.muted && (c.kind === 'channel' ? c.mentions : c.unread) > 0}
			<span class="cnt" class:hot={c.kind === 'announcements' && c.mentions > 0}>{c.kind === 'channel' ? c.mentions : c.unread}</span>
		{/if}
	</button>
{/snippet}

<nav class="side" aria-label="Conversations">
	<div class="tools">
		<h2 class="ess-h2">Chats</h2>
		<button type="button" class="ess-icon-btn" onclick={onnew} aria-label="New conversation" title="New conversation"><Plus size={19} /></button>
		<button type="button" class="ess-icon-btn" aria-label="Find a conversation" title="Find a conversation" aria-pressed={searching} onclick={() => { searching = !searching; if (!searching) filter = ''; }}><Search size={18} /></button>
	</div>
	{#if searching}
		<div class="ess-search filter">
			<Search size={15} />
			<!-- svelte-ignore a11y_autofocus -->
			<input class="ess-input" bind:value={filter} placeholder="Find a conversation" aria-label="Find a conversation" autofocus />
		</div>
	{/if}
	<div class="scroll">
		<!-- Champ lives here, in the chat list, rather than floating over every page. -->
		<button type="button" class="row champ" class:on={activeId === 'champ'} onclick={() => onselect('champ')} aria-current={activeId === 'champ' ? 'page' : undefined}>
			<span class="ic ess-tile ess-tile--sm ess-tile--round"><Sparkles size={16} strokeWidth={1.75} /></span>
			<span class="name"><span class="label">Champ</span><span class="sub">Assistant</span></span>
			{#if champWaiting > 0}<span class="cnt">{champWaiting}</span>{/if}
		</button>
		{#each top as c (c.id)}{@render row(c)}{/each}

		<h3>Channels</h3>
		{#each chans as c (c.id)}{@render row(c)}{/each}
		{#if chans.length === 0}<p class="empty">No channels match.</p>{/if}

		<h3>Direct messages</h3>
		{#each dms as c (c.id)}{@render row(c)}{/each}
		{#if dms.length === 0}<p class="empty">Start one with the + button.</p>{/if}

		{#if myDesks.length}
			<h3>Help desks</h3>
			{#each myDesks as c (c.id)}{@render row(c)}{/each}
		{/if}
		{#each answerDesks as g (g.team.key)}
			<h3>{g.team.deskName} desk{g.open ? ` · ${g.open} open` : ''}</h3>
			{#each g.list as c (c.id)}{@render row(c)}{/each}
			{#if g.list.length === 0}<p class="empty">No questions yet.</p>{/if}
		{/each}
	</div>
	<div class="quick">
		<button type="button" onclick={() => onfind('search')}><Search size={13} /> Search messages</button>
		<button type="button" onclick={() => onfind('saved')}><Bookmark size={13} /> Saved</button>
		<button type="button" onclick={onsettings} aria-label="Chat settings" title="Chat settings"><Settings size={13} /></button>
	</div>
</nav>

<style>
	.side {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		background: var(--ess-surface);
		border-right: 1px solid var(--ess-border);
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 12px 10px 8px 16px;
	}
	.tools .ess-h2 {
		flex: 1;
		font-size: 18px;
	}
	.ess-icon-btn[aria-pressed='true'] {
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	.filter {
		padding: 0 12px 8px;
	}
	.filter > :global(svg) {
		left: 24px;
	}
	.filter .ess-input {
		padding-top: 8px;
		padding-bottom: 8px;
	}
	.scroll {
		flex: 1;
		overflow-y: auto;
		padding: 2px 8px 10px;
		overscroll-behavior: contain;
	}
	h3 {
		margin: 16px 10px 6px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ess-text-muted);
	}
	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 8px 10px;
		border: 0;
		border-radius: var(--ess-radius-md);
		background: none;
		font: inherit;
		color: var(--ess-text-secondary);
		text-align: left;
		cursor: pointer;
		transition: background var(--ess-t-fast);
	}
	.row:hover {
		background: var(--ess-sunken);
		color: var(--ess-text);
	}
	.row.on {
		background: var(--ess-primary-softer);
		color: var(--ess-text);
	}
	.row.on::before {
		content: '';
		position: absolute;
		left: -8px;
		top: 6px;
		bottom: 6px;
		width: 3px;
		border-radius: 0 3px 3px 0;
		background: var(--ess-primary);
	}
	.row.unread .label {
		font-weight: 600;
		color: var(--ess-text);
	}
	.row.left {
		opacity: 0.6;
	}
	.row:focus-visible {
		outline: none;
		box-shadow: var(--ess-focus-ring);
	}
	.ic {
		flex: none;
		display: grid;
		place-items: center;
	}
	.av-wrap {
		position: relative;
		display: inline-flex;
	}
	.dot {
		position: absolute;
		right: -1px;
		bottom: -1px;
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 2px solid var(--ess-surface);
		background: var(--ess-text-muted);
	}
	.dot[data-state='in'] {
		background: var(--ess-success);
	}
	.dot[data-state='leave'],
	.dot[data-state='holiday'] {
		background: var(--ess-warning);
	}
	.dot[data-state='night'] {
		background: var(--ess-primary);
	}
	.dot[data-state='weekoff'],
	.dot[data-state='off'],
	.dot[data-state='left'] {
		background: var(--ess-surface);
		box-shadow: inset 0 0 0 1.5px var(--ess-text-muted);
	}
	.name {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 1px;
	}
	.label {
		font-size: 14px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub {
		font-size: 12px;
		color: var(--ess-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-height: 1em;
	}
	.cnt {
		min-width: 20px;
		height: 20px;
		padding: 0 6px;
		border-radius: 99px;
		display: inline-grid;
		place-items: center;
		font-size: 11px;
		font-weight: 600;
		background: var(--ess-primary);
		color: var(--ess-text-on-primary);
		flex-shrink: 0;
	}
	.cnt.hot {
		background: var(--ess-danger);
		color: #fff;
	}
	.row :global(.muted-ic) {
		color: var(--ess-text-muted);
		flex-shrink: 0;
	}
	.empty {
		margin: 2px 10px;
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}
	.quick {
		display: flex;
		gap: 2px;
		padding: 8px 10px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.quick button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 0;
		background: none;
		padding: 5px 7px;
		border-radius: var(--ess-radius-xs);
		font: inherit;
		font-size: 12px;
		color: var(--ess-text-secondary);
		cursor: pointer;
	}
	.quick button:hover {
		background: var(--ess-surface-hover);
		color: var(--ess-text);
	}
	.quick button:last-child {
		margin-left: auto;
	}
</style>
