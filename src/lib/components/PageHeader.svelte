<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The one-row page bar every screen opens with: the section's name, its
	 * tabs, any page tools, and the page's actions on the right. On desktop
	 * it shares the row with the floating top-bar cluster (search, add,
	 * settings, notifications, avatar), which sits in the space reserved
	 * on its right (--topbar-w, measured by TopBar).
	 *
	 * The longer headline (`title`) and its subtitle (`sub`) are no longer
	 * shown — the bar trades them for room for the page — but the headline
	 * stays as the name's tooltip.
	 */
	interface Props {
		/** Crumb segments; a string is text, an object a link. The bar shows
		 *  the first plain segment as the page's name. */
		crumb?: (string | { label: string; href: string })[];
		/** Overrides the name taken from the crumb. */
		label?: string;
		title: string;
		sub?: string;
		/** The page's own tabs, shown beside the name. */
		tabs?: Snippet;
		/** Buttons at the right end of the bar. */
		actions?: Snippet;
		/** Page tools between the tabs and the actions (a search, figures). */
		children?: Snippet;
		/** Kept for compatibility; the bar is always compact now. */
		compact?: boolean;
	}

	let { crumb = [], label, title, sub, tabs, actions, children }: Props = $props();

	const name = $derived.by(() => {
		if (label) return label;
		const first = crumb[0];
		if (typeof first === 'string') return first;
		const lastText = [...crumb].reverse().find((c) => typeof c === 'string');
		return (lastText as string | undefined) ?? title;
	});
	const back = $derived(crumb.find((c) => typeof c !== 'string') as { label: string; href: string } | undefined);
</script>

<!-- data-tour: anchors for the guided tour (src/lib/tour/steps.ts). -->
<header class="ess-page-head bar" data-tour="page">
	{#if back && typeof crumb[0] !== 'string'}
		<a class="back" href={back.href} title="Back to {back.label}">{back.label}<span aria-hidden="true">/</span></a>
	{/if}
	<h1 class="ess-page-title bar-title" title={sub ? `${title} ${sub}` : title}>{name}</h1>
	{#if tabs}<div class="bar-tabs" data-tour="page-tabs">{@render tabs()}</div>{/if}
	{#if children}<div class="bar-extra">{@render children()}</div>{/if}
	{#if actions}<div class="ess-page-head__actions bar-actions" data-tour="page-actions">{@render actions()}</div>{/if}
</header>

<style>
	.bar {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		flex-wrap: wrap;
		gap: 8px 14px;
		min-height: 38px;
		margin-bottom: 12px;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-right: -6px;
		font-size: 13px;
		font-weight: 500;
		color: var(--ess-text-muted);
		white-space: nowrap;
	}
	.back:hover {
		color: var(--ess-primary-text);
	}
	.bar-title {
		margin: 0;
		font-size: 21px;
		line-height: 1.2;
		font-weight: 650;
		letter-spacing: -0.022em;
		white-space: nowrap;
	}
	.bar-tabs {
		display: flex;
		min-width: 0;
		max-width: 100%;
	}
	/* Tab rows moved up from the page keep none of their old spacing. */
	.bar .bar-tabs > :global(*) {
		min-width: 0;
		margin: 0;
		align-self: center;
	}
	.bar-extra {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		flex: 1 1 auto;
	}
	.bar-actions {
		margin-left: auto;
		flex-wrap: nowrap;
	}

	/* Desktop: one row, sharing it with the floating top-bar cluster. */
	@media (min-width: 1101px) {
		@container ess-fill (min-width: 1075px) {
			.bar {
				flex-wrap: nowrap;
				padding-right: calc(var(--topbar-w, 380px) + 14px);
			}
			.bar-tabs {
				flex: 0 1 auto;
			}
		}
	}
	@media (min-width: 721px) and (max-height: 760px) {
		.bar {
			min-height: 32px;
			margin-bottom: 8px;
		}
		.bar-title {
			font-size: 19px;
		}
	}
	/* Narrow screens: name and actions on a line, the tabs below in full. */
	@container ess-main (max-width: 1074px) {
		.bar-tabs {
			order: 5;
			flex-basis: 100%;
		}
		.bar-tabs > :global(*) {
			max-width: 100%;
			overflow-x: auto;
		}
		.bar-extra {
			order: 6;
			flex-basis: 100%;
		}
	}
</style>
