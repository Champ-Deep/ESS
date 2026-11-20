<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import Video from '@lucide/svelte/icons/video';
	import Hash from '@lucide/svelte/icons/hash';
	import Send from '@lucide/svelte/icons/send';
	import SendHorizontal from '@lucide/svelte/icons/send-horizontal';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Plus from '@lucide/svelte/icons/plus';
	import User from '@lucide/svelte/icons/user';
	import Calendar from '@lucide/svelte/icons/calendar';
	import Flag from '@lucide/svelte/icons/flag';
	import Ban from '@lucide/svelte/icons/ban';
	import Avatar from '$lib/components/Avatar.svelte';
	import AssigneeSelect from './AssigneeSelect.svelte';
	import { chat } from '$lib/chat/client.svelte';
	import { api, hub } from '$lib/hub/client.svelte';
	import { moveTask, respond } from '$lib/hub/actions';
	import ApprovalButtons from './ApprovalButtons.svelte';
	import { ago, longDay } from '$lib/hub/format';
	import { lockPageScroll } from '$lib/scroll-lock';
	import { PRIORITY_LABEL, STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES, type TaskStatus } from '$lib/tasks/rules';
	import type { TaskDetail } from '$lib/tasks/types';

	/**
	 * Everything about one task, in a sheet over whatever Hub page is open.
	 * Opened by hub.openTask (shallow routing) or a ?task= link, so Back closes
	 * it and a link from a notification lands straight on it.
	 */
	let { taskId, meId, onclose }: { taskId: string; meId: string; onclose: () => void } = $props();

	let task = $state<TaskDetail | null>(null);
	let error = $state('');
	let title = $state('');
	let description = $state('');
	let newSub = $state('');
	let comment = $state('');
	let declining = $state(false);
	let declineNote = $state('');
	let confirmDelete = $state(false);
	let busy = $state(false);
	let closeBtn = $state<HTMLButtonElement | null>(null);

	async function load() {
		const r = await fetch(`/api/tasks/${taskId}`);
		const data = await r.json().catch(() => ({}));
		if (!r.ok) {
			error = data.message ?? 'That task is not available to you';
			task = null;
			return;
		}
		error = '';
		task = data.task;
		title = data.task.title;
		description = data.task.description;
	}

	$effect(() => {
		void taskId;
		void load();
	});

	$effect(() => {
		const unlock = lockPageScroll();
		const returnTo = document.activeElement as HTMLElement | null;
		queueMicrotask(() => closeBtn?.focus());
		const off = chat.on((e) => {
			if (e.type === 'tasks.changed' && e.taskId === taskId) void load();
		});
		return () => {
			unlock();
			off();
			returnTo?.focus?.();
		};
	});

	const can = $derived(task?.can.edit ?? false);
	const subsDone = $derived(task?.subtaskList.filter((s) => s.done).length ?? 0);
	const subsTotal = $derived(task?.subtaskList.length ?? 0);
	const pct = $derived(subsTotal ? Math.round((subsDone / subsTotal) * 100) : 0);

	async function patch(body: Record<string, unknown>) {
		if (!task) return;
		const r = await api<{ task: TaskDetail }>(`/api/tasks/${task.id}`, 'PATCH', { ...body, version: task.version });
		if (!r.ok) hub.say(r.message, { tone: 'bad' });
		await load();
		hub.changed();
	}

	async function move(to: { status?: TaskStatus; assigneeId?: string | null }) {
		if (!task) return;
		busy = true;
		await moveTask(task, to);
		busy = false;
		await load();
	}

	async function addSub() {
		const t = newSub.trim();
		if (!t || !task) return;
		newSub = '';
		const r = await api(`/api/tasks/${task.id}/subtasks`, 'POST', { title: t });
		if (!r.ok) hub.say(r.message, { tone: 'bad' });
		await load();
		hub.changed();
	}

	async function toggleSub(id: string) {
		if (!task) return;
		const r = await api(`/api/tasks/${task.id}/subtasks/${id}/toggle`, 'POST', {});
		if (!r.ok) hub.say(r.message, { tone: 'bad' });
		await load();
		hub.changed();
	}

	async function removeSub(id: string) {
		if (!task) return;
		await api(`/api/tasks/${task.id}/subtasks/${id}`, 'DELETE');
		await load();
	}

	async function postComment() {
		const b = comment.trim();
		if (!b || !task) return;
		comment = '';
		const r = await api(`/api/tasks/${task.id}/comments`, 'POST', { body: b });
		if (!r.ok) hub.say(r.message, { tone: 'bad' });
		await load();
	}

	async function decline() {
		if (!task || !declineNote.trim()) return;
		if (await respond(task, 'decline', declineNote)) onclose();
	}

	async function remove() {
		if (!task) return;
		const r = await api(`/api/tasks/${task.id}`, 'DELETE');
		if (!r.ok) return hub.say(r.message, { tone: 'bad' });
		hub.say('Task deleted.');
		hub.changed(0);
		onclose();
	}

	/** Events grouped by day, newest first, for the activity timeline. */
	const days = $derived.by(() => {
		if (!task) return [];
		const out: { day: string; label: string; events: TaskDetail['events'] }[] = [];
		for (const ev of task.events) {
			const day = ev.createdAt.slice(0, 10);
			const last = out[out.length - 1];
			if (last && last.day === day) last.events.push(ev);
			else out.push({ day, label: longDay(ev.createdAt), events: [ev] });
		}
		return out;
	});
	const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="ess-scrim scrim" role="presentation" onclick={onclose}></div>
