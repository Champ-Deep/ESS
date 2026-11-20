<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import Avatar from '$lib/components/Avatar.svelte';
	import MessageItem from './MessageItem.svelte';
	import { chat, type SidebarChannel } from '$lib/chat/client.svelte';
	import type { ChatMessageView } from '$lib/server/chat/messages';

	/** About a conversation: members, pinned messages, to-dos, and settings. */
	let {
		channel,
		meId,
		meName,
		can,
		statusOf,
		onclose,
		onleft
	}: {
		channel: SidebarChannel;
		meId: string;
		meName: string;
		/** desks: the desks this person answers ('hr' | 'engagement' | 'it'). */
		can: { hrDesk: boolean; desks?: string[]; export: boolean; createChannels: string };
		statusOf: (id: string) => { label: string; state: string; online: boolean } | null;
		onclose: () => void;
		onleft: () => void;
	} = $props();

	type Member = { id: string; fullName: string; role: string; isActive: boolean; memberRole: string };
	let tab = $state<'members' | 'pinned' | 'todos' | 'settings'>('members');
	let members = $state<Member[]>([]);
	let pinned = $state<ChatMessageView[]>([]);
	let todos = $state<{ id: string; text: string; doneAt: string | null; doneBy: string | null }[]>([]);
	let todoText = $state('');
	let err = $state('');
	let adding = $state(false);
	let candidates = $state<{ id: string; fullName: string }[]>([]);
	let addPick = $state('');
	let exportReason = $state('');

	const manual = $derived(channel.source === 'manual' && (channel.kind === 'channel' || channel.kind === 'group'));

	async function get<T>(path: string): Promise<T | null> {
		const r = await fetch(`/api/chat/channels/${channel.id}/${path}`);
		return r.ok ? r.json() : null;
	}
	async function post(path: string, body: unknown) {
		err = '';
		const r = await fetch(`/api/chat/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		if (!r.ok) err = (await r.json().catch(() => ({}))).message ?? 'That did not work';
		return r.ok;
	}

	async function load() {
		if (tab === 'members') members = (await get<Member[]>('members')) ?? [];
		if (tab === 'pinned') pinned = (await get<ChatMessageView[]>('pinned')) ?? [];
		if (tab === 'todos') todos = (await get<typeof todos>('todos')) ?? [];
	}

	$effect(() => {
		void channel.id;
		void tab;
		void load();
	});
	$effect(() =>
		chat.on((e) => {
			if (e.channelId !== channel.id) return;
			if (e.type === 'todos.changed' && tab === 'todos') void load();
			if (e.type === 'message.updated' && tab === 'pinned') void load();
			if (e.type === 'channels.changed' && tab === 'members') void load();
		})
	);

	async function startAdding() {
		adding = true;
		const r = await fetch('/api/chat/people');
		candidates = r.ok ? await r.json() : [];
	}
</script>

<aside class="panel" aria-label="About this conversation">
	<header>
		<strong>Details</strong>
		<button type="button" class="ess-icon-btn" onclick={onclose} aria-label="Close details"><X size={18} /></button>
	</header>
	{#if channel.topic}<p class="topic">{channel.topic}</p>{/if}
	<div class="tabs" role="tablist">
		{#each [['members', 'Members'], ['pinned', 'Pinned'], ['todos', 'To-dos'], ['settings', 'Settings']] as [k, l] (k)}
			<button type="button" role="tab" aria-selected={tab === k} onclick={() => (tab = k as typeof tab)}>{l}</button>
		{/each}
	</div>
	<div class="body">
		{#if err}<p class="err">{err}</p>{/if}
		{#if tab === 'members'}
			{#if channel.source !== 'manual' && channel.kind === 'channel'}
				<p class="note">Members follow the roster: people join and leave this channel as HR moves them between {channel.source === 'team' ? 'teams' : channel.source === 'shift' ? 'shift groups' : 'the company'}.</p>
			{/if}
			{#if manual}
				{#if adding}
					<div class="add">
						<select class="ess-select" bind:value={addPick} aria-label="Add a person">
							<option value="">Add someone…</option>
							{#each candidates.filter((c) => !members.some((m) => m.id === c.id)) as c (c.id)}
								<option value={c.id}>{c.fullName}</option>
							{/each}
						</select>
						<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" disabled={!addPick} onclick={async () => { if (await post(`channels/${channel.id}/members`, { add: [addPick] })) { addPick = ''; void load(); } }}>Add</button>
					</div>
				{:else}
					<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={startAdding}><UserPlus size={14} /> Add people</button>
				{/if}
			{/if}
			<ul class="members">
				{#each members as m (m.id)}
					{@const st = statusOf(m.id)}
					<li>
						<Avatar userId={m.id} fullName={m.fullName} size="sm" />
						<span class="who">
							<strong>{m.fullName}{m.id === meId ? ' (you)' : ''}</strong>
							<small>{!m.isActive ? 'Left the company' : (st?.label ?? '')}{st?.online ? ' · online' : ''}</small>
						</span>
						{#if m.memberRole === 'admin'}<span class="badge">Admin</span>{/if}
						{#if manual && channel.isAdmin && m.id !== meId}
							<button type="button" class="x" aria-label="Remove {m.fullName}" onclick={async () => { if (await post(`channels/${channel.id}/members`, { remove: m.id })) void load(); }}><X size={13} /></button>
						{/if}
					</li>
				{/each}
			</ul>
		{:else if tab === 'pinned'}
			{#each pinned as m (m.id)}
				<MessageItem message={m} {meId} {meName} inThread onchanged={() => load()} />
			{:else}
				<p class="note">Nothing pinned yet. Hover a message and press the pin.</p>
			{/each}
		{:else if tab === 'todos'}
			<form class="add" onsubmit={async (e) => { e.preventDefault(); if (todoText.trim() && (await post(`channels/${channel.id}/todos`, { text: todoText }))) { todoText = ''; void load(); } }}>
				<input class="ess-input" bind:value={todoText} placeholder="Add a to-do for everyone here" aria-label="New to-do" maxlength="300" />
				<button type="submit" class="ess-btn ess-btn--primary ess-btn--sm" disabled={!todoText.trim()}>Add</button>
			</form>
			<ul class="todos">
				{#each todos as t (t.id)}
					<li class:done={!!t.doneAt}>
						<label>
							<input type="checkbox" checked={!!t.doneAt} onchange={async () => { await post(`todos/${t.id}`, {}); void load(); }} />
							<span>{t.text}</span>
						</label>
						{#if t.doneAt}<small>Done by {t.doneBy}</small>{/if}
					</li>
				{:else}
					<p class="note">No to-dos. Add one here or type /todo in the conversation.</p>
				{/each}
			</ul>
		{:else}
			<div class="settings">
				<label class="field">
					<span class="ess-label">Notify me about</span>
					<select class="ess-select" value={channel.notify} onchange={(e) => post(`channels/${channel.id}/mute`, { muted: channel.muted, notify: (e.currentTarget as HTMLSelectElement).value })}>
						<option value="all">Every message</option>
						<option value="mentions">Only when I'm mentioned</option>
						<option value="none">Nothing</option>
					</select>
				</label>
				<label class="check">
					<input type="checkbox" checked={channel.muted} onchange={(e) => post(`channels/${channel.id}/mute`, { muted: (e.currentTarget as HTMLInputElement).checked })} />
					Mute this conversation (no badge, no alerts)
				</label>
				{#if channel.kind === 'desk' && channel.deskOwnerId !== meId && (can.desks ?? (can.hrDesk ? ['hr'] : [])).includes(channel.deskTeam ?? 'hr')}
					<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={() => post(`channels/${channel.id}/desk`, { status: channel.deskStatus === 'resolved' ? 'open' : 'resolved' })}>
						{channel.deskStatus === 'resolved' ? 'Reopen this question' : 'Mark resolved'}
					</button>
				{/if}
				{#if manual}
					<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={async () => { if (await post(`channels/${channel.id}/leave`, {})) onleft(); }}>Leave this {channel.kind === 'group' ? 'group' : 'channel'}</button>
				{/if}
				{#if can.export && channel.kind !== 'announcements' && channel.kind !== 'system'}
					<div class="export">
						<span class="ess-label">Export for a formal complaint</span>
						<p class="note">Super Admin only. Every member is told, and the reason is kept in the activity log.</p>
						<input class="ess-input" bind:value={exportReason} placeholder="Reason, e.g. complaint reference" aria-label="Reason for export" />
						<a
							class="ess-btn ess-btn--danger ess-btn--sm"
							class:disabled={exportReason.trim().length < 10}
							href={exportReason.trim().length >= 10 ? `/api/chat/channels/${channel.id}/export?reason=${encodeURIComponent(exportReason.trim())}` : undefined}
							aria-disabled={exportReason.trim().length < 10}
							download
						>
							Export conversation (CSV)
						</a>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</aside>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		background: var(--ess-surface);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 12px 14px 18px;
		border-bottom: 1px solid var(--ess-border);
		min-height: 64px;
	}
	header strong {
		font-family: var(--ess-font-display);
		font-size: 21px;
		font-weight: 600;
	}
	.topic {
		margin: 12px 18px 0;
		font-size: 13.5px;
		color: var(--ess-text-secondary);
	}
	.tabs {
		display: flex;
		gap: 2px;
		padding: 8px 12px 0;
		border-bottom: 1px solid var(--ess-border);
	}
	.tabs button {
		border: 0;
		background: none;
		padding: 8px 10px;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		color: var(--ess-text-secondary);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
	}
	.tabs button:hover {
		color: var(--ess-text);
	}
	.tabs button[aria-selected='true'] {
		color: var(--ess-primary-text);
		border-bottom-color: var(--ess-primary);
	}
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 14px 18px;
		display: grid;
		gap: 10px;
		align-content: start;
	}
	.note {
		margin: 0;
		font-size: 13px;
		color: var(--ess-text-muted);
	}
	.err {
		margin: 0;
		font-size: 13px;
		color: var(--ess-danger);
	}
	.members,
	.todos {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.members li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 0;
	}
	.who {
		flex: 1;
		min-width: 0;
		display: grid;
	}
	.who strong {
		font-size: 13.5px;
		font-weight: 500;
	}
	.who small {
		font-size: 12px;
		color: var(--ess-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.badge {
		font-size: 11px;
		font-weight: 500;
		padding: 1px 7px;
		border-radius: var(--ess-radius-xs);
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	.x {
		border: 0;
		background: none;
		cursor: pointer;
		color: var(--ess-text-muted);
		display: inline-flex;
	}
	.x:hover {
		color: var(--ess-danger);
	}
	.add {
		display: flex;
		gap: 6px;
	}
	.add .ess-input,
	.add .ess-select {
		flex: 1;
		min-width: 0;
	}
	.todos li {
		display: grid;
		gap: 2px;
		padding: 8px 10px;
		border-radius: var(--ess-radius-sm);
		background: var(--ess-surface);
		border: 1px solid var(--ess-border);
	}
	.todos label {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 13.5px;
		cursor: pointer;
	}
	.todos input {
		margin-top: 3px;
		accent-color: var(--ess-primary);
	}
	.todos li.done span {
		text-decoration: line-through;
		color: var(--ess-text-muted);
	}
	.todos small {
		font-size: 11.5px;
		color: var(--ess-text-muted);
		padding-left: 22px;
	}
	.settings {
		display: grid;
		gap: 12px;
		justify-items: start;
	}
	.field {
		display: grid;
		gap: 5px;
		width: 100%;
	}
	.check {
		display: flex;
		gap: 8px;
		align-items: center;
		font-size: 13.5px;
	}
	.check input {
		accent-color: var(--ess-primary);
	}
	.export {
		display: grid;
		gap: 6px;
		width: 100%;
		padding-top: 12px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.disabled {
		opacity: 0.5;
		pointer-events: none;
	}
</style>
