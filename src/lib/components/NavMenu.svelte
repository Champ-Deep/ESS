<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type Users from '@lucide/svelte/icons/users';

	// Svelte-native port of 21st.dev Origin UI Dropdown Menu, demo 383.
	// Native popovers provide the top layer and outside-click dismissal without React.
	let { id, label, items, active = false, severity, hint, action = false }: {
		id: string;
		label: string;
		items: { href: string; label: string; sub?: string; icon?: typeof Users; current?: boolean; severity?: string; hint?: string }[];
		active?: boolean;
		severity?: string;
		hint?: string;
		action?: boolean;
	} = $props();
	let trigger: HTMLButtonElement;
	let menu: HTMLDivElement;
	let open = $state(false);

	function position() {
		const rect = trigger.getBoundingClientRect();
		menu.style.maxHeight = `${Math.max(44, window.innerHeight - 16)}px`;
		menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
		menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
	}
	function show(last = false) {
		menu.showPopover();
		position();
		const links = menu.querySelectorAll<HTMLAnchorElement>('a');
		links[last ? links.length - 1 : 0]?.focus();
	}
	function close(restore = false) {
		menu.hidePopover();
		if (restore) trigger.focus();
	}
	function triggerKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			show(e.key === 'ArrowUp');
		}
	}
	function menuKey(e: KeyboardEvent) {
		if (e.key === 'Escape' || e.key === 'Tab') {
			if (e.key === 'Escape') e.preventDefault();
			close(true);
			return;
		}
		const links = [...menu.querySelectorAll<HTMLAnchorElement>('a')];
		const index = links.indexOf(document.activeElement as HTMLAnchorElement);
		let next = index;
		if (e.key === 'ArrowDown') next = (index + 1) % links.length;
		else if (e.key === 'ArrowUp') next = (index - 1 + links.length) % links.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = links.length - 1;
		else if (e.key === ' ') { e.preventDefault(); links[index]?.click(); return; }
		else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			next = links.findIndex((link, i) => i > index && link.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()));
			if (next < 0) next = links.findIndex((link) => link.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()));
		} else return;
		e.preventDefault();
		links[next]?.focus();
	}
</script>

<svelte:window onresize={() => { if (open) position(); }} onscroll={() => { if (open) close(); }} />
<button bind:this={trigger} id="{id}-trigger" type="button" class:action
	class="nav-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={id}
	aria-current={active ? 'page' : undefined} title={hint}
	onclick={() => open ? close() : show()} onkeydown={triggerKey}>
	{label}<ChevronDown size={14} aria-hidden="true" />
	{#if severity && severity !== 'info'}<span class="dot" data-sev={severity}><span class="ess-sr-only">Needs attention</span></span>{/if}
</button>
<div bind:this={menu} {id} popover="auto" role="menu" aria-labelledby="{id}-trigger" tabindex="-1"
	class="nav-menu" ontoggle={() => (open = menu.matches(':popover-open'))} onkeydown={menuKey}>
	{#each items as item (item.href)}
		<a role="menuitem" tabindex="-1" href={item.href} aria-current={item.current ? 'page' : undefined} title={item.hint} onclick={() => close()}>
			{#if item.icon}{@const Icon = item.icon}<Icon size={16} aria-hidden="true" />{/if}
			<span class="item-text"><span>{item.label}</span>{#if item.sub}<small>{item.sub}</small>{/if}</span>
			{#if item.severity && item.severity !== 'info'}<span class="dot" data-sev={item.severity}><span class="ess-sr-only">Needs attention</span></span>{/if}
		</a>
	{/each}
</div>

<style>
	.nav-trigger {
		display: inline-flex; align-items: center; gap: var(--ess-space-2);
		min-height: 44px; padding: var(--ess-space-2) var(--ess-space-3);
		border: 0; border-radius: var(--ess-radius-sm); background: transparent;
		color: var(--ess-text-secondary); font: inherit; font-size: var(--ess-fs-caption); cursor: pointer;
	}
	.nav-trigger[aria-current='page'], .nav-trigger:hover { background: var(--ess-primary-soft); color: var(--ess-primary-text); }
	.nav-trigger.action { border: 1px solid var(--ess-border); background: var(--ess-surface); color: var(--ess-text); }
	.nav-menu {
		position: fixed; inset: auto; margin: 0; padding: var(--ess-space-1);
		width: max-content; min-width: min(200px, calc(100vw - 16px)); max-width: min(340px, calc(100vw - 16px));
		overflow-y: auto; border: 1px solid var(--ess-border); border-radius: var(--ess-radius-sm);
		background: var(--ess-surface); color: var(--ess-text); box-shadow: var(--ess-elev-3);
	}
	.nav-menu a {
		display: flex; align-items: center; gap: var(--ess-space-2); min-height: 44px;
		padding: var(--ess-space-2); border-radius: var(--ess-radius-xs);
		color: var(--ess-text); text-decoration: none; font-size: var(--ess-fs-body);
	}
	.nav-menu a:hover, .nav-menu a:focus, .nav-menu a[aria-current='page'] { background: var(--ess-primary-soft); color: var(--ess-primary-text); }
	.nav-trigger:focus-visible, .nav-menu a:focus-visible { outline: 2px solid var(--ess-primary-text); outline-offset: -2px; }
	.item-text { display: grid; gap: var(--ess-space-1); min-width: 0; }
	small { color: var(--ess-text-secondary); font-size: var(--ess-fs-caption); }
	.nav-menu :global(svg) { flex-shrink: 0; }
	.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.dot[data-sev='bad'] { background: var(--ess-danger); }
	.dot[data-sev='warn'] { background: var(--ess-warning); }
</style>
