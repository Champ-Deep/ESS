<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Hash from '@lucide/svelte/icons/hash';
	import Lock from '@lucide/svelte/icons/lock';
	import Megaphone from '@lucide/svelte/icons/megaphone';
	import Bell from '@lucide/svelte/icons/bell';
	import Headset from '@lucide/svelte/icons/headset';
	import Users from '@lucide/svelte/icons/users';
	import BellOff from '@lucide/svelte/icons/bell-off';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Bookmark from '@lucide/svelte/icons/bookmark';
	import Settings from '@lucide/svelte/icons/settings';
	import Pin from '@lucide/svelte/icons/pin';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Avatar from '$lib/components/Avatar.svelte';
	import NewChatDialog from '$lib/components/chat/NewChatDialog.svelte';
	import ChatPrefs from '$lib/components/chat/ChatPrefs.svelte';
	import FindPanel from '$lib/components/chat/FindPanel.svelte';
	import MessageList from '$lib/components/chat/MessageList.svelte';
	import Composer from '$lib/components/chat/Composer.svelte';
	import SideSheet from '$lib/components/hub/SideSheet.svelte';
	import { chat, channelLabel, type SidebarChannel, deskWords } from '$lib/chat/client.svelte';
	import { ago } from '$lib/hub/format';

	/**
	 * Every conversation as one inbox list, with the selected one previewed
	 * beside it on a wide screen. Opening a row on a narrow screen (or the
	 * expand button) goes to the full conversation at /hub/c/<id>.
	 */
	let { data } = $props();
	const meId = $derived(data.hubMe.id);
	const channels = $derived<SidebarChannel[]>(chat.channels.length ? chat.channels : (data.sidebar.channels as SidebarChannel[]));

	type Filter = 'all' | 'unread' | 'mentions' | 'channels' | 'people' | 'hr';
	let filter = $state<Filter>('all');
	let q = $state('');
	let newOpen = $state(false);
	let prefsOpen = $state(false);
	let find = $state<{ mode: 'search' | 'saved'; q: string } | null>(page.url.searchParams.get('search') ? { mode: 'search', q: page.url.searchParams.get('search')! } : null);

	const label = (c: SidebarChannel) => (c.kind === 'channel' ? '#' : '') + channelLabel(c, meId);
	const count = (c: SidebarChannel) => (c.muted ? 0 : c.kind === 'channel' ? c.mentions : c.unread);
	const bold = (c: SidebarChannel) => !c.muted && c.unread > 0;

	const shown = $derived(
		channels
			.filter((c) => {
				// Someone else's desk question nobody has written in yet: nothing to answer.
				if (c.kind === 'desk' && c.deskOwnerId !== meId && c.deskEmpty) return false;
				if (q.trim() && !label(c).toLowerCase().includes(q.trim().toLowerCase())) return false;
				if (filter === 'unread') return bold(c);
				if (filter === 'mentions') return !c.muted && c.mentions > 0;
				if (filter === 'channels') return c.kind === 'channel';
				if (filter === 'people') return c.kind === 'dm' || c.kind === 'group';
				if (filter === 'hr') return c.kind === 'system' || c.kind === 'desk' || c.kind === 'announcements';
				return true;
			})
			// Announcements stay pinned at the top; then what needs reading, then the most recent.
			.sort(
				(a, b) =>
					Number(b.kind === 'announcements') - Number(a.kind === 'announcements') ||
					Number(count(b) > 0) - Number(count(a) > 0) ||
					Number(!!b.pinnedAs) - Number(!!a.pinnedAs) ||
					b.lastMessageAt.localeCompare(a.lastMessageAt)
			)
	);

	const nameOf = (cid: string) => {
		const c = channels.find((x) => x.id === cid);
		return c ? label(c) : 'Conversation';
	};

	const blurb = (c: SidebarChannel) => {
		const bits: string[] = [];
		if (c.pinnedAs) bits.push(c.pinnedAs === 'manager' ? 'Your manager' : 'Your HR');
		if (c.kind === 'desk') bits.push(c.deskStatus === 'resolved' ? 'Resolved' : 'Open');
		if (c.kind === 'dm' && !c.others[0]?.isActive) bits.push('Left');
		if (c.kind === 'channel' && c.source === 'team') bits.push('Team channel');
		if (c.kind === 'channel' && c.source === 'shift') bits.push('Shift channel');
		if (c.kind === 'announcements') bits.push('Notices from HR for everyone');
		if (c.kind === 'system') bits.push('Requests, decisions and reminders');
		if (c.topic) bits.push(c.topic);
		return bits.join(' · ');
	};

	/* ---------- preview pane (wide screens) ---------- */

	let pickedId = $state<string | null>(null);
	const previewId = $derived(pickedId && channels.some((c) => c.id === pickedId) ? pickedId : (shown[0]?.id ?? null));
	const preview = $derived(channels.find((c) => c.id === previewId) ?? null);
	// Below this width the list is the whole page and rows open the conversation.
	const WIDE = 1000;

	function open(e: MouseEvent, id: string) {
		if (typeof window !== 'undefined' && window.innerWidth >= WIDE && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			pickedId = id;
		}
	}

	$effect(() => {
		chat.openChannelId = previewId;
		return () => (chat.openChannelId = null);
	});

	let members = $state<{ id: string; fullName: string }[]>([]);
	$effect(() => {
		const id = previewId;
		if (!id || preview?.kind === 'announcements' || preview?.kind === 'system') {
			members = [];
			return;
		}
		void fetch(`/api/chat/channels/${id}/members`).then(async (r) => {
			if (r.ok && previewId === id) members = (await r.json()).filter((m: { id: string; isActive: boolean }) => m.id !== meId && m.isActive);
		});
	});
	const statusOf = () => null;

	const other = $derived(preview?.kind === 'dm' ? preview.others[0] : null);
	const disabledReason = $derived.by(() => {
		if (!preview) return 'Pick a conversation';
		if (preview.kind === 'system') return 'This is your ESS feed: requests to approve, decisions and reminders. Nothing is posted here.';
		if (other && !other.isActive) return `${other.fullName} has left, so this conversation is read-only.`;
		return null;
	});
	const placeholder = $derived(preview ? (preview.kind === 'channel' ? `Message #${preview.name}` : preview.kind === 'desk' ? (preview.deskOwnerId === meId ? deskWords(preview).placeholder : 'Reply to this question') : `Message ${channelLabel(preview, meId)}`) : 'Message');
	let list = $state<ReturnType<typeof MessageList> | null>(null);
