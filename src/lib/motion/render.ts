import type { Anim, BrandKit, Fill, Layer, MotionTemplate, SlotValues, TextStyle } from './templates';

/**
 * Draws a motion template (src/lib/motion/templates.ts) onto a canvas at a
 * moment in time. The same frames play live on Home and in the studio, and
 * are recorded into a WebM in the browser when the Engagement team
 * downloads one: no server rendering, nothing fetched.
 *
 * The timing and animation maths are pure functions, tested on their own.
 */

/** {slot} and {list.0} → the filled values; unknown names are left as written. */
export function fillSlots(text: string, values: SlotValues): string {
	return text.replace(/\{([a-z_]+)(?:\.(\d))?\}/gi, (whole, key: string, idx?: string) => {
		const v = values[key];
		if (v === undefined) return whole;
		if (Array.isArray(v)) return idx !== undefined ? (v[Number(idx)] ?? '') : v.join(', ');
		return v;
	});
}

/** Which scene plays at `t` seconds, and how far into it. Loops past the end. */
export function sceneAt(t: MotionTemplate, at: number): { index: number; local: number } {
	const total = t.scenes.reduce((s, sc) => s + sc.sec, 0);
	let rest = total > 0 ? at % total : 0;
	for (let i = 0; i < t.scenes.length; i++) {
		if (rest < t.scenes[i].sec) return { index: i, local: rest };
		rest -= t.scenes[i].sec;
	}
	return { index: t.scenes.length - 1, local: t.scenes.at(-1)?.sec ?? 0 };
}

export type AnimState = { alpha: number; dx: number; dy: number; scale: number; reveal: number };
const NONE: AnimState = { alpha: 1, dx: 0, dy: 0, scale: 1, reveal: 1 };
const HIDDEN: AnimState = { alpha: 0, dx: 0, dy: 0, scale: 1, reveal: 0 };

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const easeBack = (p: number) => {
	const c = 1.70158;
	return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

function enter(a: Anim, p: number): AnimState {
	const e = easeOut(p);
	switch (a.type) {
		case 'fade':
			return { ...NONE, alpha: e };
		case 'pop':
			return { ...NONE, alpha: Math.min(1, p * 2), scale: 0.6 + 0.4 * easeBack(p) };
		case 'slide-up':
			return { ...NONE, alpha: e, dy: (1 - e) * 0.04 };
		case 'slide-left':
			return { ...NONE, alpha: e, dx: (1 - e) * 0.08 };
		case 'slide-right':
			return { ...NONE, alpha: e, dx: -(1 - e) * 0.08 };
		case 'zoom-in':
			return { ...NONE, alpha: e, scale: 1.25 - 0.25 * e };
		case 'wipe':
			return { ...NONE, reveal: e };
	}
}

/** A layer's look at `local` seconds into its scene of `sceneSec` seconds. */
export function animAt(layer: { start: number; end?: number; in?: Anim; out?: Anim }, local: number, sceneSec: number): AnimState {
	if (local < layer.start) return HIDDEN;
	const end = layer.end ?? sceneSec;
	if (local > end) return HIDDEN;
	let s = NONE;
	if (layer.in && local < layer.start + layer.in.sec) s = enter(layer.in, (local - layer.start) / layer.in.sec);
	if (layer.out && local > end - layer.out.sec) {
		const o = enter(layer.out, (end - local) / layer.out.sec);
		s = { alpha: s.alpha * o.alpha, dx: s.dx + o.dx, dy: s.dy + o.dy, scale: s.scale * o.scale, reveal: Math.min(s.reveal, o.reveal) };
	}
	return s;
}

/* ------------------------------------------------------------- drawing */

const FONT = 'system-ui, -apple-system, "Segoe UI", Inter, Roboto, sans-serif';
const STYLE: Record<TextStyle, { size: number; weight: number; upper?: boolean; spacing?: number; lineHeight: number }> = {
	eyebrow: { size: 0.022, weight: 700, upper: true, spacing: 0.12, lineHeight: 1.3 },
	body: { size: 0.026, weight: 500, lineHeight: 1.4 },
	subtitle: { size: 0.034, weight: 600, lineHeight: 1.32 },
	button: { size: 0.028, weight: 700, lineHeight: 1.2 },
	title: { size: 0.056, weight: 800, lineHeight: 1.1 },
	stat: { size: 0.12, weight: 850, lineHeight: 1 }
};

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
	const lines: string[] = [];
	for (const para of text.split('\n')) {
		let line = '';
		for (const word of para.split(/\s+/).filter(Boolean)) {
			const next = line ? `${line} ${word}` : word;
			if (ctx.measureText(next).width > width && line) {
				lines.push(line);
				line = word;
			} else line = next;
		}
		lines.push(line);
	}
	return lines;
}

/** Deterministic pseudo-random in [0, 1) so confetti is the same every play. */
const rand = (n: number) => {
	const x = Math.sin(n * 12.9898) * 43758.5453;
	return x - Math.floor(x);
};

export type FrameInput = {
	template: MotionTemplate;
	values: SlotValues;
	brand: BrandKit;
	/** Seconds since the start. */
	t: number;
	/** An uploaded video or image for scenes with a media background. */
	media?: CanvasImageSource | null;
};

