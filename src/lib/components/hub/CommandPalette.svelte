<script lang="ts">
	import { goto } from '$app/navigation';
	import Search from '@lucide/svelte/icons/search';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Hash from '@lucide/svelte/icons/hash';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import SquareKanban from '@lucide/svelte/icons/square-kanban';
	import Video from '@lucide/svelte/icons/video';
	import Plus from '@lucide/svelte/icons/plus';
	import UserIcon from '@lucide/svelte/icons/user';
	import Compass from '@lucide/svelte/icons/compass';
	import { tour } from '$lib/tour/tour.svelte';
	import { chat, channelLabel } from '$lib/chat/client.svelte';
	import { api, hub } from '$lib/hub/client.svelte';
	import { lockPageScroll } from '$lib/scroll-lock';
	import type { MeetingRowView, TaskView } from '$lib/tasks/types';

	/**
	 * Ctrl K: go anywhere in Champ Hub, open any conversation, task, meeting or
	 * person, start a task, or ask Champ. Replaces the old chat sidebar's search
	 * box and most navigation.
	 */
	let { meId, isLead, onclose }: { meId: string; isLead: boolean; onclose: () => void } = $props();

	type Item = { key: string; icon: typeof Search; label: string; hint: string; run: () => void | Promise<void> };

	let q = $state('');
	let index = $state(0);
	let remote = $state<{ tasks: TaskView[]; meetings: MeetingRowView[]; people: { id: string; fullName: string }[] }>({ tasks: [], meetings: [], people: [] });
	let inputEl = $state<HTMLInputElement | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const unlock = lockPageScroll();
		queueMicrotask(() => inputEl?.focus());
		return unlock;
	});

	$effect(() => {
		const text = q.trim();
		if (timer) clearTimeout(timer);
		if (text.length < 2) {
			remote = { tasks: [], meetings: [], people: [] };
			return;
		}
		timer = setTimeout(async () => {
			const r = await fetch(`/api/hub/search?q=${encodeURIComponent(text)}`);
			if (r.ok && q.trim() === text) remote = await r.json();
		}, 180);
	});

	function go(href: string) {
		onclose();
		void goto(href);
	}

	async function messagePerson(id: string, name: string) {
		const r = await api<{ id: string }>('/api/chat/dm', 'POST', { userId: id });
		if (!r.ok) return hub.say(r.message, { tone: 'bad' });
		await chat.refresh();
		go(`/hub/c/${r.id}`);
		void name;
	}

	const items = $derived.by(() => {
		const text = q.trim().toLowerCase();
		const has = (s: string) => !text || s.toLowerCase().includes(text);
		const out: Item[] = [];
		const nav: [string, string][] = [
			['Today', '/hub'],
			['Chats', '/hub/chats'],
			['Tasks', '/hub/tasks'],
			['Meetings', '/hub/meetings'],
			...(isLead ? ([['Team', '/hub/team']] as [string, string][]) : [])
		];
		for (const [label, href] of nav) if (has(label)) out.push({ key: 'nav' + href, icon: ArrowRight, label: `Go to ${label}`, hint: 'Go to', run: () => go(href) });
		if (has('new task')) out.push({ key: 'new', icon: Plus, label: 'New task', hint: 'Action', run: () => { onclose(); hub.newTaskOpen = true; } });
		if (has('champ')) out.push({ key: 'champ', icon: Sparkles, label: 'Open Champ', hint: 'Assistant', run: () => go('/hub/c/champ') });
		if (has('take the tour')) out.push({ key: 'tour', icon: Compass, label: 'Take the tour', hint: 'Help', run: () => { onclose(); tour.start(0); } });
		const convs = chat.channels.filter((c) => has(channelLabel(c, meId))).slice(0, text ? 6 : 4);
		for (const c of convs) out.push({ key: 'c' + c.id, icon: c.kind === 'dm' ? MessageSquare : Hash, label: (c.kind === 'channel' ? '#' : '') + channelLabel(c, meId), hint: 'Chat', run: () => go(`/hub/c/${c.id}`) });
		for (const t of remote.tasks) out.push({ key: 't' + t.id, icon: SquareKanban, label: t.title, hint: `Task · ${t.assignee?.fullName ?? 'Unassigned'}`, run: () => { onclose(); hub.openTask(t.id); } });
		for (const m of remote.meetings) out.push({ key: 'm' + m.id, icon: Video, label: m.topic, hint: 'Meeting', run: () => go(m.isHost ? `/hub/meetings/${m.id}` : '/hub/meetings') });
		for (const p of remote.people) if (p.id !== meId) out.push({ key: 'p' + p.id, icon: UserIcon, label: `Message ${p.fullName}`, hint: 'Person', run: () => messagePerson(p.id, p.fullName) });
		if (text.length >= 2) {
			out.push({ key: 'msgs', icon: Search, label: `Search messages for "${q.trim()}"`, hint: 'Chat', run: () => go(`/hub/chats?search=${encodeURIComponent(q.trim())}`) });
			out.push({ key: 'ask', icon: Sparkles, label: `Ask Champ: "${q.trim()}"`, hint: 'Champ', run: () => go(`/hub/c/champ?ask=${encodeURIComponent(q.trim())}`) });
		}
		return out;
	});

	$effect(() => {
		void items.length;
		if (index >= items.length) index = 0;
	});

	function key(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			index = items.length ? (index + 1) % items.length : 0;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			index = items.length ? (index - 1 + items.length) % items.length : 0;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			void items[index]?.run();
		}
	}
