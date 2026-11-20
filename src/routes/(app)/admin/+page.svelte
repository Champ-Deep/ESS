<script lang="ts">
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import Upload from '@lucide/svelte/icons/upload';
	import Calendar from '@lucide/svelte/icons/calendar';
	import FileText from '@lucide/svelte/icons/file-text';
	import CheckCheck from '@lucide/svelte/icons/check-check';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Users from '@lucide/svelte/icons/users';
	import Mail from '@lucide/svelte/icons/mail';
	import Fingerprint from '@lucide/svelte/icons/fingerprint';
	import Network from '@lucide/svelte/icons/network';
	import Scale from '@lucide/svelte/icons/scale';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type { AdminIssue } from '$lib/admin-issues';

	let { data } = $props();

	const can = (key: string) => (data.adminCaps as string[]).includes(key);

	/*
	 * Hiding an item is a per-browser convenience, not a resolution. Ids carry
	 * the size of the condition (see AdminIssue.id), so a hidden "23 people
	 * have no manager" comes back by itself once it becomes 24 — or disappears
	 * for real once it is fixed.
	 */
	const HIDDEN_KEY = 'essAdminHiddenIssues';
	let hidden = $state<string[]>([]);

	$effect(() => {
		try {
			hidden = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
		} catch {
			hidden = [];
		}
	});

	function toggleHidden(id: string) {
		hidden = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
		try {
			// Only ids that still exist are kept, so the list cannot grow forever.
			const live = new Set(data.adminIssues.map((i) => i.id));
			localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden.filter((h) => live.has(h))));
		} catch {
			/* storage blocked: hiding lasts for this visit only */
		}
	}

	let showHidden = $state(false);
	const open = $derived(data.adminIssues.filter((i) => !hidden.includes(i.id)));
	const hiddenCount = $derived(data.adminIssues.length - open.length);
	const listed = $derived(showHidden ? data.adminIssues : open);

	/* The three figures at the top: open problems, imports waiting, people. */
	const openIssues = $derived(open.filter((i) => i.severity !== 'info').length);
	const importsToReview = $derived(open.filter((i) => i.tab === 'biometric' || i.id.startsWith('bulk')).length);
	const activePeople = $derived(data.adminStrips.overview?.find((s) => s.label === 'Active people')?.value ?? '—');

	/* Which section an issue belongs to decides its icon. */
	const ICONS: Record<string, typeof Users> = {
		people: Mail,
		biometric: Fingerprint,
		balances: Scale,
		policies: FileText,
		org: Network,
		access: ShieldCheck,
		chat: MessagesSquare,
		leave: CheckCheck
	};
	const iconFor = (i: AdminIssue) => (i.id.includes('bulk') ? Upload : (ICONS[i.tab] ?? TriangleAlert));
	/* The leading number in a title ("3 attendance records…") is pulled out as the badge. */
	const countOf = (i: AdminIssue) => i.title.match(/^(\d+)\b/)?.[1] ?? i.detail.match(/^(\d+)\b/)?.[1] ?? null;

	const tasks = $derived(
		[
			...(can('people.create_login') ? [{ href: '/admin/people?create=1', label: 'Create login', sub: 'Add a new team member and send their login email.', icon: UserPlus }] : []),
			...(can('attendance.biometric_upload') ? [{ href: '/admin/biometric', label: 'Upload attendance', sub: 'Import attendance from a file (CSV or Excel).', icon: Upload }] : []),
			...(can('leave.set_balances') ? [{ href: '/admin/leave-balances', label: 'Set leave balances', sub: 'Configure or update leave balances for individuals or groups.', icon: Calendar }] : []),
			...(can('policies.publish') ? [{ href: '/admin/policies', label: 'Publish policy', sub: 'Review and publish a policy for your organisation.', icon: FileText }] : []),
			{ href: '/leave', label: 'Approve leave requests', sub: 'Everything waiting on you.', icon: CheckCheck }
		]
	);

	const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
	const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
	const toneOf = (action: string) => (action.includes('delete') || action.includes('cleanup') || action.includes('failed') ? 'bad' : action.includes('create') || action.includes('publish') || action.includes('apply') ? 'ok' : 'accent');
