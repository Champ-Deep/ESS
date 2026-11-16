<script lang="ts">
	import { onMount, tick } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import Volume2 from '@lucide/svelte/icons/volume-2';
	import VolumeX from '@lucide/svelte/icons/volume-x';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Minus from '@lucide/svelte/icons/minus';
	import CelebrationArt from './CelebrationArt.svelte';
	import MotionPlayer from './MotionPlayer.svelte';
	import { DEFAULT_BRAND, motionTemplate, totalSeconds, type BrandKit, type SlotValues } from '$lib/motion/templates';

	/**
	 * The Home page's "live" reel: today's celebrations (birthdays, work and
	 * wedding anniversaries, from the Engagement studio's templates) and the
	 * studio's short reels. A small vertical card plays muted in the corner;
	 * tapping it opens a full reel viewer with sound. Videos stream from the
	 * portal itself (/api/engagement/media). Nothing shows on a day with
	 * nothing to show.
	 */
	type Motion = { templateId: string; values: SlotValues } | null;
	type Item =
		| { key: string; type: 'celebration'; kind: string; headline: string; message: string; theme: string; mediaUrl: string | null; motion: Motion; isYou: boolean }
		| { key: string; type: 'reel'; title: string; caption: string; mediaUrl: string | null; motion: Motion; durationSec: number | null };
	let brand = $state<BrandKit>(DEFAULT_BRAND);
	/** A motion template plays for its own length; a video until it ends. */
	const motionOf = (it: Item | undefined) => (it?.motion ? motionTemplate(it.motion.templateId) : null);

	const STILL_MS = 6000; // a celebration with no video stays this long

	let items = $state<Item[]>([]);
	let index = $state(0);
	let open = $state(false);
	let small = $state(false);
	let muted = $state(true);
	let progress = $state(0);
	let video = $state<HTMLVideoElement | null>(null);
	let dialog = $state<HTMLElement | null>(null);

	const item = $derived(items[index] as Item | undefined);

	onMount(() => {
		try {
			small = sessionStorage.getItem('essReelSmall') === '1';
		} catch {
			/* storage blocked */
		}
		void fetch('/api/engagement/home')
			.then((r) => (r.ok ? r.json() : { items: [] }))
			.then((b: { items: Item[]; brand?: BrandKit }) => {
				items = b.items ?? [];
				if (b.brand) brand = b.brand;
			})
			.catch(() => {});
	});

	function setSmall(v: boolean) {
		small = v;
		try {
			sessionStorage.setItem('essReelSmall', v ? '1' : '0');
		} catch {
			/* storage blocked */
		}
	}

	function go(to: number) {
		if (!items.length) return;
		index = (to + items.length) % items.length;
		progress = 0;
	}

	// Advance: a video when it ends, a still card after a few seconds. Paused
	// while the card is shrunk to its bubble.
	$effect(() => {
		const current = item;
		if (!current || small) return;
		const mt = motionOf(current);
		const hasVideo = !mt && !!current.mediaUrl;
		const stillMs = mt ? totalSeconds(mt) * 1000 : STILL_MS;
		const started = performance.now();
		let raf = 0;
		const tickFrame = () => {
			if (hasVideo && video && video.duration) progress = Math.min(1, video.currentTime / video.duration);
			else if (!hasVideo) {
				progress = Math.min(1, (performance.now() - started) / stillMs);
				if (progress >= 1) return go(index + 1);
			}
			raf = requestAnimationFrame(tickFrame);
		};
		raf = requestAnimationFrame(tickFrame);
		return () => cancelAnimationFrame(raf);
	});

	// Count a view once it has played for two seconds, once per session.
	const counted = new Set<string>();
	$effect(() => {
		const key = item?.key;
		if (!key || small || counted.has(key)) return;
		const t = setTimeout(() => {
			counted.add(key);
			void fetch('/api/engagement/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => {});
		}, 2000);
		return () => clearTimeout(t);
	});

	async function openViewer() {
		open = true;
		muted = false;
		await tick();
		dialog?.focus();
	}
	function closeViewer() {
		open = false;
		muted = true;
	}

	function onKey(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') closeViewer();
		else if (e.key === 'ArrowRight') go(index + 1);
		else if (e.key === 'ArrowLeft') go(index - 1);
		else return;
		e.preventDefault();
	}

	let touchX = 0;
	function onTouchEnd(e: TouchEvent) {
		const dx = e.changedTouches[0].clientX - touchX;
		if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
	}

	const label = (it: Item) => (it.type === 'reel' ? it.title : it.headline);
</script>

<svelte:window onkeydown={onKey} />

{#snippet frame(it: Item, inViewer: boolean)}
	{@const mt = motionOf(it)}
	{#if mt && it.motion}
		<MotionPlayer template={mt} values={it.motion.values} {brand} mediaUrl={it.mediaUrl} />
	{:else if it.type === 'celebration'}
		<CelebrationArt headline={it.headline} message={it.message} theme={it.theme} mediaUrl={it.mediaUrl} muted={inViewer ? muted : true} onended={() => go(index + 1)} />
	{:else}
		<div class="reel">
			<!-- svelte-ignore a11y_media_has_caption -->
			<video bind:this={video} src={it.mediaUrl ?? undefined} muted={inViewer ? muted : true} autoplay playsinline preload="metadata" onended={() => go(index + 1)}></video>
			<div class="caption">
				<strong>{it.title}</strong>
				{#if it.caption}<span>{it.caption}</span>{/if}
			</div>
		</div>
	{/if}
{/snippet}

{#snippet bars()}
	<div class="bars" aria-hidden="true">
		{#each items as it, i (it.key)}
			<span><i style:width="{i < index ? 100 : i === index ? progress * 100 : 0}%"></i></span>
		{/each}
	</div>
{/snippet}

{#if item && !open}
	{#if small}
		<button type="button" class="bubble" onclick={() => setSmall(false)} aria-label="Show the live reel: {label(item)}" data-tour="home-reel">
			<span class="ring"></span>
			<span class="live">LIVE</span>
		</button>
	{:else}
		<div class="mini" data-tour="home-reel">
			<button type="button" class="mini-hit" onclick={openViewer} aria-label="Watch {label(item)}">
				{#key item.key}{@render frame(item, false)}{/key}
			</button>
			{@render bars()}
			<span class="live tag"><span class="dot"></span>LIVE</span>
			<button type="button" class="mini-x" onclick={() => setSmall(true)} aria-label="Shrink the live reel"><Minus size={14} /></button>
		</div>
	{/if}
{/if}

{#if open && item}
	<div class="viewer" role="dialog" aria-modal="true" aria-label="Live on Home" tabindex="-1" bind:this={dialog}>
		<button type="button" class="backdrop" aria-label="Close" onclick={closeViewer}></button>
		<div class="stage" ontouchstart={(e) => (touchX = e.touches[0].clientX)} ontouchend={onTouchEnd}>
			{#key item.key}{@render frame(item, true)}{/key}
			{@render bars()}
			<div class="top">
				<span class="live tag"><span class="dot"></span>LIVE</span>
				<span class="count">{index + 1} / {items.length}</span>
				<button type="button" class="round" onclick={() => (muted = !muted)} aria-label={muted ? 'Sound on' : 'Sound off'}>{#if muted}<VolumeX size={17} />{:else}<Volume2 size={17} />{/if}</button>
				<button type="button" class="round" onclick={closeViewer} aria-label="Close"><X size={18} /></button>
			</div>
			<button type="button" class="tap left" onclick={() => go(index - 1)} aria-label="Previous"></button>
			<button type="button" class="tap right" onclick={() => go(index + 1)} aria-label="Next"></button>
		</div>
		{#if items.length > 1}
			<button type="button" class="nav prev" onclick={() => go(index - 1)} aria-label="Previous"><ChevronLeft size={22} /></button>
			<button type="button" class="nav next" onclick={() => go(index + 1)} aria-label="Next"><ChevronRight size={22} /></button>
		{/if}
	</div>
{/if}

<style>
	.mini {
		position: fixed;
		left: 22px;
		bottom: 22px;
		z-index: 65;
		width: 128px;
		aspect-ratio: 9 / 16;
		border-radius: 18px;
		overflow: hidden;
		background: #111;
		box-shadow:
			0 18px 40px -14px rgba(10, 12, 30, 0.55),
			0 0 0 3px #fff;
		animation: pop 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.mini-hit {
		all: unset;
		position: absolute;
		inset: 0;
		cursor: pointer;
		border-radius: inherit;
	}
	.mini-hit:focus-visible {
		outline: 3px solid var(--ess-primary);
	}
	.mini-x {
		position: absolute;
		top: 16px;
		right: 6px;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.45);
		color: #fff;
		cursor: pointer;
	}
	.bubble {
		position: fixed;
		left: 22px;
		bottom: 22px;
		z-index: 65;
		display: grid;
		place-items: center;
		width: 58px;
		height: 58px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: linear-gradient(160deg, #ff7a59, #ff3d7f 55%, #7b5cff);
		cursor: pointer;
		box-shadow: 0 10px 26px -10px rgba(10, 12, 30, 0.6);
	}
	.ring {
		position: absolute;
		inset: -5px;
		border-radius: 50%;
		border: 3px solid #ff3d7f;
		animation: pulse 1.8s ease-out infinite;
	}
	.live {
		font: 700 10px/1 var(--ess-font-sans);
		letter-spacing: 0.08em;
		color: #fff;
	}
	.tag {
		position: absolute;
		top: 14px;
		left: 8px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 6px;
		border-radius: 6px;
		background: #ff2d55;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #fff;
		animation: blink 1.2s ease-in-out infinite;
	}
	.bars {
		position: absolute;
		top: 6px;
		left: 8px;
		right: 8px;
		display: flex;
		gap: 3px;
		pointer-events: none;
	}
	.bars span {
		flex: 1;
		height: 3px;
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.35);
		overflow: hidden;
	}
	.bars i {
		display: block;
		height: 100%;
		background: #fff;
	}
	.reel {
		position: relative;
		width: 100%;
		height: 100%;
		background: #000;
	}
	.reel video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.caption {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		display: grid;
		gap: 3px;
		padding: 30% 9% 9%;
		color: #fff;
		background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.65));
		container-type: inline-size;
	}
	.caption strong {
		font-size: clamp(12px, 8cqi, 22px);
		line-height: 1.15;
	}
	.caption span {
		font-size: clamp(10px, 5.5cqi, 15px);
		opacity: 0.92;
	}

	/* ---------- full viewer ---------- */
	.viewer {
		position: fixed;
		inset: 0;
		z-index: 1100;
		display: grid;
		place-items: center;
		outline: none;
	}
	.backdrop {
		position: absolute;
		inset: 0;
		border: none;
		background: rgba(8, 9, 20, 0.86);
		cursor: zoom-out;
	}
	.stage {
		position: relative;
		height: min(88vh, 860px);
		aspect-ratio: 9 / 16;
		max-width: calc(100vw - 24px);
		border-radius: 22px;
		overflow: hidden;
		background: #000;
		box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.8);
		animation: pop 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.stage .bars {
		top: 10px;
		left: 12px;
		right: 12px;
	}
	.top {
		position: absolute;
		top: 22px;
		left: 12px;
		right: 12px;
		display: flex;
		align-items: center;
		gap: 8px;
		z-index: 2;
	}
	.top .tag {
		position: static;
	}
	.count {
		flex: 1;
		color: rgba(255, 255, 255, 0.85);
		font-size: 12px;
	}
	.round {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.45);
		color: #fff;
		cursor: pointer;
	}
	.tap {
		position: absolute;
		top: 70px;
		bottom: 0;
		width: 30%;
		border: none;
		background: transparent;
		cursor: pointer;
		z-index: 1;
	}
	.tap.left {
		left: 0;
	}
	.tap.right {
		right: 0;
	}
	.nav {
		position: absolute;
		top: 50%;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-top: -22px;
		border: none;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.14);
		color: #fff;
		cursor: pointer;
	}
	.nav.prev {
		left: calc(50% - min(88vh, 860px) * 9 / 32 - 64px);
	}
	.nav.next {
		right: calc(50% - min(88vh, 860px) * 9 / 32 - 64px);
	}
	@media (max-width: 720px) {
		.mini {
			width: 96px;
			left: 72px;
			bottom: 12px;
		}
		.nav {
			display: none;
		}
	}
	@keyframes pop {
		from {
			opacity: 0;
			transform: translateY(12px) scale(0.96);
		}
	}
	@keyframes pulse {
		from {
			opacity: 0.9;
			transform: scale(0.92);
		}
		to {
			opacity: 0;
			transform: scale(1.25);
		}
	}
	@keyframes blink {
		50% {
			opacity: 0.3;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.mini,
		.stage,
		.ring,
		.dot {
			animation: none;
		}
	}
</style>
