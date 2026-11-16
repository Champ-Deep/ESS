<script lang="ts" module>
	import { drawFrame } from '$lib/motion/render';
	import { totalSeconds, type BrandKit, type MotionTemplate, type SlotValues } from '$lib/motion/templates';

	/**
	 * Records one full play of a template into a 1080×1920 WebM, in the
	 * browser (canvas + MediaRecorder): a file the Engagement team can download
	 * and use anywhere. Nothing is uploaded or rendered elsewhere.
	 */
	export async function recordMotion(template: MotionTemplate, values: SlotValues, brand: BrandKit, media: CanvasImageSource | null = null): Promise<Blob> {
		const canvas = document.createElement('canvas');
		canvas.width = 1080;
		canvas.height = 1920;
		const ctx = canvas.getContext('2d')!;
		const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
		const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 5_000_000 });
		const chunks: Blob[] = [];
		rec.ondataavailable = (e) => chunks.push(e.data);
		const total = totalSeconds(template);
		const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
		rec.start(250);
		const start = performance.now();
		await new Promise<void>((resolve) => {
			const tick = () => {
				const t = (performance.now() - start) / 1000;
				drawFrame(ctx, 1080, 1920, { template, values, brand, t: Math.min(t, total - 0.001), media });
				if (t < total) requestAnimationFrame(tick);
				else resolve();
			};
			tick();
		});
		rec.stop();
		await done;
		return new Blob(chunks, { type: 'video/webm' });
	}
</script>

<script lang="ts">
	/**
	 * Plays a motion template (src/lib/motion) on a canvas: the Home reel, the
	 * studio's previews. Loops unless `onended` is given, then plays once.
	 */
	let {
		template,
		values,
		brand,
		mediaUrl = null,
		playing = true,
		onended
	}: {
		template: MotionTemplate;
		values: SlotValues;
		brand: BrandKit;
		mediaUrl?: string | null;
		playing?: boolean;
		onended?: () => void;
	} = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let box = $state<HTMLElement | null>(null);
	let media = $state<HTMLVideoElement | null>(null);

	// Size the canvas to its box at the screen's pixel density.
	let w = $state(270);
	let h = $state(480);
	$effect(() => {
		if (!box) return;
		const ro = new ResizeObserver(() => {
			const r = box!.getBoundingClientRect();
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			w = Math.max(90, Math.round(r.width * dpr));
			h = Math.round((w * 16) / 9);
		});
		ro.observe(box);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!canvas || !playing) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const total = totalSeconds(template);
		const start = performance.now();
		let raf = 0;
		let ended = false;
		const tick = () => {
			const t = (performance.now() - start) / 1000;
			drawFrame(ctx, w, h, { template, values, brand, t: onended ? Math.min(t, total - 0.001) : t, media });
			if (onended && t >= total) {
				if (!ended) {
					ended = true;
					onended();
				}
				return;
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="motion" bind:this={box}>
	<canvas bind:this={canvas} width={w} height={h} aria-hidden="true"></canvas>
	{#if mediaUrl}
		<!-- A scene's background video: drawn into the canvas, never shown itself. -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video bind:this={media} src={mediaUrl} muted autoplay loop playsinline preload="auto" class="src"></video>
	{/if}
</div>

<style>
	.motion {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		border-radius: inherit;
		background: #111;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
	.src {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}
</style>