export function drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number, f: FrameInput): void {
	const { index, local } = sceneAt(f.template, f.t);
	const scene = f.template.scenes[index];
	const color = (c: Fill) => f.brand.colors[c];

	// Background
	if (scene.background.kind === 'solid') {
		ctx.fillStyle = color(scene.background.fill);
		ctx.fillRect(0, 0, w, h);
	} else {
		const g = ctx.createLinearGradient(0, 0, w, h);
		g.addColorStop(0, f.brand.gradient[0]);
		g.addColorStop(0.55, f.brand.gradient[1]);
		g.addColorStop(1, f.brand.gradient[2]);
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, w, h);
		if (scene.background.kind === 'media' && f.media) {
			drawCover(ctx, f.media, w, h);
			const shade = ctx.createLinearGradient(0, h * 0.35, 0, h);
			shade.addColorStop(0, 'rgba(0,0,0,0)');
			shade.addColorStop(1, 'rgba(0,0,0,0.72)');
			ctx.fillStyle = shade;
			ctx.fillRect(0, 0, w, h);
		}
	}

	for (const [i, layer] of scene.layers.entries()) drawLayer(ctx, w, h, layer, local, scene.sec, f, color, index * 100 + i);
}

function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number) {
	const s = src as { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
	const sw = s.videoWidth || s.naturalWidth || Number(s.width) || w;
	const sh = s.videoHeight || s.naturalHeight || Number(s.height) || h;
	if (!sw || !sh) return;
	const scale = Math.max(w / sw, h / sh);
	const dw = sw * scale;
	const dh = sh * scale;
	try {
		ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
	} catch {
		/* not ready yet */
	}
}

function drawLayer(ctx: CanvasRenderingContext2D, w: number, h: number, layer: Layer, local: number, sceneSec: number, f: FrameInput, color: (c: Fill) => string, seed: number) {
	if (layer.type === 'confetti') {
		if (local < layer.start) return;
		const age = local - layer.start;
		for (let i = 0; i < layer.count; i++) {
			const x0 = rand(seed + i) * w;
			const speed = 0.18 + rand(seed + i + 50) * 0.22;
			const y = ((rand(seed + i + 90) * 0.4 - 0.15 + age * speed) % 1.15) * h;
			const size = (0.008 + rand(seed + i + 130) * 0.01) * w;
			ctx.save();
			ctx.globalAlpha = Math.min(1, age * 2) * 0.85;
			ctx.translate(x0 + Math.sin(age * 2 + i) * w * 0.02, y);
			ctx.rotate(age * (1 + rand(seed + i + 170) * 3));
			ctx.fillStyle = color(layer.palette[i % layer.palette.length]);
			ctx.fillRect(-size / 2, -size, size, size * 1.8);
			ctx.restore();
		}
		return;
	}

	const a = animAt(layer, local, sceneSec);
	if (a.alpha <= 0 || a.reveal <= 0) return;
	const [bx, by, bw, bh] = layer.box;
	const x = (bx + a.dx) * w;
	const y = (by + a.dy) * h;
	const bw2 = bw * w;
	const bh2 = bh * h;

	ctx.save();
	ctx.globalAlpha = a.alpha * (layer.type === 'shape' ? (layer.opacity ?? 1) : 1);
	if (a.scale !== 1) {
		ctx.translate(x + bw2 / 2, y + bh2 / 2);
		ctx.scale(a.scale, a.scale);
		ctx.translate(-(x + bw2 / 2), -(y + bh2 / 2));
	}
	if (a.reveal < 1) {
		ctx.beginPath();
		ctx.rect(x, y - bh2, bw2 * a.reveal, bh2 * 3);
		ctx.clip();
	}

	if (layer.type === 'shape') {
		ctx.fillStyle = color(layer.fill);
		ctx.beginPath();
		if (layer.shape === 'ellipse') ctx.ellipse(x + bw2 / 2, y + bh2 / 2, bw2 / 2, bh2 / 2, 0, 0, Math.PI * 2);
		else if (layer.shape === 'pill') ctx.roundRect(x, y, bw2, bh2, Math.min(bw2, bh2) / 2);
		else ctx.rect(x, y, bw2, bh2);
		ctx.fill();
	} else {
		const st = STYLE[layer.style];
		let text = fillSlots(layer.text, f.values).trim();
		if (st.upper) text = text.toUpperCase();
		if (text) {
			// Shrink to fit the box: long names and messages still fit the frame.
			let size = st.size * h;
			let lines: string[] = [];
			for (let tries = 0; tries < 12; tries++) {
				ctx.font = `${st.weight} ${size}px ${FONT}`;
				lines = wrap(ctx, text, bw2);
				// Fits both ways: a long single word ("Engagement!") must not run off the frame.
				const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
				const tallEnough = lines.length * size * st.lineHeight <= Math.max(bh2, size * st.lineHeight);
				if ((tallEnough && widest <= bw2) || size < 10) break;
				size *= 0.9;
			}
			ctx.fillStyle = color(layer.color ?? 'text');
			ctx.textBaseline = 'top';
			ctx.textAlign = layer.align === 'center' ? 'center' : 'left';
			if (st.spacing) (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${st.spacing * size}px`;
			ctx.shadowColor = 'rgba(0,0,0,0.25)';
			ctx.shadowBlur = size * 0.25;
			const tx = layer.align === 'center' ? x + bw2 / 2 : x;
			const lineH = size * st.lineHeight;
			const top = layer.style === 'button' ? y + (bh2 - lines.length * lineH) / 2 : y;
			lines.forEach((line, i) => ctx.fillText(line, tx, top + i * lineH));
		}
	}
	ctx.restore();
}
