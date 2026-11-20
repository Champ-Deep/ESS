<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Info from '@lucide/svelte/icons/info';
	import Hash from '@lucide/svelte/icons/hash';
	import Megaphone from '@lucide/svelte/icons/megaphone';
	import Headset from '@lucide/svelte/icons/headset';
	import Bell from '@lucide/svelte/icons/bell';
	import Users from '@lucide/svelte/icons/users';
	import PenLine from '@lucide/svelte/icons/pen-line';
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
	import { chat, channelLabel, type SidebarChannel, deskWords } from '$lib/chat/client.svelte';
	import type { ChatMessageView } from '$lib/server/chat/messages';

	let { data, form } = $props();

	const me = $derived(data.me);
	// The server's sidebar until the live one has loaded.
	const channels = $derived<SidebarChannel[]>(chat.channels.length ? chat.channels : (data.sidebar.channels as SidebarChannel[]));

	/* ---------- which conversation ---------- */

	function resolveId(want: string | null): string | null {
		if (!want) return null;
		if (want === 'announcements') return channels.find((c) => c.kind === 'announcements')?.id ?? null;
		if (want === 'ess') return channels.find((c) => c.kind === 'system')?.id ?? null;
		if (want === 'champ') return 'champ';
		return channels.some((c) => c.id === want) ? want : null;
	}

	const defaultId = $derived(channels.find((c) => c.kind === 'channel' && c.source === 'everyone')?.id ?? channels[0]?.id ?? null);
	let activeId = $state<string | null>(null);
	let mobileList = $state(!page.url.searchParams.get('c'));
	$effect(() => {
		// Follow the URL (a link from an ESS notice, a push, the jump list).
		const want = resolveId(page.url.searchParams.get('c'));
		activeId = want ?? activeId ?? defaultId;
	});
	const active = $derived(channels.find((c) => c.id === activeId) ?? null);
	const champOpen = $derived(activeId === 'champ');
	let champWaiting = $state(0);
	$effect(() => {
		chat.openChannelId = activeId;
		return () => (chat.openChannelId = null);
	});

	function select(id: string) {
		activeId = id;
		mobileList = false;
		thread = null;
		if (panel === 'thread' || id === 'champ') panel = null;
		const url = new URL(page.url);
		url.searchParams.set('c', id);
		url.searchParams.delete('t');
		url.searchParams.delete('compose');
		url.searchParams.delete('draft');
		replaceState(url, {});
		manageAnnouncements = false;
	}

	/* ---------- panels ---------- */

	type Panel = 'thread' | 'info' | 'search' | 'saved' | null;
	let panel = $state<Panel>(null);
	let thread = $state<ChatMessageView | null>(null);
	let newOpen = $state(false);
	let prefsOpen = $state(false);
	let manageAnnouncements = $state(page.url.searchParams.has('compose'));
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
		if (!id || active?.kind === 'announcements' || active?.kind === 'system') {
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
		const list: Presence[] = await r.json();
		const next = new Map(presence);
		for (const p of list) next.set(p.id, p);
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
		if (active.kind === 'system') return 'This is your ESS notices feed: requests to approve, decisions and reminders. Nothing is posted here.';
		if (other && !other.isActive) return `${other.fullName} has left, so this conversation is read-only.`;
		return null;
	});
	const placeholder = $derived(active ? (active.kind === 'channel' ? `Message #${active.name}` : active.kind === 'desk' ? (active.deskOwnerId === me.id ? deskWords(active).placeholder : 'Reply to this question') : `Message ${channelLabel(active, me.id)}`) : 'Message');
	const canMentionAll = $derived(!!active && active.kind === 'channel' && (data.can.mentionAll || (me.role === 'team_lead' && (active.teamId === me.teamId || (active.source === 'team' && !!me.teamId)))));

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
	<title>{champOpen ? 'Champ · ' : active ? `${active.kind === 'channel' ? '#' : ''}${channelLabel(active, me.id)} · ` : ''}Champ Chat — Champ HR ESS Portal</title>
</svelte:head>

