<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Info from '@lucide/svelte/icons/info';
	import Search from '@lucide/svelte/icons/search';
	import Hash from '@lucide/svelte/icons/hash';
	import Megaphone from '@lucide/svelte/icons/megaphone';
	import Headset from '@lucide/svelte/icons/headset';
	import Bell from '@lucide/svelte/icons/bell';
	import Users from '@lucide/svelte/icons/users';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import PenLine from '@lucide/svelte/icons/pen-line';
	import Avatar from '$lib/components/Avatar.svelte';
	import ChatSidebar from '$lib/components/chat/ChatSidebar.svelte';
	import MessageList from '$lib/components/chat/MessageList.svelte';
	import Composer from '$lib/components/chat/Composer.svelte';
	import ThreadPanel from '$lib/components/chat/ThreadPanel.svelte';
	import InfoPanel from '$lib/components/chat/InfoPanel.svelte';
	import FindPanel from '$lib/components/chat/FindPanel.svelte';
	import NewChatDialog from '$lib/components/chat/NewChatDialog.svelte';
	import ChatPrefs from '$lib/components/chat/ChatPrefs.svelte';
	import AnnouncementFeed from '$lib/components/announcements/AnnouncementFeed.svelte';
	import AnnouncementAdmin from '$lib/components/announcements/AnnouncementAdmin.svelte';
	import ChampPanel from '$lib/components/champ/ChampPanel.svelte';
	import NewTaskDialog from '$lib/components/hub/NewTaskDialog.svelte';
	import { chat, channelLabel, type SidebarChannel, deskWords } from '$lib/chat/client.svelte';
	import type { ChatMessageView } from '$lib/server/chat/messages';

	let { data, form } = $props();

	const me = $derived(data.me);
	const channels = $derived<SidebarChannel[]>(chat.channels.length ? chat.channels : (data.sidebar.channels as SidebarChannel[]));

	/* ---------- which conversation ---------- */

	const want = $derived(page.params.id ?? '');
	const activeId = $derived.by(() => {
		if (want === 'champ') return 'champ';
		if (want === 'announcements') return channels.find((c) => c.kind === 'announcements')?.id ?? null;
		if (want === 'ess') return channels.find((c) => c.kind === 'system')?.id ?? null;
		return channels.some((c) => c.id === want) ? want : null;
	});
	const active = $derived(channels.find((c) => c.id === activeId) ?? null);
	const champOpen = $derived(activeId === 'champ');
	let champWaiting = $state(0);

	$effect(() => {
		chat.openChannelId = activeId;
		return () => (chat.openChannelId = null);
	});

	function select(id: string) {
		if (id === activeId) return;
		void goto(`/hub/c/${id}`);
	}

	/* ---------- side panel ---------- */

	type Panel = 'thread' | 'info' | 'search' | 'saved' | null;
	let panel = $state<Panel>(null);
	let thread = $state<ChatMessageView | null>(null);
	let newOpen = $state(false);
	let prefsOpen = $state(false);
	let manageAnnouncements = $state(page.url.searchParams.has('compose'));
	let makeFrom = $state<{ messageId: string; text: string; mentionIds: string[] } | null>(null);
	const draft = $derived.by(() => {
		try {
			const d = page.url.searchParams.get('draft');
			return d ? JSON.parse(d) : null;
		} catch {
			return null;
		}
	});

	function openThread(m: ChatMessageView) {
		thread = m;
		panel = 'thread';
	}
	function closePanel() {
		panel = null;
		thread = null;
		if (page.url.searchParams.has('t')) {
			const url = new URL(page.url);
			url.searchParams.delete('t');
			replaceState(url, {});
		}
	}

	// Switching conversation closes a thread; details and search stay.
	$effect(() => {
		void activeId;
		if (panel === 'thread') {
			panel = null;
			thread = null;
		}
	});

	// ?t=<id> opens a thread (from a notification about a reply).
	$effect(() => {
		const t = page.url.searchParams.get('t');
		if (!t || thread?.id === t) return;
		void fetch(`/api/chat/messages?ids=${t}`).then(async (r) => {
			const [m] = r.ok ? await r.json() : [];
			if (m) openThread(m);
		});
	});

	/* ---------- members and presence ---------- */

	let members = $state<{ id: string; fullName: string }[]>([]);
	$effect(() => {
		const id = activeId;
		if (!id || id === 'champ' || active?.kind === 'announcements' || active?.kind === 'system') {
			members = [];
			return;
		}
		void fetch(`/api/chat/channels/${id}/members`).then(async (r) => {
			if (r.ok && activeId === id) members = (await r.json()).filter((m: { id: string; isActive: boolean }) => m.id !== me.id && m.isActive);
		});
	});

	type Presence = { id: string; label: string; state: string; online: boolean };
	let presence = $state(new Map<string, Presence>());
	const presenceIds = $derived([...new Set([...members.map((m) => m.id), ...channels.flatMap((c) => (c.kind === 'dm' ? c.others.map((o) => o.id) : []))])].slice(0, 300));
	async function loadPresence(ids: string[]) {
		if (!ids.length) return;
		const r = await fetch(`/api/chat/presence?ids=${ids.join(',')}`);
		if (!r.ok) return;
		const next = new Map(presence);
		for (const p of (await r.json()) as Presence[]) next.set(p.id, p);
		presence = next;
	}
	$effect(() => {
		const ids = presenceIds;
		void loadPresence(ids);
		const t = setInterval(() => loadPresence(ids), 60_000);
		return () => clearInterval(t);
	});
	const statusOf = (id: string) => presence.get(id) ?? null;

	/* ---------- composer rules ---------- */

	const other = $derived(active?.kind === 'dm' ? active.others[0] : null);
	const disabledReason = $derived.by(() => {
		if (!active) return 'Pick a conversation';
		if (active.kind === 'system') return 'This is your ESS feed: requests to approve, decisions and reminders. Nothing is posted here.';
		if (other && !other.isActive) return `${other.fullName} has left, so this conversation is read-only.`;
		return null;
	});
	const placeholder = $derived(active ? (active.kind === 'channel' ? `Message #${active.name}  ·  /task @name to give a task` : active.kind === 'desk' ? (active.deskOwnerId === me.id ? deskWords(active).placeholder : 'Reply to this question') : `Message ${channelLabel(active, me.id)}`) : 'Message');
	const canMentionAll = $derived(!!active && active.kind === 'channel' && (data.can.mentionAll || (me.role === 'team_lead' && (active.teamId === me.teamId || (active.source === 'team' && !!me.teamId)))));
	// Tasks come from conversations between people, not from feeds.
	const canMakeTasks = $derived(!!active && (active.kind === 'channel' || active.kind === 'dm' || active.kind === 'group' || active.kind === 'desk'));

	const subtitle = $derived.by(() => {
		if (!active) return '';
		if (other) return `${statusOf(other.id)?.label ?? ''}${statusOf(other.id)?.online ? ' · online' : ''}${active.pinnedAs ? ` · ${active.pinnedAs === 'manager' ? 'Your reporting manager' : 'Your concerned HR'}` : ''}`.replace(/^ · /, '');
		if (active.kind === 'desk') return `${active.deskOwnerId === me.id ? deskWords(active).privacy : `Question from ${channelLabel(active, me.id)}`} · ${active.deskStatus === 'resolved' ? 'Resolved' : 'Open'}`;
		if (active.kind === 'announcements') return 'Notices from HR: what needs you, what is coming up, updates';
		if (active.kind === 'system') return 'Requests waiting on you, decisions on yours, reminders';
		const n = members.length ? `${members.length + 1} members` : '';
		const t = active.topic || (active.source === 'team' ? 'Team channel' : active.source === 'shift' ? 'Shift channel' : '');
		return [n, t].filter(Boolean).join(' · ');
	});

	let list = $state<ReturnType<typeof MessageList> | null>(null);
	const nameOf = (cid: string) => {
		const c = channels.find((x) => x.id === cid);
		return c ? (c.kind === 'channel' ? '#' : '') + channelLabel(c, me.id) : 'Conversation';
	};

	async function refreshFeed() {
		await invalidateAll();
		await chat.refresh();
	}