<div class="ess-drawer sheet" role="dialog" aria-modal="true" aria-labelledby="task-sheet-title">
	<header class="head">
		<span id="task-sheet-title" class="ess-sr-only">Task</span>
		<div class="head-row">
			{#if task}
				<input
					class="title"
					aria-label="Task title"
					bind:value={title}
					disabled={!can}
					onblur={() => title.trim() && title !== task!.title && patch({ title })}
					onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
				/>
			{:else}
				<span class="title-ph">Task</span>
			{/if}
			{#if task?.can.delete}
				<button type="button" class="ess-icon-btn" aria-label="Delete task" title="Delete" onclick={() => (confirmDelete = !confirmDelete)}><Trash2 size={16} /></button>
			{/if}
			<button type="button" class="ess-icon-btn" bind:this={closeBtn} onclick={onclose} aria-label="Close task"><X size={18} /></button>
		</div>
		{#if task}
			<div class="status-row">
				<label class="ess-sr-only" for="ts-status">Status</label>
				<span class="status-pill" data-status={task.status}>
					<span class="sdot" aria-hidden="true"></span>
					<select id="ts-status" disabled={!can || busy} value={task.status} onchange={(e) => move({ status: e.currentTarget.value as TaskStatus })}>
						{#each TASK_STATUSES as s (s)}<option value={s}>{STATUS_LABEL[s]}</option>{/each}
					</select>
				</span>
				{#if task.blocked}<span class="ess-badge ess-badge--bad"><Ban size={12} /> Blocked</span>{/if}
			</div>
		{/if}
	</header>

	<div class="body">
		{#if error}
			<p class="ess-alert ess-alert--warning">{error}</p>
		{:else if !task}
			<div class="ess-skeleton" style="height:22px;width:70%"></div>
			<div class="ess-skeleton" style="width:40%"></div>
		{:else}
			{#if confirmDelete}
				<div class="ess-notice ess-notice--danger">
					<div class="ess-notice__body"><strong>Delete this task for everyone?</strong>This cannot be undone.</div>
					<button type="button" class="ess-btn ess-btn--danger ess-btn--sm" onclick={remove}>Delete</button>
					<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (confirmDelete = false)}>Keep</button>
				</div>
			{/if}

			{#if task.can.approve}
				<div class="ess-notice ess-notice--info banner">
					<span class="ess-notice__icon"><Send size={14} /></span>
					<div class="ess-notice__body grow">
						<strong>Waiting for your approval</strong>
						{task.assignee?.id === task.createdBy.id ? `${task.createdBy.fullName} made this task for themselves.` : `${task.createdBy.fullName} made this task for ${task.assignee?.fullName ?? 'nobody yet'}.`}
						It starts once you approve.
						<div class="banner-acts"><ApprovalButtons {task} ondone={() => void load()} /></div>
					</div>
				</div>
			{:else if task.requestState === 'pending'}
				<p class="ess-alert ess-alert--info">Waiting for {task.approver?.fullName ?? 'the lead'} to approve. It can be started once they do.</p>
			{:else if task.requestState === 'declined'}
				<p class="ess-alert ess-alert--warning">Not approved or handed back{task.requestNote ? `: "${task.requestNote}"` : ''}. Change it and give it to someone, or delete it.</p>
			{/if}
			{#if task.assignee?.id === meId && task.createdBy.id !== meId && !task.requestState}
				{#if declining}
					<div class="ess-field">
						<label class="ess-label" for="ts-decline">Why can't you take it?</label>
						<input id="ts-decline" class="ess-input" bind:value={declineNote} placeholder="For example: on leave until the 14th" />
						<div class="row">
							<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" disabled={!declineNote.trim()} onclick={decline}>Hand it back</button>
							<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (declining = false)}>Cancel</button>
						</div>
					</div>
				{:else}
					<button type="button" class="ess-link handback" onclick={() => (declining = true)}>Can't take this? Hand it back</button>
				{/if}
			{/if}
			{#if !can}<p class="ess-help">You can see this because it is on your team. Only its owner, the person who made it and their leads can change it.</p>{/if}

			<div class="ess-field">
				<label class="ess-sr-only" for="ts-desc">Description</label>
				<textarea id="ts-desc" class="desc" rows="3" disabled={!can} bind:value={description} placeholder={can ? 'Add a description: context, links, what done looks like' : 'No description'} onblur={() => description !== task!.description && patch({ description })}></textarea>
			</div>

			<div class="facts">
				<div class="fact">
					<label class="fact-l" for="ts-assignee"><User size={14} /> Assignee</label>
					<div class="fact-v">
						{#if task.assignee}<Avatar userId={task.assignee.id} fullName={task.assignee.fullName} size="sm" />{/if}
						<AssigneeSelect id="ts-assignee" groups={task.assignable} value={task.assignee?.id ?? null} {meId} disabled={!can || busy} onchange={(v) => move({ assigneeId: v })} />
					</div>
				</div>
				<div class="fact">
					<label class="fact-l" for="ts-due"><Calendar size={14} /> Due date</label>
					<div class="fact-v"><input id="ts-due" type="date" class="ess-input" disabled={!can} value={task.dueDate ?? ''} onchange={(e) => patch({ dueDate: e.currentTarget.value || null })} /></div>
				</div>
				<div class="fact">
					<label class="fact-l" for="ts-priority"><Flag size={14} /> Priority</label>
					<div class="fact-v">
						<select id="ts-priority" class="ess-select pri-{task.priority}" disabled={!can} value={task.priority} onchange={(e) => patch({ priority: e.currentTarget.value })}>
							{#each TASK_PRIORITIES as p (p)}<option value={p}>{PRIORITY_LABEL[p]}</option>{/each}
						</select>
					</div>
				</div>
			</div>
			<label class="check"><input type="checkbox" disabled={!can} checked={task.blocked} onchange={(e) => patch({ blocked: e.currentTarget.checked })} /> Blocked: waiting on something</label>

			{#if task.source?.kind === 'meeting'}
				<div class="src">
					<div class="src-top">
						<span class="src-name"><Video size={14} /> From {task.source.topic} · {longDay(task.source.date + 'T06:30:00Z')}</span>
						{#if task.source.canOpen}<a class="ess-link" href="/hub/meetings/{task.source.meetingId}">Open minutes</a>{/if}
					</div>
					{#if task.source.quote}<blockquote>"{task.source.quote}"</blockquote>{/if}
					{#if !task.source.canOpen}<p class="ess-help">Only the host sees the full minutes.</p>{/if}
				</div>
			{:else if task.source?.kind === 'message'}
				<div class="src">
					<div class="src-top">
						<span class="src-name"><Hash size={14} /> From {task.source.channelName ?? 'a conversation'}</span>
						{#if task.source.channelId}<a class="ess-link" href="/hub/c/{task.source.channelId}">Open chat</a>{/if}
					</div>
					{#if task.source.quote}<blockquote>"{task.source.quote}"</blockquote>{/if}
				</div>
			{/if}

			<section>
				<div class="sec-head">
					<h3 class="ess-h2 sec">Checklist{#if subsTotal} ({subsDone} of {subsTotal}){/if}</h3>
					{#if subsTotal}
						<span class="pct">{pct}%</span>
						<span class="ess-meter ess-meter--thin meter"><span style="width:{pct}%"></span></span>
					{/if}
				</div>
				<ul class="subs">
					{#each task.subtaskList as s (s.id)}
						<li class:done={s.done}>
							<label><input type="checkbox" class="tick" checked={s.done} disabled={!can} onchange={() => toggleSub(s.id)} /> <span>{s.title}</span></label>
							{#if can}<button type="button" class="ess-icon-btn small" aria-label="Remove subtask {s.title}" onclick={() => removeSub(s.id)}><X size={13} /></button>{/if}
						</li>
					{/each}
				</ul>
				{#if can}
					<form class="addsub" onsubmit={(e) => { e.preventDefault(); void addSub(); }}>
						<Plus size={15} />
						<input aria-label="New subtask" bind:value={newSub} placeholder="Add subtask" />
						{#if newSub.trim()}<button class="ess-btn ess-btn--secondary ess-btn--sm" type="submit">Add</button>{/if}
					</form>
				{/if}
			</section>

			<section>
				<h3 class="ess-h2 sec">Activity</h3>
				<ol class="days">
					{#each days as d (d.day)}
						<li class="day">
							<span class="day-l">{d.label}</span>
							<ul class="events">
								{#each d.events as ev (ev.id)}
									<li class:comment={ev.kind === 'comment'}>
										<span class="t">{timeOf(ev.createdAt)}</span>
										{#if ev.actor}<Avatar userId={ev.actor.id} fullName={ev.actor.fullName} size="sm" />{:else}<span class="sys">ESS</span>{/if}
										<div class="ev-b">
											<span><strong>{ev.actor?.fullName ?? 'ESS'}</strong> {ev.kind === 'comment' ? 'added a comment' : ev.body}</span>
											{#if ev.kind === 'comment'}<p>{ev.body}</p>{/if}
										</div>
									</li>
								{/each}
							</ul>
						</li>
					{:else}
						<li class="ess-help">Nothing has happened yet.</li>
					{/each}
				</ol>
			</section>

			<p class="ess-help made">Made by {task.createdBy.fullName}{task.completedAt ? ` · completed ${ago(task.completedAt)}` : ''}</p>
		{/if}
	</div>

	{#if task && !error}
		<form class="composer" onsubmit={(e) => { e.preventDefault(); void postComment(); }}>
			<Avatar userId={meId} fullName={task.assignee?.id === meId ? task.assignee.fullName : 'Me'} size="md" />
			<input class="ess-input" aria-label="Comment" bind:value={comment} placeholder="Add a comment…" />
			<button class="ess-btn ess-btn--primary send" type="submit" disabled={!comment.trim()} aria-label="Send comment"><SendHorizontal size={17} /></button>
		</form>
	{/if}
</div>

<style>
	.scrim {
		z-index: 70;
	}
	.sheet {
		z-index: 71;
		width: min(520px, 100vw);
		padding-top: env(safe-area-inset-top, 0px);
		padding-bottom: env(safe-area-inset-bottom, 0px);
	}
	.head {
		display: grid;
		gap: 10px;
		padding: 18px 20px 14px;
		border-bottom: 1px solid var(--ess-border);
	}
	.head-row {
		display: flex;
		align-items: flex-start;
		gap: 4px;
	}
	.title,
	.title-ph {
		flex: 1;
		min-width: 0;
		font-family: var(--ess-font-display);
		font-size: 26px;
		font-weight: 600;
		line-height: 1.15;
		letter-spacing: -0.01em;
		border: 1px solid transparent;
		background: transparent;
		color: var(--ess-text);
		border-radius: var(--ess-radius-sm);
		padding: 4px 8px;
		margin-left: -8px;
	}
	.title:hover:not(:disabled),
	.title:focus {
		border-color: var(--ess-border);
		outline: none;
	}
	.status-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.status-pill {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 0 8px 0 10px;
		border-radius: var(--ess-radius-pill);
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	.status-pill[data-status='todo'] {
		background: var(--ess-neutral-bg);
		color: var(--ess-neutral);
	}
	.status-pill[data-status='in_review'] {
		background: var(--ess-warning-bg);
		color: var(--ess-warning);
	}
	.status-pill[data-status='done'] {
		background: var(--ess-success-bg);
		color: var(--ess-success);
	}
	.sdot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		border: 2px solid currentColor;
	}
	.status-pill[data-status='in_progress'] .sdot {
		border-right-color: transparent;
		border-bottom-color: transparent;
		transform: rotate(-45deg);
	}
	.status-pill[data-status='done'] .sdot {
		background: currentColor;
	}
	.status-pill select {
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 13.5px;
		font-weight: 500;
		padding: 6px 4px 6px 0;
		cursor: pointer;
	}
	.status-pill select:focus-visible {
		outline: none;
		box-shadow: none;
	}
	.status-pill:focus-within {
		box-shadow: var(--ess-focus-ring);
	}
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 18px 20px;
		display: grid;
		gap: 18px;
		align-content: start;
	}
	.banner-acts {
		margin-top: 8px;
	}
	.grow {
		flex: 1;
	}
	.row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.handback {
		justify-self: start;
		border: 0;
		background: none;
		padding: 0;
		cursor: pointer;
		font: inherit;
		font-size: 13px;
	}
	.desc {
		width: 100%;
		border: 1px solid transparent;
		background: transparent;
		border-radius: var(--ess-radius-sm);
		padding: 6px 8px;
		margin-left: -8px;
		font: inherit;
		font-size: 14.5px;
		line-height: 1.55;
		color: var(--ess-text-secondary);
		resize: vertical;
	}
	.desc:hover:not(:disabled),
	.desc:focus {
		border-color: var(--ess-border);
		background: var(--ess-field-bg);
		outline: none;
	}
	.desc::placeholder {
		color: var(--ess-text-muted);
	}
	.facts {
		display: grid;
		grid-template-columns: 1.3fr 1fr 1fr;
		gap: 0;
		border-top: 1px solid var(--ess-border);
		border-bottom: 1px solid var(--ess-border);
	}
	.fact {
		display: grid;
		gap: 6px;
		padding: 12px 12px 12px 0;
		border-right: 1px solid var(--ess-border);
		min-width: 0;
	}
	.fact + .fact {
		padding-left: 12px;
	}
	.fact:last-child {
		border-right: none;
		padding-right: 0;
	}
	.fact-l {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}
	.fact-v {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.fact-v :global(.ess-select),
	.fact-v .ess-input {
		padding-top: 6px;
		padding-bottom: 6px;
		font-size: 13.5px;
		min-width: 0;
	}
	.pri-high {
		color: var(--ess-danger);
		background-color: var(--ess-danger-bg);
		border-color: transparent;
	}
	.pri-medium {
		color: var(--ess-warning);
		background-color: var(--ess-warning-bg);
		border-color: transparent;
	}
	.pri-low {
		color: var(--ess-success);
		background-color: var(--ess-success-bg);
		border-color: transparent;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
		color: var(--ess-text-secondary);
		margin-top: -8px;
	}
	.check input,
	.tick {
		accent-color: var(--ess-primary);
		width: 16px;
		height: 16px;
	}
	.src {
		display: grid;
		gap: 8px;
		padding: 12px 14px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-sunken);
		border: 1px solid var(--ess-border-subtle);
	}
	.src-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
	}
	.src-name {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 500;
		color: var(--ess-text);
	}
	blockquote {
		margin: 0;
		padding-left: 10px;
		border-left: 2px solid var(--ess-border-strong);
		font-style: italic;
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.sec-head {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
	}
	.sec {
		margin: 0;
		font-size: 18px;
		flex: 1;
	}
	.pct {
		font-size: 13px;
		color: var(--ess-text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.meter {
		width: 140px;
	}
	.subs {
		list-style: none;
		margin: 0 0 6px;
		padding: 0;
		display: grid;
	}
	.subs li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 7px 4px;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.subs li:last-child {
		border-bottom: none;
	}
	.subs label {
		display: flex;
		gap: 10px;
		align-items: center;
		font-size: 14px;
		cursor: pointer;
	}
	.subs li.done span {
		text-decoration: line-through;
		color: var(--ess-text-muted);
	}
	.small {
		width: 28px;
		height: 28px;
	}
	.addsub {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 12px;
		height: 40px;
		border: 1px dashed var(--ess-border-strong);
		border-radius: var(--ess-radius-md);
		color: var(--ess-text-muted);
	}
	.addsub:focus-within {
		border-style: solid;
		border-color: var(--ess-primary);
	}
	.addsub input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		font: inherit;
		font-size: 13.5px;
		color: var(--ess-text);
		outline: none;
	}
	.days {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	.day {
		display: grid;
		gap: 6px;
	}
	.day-l {
		font-size: 13px;
		font-weight: 500;
		color: var(--ess-text);
		padding-left: 14px;
		position: relative;
	}
	.day-l::before {
		content: '';
		position: absolute;
		left: 0;
		top: 7px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ess-border-strong);
	}
	.events {
		list-style: none;
		margin: 0;
		padding: 0 0 0 3px;
		border-left: 2px solid var(--ess-border-subtle);
		display: grid;
		gap: 10px;
	}
	.events li {
		display: grid;
		grid-template-columns: 44px 28px minmax(0, 1fr);
		gap: 8px;
		align-items: start;
		padding-left: 10px;
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.events .t {
		font-size: 12px;
		color: var(--ess-text-muted);
		font-variant-numeric: tabular-nums;
		padding-top: 6px;
	}
	.ev-b {
		padding-top: 4px;
		min-width: 0;
	}
	.events strong {
		color: var(--ess-text);
		font-weight: 500;
	}
	.events p {
		margin: 6px 0 0;
		padding: 10px 12px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-sunken);
		color: var(--ess-text);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 13.5px;
	}
	.sys {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 8.5px;
		font-weight: 700;
		background: var(--ess-sunken);
		color: var(--ess-text-muted);
	}
	.made {
		padding-top: 8px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.composer {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 20px 16px;
		border-top: 1px solid var(--ess-border);
		background: var(--ess-surface);
	}
	.composer .ess-input {
		flex: 1;
	}
	.send {
		width: 40px;
		padding: 0;
		flex: none;
	}
	@media (max-width: 520px) {
		.facts {
			grid-template-columns: 1fr;
		}
		.fact {
			border-right: none;
			border-bottom: 1px solid var(--ess-border-subtle);
			padding: 10px 0;
		}
		.fact + .fact {
			padding-left: 0;
		}
		.fact:last-child {
			border-bottom: none;
		}
		.meter {
			display: none;
		}
	}
</style>