<div class="chat" class:with-panel={!!panel} class:mobile-list={mobileList}>
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
			onfind={(m) => { panel = m; mobileList = false; }}
			onsettings={() => (prefsOpen = true)}
		/>
	</div>

	<section class="main" aria-label="Conversation">
		<!-- Kept mounted so its badge and conversation survive switching away. -->
		<div class="champ-view" class:hidden={!champOpen}>
			<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm back champ-back" onclick={() => (mobileList = true)} aria-label="Back to conversations"><ArrowLeft size={16} /></button>
			<ChampPanel firstName={me.fullName.split(' ')[0]} onwaiting={(n) => (champWaiting = n)} />
		</div>
		{#if champOpen}
			<!-- Champ is shown above. -->
		{:else if active}
			<header class="head">
				<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm back" onclick={() => (mobileList = true)} aria-label="Back to conversations"><ArrowLeft size={16} /></button>
				<span class="head-ic">
					{#if active.kind === 'announcements'}<Megaphone size={17} />
					{:else if active.kind === 'system'}<Bell size={17} />
					{:else if active.kind === 'desk'}<Headset size={17} />
					{:else if active.kind === 'group'}<Users size={17} />
					{:else if active.kind === 'channel'}<Hash size={17} />{/if}
				</span>
				<div class="title">
					<strong>{channelLabel(active, me.id)}</strong>
					<small>
						{#if other}
							{statusOf(other.id)?.label ?? ''}{statusOf(other.id)?.online ? ' · online' : ''}{active.pinnedAs ? ` · ${active.pinnedAs === 'manager' ? 'Your reporting manager' : 'Your concerned HR'}` : ''}
						{:else if active.kind === 'desk'}
							{active.deskOwnerId === me.id ? deskWords(active).privacy : `Question from ${channelLabel(active, me.id)}`} · {active.deskStatus === 'resolved' ? 'Resolved' : 'Open'}
						{:else if active.kind === 'announcements'}
							Notices from HR: what needs you, what is coming up, updates
						{:else if active.kind === 'system'}
							Requests waiting on you, decisions on yours, reminders
						{:else}
							{active.topic || (active.source === 'team' ? 'Team channel' : active.source === 'shift' ? 'Shift channel' : '')}
						{/if}
					</small>
				</div>
				{#if active.kind === 'announcements' && data.can.postAnnouncements}
					<button type="button" class="ess-btn ess-btn--sm {manageAnnouncements ? 'ess-btn--secondary' : 'ess-btn--primary'}" onclick={() => (manageAnnouncements = !manageAnnouncements)}>
						<PenLine size={14} /> {manageAnnouncements ? 'Back to the feed' : 'Post & manage'}
					</button>
				{/if}
				{#if active.kind !== 'announcements'}
					<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" aria-label="Details" aria-pressed={panel === 'info'} onclick={() => (panel = panel === 'info' ? null : 'info')}><Info size={16} /></button>
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
					<MessageList bind:this={list} channelId={active.id} meId={me.id} meName={me.fullName} {statusOf} onreply={openThread} emptyText={active.kind === 'system' ? 'Nothing here yet. Leave requests to approve and decisions on yours will appear here.' : active.kind === 'desk' ? deskWords(active).empty : 'No messages yet. Say hello.'} />
					<Composer channelId={active.id} {members} {placeholder} {disabledReason} {canMentionAll} onsent={(m) => m && list?.upsert([m])} />
				{/key}
			{/if}
		{:else}
			<p class="none">Pick a conversation on the left.</p>
		{/if}
	</section>

	{#if panel}
		<div class="panel-col">
			{#if panel === 'thread' && thread}
				{#key thread.id}
					<ThreadPanel root={thread} meId={me.id} meName={me.fullName} {members} canPost={!disabledReason} {statusOf} onclose={() => { panel = null; thread = null; }} />
				{/key}
			{:else if panel === 'info' && active}
				<InfoPanel channel={active} meId={me.id} meName={me.fullName} can={{ hrDesk: data.can.hrDesk, desks: data.can.desks, export: data.can.export, createChannels: data.can.createChannels }} {statusOf} onclose={() => (panel = null)} onleft={() => { panel = null; void chat.refresh().then(() => defaultId && select(defaultId)); }} />
			{:else if panel === 'search' || panel === 'saved'}
				<FindPanel mode={panel} meId={me.id} meName={me.fullName} {nameOf} onopen={(m) => { select(m.channelId); if (m.threadRootId) void fetch(`/api/chat/messages?ids=${m.threadRootId}`).then(async (r) => { const [root] = r.ok ? await r.json() : []; if (root) openThread(root); }); }} onclose={() => (panel = null)} />
			{/if}
		</div>
	{/if}
</div>

{#if newOpen}
	<NewChatDialog scope={data.can.createChannels as 'anywhere' | 'team' | 'none'} onclose={() => (newOpen = false)} onopen={async (id) => { newOpen = false; await chat.refresh(); select(id); }} />
{/if}
{#if prefsOpen}<ChatPrefs onclose={() => (prefsOpen = false)} />{/if}

<style>
	.chat {
		--h: calc(100dvh - 56px - var(--ess-page-pad-y) - var(--ess-space-10));
		height: var(--h);
		min-height: min(480px, var(--h));
		display: grid;
		grid-template-columns: 280px minmax(0, 1fr);
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-lg);
		overflow: hidden;
		background: var(--ess-surface);
		box-shadow: var(--ess-elev-1);
	}
	.chat.with-panel {
		grid-template-columns: 280px minmax(0, 1fr) 360px;
	}
	.side-col,
	.panel-col {
		min-height: 0;
	}
	.main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px 8px 16px;
		min-height: 56px;
		border-bottom: 1px solid var(--ess-border);
	}
	.back {
		display: none;
	}
	.head-ic {
		color: var(--ess-text-muted);
		display: inline-flex;
	}
	.title {
		flex: 1;
		min-width: 0;
		display: grid;
	}
	.title strong {
		font-family: var(--ess-font-display);
		font-size: 20px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.title small {
		font-size: 12px;
		color: var(--ess-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ann {
		flex: 1;
		overflow-y: auto;
		padding: 18px 20px 40px;
		display: grid;
		gap: 18px;
		align-content: start;
	}
	.champ-view {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.champ-view.hidden {
		display: none;
	}
	.champ-back {
		position: absolute;
		top: 12px;
		right: 90px;
		z-index: 2;
	}
	.none {
		margin: auto;
		color: var(--ess-text-muted);
	}
	@container ess-main (max-width: 1154px) {
		.chat.with-panel {
			grid-template-columns: 260px minmax(0, 1fr);
		}
		.chat.with-panel .panel-col {
			position: fixed;
			z-index: 60;
			top: 0;
			right: 0;
			bottom: 0;
			width: min(380px, 100vw);
			box-shadow: var(--ess-elev-4);
		}
	}
	@media (max-width: 720px) {
		.chat {
			--h: calc(100dvh - 56px - 20px - 32px);
			grid-template-columns: minmax(0, 1fr);
			border-radius: var(--ess-radius-md);
		}
		.chat.with-panel {
			grid-template-columns: minmax(0, 1fr);
		}
		.side-col {
			display: none;
		}
		.chat.mobile-list .side-col {
			display: block;
		}
		.chat.mobile-list .main {
			display: none;
		}
		.back {
			display: inline-flex;
		}
	}
</style>
