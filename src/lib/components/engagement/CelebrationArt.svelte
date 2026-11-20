<script lang="ts">
	/**
	 * A celebration as a vertical reel frame: the template's video when there is
	 * one, else an animated backdrop for its theme, with the words on top. Used
	 * by the Home reel and the studio's preview. CSS only, no images to fetch.
	 */
	let {
		headline,
		message,
		theme = 'confetti',
		mediaUrl = null,
		playing = true,
		muted = true,
		onended
	}: {
		headline: string;
		message: string;
		theme?: string;
		mediaUrl?: string | null;
		playing?: boolean;
		muted?: boolean;
		onended?: () => void;
	} = $props();

	let video = $state<HTMLVideoElement | null>(null);
	$effect(() => {
		if (!video) return;
		if (playing) void video.play().catch(() => {});
		else video.pause();
	});

	const BITS = Array.from({ length: 14 }, (_, i) => i);
</script>

<div class="art" data-theme={theme}>
	{#if mediaUrl}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video bind:this={video} src={mediaUrl} {muted} playsinline preload="metadata" loop={!onended} onended={() => onended?.()}></video>
		<div class="shade"></div>
	{:else}
		<div class="bits" aria-hidden="true">
			{#each BITS as i (i)}<span style="--i:{i};--x:{(i * 37) % 100}"></span>{/each}
		</div>
	{/if}
	<div class="words">
		<strong>{headline}</strong>
		{#if message}<span>{message}</span>{/if}
	</div>
</div>

<style>
	.art {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		border-radius: inherit;
		color: #fff;
		background: linear-gradient(160deg, #ff7a59, #ff3d7f 55%, #7b5cff);
		container-type: inline-size;
	}
	.art[data-theme='stars'] {
		background: linear-gradient(165deg, #1b1f4b, #3b2a8f 60%, #0a7ad6);
	}
	.art[data-theme='hearts'] {
		background: linear-gradient(160deg, #ff8fb1, #e0336f 60%, #8a2be2);
	}
	.art[data-theme='calm'] {
		background: linear-gradient(160deg, #0fa3a3, #1572d3 65%, #3a3fa8);
	}
	video {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.shade {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, transparent 45%, rgba(0, 0, 0, 0.6));
	}
	.bits span {
		position: absolute;
		top: -10%;
		left: calc(var(--i) * 7.2%);
		width: 7px;
		height: 12px;
		border-radius: 2px;
		background: rgba(255, 255, 255, 0.85);
		opacity: 0.8;
		animation: fall calc(3.2s + var(--i) * 0.23s) linear infinite;
		animation-delay: calc(var(--i) * -0.41s);
	}
	.bits span:nth-child(3n) {
		background: #ffd84d;
	}
	.bits span:nth-child(4n) {
		background: #7cf3d0;
	}
	.art[data-theme='stars'] .bits span,
	.art[data-theme='calm'] .bits span {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: #fff;
		animation-name: twinkle;
		top: calc(var(--i) * 6.5%);
		left: calc(var(--x) * 1%);
	}
	.art[data-theme='hearts'] .bits span {
		width: 10px;
		height: 10px;
		border-radius: 50% 50% 0 50%;
		transform: rotate(45deg);
		background: rgba(255, 255, 255, 0.75);
		animation-name: rise;
		top: auto;
		bottom: -10%;
	}
	@keyframes fall {
		to {
			transform: translateY(1200%) rotate(540deg);
		}
	}
	@keyframes twinkle {
		50% {
			opacity: 0.15;
			transform: scale(0.6);
		}
	}
	@keyframes rise {
		to {
			transform: translateY(-1100%) rotate(45deg);
			opacity: 0;
		}
	}
	.words {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		display: grid;
		gap: 6px;
		padding: 14% 9% 12%;
		text-shadow: 0 1px 8px rgba(0, 0, 0, 0.35);
	}
	.words strong {
		font-size: clamp(14px, 11cqi, 30px);
		line-height: 1.12;
		font-weight: 750;
		letter-spacing: -0.01em;
	}
	.words span {
		font-size: clamp(10px, 6.4cqi, 17px);
		line-height: 1.35;
		opacity: 0.95;
	}
	@media (prefers-reduced-motion: reduce) {
		.bits span {
			animation: none;
		}
	}
</style>