</script>

<div class="ess-scrim scrim" role="presentation" onclick={onclose}></div>
<div class="pal" role="dialog" aria-modal="true" aria-label="Search and go">
	<div class="in">
		<Search size={17} />
		<input
			bind:this={inputEl}
			bind:value={q}
			onkeydown={key}
			placeholder="Search chats, tasks, meetings, people, or ask Champ"
			aria-label="Search"
			role="combobox"
			aria-expanded="true"
			aria-controls="pal-list"
			aria-activedescendant={items[index] ? `pal-${items[index].key}` : undefined}
			autocomplete="off"
		/>
	</div>
	<ul id="pal-list" role="listbox">
		{#each items as it, i (it.key)}
			<li id="pal-{it.key}" role="option" aria-selected={i === index}>
				<button type="button" class:on={i === index} onmouseenter={() => (index = i)} onclick={() => it.run()}>
					<it.icon size={15} />
					<span class="label">{it.label}</span>
					<span class="hint">{it.hint}</span>
				</button>
			</li>
		{:else}
			<li class="none">Nothing matches. Try fewer letters.</li>
		{/each}
	</ul>
	<p class="foot"><kbd class="ess-kbd">↑</kbd> <kbd class="ess-kbd">↓</kbd> to move <span class="ess-dot-sep"></span> <kbd class="ess-kbd">Enter</kbd> to open <span class="ess-dot-sep"></span> <kbd class="ess-kbd">Esc</kbd> to close</p>
</div>

<style>
	.scrim {
		z-index: 90;
	}
	.pal {
		position: fixed;
		z-index: 91;
		top: 12vh;
		left: 50%;
		transform: translateX(-50%);
		width: min(620px, calc(100vw - 32px));
		background: var(--ess-modal-bg);
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-lg);
		box-shadow: var(--ess-elev-4);
		overflow: hidden;
	}
	.in {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 16px;
		border-bottom: 1px solid var(--ess-border);
		color: var(--ess-text-muted);
	}
	.in input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		padding: 15px 0;
		font-size: 15px;
		color: var(--ess-text);
		outline: none;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 6px;
		max-height: min(52vh, 440px);
		overflow-y: auto;
	}
	li button {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		border: 0;
		background: transparent;
		color: var(--ess-text);
		padding: 10px 12px;
		border-radius: var(--ess-radius-sm);
		cursor: pointer;
		text-align: left;
		font: inherit;
		font-size: 13.5px;
	}
	li button :global(svg) {
		color: var(--ess-text-muted);
		flex: none;
	}
	li button.on {
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	li button.on :global(svg) {
		color: var(--ess-primary);
	}
	li + li button {
		border-top: 1px solid var(--ess-border-subtle);
		border-radius: 0;
	}
	li:last-child button {
		border-bottom-left-radius: var(--ess-radius-sm);
		border-bottom-right-radius: var(--ess-radius-sm);
	}
	li:first-child button {
		border-top-left-radius: var(--ess-radius-sm);
		border-top-right-radius: var(--ess-radius-sm);
	}
	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hint {
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
	.none {
		padding: 16px;
		text-align: center;
		color: var(--ess-text-muted);
		font-size: 13px;
	}
	.foot {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 9px 14px;
		border-top: 1px solid var(--ess-border);
		background: var(--ess-sunken);
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
</style>