</script>

<svelte:head><title>Chats · Champ Hub — Champ HR ESS Portal</title></svelte:head>

<div class="chats ess-card hub-fill" class:has-preview={!!preview}>
	<section class="inbox" aria-label="Conversations">
		<div class="inbox-head">
			<h2 class="ess-h2">Conversations</h2>
			<div class="tools">
				<button type="button" class="ess-icon-btn" onclick={() => (find = { mode: 'search', q: '' })} aria-label="Search messages" title="Search messages"><Search size={17} /></button>
				<button type="button" class="ess-icon-btn" onclick={() => (find = { mode: 'saved', q: '' })} aria-label="Saved messages" title="Saved messages"><Bookmark size={17} /></button>
				<button type="button" class="ess-icon-btn" onclick={() => (prefsOpen = true)} aria-label="Chat settings" title="Chat settings"><Settings size={17} /></button>
				<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" onclick={() => (newOpen = true)} title="New conversation"><Plus size={15} /> <span class="new-label">New conversation</span></button>
			</div>
		</div>

		<div class="ess-search">
			<Search size={16} />
			<input class="ess-input" bind:value={q} placeholder="Search conversations…" aria-label="Search conversations" />
		</div>

		<div class="filters" role="group" aria-label="Show">
			{#each [['all', 'All'], ['unread', 'Unread'], ['mentions', 'Mentions'], ['channels', 'Channels'], ['people', 'People'], ['hr', 'ESS & HR']] as [k, l] (k)}
				<button type="button" class="f" aria-pressed={filter === k} onclick={() => (filter = k as Filter)}>{l}</button>
			{/each}
		</div>

		<div class="list">
			{#if filter === 'all' && !q.trim()}
				<a class="row champ" href="/hub/c/champ">
					<span class="ess-tile ic"><Sparkles size={18} strokeWidth={1.75} /></span>
					<span class="b"><strong>Champ</strong><small>Ask about leave, holidays, your tasks or your team</small></span>
					<span class="end"><span class="tag">Assistant</span></span>
				</a>
			{/if}
			{#each shown as c (c.id)}
				{@const dm = c.kind === 'dm' ? c.others[0] : null}
				<a class="row" class:unread={bold(c)} class:on={c.id === previewId} href="/hub/c/{c.id}" onclick={(e) => open(e, c.id)} aria-current={c.id === previewId ? 'true' : undefined}>
					<span class="ic" class:ess-tile={!dm} class:ess-tile--round={!dm} class:ess-tile--neutral={!dm && c.kind !== 'announcements'}>
						{#if dm}<Avatar userId={dm.id} fullName={dm.fullName} size="md" />
						{:else if c.kind === 'announcements'}<Megaphone size={18} strokeWidth={1.75} />
						{:else if c.kind === 'system'}<Bell size={18} strokeWidth={1.75} />
						{:else if c.kind === 'desk'}<Headset size={18} strokeWidth={1.75} />
						{:else if c.kind === 'group'}<Users size={18} strokeWidth={1.75} />
						{:else if c.isPrivate}<Lock size={17} strokeWidth={1.75} />
						{:else}<Hash size={18} strokeWidth={1.75} />{/if}
					</span>
					<span class="b">
						<strong>{label(c)}</strong>
						<small>{blurb(c) || 'No messages yet'}</small>
					</span>
					<span class="end">
						<span class="when">
							{#if c.kind === 'announcements'}<Pin size={12} class="pin" />{/if}
							{#if c.muted}<BellOff size={12} class="muted" />{/if}
							{ago(c.lastMessageAt)}
						</span>
						{#if count(c) > 0}<span class="n" class:hot={c.kind === 'announcements' && c.mentions > 0}>{count(c)}</span>{:else if bold(c)}<span class="dot"></span>{/if}
					</span>
				</a>
			{:else}
				<p class="empty">{q.trim() ? 'No conversation matches.' : filter === 'unread' ? 'All caught up.' : filter === 'mentions' ? 'Nobody has mentioned you.' : 'Nothing here yet.'}</p>
			{/each}
		</div>
	</section>

	<section class="preview" aria-label="Conversation preview">
		{#if preview}
			{@const dm = preview.kind === 'dm' ? preview.others[0] : null}
			<header class="p-head">
				<span class="ic" class:ess-tile={!dm} class:ess-tile--round={!dm}>
					{#if dm}<Avatar userId={dm.id} fullName={dm.fullName} size="md" />
					{:else if preview.kind === 'announcements'}<Megaphone size={18} />
					{:else if preview.kind === 'system'}<Bell size={18} />
					{:else if preview.kind === 'desk'}<Headset size={18} />
					{:else if preview.kind === 'group'}<Users size={18} />
					{:else}<Hash size={18} />{/if}
				</span>
				<div class="p-title">
					<h3>{channelLabel(preview, meId)}</h3>
					<small>
						{#if members.length}{members.length + 1} members{/if}
						{#if members.length && blurb(preview)} <span class="ess-dot-sep"></span> {/if}{blurb(preview)}
					</small>
				</div>
				<a class="ess-btn ess-btn--secondary ess-btn--sm" href="/hub/c/{preview.id}"><Maximize2 size={14} /> Open</a>
			</header>
			{#if preview.kind === 'announcements'}
				<div class="p-empty">
					<span class="ess-tile ess-tile--lg"><Megaphone size={24} strokeWidth={1.75} /></span>
					<strong>Announcements</strong>
					<p>Notices from HR, with what needs you and what is coming up.</p>
					<a class="ess-btn ess-btn--primary" href="/hub/c/{preview.id}">Open announcements</a>
				</div>
			{:else}
				{#key preview.id}
					<MessageList bind:this={list} channelId={preview.id} meId={meId} meName={data.hubMe.fullName} {statusOf} emptyText={preview.kind === 'system' ? 'Nothing here yet. Leave requests to approve and decisions on yours will appear here.' : preview.kind === 'desk' ? deskWords(preview).empty : 'No messages yet. Say hello.'} />
					<Composer channelId={preview.id} {members} {placeholder} {disabledReason} onsent={(m) => m && list?.upsert([m])} />
				{/key}
			{/if}
		{:else}
			<div class="p-empty">
				<span class="ess-tile ess-tile--lg ess-tile--neutral"><Search size={24} strokeWidth={1.75} /></span>
				<strong>Pick a conversation</strong>
				<p>It shows here, and opens full width from the Open button.</p>
			</div>
		{/if}
	</section>
</div>

{#if newOpen}
	<NewChatDialog scope={data.can.createChannels as 'anywhere' | 'team' | 'none'} onclose={() => (newOpen = false)} onopen={async (id) => { newOpen = false; await chat.refresh(); await goto(`/hub/c/${id}`); }} />
{/if}
{#if prefsOpen}<ChatPrefs onclose={() => (prefsOpen = false)} />{/if}
{#if find}
	{@const f = find}
	<SideSheet label={f.mode === 'saved' ? 'Saved messages' : 'Search messages'} onclose={() => (find = null)}>
		<FindPanel mode={f.mode} initialQuery={f.q} {meId} meName={data.hubMe.fullName} {nameOf} onopen={(m) => goto(`/hub/c/${m.channelId}${m.threadRootId ? `?t=${m.threadRootId}` : ''}`)} onclose={() => (find = null)} />
	</SideSheet>
{/if}

<style>
	.chats {
		--h: calc(100dvh - 300px);
		height: max(520px, var(--h));
		padding: 0;
		display: grid;
		grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
		overflow: hidden;
	}
	/* Desktop: the hub layout stretches this card to the bottom edge. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.chats {
				height: auto;
				min-height: 0;
			}
		}
	}
	.inbox {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--ess-border);
	}
	.inbox-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 14px 8px;
	}
	.inbox-head .ess-h2 {
		font-size: 18px;
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.tools .ess-btn {
		margin-left: 6px;
	}
	.inbox .ess-search {
		padding: 0 14px;
	}
	.inbox .ess-search > :global(svg) {
		left: 26px;
	}
	.inbox .ess-search .ess-input {
		padding-top: 7px;
		padding-bottom: 7px;
	}
	.filters {
		display: flex;
		gap: 5px;
		flex-wrap: wrap;
		padding: 8px 14px 8px;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.f {
		border: 1px solid var(--ess-border);
		background: var(--ess-surface);
		border-radius: var(--ess-radius-sm);
		padding: 3px 9px;
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--ess-text-secondary);
		cursor: pointer;
	}
	.f:hover {
		border-color: var(--ess-border-strong);
		color: var(--ess-text);
	}
	.f[aria-pressed='true'] {
		background: var(--ess-primary-soft);
		border-color: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	/* Short laptop screens: keep the six filters on one line. */
	@media (min-width: 721px) and (max-height: 760px) {
		.filters {
			flex-wrap: nowrap;
			gap: 4px;
			padding: 6px 14px;
			overflow-x: auto;
			scrollbar-width: none;
		}
		.f {
			flex: none;
			padding: 2px 6px;
			font-size: 12px;
			white-space: nowrap;
		}
	}
	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 9px 14px;
		border-bottom: 1px solid var(--ess-border-subtle);
		color: var(--ess-text);
		transition: background var(--ess-t-fast);
	}
	.row:hover {
		background: var(--ess-sunken);
	}
	.row.on {
		background: var(--ess-primary-softer);
	}
	.row.on::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
		background: var(--ess-primary);
	}
	.ic {
		flex: none;
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
	}
	.b {
		flex: 1;
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.b strong {
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.unread .b strong {
		font-weight: 600;
	}
	.b small {
		font-size: 12.5px;
		color: var(--ess-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.end {
		flex: none;
		display: grid;
		justify-items: end;
		gap: 6px;
	}
	.when {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		color: var(--ess-text-muted);
		white-space: nowrap;
	}
	.when :global(.pin),
	.when :global(.muted) {
		color: var(--ess-text-muted);
	}
	.tag {
		font-size: 11px;
		font-weight: 500;
		color: var(--ess-primary-text);
		background: var(--ess-primary-soft);
		border-radius: var(--ess-radius-xs);
		padding: 2px 8px;
	}
	.n {
		min-width: 20px;
		height: 20px;
		padding: 0 6px;
		border-radius: 99px;
		background: var(--ess-primary);
		color: var(--ess-text-on-primary);
		font-size: 11px;
		font-weight: 600;
		display: grid;
		place-items: center;
	}
	.n.hot {
		background: var(--ess-danger);
		color: #fff;
	}
	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--ess-primary);
		margin: 5px 4px;
	}
	.empty {
		margin: 0;
		padding: 20px 14px;
		text-align: center;
		color: var(--ess-text-muted);
		font-size: 13.5px;
	}

	/* ---------- preview ---------- */
	.preview {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.p-head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--ess-border);
	}
	.p-title {
		flex: 1;
		min-width: 0;
		display: grid;
	}
	.p-title h3 {
		font-family: var(--ess-font-display);
		font-size: 18px;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.p-title small {
		font-size: 13px;
		color: var(--ess-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.p-empty {
		margin: auto;
		display: grid;
		justify-items: center;
		gap: 8px;
		text-align: center;
		padding: 24px;
		color: var(--ess-text-secondary);
		max-width: 36ch;
	}
	.p-empty strong {
		font-family: var(--ess-font-display);
		font-size: 17px;
		font-weight: 600;
		color: var(--ess-text);
	}
	.p-empty p {
		font-size: 13.5px;
	}
	.p-empty .ess-btn {
		margin-top: 8px;
	}

	/* The button keeps its name for screen readers; the words show when
	   there is room for them. */
	@container ess-main (max-width: 1473px) {
		.new-label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
			white-space: nowrap;
		}
	}
	@media (max-width: 999px) {
		.chats {
			grid-template-columns: minmax(0, 1fr);
			height: auto;
		}
		.inbox {
			border-right: none;
		}
		.list {
			overflow: visible;
		}
		.preview {
			display: none;
		}
		.new-label {
			display: none;
		}
	}
</style>