</script>

<svelte:head>
	<title>{champOpen ? 'Champ' : active ? nameOf(active.id) : 'Chat'} · Champ Hub — Champ HR ESS Portal</title>
</svelte:head>

<div class="conv ess-card hub-fill" class:with-panel={!!panel}>
	<div class="side-col">
		<ChatSidebar
			{channels}
			{activeId}
			meId={me.id}
			isHr={data.can.hrDesk}
			desks={data.can.desks}
			{presence}
			{champWaiting}
			onselect={select}
			onnew={() => (newOpen = true)}
			onfind={(m) => (panel = m)}
			onsettings={() => (prefsOpen = true)}
		/>
	</div>

	<section class="main" aria-label="Conversation">
		{#if champOpen}
			<header class="head">
				<a class="back" href="/hub/chats" aria-label="All chats"><ArrowLeft size={16} /></a>
				<span class="ess-tile ess-tile--round head-ic"><Sparkles size={18} strokeWidth={1.75} /></span>
				<div class="title">
					<h2>Champ</h2>
					<small>Ask about leave, holidays, your tasks or your team</small>
				</div>
			</header>
			<div class="champ-view">
				<ChampPanel firstName={me.fullName.split(' ')[0]} initialQuestion={page.url.searchParams.get('ask') ?? ''} onwaiting={(n) => (champWaiting = n)} />
			</div>
		{:else if active}
			<header class="head">
				<a class="back" href="/hub/chats" aria-label="All chats"><ArrowLeft size={16} /></a>
				<span class="head-ic" class:ess-tile={!other} class:ess-tile--round={!other}>
					{#if active.kind === 'announcements'}<Megaphone size={18} strokeWidth={1.75} />
					{:else if active.kind === 'system'}<Bell size={18} strokeWidth={1.75} />
					{:else if active.kind === 'desk'}<Headset size={18} strokeWidth={1.75} />
					{:else if active.kind === 'group'}<Users size={18} strokeWidth={1.75} />
					{:else if other}<Avatar userId={other.id} fullName={other.fullName} size="md" />
					{:else}<Hash size={18} strokeWidth={1.75} />{/if}
				</span>
				<div class="title">
					<h2>{channelLabel(active, me.id)}</h2>
					<small>{subtitle}</small>
				</div>
				{#if active.kind === 'announcements' && data.can.postAnnouncements}
					<button type="button" class="ess-btn ess-btn--sm {manageAnnouncements ? 'ess-btn--secondary' : 'ess-btn--primary'}" onclick={() => (manageAnnouncements = !manageAnnouncements)}>
						<PenLine size={14} /> {manageAnnouncements ? 'Back to the feed' : 'Post & manage'}
					</button>
				{/if}
				<button type="button" class="ess-icon-btn" aria-label="Search messages" title="Search messages" aria-pressed={panel === 'search'} onclick={() => (panel = panel === 'search' ? null : 'search')}><Search size={18} /></button>
				{#if active.kind !== 'announcements'}
					<button type="button" class="ess-icon-btn" aria-label="Details" title="Details" aria-pressed={panel === 'info'} onclick={() => (panel = panel === 'info' ? null : 'info')}><Info size={18} /></button>
				{/if}
			</header>

			{#if active.kind === 'announcements'}
				<div class="ann">
					{#if manageAnnouncements && data.announcementAdmin}
						<AnnouncementAdmin data={data.announcementAdmin} {form} {draft} />
					{:else}
						<AnnouncementFeed feed={data.feed} now={data.now} onchanged={refreshFeed} />
					{/if}
				</div>
			{:else}
				{#key active.id}
					<MessageList
						bind:this={list}
						channelId={active.id}
						meId={me.id}
						meName={me.fullName}
						{statusOf}
						onreply={openThread}
						onmaketask={canMakeTasks ? (m) => (makeFrom = { messageId: m.id, text: m.body, mentionIds: m.mentions }) : undefined}
						emptyText={active.kind === 'system' ? 'Nothing here yet. Leave requests to approve and decisions on yours will appear here.' : active.kind === 'desk' ? deskWords(active).empty : 'No messages yet. Say hello.'}
					/>
					<Composer channelId={active.id} {members} {placeholder} {disabledReason} {canMentionAll} onsent={(m) => m && list?.upsert([m])} />
				{/key}
			{/if}
		{:else if channels.length}
			<div class="none">
				<p>That conversation isn't available to you. It may have been archived, or you may have left it.</p>
				<a class="ess-btn ess-btn--secondary" href="/hub/chats">All chats</a>
			</div>
		{:else}
			<div class="none"><p>Loading…</p></div>
		{/if}
	</section>

	{#if panel}
		<div class="panel-col">
			{#if panel === 'thread' && thread && active}
				{#key thread.id}
					<ThreadPanel root={thread} meId={me.id} meName={me.fullName} {members} canPost={!disabledReason} {statusOf} onclose={closePanel} />
				{/key}
			{:else if panel === 'info' && active}
				<InfoPanel
					channel={active}
					meId={me.id}
					meName={me.fullName}
					can={{ hrDesk: data.can.hrDesk, desks: data.can.desks, export: data.can.export, createChannels: data.can.createChannels }}
					{statusOf}
					onclose={closePanel}
					onleft={() => {
						closePanel();
						void chat.refresh().then(() => goto('/hub/chats'));
					}}
				/>
			{:else if panel === 'search' || panel === 'saved'}
				<FindPanel
					mode={panel}
					meId={me.id}
					meName={me.fullName}
					{nameOf}
					onopen={(m) => {
						if (m.channelId !== activeId) void goto(`/hub/c/${m.channelId}${m.threadRootId ? `?t=${m.threadRootId}` : ''}`);
						else if (m.threadRootId) void fetch(`/api/chat/messages?ids=${m.threadRootId}`).then(async (r) => { const [root] = r.ok ? await r.json() : []; if (root) openThread(root); });
					}}
					onclose={closePanel}
				/>
			{:else}
				<div class="none"><p>Nothing to show.</p></div>
			{/if}
		</div>
	{/if}
</div>

{#if newOpen}
	<NewChatDialog scope={data.can.createChannels as 'anywhere' | 'team' | 'none'} onclose={() => (newOpen = false)} onopen={async (id) => { newOpen = false; await chat.refresh(); await goto(`/hub/c/${id}`); }} />
{/if}
{#if prefsOpen}<ChatPrefs onclose={() => (prefsOpen = false)} />{/if}
{#if makeFrom}
	<NewTaskDialog meId={me.id} from={makeFrom} onclose={() => (makeFrom = null)} />
{/if}

<style>
	.conv {
		--h: calc(100dvh - 2 * var(--ess-page-pad-y) - 150px);
		height: var(--h);
		min-height: 520px;
		padding: 0;
		display: grid;
		grid-template-columns: 300px minmax(0, 1fr);
		overflow: hidden;
	}
	.conv.with-panel {
		grid-template-columns: 300px minmax(0, 1fr) 360px;
	}
	.side-col,
	.panel-col {
		min-height: 0;
		min-width: 0;
	}
	.panel-col {
		border-left: 1px solid var(--ess-border);
	}
	.main {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px 10px 18px;
		min-height: 60px;
		border-bottom: 1px solid var(--ess-border);
	}
	.back {
		display: none;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--ess-radius-sm);
		color: var(--ess-text-secondary);
		flex: none;
	}
	.back:hover {
		background: var(--ess-surface-hover);
	}
	.head-ic {
		flex: none;
		display: grid;
		place-items: center;
	}
	.title {
		flex: 1;
		min-width: 0;
		display: grid;
	}
	.title h2 {
		font-family: var(--ess-font-display);
		font-size: 20px;
		font-weight: 600;
		line-height: 1.15;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title small {
		font-size: 13px;
		color: var(--ess-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ess-icon-btn[aria-pressed='true'] {
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	.ann {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 14px 16px 16px;
		display: grid;
		gap: 14px;
		align-content: start;
	}
	.champ-view {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.none {
		margin: auto;
		display: grid;
		gap: 12px;
		justify-items: center;
		text-align: center;
		color: var(--ess-text-muted);
		padding: 24px;
	}
	/* Desktop: the hub layout stretches this card to the bottom of the
	   workspace, so the fixed height above gives way to the fill. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.conv {
				height: auto;
				min-height: 0;
			}
		}
	}
	@container ess-main (max-width: 1214px) {
		.conv,
		.conv.with-panel {
			grid-template-columns: 260px minmax(0, 1fr);
		}
		.conv.with-panel .panel-col {
			position: fixed;
			z-index: 60;
			top: 0;
			right: 0;
			bottom: 0;
			width: min(400px, 100vw);
			background: var(--ess-modal-bg);
			box-shadow: var(--ess-elev-4);
		}
	}
	@media (max-width: 900px) {
		.conv,
		.conv.with-panel {
			grid-template-columns: minmax(0, 1fr);
		}
		.side-col {
			display: none;
		}
		.back {
			display: grid;
		}
	}
	@media (max-width: 720px) {
		.conv {
			--h: calc(100dvh - 180px);
		}
		.head {
			padding-left: 12px;
			min-height: 60px;
		}
		.title h2 {
			font-size: 20px;
		}
	}
</style>
