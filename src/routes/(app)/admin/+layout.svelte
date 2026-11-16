<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import ChartColumn from '@lucide/svelte/icons/chart-column';
	import Users from '@lucide/svelte/icons/users';
	import Clock from '@lucide/svelte/icons/clock';
	import Calendar from '@lucide/svelte/icons/calendar';
	import FileText from '@lucide/svelte/icons/file-text';
	import Network from '@lucide/svelte/icons/network';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import DatabaseZap from '@lucide/svelte/icons/database-zap';
	import Palette from '@lucide/svelte/icons/palette';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Video from '@lucide/svelte/icons/video';
	import Headset from '@lucide/svelte/icons/headset';
	import GraduationCap from '@lucide/svelte/icons/graduation-cap';
	import PartyPopper from '@lucide/svelte/icons/party-popper';
	import Laptop from '@lucide/svelte/icons/laptop';
	import Search from '@lucide/svelte/icons/search';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { adminTabForPath, visibleAdminTabs, type AdminTabId } from '$lib/admin-tabs';
	import { tabSeverities } from '$lib/admin-issues';
	import { lockPageScroll } from '$lib/scroll-lock';
	import SummaryStrip from '$lib/components/SummaryStrip.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	let { data, children } = $props();

	const ICONS: Record<AdminTabId, typeof Users> = {
		overview: LayoutGrid,
		analytics: ChartColumn,
		people: Users,
		alumni: GraduationCap,
		engagement: PartyPopper,
		it: Laptop,
		biometric: Clock,
		balances: Calendar,
		policies: FileText,
		org: Network,
		access: ShieldCheck,
		support: Headset,
		chat: MessagesSquare,
		zoom: Video,
		cleanup: DatabaseZap,
		tweaks: Palette
	};

	const can = (key: string) => (data.adminCaps as string[]).includes(key);
	const sectionTabs = $derived(visibleAdminTabs(data.adminCaps));
	const current = $derived(adminTabForPath(page.url.pathname));
	const severities = $derived(tabSeverities(data.adminIssues));
	const strip = $derived(current ? data.adminStrips[current.id] : undefined);

	/** Why a tab has a dot, for its tooltip. */
	function tabHint(id: AdminTabId): string | undefined {
		const top = data.adminIssues.find((i) => i.tab === id);
		return top?.title;
	}

	/* ---------- Ctrl+K jump box ---------- */

	type Jump = { label: string; kind: 'Section' | 'Action'; href: string };

	const jumps = $derived.by((): Jump[] => [
		...sectionTabs.map((t) => ({ label: t.label, kind: 'Section' as const, href: t.href })),
		...(can('people.create_login') ? [{ label: 'Create a login', kind: 'Action' as const, href: '/admin/people?create=1' }] : []),
		...(can('announcements.post') ? [{ label: 'Post an announcement', kind: 'Action' as const, href: '/chat?c=announcements&compose=1' }] : []),
		...(can('people.directory') ? [{ label: 'Week-off rosters', kind: 'Action' as const, href: '/admin/people?view=weekoff' }] : []),
		...(can('people.bulk_import') ? [{ label: 'Bulk import logins', kind: 'Action' as const, href: '/admin/people?view=bulk' }] : []),
		...(can('people.password_activity') ? [{ label: 'Password activity', kind: 'Action' as const, href: '/admin/people?view=passwords' }] : []),
		...(can('policies.publish') ? [{ label: 'Publish a holiday calendar', kind: 'Action' as const, href: '/admin/policies' }] : []),
		...(can('system.roles') ? [{ label: 'Create a named role', kind: 'Action' as const, href: '/admin/access-control?new=1' }] : []),
		...(can('attendance.biometric_upload') ? [{ label: 'Upload a biometric report', kind: 'Action' as const, href: '/admin/biometric' }] : []),
		...(can('leave.set_balances') ? [{ label: 'Set leave balances', kind: 'Action' as const, href: '/admin/leave-balances' }] : []),
		{ label: 'Approve leave requests', kind: 'Action', href: '/leave' }
	]);

	let jumpOpen = $state(false);
	let jumpQuery = $state('');
	let jumpIndex = $state(0);
	let jumpInput = $state<HTMLInputElement | null>(null);
	let unlockScroll: (() => void) | null = null;

	const jumpMatches = $derived(jumps.filter((j) => j.label.toLowerCase().includes(jumpQuery.trim().toLowerCase())));

	async function openJump() {
		jumpQuery = '';
		jumpIndex = 0;
		jumpOpen = true;
		unlockScroll = lockPageScroll();
		await tick();
		jumpInput?.focus();
	}

	function closeJump() {
		jumpOpen = false;
		unlockScroll?.();
		unlockScroll = null;
	}

	function pick(j: Jump) {
		closeJump();
		goto(j.href);
	}

	function onJumpKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			jumpIndex = Math.min(jumpIndex + 1, jumpMatches.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			jumpIndex = Math.max(jumpIndex - 1, 0);
		} else if (e.key === 'Enter' && jumpMatches[jumpIndex]) {
			e.preventDefault();
			pick(jumpMatches[jumpIndex]);
		}
	}

	function onWindowKey(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			if (jumpOpen) closeJump();
			else openJump();
		} else if (e.key === 'Escape' && jumpOpen) {
			closeJump();
		}
	}

	$effect(() => () => unlockScroll?.());

	/* The tab bar scrolls sideways: keep the active tab in view, show the
	   arrows and edge fades only on the side that has more tabs, and let
	   a mouse wheel over the bar scroll it sideways. */
	let tabBar = $state<HTMLElement | null>(null);
	let canLeft = $state(false);
	let canRight = $state(false);
	function measureTabs() {
		if (!tabBar) return;
		canLeft = tabBar.scrollLeft > 2;
		canRight = tabBar.scrollLeft + tabBar.clientWidth < tabBar.scrollWidth - 2;
	}
	function scrollTabs(dir: -1 | 1) {
		tabBar?.scrollBy({ left: dir * Math.max(160, (tabBar.clientWidth ?? 0) * 0.6), behavior: 'smooth' });
	}
	function wheelTabs(e: WheelEvent) {
		if (!tabBar || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
		if (tabBar.scrollWidth <= tabBar.clientWidth) return;
		e.preventDefault();
		tabBar.scrollLeft += e.deltaY;
	}
	$effect(() => {
		void current?.id;
		tabBar?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		measureTabs();
	});
	$effect(() => {
		if (!tabBar) return;
		const bar = tabBar;
		const ro = new ResizeObserver(measureTabs);
		ro.observe(bar);
		// Not passive: a vertical wheel over the bar scrolls it sideways.
		bar.addEventListener('wheel', wheelTabs, { passive: false });
		return () => {
			ro.disconnect();
			bar.removeEventListener('wheel', wheelTabs);
		};
	});
</script>

<svelte:window onkeydown={onWindowKey} />

<PageHeader
	crumb={['Admin Controls']}
	title={current?.heading ?? 'Admin Controls'}
	sub={current?.blurb}
	compact
>
	{#snippet actions()}
		<button type="button" class="ess-btn ess-btn--secondary jump-btn" onclick={openJump} aria-label="Jump to a section or task" title="Jump to… (Ctrl K)">
			<Search size={15} />
			<span class="jump-label">Jump to…</span>
			<kbd class="ess-kbd">Ctrl K</kbd>
		</button>
	{/snippet}
	{#snippet tabs()}
		<nav class="admin-tabs" aria-label="Admin sections" class:fade-l={canLeft} class:fade-r={canRight}>
			<button type="button" class="tab-arrow left" hidden={!canLeft} onclick={() => scrollTabs(-1)} aria-label="Scroll sections left" tabindex="-1"><ChevronLeft size={16} /></button>
			<div class="ess-tabs ess-tabs--line tab-row" bind:this={tabBar} onscroll={measureTabs}>
				{#each sectionTabs as tab, i (tab.id)}
					{@const Icon = ICONS[tab.id]}
					{@const sev = severities[tab.id]}
					{#if i > 0 && sectionTabs[i - 1].group !== tab.group}
						<span class="group-sep" aria-hidden="true"></span>
					{/if}
					<a href={tab.href} class="ess-tab tab" aria-current={current?.id === tab.id ? 'page' : undefined} title={sev ? tabHint(tab.id) : undefined}>
						<Icon size={16} strokeWidth={1.75} />
						{tab.label}
						{#if sev && sev !== 'info'}
							<span class="dot" data-sev={sev}>
								<span class="ess-sr-only">— needs attention</span>
							</span>
						{/if}
					</a>
				{/each}
			</div>
			<button type="button" class="tab-arrow right" hidden={!canRight} onclick={() => scrollTabs(1)} aria-label="Scroll sections right" tabindex="-1"><ChevronRight size={16} /></button>
		</nav>
	{/snippet}
</PageHeader>

<div class="admin-body ess-fill">
	{#if strip && strip.length > 0}
		<SummaryStrip items={strip} />
	{/if}
	{@render children()}
</div>

{#if jumpOpen}
	<div class="jump-scrim" role="presentation" onclick={closeJump}></div>
	<div class="jump" role="dialog" aria-modal="true" aria-label="Jump to a section or action">
		<input
			bind:this={jumpInput}
			bind:value={jumpQuery}
			oninput={() => (jumpIndex = 0)}
			onkeydown={onJumpKey}
			class="jump-input"
			placeholder="Jump to a section or action…"
			autocomplete="off"
			role="combobox"
			aria-expanded="true"
			aria-controls="jump-list"
		/>
		<ul class="jump-list" id="jump-list" role="listbox">
			{#each jumpMatches as j, i (j.href + j.label)}
				<li role="option" aria-selected={i === jumpIndex}>
					<button type="button" onclick={() => pick(j)} onmouseenter={() => (jumpIndex = i)}>
						{j.label}
						<span class="jump-kind">{j.kind}</span>
					</button>
				</li>
			{:else}
				<li class="jump-empty">Nothing matches “{jumpQuery}”.</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.jump-btn {
		gap: 8px;
	}

	/* The section tabs sit in the page's header row and scroll sideways
	   in the room it leaves them. */
	.admin-tabs {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		width: 100%;
	}
	:global(.ess-page-head:has(nav.admin-tabs) .bar-tabs) {
		flex: 1 1 0%;
	}
	.tab-row {
		flex: 1 1 auto;
		min-width: 0;
		width: 100%;
		overflow-x: auto;
		scroll-behavior: smooth;
		scrollbar-width: none;
	}
	/* Edge fades on the side(s) with more tabs to scroll to. */
	.fade-l .tab-row {
		-webkit-mask-image: linear-gradient(to right, transparent, #000 36px);
		mask-image: linear-gradient(to right, transparent, #000 36px);
	}
	.fade-r .tab-row {
		-webkit-mask-image: linear-gradient(to left, transparent, #000 36px);
		mask-image: linear-gradient(to left, transparent, #000 36px);
	}
	.fade-l.fade-r .tab-row {
		-webkit-mask-image: linear-gradient(to right, transparent, #000 36px, #000 calc(100% - 36px), transparent);
		mask-image: linear-gradient(to right, transparent, #000 36px, #000 calc(100% - 36px), transparent);
	}
	.tab-arrow {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 1px solid var(--ess-border-subtle);
		background: var(--ess-surface);
		color: var(--ess-text-secondary);
		box-shadow: 0 1px 3px rgba(20, 22, 40, 0.08);
		cursor: pointer;
	}
	.tab-arrow:hover {
		color: var(--ess-primary-text);
		border-color: var(--ess-primary-soft);
	}
	.tab-arrow[hidden] {
		display: none;
	}
	.tab-row::-webkit-scrollbar {
		display: none;
	}

	.group-sep {
		flex-shrink: 0;
		width: 1px;
		margin: 10px 6px;
		background: var(--ess-border);
	}

	.tab {
		flex-shrink: 0;
		white-space: nowrap;
		padding: 9px 14px;
		font-size: 13px;
	}
	.tab :global(svg) {
		flex-shrink: 0;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.dot[data-sev='bad'] {
		background: var(--ess-danger);
	}
	.dot[data-sev='warn'] {
		background: var(--ess-warning);
	}

	.admin-body {
		display: grid;
		gap: 14px;
		padding-top: 14px;
		min-width: 0;
	}

	/* The summary strip sits above every admin page: keep it a slim band. */
	.admin-body > :global(.ess-figures > .ess-figure) {
		padding: 10px 16px;
		gap: 10px;
	}
	/* Value on the left, label and detail stacked beside it. */
	.admin-body > :global(.ess-figures > .ess-figure > div) {
		grid-template-columns: auto minmax(0, 1fr);
		column-gap: 10px;
		align-items: start;
	}
	.admin-body > :global(.ess-figures) :global(.ess-figure__value) {
		grid-row: 1 / span 2;
		font-size: 20px;
		line-height: 1;
	}
	.admin-body > :global(.ess-figures) :global(.ess-figure__label),
	.admin-body > :global(.ess-figures) :global(.ess-figure__value ~ span) {
		grid-column: 2;
		line-height: 1.3;
	}
	.admin-body > :global(.ess-figures) :global(.ess-figure__label) {
		font-size: 12.5px;
	}
	.admin-body > :global(.ess-figures) :global(.ess-figure__dot) {
		width: 10px;
		height: 10px;
		margin-top: 6px;
		align-self: flex-start;
	}

	/* Fill layout (desktop). The body is the .ess-fill child of .ess-content,
	   so it stretches to the bottom of the workspace as a column. A page opts
	   in by putting .ess-fill on its own top block: that block takes the
	   height left under the summary strip, and the page never scrolls.
	   A page that does not opt in keeps its natural height and the workspace
	   scrolls as before. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.admin-body {
				display: flex;
				flex-direction: column;
			}
			.admin-body > :global(*) {
				flex-shrink: 0;
			}
			.admin-body > :global(.ess-fill) {
				flex: 1 1 0px;
				min-height: 0;
			}
			:global(.ess-content) > .admin-body:not(:has(> :global(.ess-fill))) {
				flex: 1 0 auto;
			}
		}
	}

	/* The pages were written as standalone screens and each sets its own top
	   spacing; inside the grid, gap does that job. */
	.admin-body > :global(*) {
		min-width: 0;
		margin-top: 0;
	}

	/* ---------- jump box ---------- */

	.jump-scrim {
		position: fixed;
		inset: 0;
		z-index: 90;
		background: rgba(27, 31, 59, 0.42);
	}

	.jump {
		position: fixed;
		z-index: 91;
		top: 12vh;
		left: 50%;
		transform: translateX(-50%);
		width: min(560px, calc(100vw - 32px));
		background: var(--ess-modal-bg);
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-lg);
		box-shadow: var(--ess-elev-4);
		overflow: hidden;
	}

	.jump-input {
		width: 100%;
		border: 0;
		border-bottom: 1px solid var(--ess-border);
		background: transparent;
		padding: 16px 18px;
		font: inherit;
		font-size: 15px;
		color: var(--ess-text);
		outline: none;
	}

	.jump-list {
		list-style: none;
		margin: 0;
		padding: 6px;
		max-height: 340px;
		overflow-y: auto;
	}

	.jump-list button {
		display: flex;
		align-items: center;
		width: 100%;
		gap: 12px;
		padding: 9px 12px;
		border: 0;
		border-radius: var(--ess-radius-sm);
		background: transparent;
		font: inherit;
		color: var(--ess-text);
		text-align: left;
		cursor: pointer;
	}

	.jump-list li[aria-selected='true'] button {
		background: var(--ess-primary-soft);
	}

	.jump-kind {
		margin-left: auto;
		font-size: var(--ess-fs-caption);
		color: var(--ess-text-muted);
	}

	.jump-empty {
		padding: 10px 12px;
		color: var(--ess-text-muted);
		font-size: var(--ess-fs-caption);
	}


	/* Short desktop screens (a 1280x580 browser): the header, tabs and
	   summary strip give back as much height as they can, so the page below
	   keeps room for its cards. */
	@media (min-width: 1101px) and (max-height: 800px) {
		.tab {
			padding-top: 6px;
			padding-bottom: 6px;
			font-size: 12.5px;
		}
		.group-sep {
			margin-top: 7px;
			margin-bottom: 7px;
		}
		.admin-body {
			gap: 10px;
			padding-top: 10px;
		}
		/* The strip becomes a slim band: each cell is the value beside
		   two single lines (label, detail). */
		.admin-body > :global(.ess-figures > .ess-figure) {
			align-items: center;
			padding: 6px 14px;
			gap: 9px;
		}
		.admin-body > :global(.ess-figures > .ess-figure > div) {
			align-items: center;
			row-gap: 0;
		}
		.admin-body > :global(.ess-figures) :global(.ess-figure__value) {
			font-size: 18px;
		}
		.admin-body > :global(.ess-figures) :global(.ess-figure__label),
		.admin-body > :global(.ess-figures) :global(.ess-figure__value ~ span) {
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
			line-height: 1.25;
		}
		.admin-body > :global(.ess-figures) :global(.ess-figure__label) {
			font-size: 12px;
		}
		.admin-body > :global(.ess-figures) :global(.ess-figure__label ~ span) {
			font-size: 11.5px;
		}
		.admin-body > :global(.ess-figures) :global(.ess-figure__dot) {
			width: 9px;
			height: 9px;
			margin-top: 0;
			align-self: center;
		}
	}

	@media (max-width: 720px) {
		.jump-btn kbd {
			display: none;
		}
	}

	/* The header row is shared with the top-bar cluster: Jump to shows its
	   icon only until there's room for the label. */
	@media (min-width: 1101px) {
		@container ess-main (max-width: 1474px) {
			.jump-btn.jump-btn {
				width: 36px;
				padding: 0;
			}
			.jump-label,
			.jump-btn kbd {
				display: none;
			}
		}
	}
</style>
