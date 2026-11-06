<script lang="ts">
	import { goto } from '$app/navigation';
	import Search from '@lucide/svelte/icons/search';
	import Bell from '@lucide/svelte/icons/bell';
	import Settings from '@lucide/svelte/icons/settings';
	import Plus from '@lucide/svelte/icons/plus';
	import User from '@lucide/svelte/icons/user';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Sun from '@lucide/svelte/icons/sun';
	import Moon from '@lucide/svelte/icons/moon';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import PanelLeftDashed from '@lucide/svelte/icons/panel-left-dashed';
	import Avatar from './Avatar.svelte';
	import { hub } from '$lib/hub/client.svelte';

	/**
	 * The row along the top of the workspace: today's date on the left; the
	 * section links, a search pill (Champ Hub's command palette),
	 * Add employee for people who may create logins, settings,
	 * announcements and the person's round avatar on the right. The avatar
	 * opens profile, password, theme, text size, dock and sign-out.
	 */
	interface Props {
		fullName: string;
		userId: string;
		hasPicture?: boolean;
		pictureVersion?: number | null;
		/** What the person is here as ("Employee", "Administrator"), shown in their menu. */
		roleLabel: string;
		/** Unread announcements; the bell shows a dot when there are any. */
		notifications?: { count: number; urgent: boolean };
		activePath?: string;
		canAdmin?: boolean;
		/** Where Add employee goes, or null when this login cannot create logins. */
		addEmployeeHref?: string | null;
	}

	let {
		fullName,
		userId,
		hasPicture = false,
		pictureVersion,
		roleLabel,
		notifications = { count: 0, urgent: false },
		activePath = '',
		canAdmin = false,
		addEmployeeHref = null
	}: Props = $props();

	// The same sections as the rail, as text links.
	const links = $derived([
		{ href: '/dashboard', label: 'Home' },
		{ href: '/hub', label: 'Champ Hub' },
		{ href: '/leave', label: 'Leave' },
		{ href: '/attendance', label: 'Attendance' },
		{ href: '/policies', label: 'Policies' },
		...(canAdmin ? [{ href: '/admin', label: 'Admin' }] : [])
	]);
	const isActive = (href: string) =>
		href === '/dashboard' ? activePath === '/dashboard' || activePath === '/' : activePath === href || activePath.startsWith(href + '/');

	// The date is the viewer's own, filled in after hydration.
	let today = $state('');
	$effect(() => {
		today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	});

	let menuOpen = $state(false);

	/* On desktop the cluster floats over the top-right of the page and
	   each page's header row leaves room for it: publish its width. */
	let cluster = $state<HTMLElement | null>(null);
	$effect(() => {
		if (!cluster) return;
		const el = cluster;
		const root = document.documentElement;
		const ro = new ResizeObserver(() => root.style.setProperty("--topbar-w", `${el.offsetWidth}px`));
		ro.observe(el);
		return () => ro.disconnect();
	});
	let theme = $state<'light' | 'dark'>('light');

	$effect(() => {
		theme = document.documentElement.getAttribute('data-ess-theme') === 'dark' ? 'dark' : 'light';
	});

	function setTheme(next: 'light' | 'dark') {
		theme = next;
		if (next === 'dark') document.documentElement.setAttribute('data-ess-theme', 'dark');
		else document.documentElement.removeAttribute('data-ess-theme');
		try {
			localStorage.setItem('essTheme', next);
		} catch {
			/* not remembered in private mode */
		}
	}

	/* Text size: a bar per step, each taller than the last. The choice is a
	   multiplier on the workspace zoom (--ess-text-scale, see .ess-shell). */
	const TEXT_STEPS = [0.9, 1, 1.1, 1.2, 1.3];
	let textStep = $state(1);

	/* The dock either floats (slides in from the left edge) or stays fixed. */
	let dock = $state<'floating' | 'fixed'>('floating');

	$effect(() => {
		const root = document.documentElement;
		const scale = parseFloat(root.style.getPropertyValue('--ess-text-scale')) || 1;
		const i = TEXT_STEPS.indexOf(scale);
		textStep = i === -1 ? 1 : i;
		dock = root.getAttribute('data-ess-dock') === 'fixed' ? 'fixed' : 'floating';
	});

	function setTextStep(i: number) {
		textStep = Math.max(0, Math.min(TEXT_STEPS.length - 1, i));
		const scale = TEXT_STEPS[textStep];
		const root = document.documentElement;
		if (scale === 1) root.style.removeProperty('--ess-text-scale');
		else root.style.setProperty('--ess-text-scale', String(scale));
		// Enlarged text: pages flow and scroll instead of fitting the screen.
		root.toggleAttribute('data-ess-flow', scale > 1);
		try {
			if (scale === 1) localStorage.removeItem('essTextScale');
			else localStorage.setItem('essTextScale', String(scale));
		} catch {
			/* not remembered in private mode */
		}
	}

	function setDock(next: 'floating' | 'fixed') {
		dock = next;
		if (next === 'fixed') document.documentElement.setAttribute('data-ess-dock', 'fixed');
		else document.documentElement.removeAttribute('data-ess-dock');
		try {
			localStorage.setItem('essDock', next);
		} catch {
			/* not remembered in private mode */
		}
	}

	async function openSearch() {
		// Search lives in Champ Hub's command palette; open it wherever we are.
		if (location.pathname.startsWith('/hub')) hub.paletteOpen = true;
		else {
			await goto('/hub');
			hub.paletteOpen = true;
		}
	}

	function onWindowClick(e: MouseEvent) {
		if (menuOpen && !(e.target as HTMLElement).closest('.me')) menuOpen = false;
	}
	function onWindowKey(e: KeyboardEvent) {
		if (e.key === 'Escape') menuOpen = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

<div class="topbar">
	<span class="today">{today || ' '}</span>

	<nav class="links" aria-label="Sections">
		{#each links as l (l.href)}
			<a href={l.href} aria-current={isActive(l.href) ? 'page' : undefined}>{l.label}</a>
		{/each}
	</nav>

	<div class="right" bind:this={cluster}>
		<button type="button" class="search" onclick={openSearch} aria-label="Search or ask Champ" title="Search (Ctrl K)">
			<Search size={15} strokeWidth={2} />
			<span class="search-label">Search here</span>
		</button>

		{#if addEmployeeHref}
			<a class="add" href={addEmployeeHref} aria-label="Add employee">
				<Plus size={15} strokeWidth={2.4} />
				<span class="add-label">Add employee</span>
			</a>
		{/if}

		<a href="/profile" class="round settings" aria-label="Profile and settings" title="Profile and settings">
			<Settings size={17} strokeWidth={1.75} />
		</a>
		<a
			href="/chat?c=announcements"
			class="round bell"
			aria-label={notifications.count ? `${notifications.count} unread announcement${notifications.count === 1 ? '' : 's'}` : 'Announcements'}
			title="Announcements"
		>
			<Bell size={17} strokeWidth={1.75} />
			{#if notifications.count > 0}<span class="dot" class:urgent={notifications.urgent}></span>{/if}
		</a>

		<div class="me">
			<button type="button" class="me-btn" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Your account" onclick={() => (menuOpen = !menuOpen)}>
				<Avatar {userId} {fullName} {hasPicture} size="md" version={pictureVersion ?? undefined} />
			</button>
			{#if menuOpen}
				<div class="menu" role="menu">
					<div class="who">
						<strong>{fullName}</strong>
						<span>{roleLabel}</span>
					</div>
					<div class="menu-sep"></div>
					<a role="menuitem" href="/profile" onclick={() => (menuOpen = false)}><User size={15} /> My profile</a>
					<a role="menuitem" href="/change-password" onclick={() => (menuOpen = false)}><KeyRound size={15} /> Change password</a>
					<div class="menu-sep"></div>
					<div class="seg" role="group" aria-label="Appearance">
						<button type="button" aria-pressed={theme === 'light'} onclick={() => setTheme('light')}><Sun size={14} /> Light</button>
						<button type="button" aria-pressed={theme === 'dark'} onclick={() => setTheme('dark')}><Moon size={14} /> Dark</button>
					</div>
					<div class="pref">
						<span class="pref-label">Text size <b>{Math.round(TEXT_STEPS[textStep] * 100)}%</b></span>
						<div class="text-size" role="group" aria-label="Text size">
							<button type="button" class="ts-step sm" aria-label="Smaller text" disabled={textStep === 0} onclick={() => setTextStep(textStep - 1)}>A</button>
							<div class="bars">
								{#each TEXT_STEPS as s, i (s)}
									<button
										type="button"
										class="bar"
										class:on={i <= textStep}
										style="height: {36 + i * 16}%"
										aria-label="{Math.round(s * 100)}%"
										aria-pressed={i === textStep}
										onclick={() => setTextStep(i)}
									></button>
								{/each}
							</div>
							<button type="button" class="ts-step lg" aria-label="Larger text" disabled={textStep === TEXT_STEPS.length - 1} onclick={() => setTextStep(textStep + 1)}>A</button>
						</div>
					</div>
					<div class="pref">
						<span class="pref-label">Dock</span>
						<div class="seg" role="group" aria-label="Dock">
							<button type="button" aria-pressed={dock === 'floating'} onclick={() => setDock('floating')}><PanelLeftDashed size={14} /> Floating</button>
							<button type="button" aria-pressed={dock === 'fixed'} onclick={() => setDock('fixed')}><PanelLeft size={14} /> Fixed</button>
						</div>
					</div>
					<div class="menu-sep"></div>
					<form method="POST" action="/logout">
						<button type="submit" role="menuitem" class="logout"><LogOut size={15} /> Log out</button>
					</form>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.topbar {
		display: flex;
		align-items: center;
		gap: 18px;
		min-height: 68px;
		padding: 14px var(--ess-page-pad-x) 6px;
	}

	.today {
		font-size: 12px;
		color: var(--ess-text-muted);
		white-space: nowrap;
	}

	/* ---------- section links: quiet text, the current one in ink ---------- */
	.links {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: auto;
		min-width: 0;
	}
	.links a {
		position: relative;
		padding: 6px 10px;
		border-radius: 999px;
		color: var(--ess-text-muted);
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		transition: color var(--ess-t-fast);
	}
	.links a:hover {
		color: var(--ess-text);
	}
	.links a[aria-current='page'] {
		color: var(--ess-text);
		font-weight: 600;
	}
	.links a[aria-current='page']::after {
		content: '';
		position: absolute;
		left: 50%;
		bottom: -1px;
		width: 4px;
		height: 4px;
		margin-left: -2px;
		border-radius: 50%;
		background: var(--ess-primary);
	}

	.right {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.search {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 190px;
		height: 38px;
		padding: 0 16px;
		border: 1px solid transparent;
		border-radius: 999px;
		background: #e6e6ea;
		background: color-mix(in srgb, var(--ess-text) 7%, var(--ess-canvas));
		color: var(--ess-text-muted);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
		transition:
			background var(--ess-t-fast),
			border-color var(--ess-t-fast);
	}
	.search:hover {
		background: var(--ess-surface);
		border-color: var(--ess-border);
	}

	/* ---------- add ---------- */
	.add {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 38px;
		padding: 0 16px 0 13px;
		border-radius: 12px;
		background: var(--ess-primary);
		color: var(--ess-text-on-primary);
		box-shadow: var(--ess-primary-shadow);
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
		transition: background var(--ess-t-fast);
	}
	.add:hover {
		background: var(--ess-primary-hover);
		color: var(--ess-text-on-primary);
	}

	/* ---------- round buttons ---------- */
	.round {
		position: relative;
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		border-radius: 50%;
		background: var(--ess-surface);
		border: 1px solid var(--ess-border-subtle);
		color: var(--ess-text-secondary);
		box-shadow: 0 1px 2px rgba(20, 22, 40, 0.04);
		transition:
			background var(--ess-t-fast),
			color var(--ess-t-fast);
	}
	.round:hover {
		color: var(--ess-text);
		background: var(--ess-surface-hover);
	}
	.dot {
		position: absolute;
		top: 8px;
		right: 9px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ess-primary);
		box-shadow: 0 0 0 2px var(--ess-surface);
	}
	.dot.urgent {
		background: var(--ess-danger);
	}

	.me {
		position: relative;
	}
	.me-btn {
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: none;
		cursor: pointer;
		box-shadow: 0 0 0 2px var(--ess-surface), 0 4px 10px -4px rgba(20, 22, 40, 0.3);
	}

	.menu {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 80;
		min-width: 230px;
		padding: 6px;
		background: var(--ess-modal-bg);
		border: 1px solid var(--ess-border);
		border-radius: 14px;
		box-shadow: var(--ess-elev-3);
		display: grid;
		gap: 2px;
	}
	.who {
		display: grid;
		padding: 6px 10px 4px;
		line-height: 1.3;
	}
	.who strong {
		font-size: 13.5px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.who span {
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.menu a,
	.menu .logout {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 10px;
		border: none;
		border-radius: 9px;
		background: transparent;
		color: var(--ess-text);
		font: inherit;
		font-size: 13.5px;
		text-align: left;
		cursor: pointer;
	}
	.menu a:hover,
	.menu .logout:hover {
		background: var(--ess-surface-hover);
	}
	.menu .logout:hover {
		color: var(--ess-danger);
	}
	.menu-sep {
		height: 1px;
		background: var(--ess-border);
		margin: 4px 0;
	}
	.seg {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
		padding: 2px;
		background: var(--ess-sunken);
		border-radius: 9px;
	}
	.seg button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 6px 0;
		border: none;
		border-radius: 7px;
		background: transparent;
		color: var(--ess-text-secondary);
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
	}
	.seg button[aria-pressed='true'] {
		background: var(--ess-surface);
		color: var(--ess-primary-text);
		box-shadow: 0 1px 2px rgba(20, 22, 40, 0.08);
	}

	/* ---------- text size and dock, under the theme ---------- */
	.pref {
		display: grid;
		gap: 5px;
		padding: 6px 2px 0;
	}
	.pref-label {
		display: flex;
		justify-content: space-between;
		padding: 0 8px;
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.pref-label b {
		font-weight: 600;
		color: var(--ess-text-secondary);
		font-variant-numeric: tabular-nums;
	}
	.text-size {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		background: var(--ess-sunken);
		border-radius: 9px;
	}
	.ts-step {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--ess-text-secondary);
		font: inherit;
		font-weight: 600;
		line-height: 1;
		cursor: pointer;
	}
	.ts-step.sm {
		font-size: 11px;
	}
	.ts-step.lg {
		font-size: 16px;
	}
	.ts-step:hover:not(:disabled) {
		background: var(--ess-surface);
		color: var(--ess-text);
	}
	.ts-step:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.bars {
		flex: 1;
		display: flex;
		align-items: flex-end;
		gap: 4px;
		height: 24px;
	}
	.bar {
		flex: 1;
		padding: 0;
		border: none;
		border-radius: 3px;
		background: color-mix(in srgb, var(--ess-text) 14%, transparent);
		cursor: pointer;
		transition: background var(--ess-t-fast);
	}
	.bar:hover {
		background: color-mix(in srgb, var(--ess-primary) 45%, transparent);
	}
	.bar.on {
		background: var(--ess-primary);
	}

	/* Narrower laptops: the rail carries the sections. */
	/* Short laptop screens (e.g. 1280×720 at 150% scaling): a slimmer bar. */
	/* Desktop: the date and section links give way (the sidebar has the
	   sections) and the cluster floats at the top right, beside the page's
	   own header row. */
	@media (min-width: 1101px) {
		@container ess-fill (min-width: 1075px) {
			.topbar {
				position: absolute;
				top: var(--bar-top, 14px);
				right: var(--ess-page-pad-x);
				z-index: 25;
				min-height: 0;
				padding: 0;
			}
		}
		/* Not floating (the page scrolls with large text, or the workspace
		   is too narrow with a fixed dock): its own row. */
		@container ess-main (max-width: 1074px) {
			.right {
				margin-left: auto;
			}
		}
		:global([data-ess-flow]) .right {
			margin-left: auto;
		}
		.today,
		.links {
			display: none;
		}
		.right {
			gap: 8px;
		}
	}
	@media (min-width: 1101px) {
		@container ess-main (max-width: 1474px) {
			.search {
				width: 38px;
				padding: 0;
				justify-content: center;
				background: var(--ess-surface);
				border-color: var(--ess-border-subtle);
				color: var(--ess-text-secondary);
			}
			.search-label {
				display: none;
			}
		}
	}
	@media (min-width: 721px) and (max-width: 1100px) and (max-height: 760px) {
		.topbar {
			min-height: 50px;
			padding: 8px var(--ess-page-pad-x) 2px;
		}
	}
	@media (min-width: 721px) and (max-height: 760px) {
		.search,
		.add {
			height: 32px;
		}
		.round {
			width: 32px;
			height: 32px;
		}
	}

	@media (max-width: 1300px) {
		.links {
			display: none;
		}
		.right {
			margin-left: auto;
		}
	}
	@container ess-main (max-width: 1274px) {
		.add-label {
			display: none;
		}
		.add {
			width: 38px;
			padding: 0;
			justify-content: center;
		}
	}

	@media (max-width: 960px) {
		.settings,
		.today {
			display: none;
		}
	}

	@media (max-width: 720px) {
		.topbar {
			min-height: 56px;
			padding: 10px 14px 0;
		}
		.search {
			width: 38px;
			padding: 0;
			justify-content: center;
		}
		.search-label {
			display: none;
		}
	}
</style>