</script>

<svelte:head>
	<title>Admin Controls — Champ HR</title>
</svelte:head>

<div class="ess-split overview ess-fill">
	<div class="ess-stack main-col">
		<section class="ess-card" aria-labelledby="ops-title">
			<div class="ess-card-head">
				<h2 class="ess-h2" id="ops-title">Operations overview</h2>
			</div>
			<div class="figures">
				<a class="figure" href="#attention">
					<span class="ess-tile" class:ess-tile--bad={openIssues > 0} class:ess-tile--ok={openIssues === 0}>
						{#if openIssues > 0}<TriangleAlert size={18} strokeWidth={1.75} />{:else}<CircleCheck size={18} strokeWidth={1.75} />{/if}
					</span>
					<span class="fig-text"><strong>{openIssues}</strong><span>Open {openIssues === 1 ? 'issue' : 'issues'}</span></span>
					<ChevronRight size={16} class="chev" />
				</a>
				<a class="figure" href={can('attendance.biometric_upload') ? '/admin/biometric' : '/admin/people?view=bulk'}>
					<span class="ess-tile"><FileText size={18} strokeWidth={1.75} /></span>
					<span class="fig-text"><strong>{importsToReview}</strong><span>Imports to review</span></span>
					<ChevronRight size={16} class="chev" />
				</a>
				<a class="figure" href={can('people.directory') ? '/admin/people' : '/team'}>
					<span class="ess-tile ess-tile--ok"><Users size={18} strokeWidth={1.75} /></span>
					<span class="fig-text"><strong>{activePeople}</strong><span>Active people</span></span>
					<ChevronRight size={16} class="chev" />
				</a>
			</div>
		</section>

		<section class="ess-card ess-fill-card grow-card" aria-labelledby="attention-title" id="attention" data-tour="admin-attention">
			<div class="ess-card-head">
				<h2 class="ess-h2" id="attention-title">Needs attention</h2>
				{#if hiddenCount > 0}
					<button type="button" class="ess-link as-btn" onclick={() => (showHidden = !showHidden)}>
						{showHidden ? 'Hide dismissed' : `Show ${hiddenCount} dismissed`}
					</button>
				{/if}
			</div>

			{#if listed.length === 0}
				<div class="ess-notice ess-notice--success">
					<span class="ess-notice__icon"><CircleCheck size={16} /></span>
					<div class="ess-notice__body">
						<strong>Nothing needs attention.</strong>
						Attendance is arriving, everyone has a manager and the policies are published.
					</div>
				</div>
			{:else}
				<ul class="ess-rows list ess-scroll">
					{#each listed as issue (issue.id)}
						{@const isHidden = hidden.includes(issue.id)}
						{@const Icon = iconFor(issue)}
						{@const n = countOf(issue)}
						<li class="ess-row item" class:is-hidden={isHidden}>
							<span class="ess-tile" class:ess-tile--bad={issue.severity === 'bad'} class:ess-tile--warn={issue.severity === 'warn'} class:ess-tile--info={issue.severity === 'info'}>
								<Icon size={18} strokeWidth={1.75} />
							</span>
							<div class="ess-row__body">
								<span class="ess-row__title">{issue.title}</span>
								<span class="ess-row__meta wrap">{issue.detail}</span>
							</div>
							<div class="ess-row__end">
								{#if n}
									<span class="ess-badge" class:ess-badge--bad={issue.severity === 'bad'} class:ess-badge--warn={issue.severity === 'warn'} class:ess-badge--info={issue.severity === 'info'}>{n}</span>
								{:else}
									<span class="ess-badge" class:ess-badge--bad={issue.severity === 'bad'} class:ess-badge--warn={issue.severity === 'warn'} class:ess-badge--accent={issue.severity === 'info'}>{issue.severity === 'info' ? 'Ready' : issue.severity === 'bad' ? 'Urgent' : 'Review'}</span>
								{/if}
								<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm dismiss" onclick={() => toggleHidden(issue.id)}>
									{isHidden ? 'Restore' : 'Dismiss'}
								</button>
								<a class="ess-icon-btn" href={issue.href} aria-label={issue.cta} title={issue.cta}><ChevronRight size={18} /></a>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if data.recentActivity.length > 0}
			<section class="ess-card ess-fill-card grow-card" aria-labelledby="activity-title">
				<div class="ess-card-head">
					<h2 class="ess-h2" id="activity-title">Recent admin activity</h2>
					{#if can('people.password_activity')}
						<a class="ess-link" href="/admin/people?view=passwords">Password activity <ChevronRight size={14} /></a>
					{/if}
				</div>
				<ol class="activity ess-scroll">
					{#each data.recentActivity as a (a.id)}
						<li class="act">
							<span class="when"><span>{fmtDay(a.at)}</span><span class="t">{fmtTime(a.at)}</span></span>
							<span class="dot" data-tone={toneOf(a.action)} aria-hidden="true"></span>
							<span class="act-body">
								<strong>{a.title}</strong>
								{#if a.meta}<span>{a.meta}</span>{/if}
							</span>
							<span class="actor">
								<strong>{a.actorName}</strong>
								{#if a.actorEmail}<span>{a.actorEmail}</span>{/if}
							</span>
						</li>
					{/each}
				</ol>
			</section>
		{/if}
	</div>

	<aside class="ess-stack ess-stack--tight">
		<section class="ess-card ess-fill-card tasks-card" aria-labelledby="tasks-title">
			<div class="ess-card-head">
				<h2 class="ess-h2" id="tasks-title">Start a task</h2>
			</div>
			<div class="task-list ess-scroll">
				{#each tasks as task (task.href)}
					{@const Icon = task.icon}
					<a class="task" href={task.href}>
						<span class="ess-tile task-tile"><Icon size={18} strokeWidth={1.75} /></span>
						<span class="task-text">
							<strong>{task.label}</strong>
							<span>{task.sub}</span>
						</span>
						<ChevronRight size={16} class="chev" />
					</a>
				{/each}
			</div>
			<p class="ess-help hint">Press <kbd class="ess-kbd">Ctrl K</kbd> on any admin tab to jump straight to a section.</p>
		</section>
	</aside>
</div>

<style>
	.figures {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}
	.figure {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		color: var(--ess-text);
		transition: border-color var(--ess-t-fast);
	}
	.figure:hover {
		border-color: var(--ess-border-strong);
	}
	.figure .ess-tile {
		width: 38px;
		height: 38px;
		border-radius: 50%;
	}
	.fig-text {
		display: grid;
		min-width: 0;
	}
	.fig-text strong {
		font-family: var(--ess-font-display);
		font-size: 22px;
		font-weight: 600;
		line-height: 1.05;
		font-variant-numeric: tabular-nums;
	}
	.fig-text span {
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}
	.figure :global(.chev),
	.task :global(.chev) {
		margin-left: auto;
		color: var(--ess-text-muted);
		flex: none;
	}

	.as-btn {
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		font: inherit;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.item {
		padding-top: 9px;
		padding-bottom: 9px;
	}
	.item > .ess-tile {
		width: 36px;
		height: 36px;
		border-radius: var(--ess-radius-sm);
	}
	.item.is-hidden {
		opacity: 0.5;
	}
	.item .wrap {
		white-space: normal;
	}
	.dismiss {
		opacity: 0;
		transition: opacity var(--ess-t-fast);
	}
	.item:hover .dismiss,
	.item:focus-within .dismiss {
		opacity: 1;
	}

	.activity {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.act {
		position: relative;
		display: grid;
		grid-template-columns: 96px 20px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: start;
		padding: 8px 0;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.act:last-child {
		border-bottom: 0;
	}
	/* The rail the dots sit on. */
	.act::before {
		content: '';
		position: absolute;
		left: calc(96px + 14px + 9px);
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--ess-border-subtle);
	}
	.act:first-child::before {
		top: 18px;
	}
	.act:last-child::before {
		bottom: calc(100% - 18px);
	}
	.when {
		display: grid;
		font-size: 13px;
		color: var(--ess-text-secondary);
		line-height: 1.35;
	}
	.when .t {
		color: var(--ess-text-muted);
		font-variant-numeric: tabular-nums;
	}
	.dot {
		position: relative;
		z-index: 1;
		width: 12px;
		height: 12px;
		margin: 5px 4px;
		border-radius: 50%;
		background: var(--ess-primary);
		box-shadow: 0 0 0 3px var(--ess-surface);
	}
	.dot[data-tone='ok'] {
		background: var(--ess-success);
	}
	.dot[data-tone='bad'] {
		background: var(--ess-danger);
	}
	.act-body,
	.actor {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.act-body strong,
	.actor strong {
		font-size: 14px;
		font-weight: 500;
	}
	.act-body span,
	.actor span {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.actor {
		text-align: right;
	}

	.task-list {
		display: grid;
		align-content: start;
		gap: 8px;
	}
	.task {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 9px 12px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		background: var(--ess-surface);
		color: inherit;
		transition: border-color var(--ess-t-fast);
	}
	.task:hover {
		border-color: var(--ess-primary);
	}
	.task:focus-visible {
		outline: none;
		box-shadow: var(--ess-focus-ring);
	}
	.task-text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.task-tile {
		width: 36px;
		height: 36px;
		border-radius: var(--ess-radius-sm);
	}
	.task-text strong {
		font-size: 14px;
		font-weight: 600;
	}
	.task-text span {
		font-size: 12.5px;
		color: var(--ess-text-secondary);
		line-height: 1.35;
	}
	.hint {
		margin-top: 10px;
		flex: none;
	}

	/* Fill layout: the columns end on the workspace's bottom edge; the issue
	   list, the activity log and the task list scroll inside their cards. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.overview .main-col {
				overflow: hidden;
			}
			.overview .main-col > .grow-card {
				flex: 0 1 auto;
				min-height: 150px;
			}
			.overview .main-col > .grow-card:last-child {
				flex-grow: 1;
			}
			.overview .ess-scroll {
				margin-right: -6px;
				padding-right: 6px;
			}
			.overview .main-col > :first-child {
				flex-shrink: 0;
			}
			.overview aside > .tasks-card {
				flex: 1 1 0px;
				min-height: 0;
			}
		}
	}

	/* Short desktop screens (a 1280x580 browser): slimmer figures and task
	   rows so all five tasks show without scrolling, and the two lists share
	   the rest of the main column. */
	@media (min-width: 1101px) and (min-height: 480px) and (max-height: 800px) {
		@container ess-fill (min-width: 0px) {
			/* A wider task column keeps most task descriptions on one line. */
			.overview {
				--ess-aside-width: 440px;
			}
			.figures {
				gap: 10px;
			}
			.figure {
				padding: 6px 10px;
				gap: 10px;
			}
			.figure .ess-tile {
				width: 32px;
				height: 32px;
			}
			.fig-text strong {
				font-size: 19px;
			}
			.fig-text span {
				font-size: 12px;
			}
			.overview .main-col > .grow-card {
				min-height: 120px;
			}
			.item {
				padding-top: 7px;
				padding-bottom: 7px;
			}
			.item > .ess-tile {
				width: 32px;
				height: 32px;
			}
			.act {
				padding: 6px 0;
			}
			.task-list {
				gap: 6px;
			}
			.task {
				padding: 6px 10px;
				gap: 10px;
			}
			.task-tile {
				width: 32px;
				height: 32px;
			}
			.task-text {
				gap: 1px;
			}
			.task-text strong {
				font-size: 13.5px;
				line-height: 1.25;
			}
			.task-text span {
				font-size: 12px;
				line-height: 1.3;
			}
			/* The Jump to… button above already shows the shortcut. */
			.hint {
				display: none;
			}
		}
	}

	@media (max-width: 960px) {
		.figures {
			grid-template-columns: 1fr;
		}
		.act {
			grid-template-columns: 20px minmax(0, 1fr);
		}
		.act::before {
			left: 9px;
		}
		.when,
		.actor {
			grid-column: 2;
			text-align: left;
		}
	}
</style>
