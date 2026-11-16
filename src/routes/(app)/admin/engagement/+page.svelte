<script lang="ts">
	import { enhance } from '$app/forms';
	import Cake from '@lucide/svelte/icons/cake';
	import Award from '@lucide/svelte/icons/award';
	import Heart from '@lucide/svelte/icons/heart';
	import Eye from '@lucide/svelte/icons/eye';
	import Megaphone from '@lucide/svelte/icons/megaphone';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Upload from '@lucide/svelte/icons/upload';
	import Pause from '@lucide/svelte/icons/pause';
	import Play from '@lucide/svelte/icons/play';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Download from '@lucide/svelte/icons/download';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import DeskStatsCard from '$lib/components/DeskStatsCard.svelte';
	import MotionPlayer, { recordMotion } from '$lib/components/engagement/MotionPlayer.svelte';
	import SlotFields from '$lib/components/engagement/SlotFields.svelte';
	import { CELEBRATION_KINDS, CELEBRATION_LABEL, REEL_MAX_SECONDS, renderTemplate, type CelebrationKind } from '$lib/engagement';
	import { CELEBRATION_TEMPLATE, MOTION_TEMPLATES, motionTemplate, totalSeconds, withDefaults, type BrandKit, type SlotValues } from '$lib/motion/templates';

	let { data, form } = $props();

	type Tab = 'overview' | 'celebrations' | 'create' | 'reels' | 'brand';
	let tab = $state<Tab>((form as { tab?: Tab } | null)?.tab ?? 'overview');
	$effect(() => {
		const t = (form as { tab?: Tab } | null)?.tab;
		if (t) tab = t;
	});

	const ICON: Record<CelebrationKind, typeof Cake> = { birthday: Cake, work_anniversary: Award, wedding_anniversary: Heart };
	const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
	const s = $derived(data.stats);

	/* ---------- brand kit (edited live, used by every preview) ---------- */
	let brand = $state<BrandKit>(structuredClone(data.brand));
	const COLOR_LABEL: Record<keyof BrandKit['colors'], string> = { primary: 'Primary', accent: 'Accent', dark: 'Dark background', light: 'Light', text: 'Text', muted: 'Soft text' };

	/* ---------- person-filled preview values ---------- */
	function sampleFor(kind: CelebrationKind) {
		const next = data.upcoming.find((u) => u.kind === kind);
		return next ? { person: { fullName: next.fullName, team: next.team }, years: next.years } : { person: { fullName: 'Asha Rao', team: 'Data Team' }, years: kind === 'birthday' ? null : 3 };
	}
	function personalise(values: SlotValues, kind: CelebrationKind): SlotValues {
		const { person, years } = sampleFor(kind);
		return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => renderTemplate(x, person, years)) : renderTemplate(v, person, years)]));
	}

	/* ---------- celebrations: one template each, filled per person ---------- */
	type Cel = { enabled: boolean; templateId: string; values: SlotValues; videoUrl: string | null; durationSec: string; removeVideo: boolean; error: string };
	const cels = $state(
		Object.fromEntries(
			CELEBRATION_KINDS.map((k) => {
				const t = data.templates[k];
				const mt = motionTemplate(t.motionTemplate) ?? motionTemplate(CELEBRATION_TEMPLATE[k])!;
				return [k, { enabled: t.enabled, templateId: mt.id, values: withDefaults(mt, t.slotValues), videoUrl: t.mediaUrl, durationSec: '', removeVideo: false, error: '' } satisfies Cel];
			})
		) as Record<CelebrationKind, Cel>
	);
	function switchTemplate(kind: CelebrationKind, id: string) {
		const mt = motionTemplate(id);
		if (!mt) return;
		cels[kind].templateId = id;
		cels[kind].values = withDefaults(mt, null);
	}

	/** Reads a chosen video's length in the browser, before anything is uploaded. */
	function readDuration(file: File): Promise<number> {
		return new Promise((resolve) => {
			const v = document.createElement('video');
			v.preload = 'metadata';
			v.onloadedmetadata = () => resolve(v.duration);
			v.onerror = () => resolve(NaN);
			v.src = URL.createObjectURL(file);
		});
	}
	async function checkVideo(e: Event): Promise<{ url: string; secs: string } | { error: string } | null> {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return null;
		const secs = await readDuration(file);
		if (Number.isFinite(secs) && secs > REEL_MAX_SECONDS + 0.5) {
			input.value = '';
			return { error: `That video is ${Math.round(secs)} seconds. Keep it to ${REEL_MAX_SECONDS} at most.` };
		}
		return { url: URL.createObjectURL(file), secs: Number.isFinite(secs) ? secs.toFixed(2) : '' };
	}
	async function pickCelVideo(kind: CelebrationKind, e: Event) {
		const r = await checkVideo(e);
		cels[kind].error = r && 'error' in r ? r.error : '';
		if (r && 'url' in r) {
			cels[kind].videoUrl = r.url;
			cels[kind].durationSec = r.secs;
			cels[kind].removeVideo = false;
		}
	}

	/* ---------- create: gallery → fields (or AI) → publish or download ---------- */
	let picked = $state<string | null>(null);
	const pickedTemplate = $derived(motionTemplate(picked));
	let createValues = $state<SlotValues>({});
	let brief = $state('');
	let filling = $state(false);
	let fillError = $state('');
	let bgUrl = $state<string | null>(null);
	let bgSecs = $state('');
	let bgError = $state('');
	let exporting = $state(false);
	let publishing = $state(false);
	/** Set while changing a published template reel instead of making a new one. */
	let editingReel = $state<{ id: string; title: string; caption: string; startsOn: string | null; endsOn: string | null } | null>(null);

	function startCreate(id: string) {
		const mt = motionTemplate(id)!;
		picked = id;
		createValues = withDefaults(mt, null);
		brief = '';
		fillError = '';
		bgUrl = null;
		editingReel = null;
	}
	function editReel(r: (typeof data.reels)[number]) {
		const mt = motionTemplate(r.motionTemplate);
		if (!mt) return;
		picked = mt.id;
		createValues = withDefaults(mt, r.slotValues);
		brief = '';
		fillError = '';
		bgUrl = r.mediaUrl;
		editingReel = { id: r.id, title: r.title, caption: r.caption, startsOn: r.startsOn, endsOn: r.endsOn };
		tab = 'create';
	}
	/** Still the template's sample words: worth a warning before it goes on Home. */
	const isSample = $derived(!!pickedTemplate && Object.keys(pickedTemplate.slots).every((k) => JSON.stringify(createValues[k]) === JSON.stringify(withDefaults(pickedTemplate!, null)[k])));
	async function fillWithAi() {
		if (!pickedTemplate) return;
		filling = true;
		fillError = '';
		try {
			const res = await fetch('/api/engagement/fill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: pickedTemplate.id, brief, current: createValues }) });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) fillError = body.message ?? 'The AI could not fill it just now';
			else createValues = withDefaults(pickedTemplate, { ...createValues, ...body.values });
		} finally {
			filling = false;
		}
	}
	async function pickBackground(e: Event) {
		const r = await checkVideo(e);
		bgError = r && 'error' in r ? r.error : '';
		if (r && 'url' in r) {
			bgUrl = r.url;
			bgSecs = r.secs;
		}
	}
	async function download(template = pickedTemplate, values = createValues, name = 'reel') {
		if (!template) return;
		exporting = true;
		try {
			let media: HTMLVideoElement | null = null;
			if (bgUrl && template === pickedTemplate) {
				media = document.createElement('video');
				media.src = bgUrl;
				media.muted = true;
				media.loop = true;
				await media.play().catch(() => {});
			}
			const blob = await recordMotion(template, values, brand, media);
			const url = URL.createObjectURL(blob);
			Object.assign(document.createElement('a'), { href: url, download: `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'reel'}.webm` }).click();
			setTimeout(() => URL.revokeObjectURL(url), 5000);
			media?.pause();
		} finally {
			exporting = false;
		}
	}
	const hasMediaScene = $derived(!!pickedTemplate?.scenes.some((sc) => sc.background.kind === 'media'));

	/* ---------- uploaded-video reels ---------- */
	let reelDuration = $state('');
	let reelError = $state('');
	let reelPreview = $state<string | null>(null);
	let uploadingReel = $state(false);
	async function pickReel(e: Event) {
		const r = await checkVideo(e);
		reelError = r && 'error' in r ? r.error : '';
		reelPreview = r && 'url' in r ? r.url : null;
		reelDuration = r && 'url' in r ? r.secs : '';
	}

	let editing = $state<string | null>(null);
	let saving = $state<string | null>(null);
	const done = (key: string) => () => {
		saving = key;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			saving = null;
		};
	};
</script>

<svelte:head><title>Engagement studio — Champ HR ESS Portal</title></svelte:head>

<div class="top">
	<div class="ess-tabs" role="tablist" aria-label="Studio">
		<button type="button" class="ess-tab" role="tab" aria-selected={tab === 'overview'} onclick={() => (tab = 'overview')}>Overview</button>
		<button type="button" class="ess-tab" role="tab" aria-selected={tab === 'celebrations'} onclick={() => (tab = 'celebrations')}>Celebrations</button>
		<button type="button" class="ess-tab" role="tab" aria-selected={tab === 'create'} onclick={() => (tab = 'create')}>Create</button>
		<button type="button" class="ess-tab" role="tab" aria-selected={tab === 'reels'} onclick={() => (tab = 'reels')}>
			Home reels {#if data.reels.some((r) => r.live)}<span class="ess-count">{data.reels.filter((r) => r.live).length}</span>{/if}
		</button>
		<button type="button" class="ess-tab" role="tab" aria-selected={tab === 'brand'} onclick={() => (tab = 'brand')}>Brand kit</button>
	</div>
</div>

{#if form?.error}
	<p class="ess-alert ess-alert--danger" role="alert">{form.error}</p>
{:else if form?.message}
	<p class="ess-alert ess-alert--success" role="status">{form.message}</p>
{/if}

{#if tab === 'overview'}
	<div class="ess-figures figures">
		<div class="ess-figure"><span class="ess-tile ess-tile--sm"><Cake size={17} /></span><div><div class="ess-figure__value">{s.birthdaysThisMonth}</div><div class="ess-figure__label">Birthdays this month</div></div></div>
		<div class="ess-figure"><span class="ess-tile ess-tile--sm"><Award size={17} /></span><div><div class="ess-figure__value">{s.workAnniversariesThisMonth}</div><div class="ess-figure__label">Work anniversaries</div></div></div>
		<div class="ess-figure"><span class="ess-tile ess-tile--sm"><Heart size={17} /></span><div><div class="ess-figure__value">{s.weddingAnniversariesThisMonth}</div><div class="ess-figure__label">Wedding anniversaries</div></div></div>
		<div class="ess-figure"><span class="ess-tile ess-tile--sm"><Eye size={17} /></span><div><div class="ess-figure__value">{s.reelViews7d + s.celebrationViews7d}</div><div class="ess-figure__label">Home reel views, 7 days</div></div></div>
		<div class="ess-figure"><span class="ess-tile ess-tile--sm"><Megaphone size={17} /></span><div><div class="ess-figure__value">{s.announcementReads30d}</div><div class="ess-figure__label">Reads of {s.announcements30d} announcements, 30 days</div></div></div>
		<div class="ess-figure"><span class="ess-tile ess-tile--sm"><MessagesSquare size={17} /></span><div><div class="ess-figure__value">{s.chatPeople7d}<small> / {s.headcount}</small></div><div class="ess-figure__label">Chatting this week · {s.chatMessages7d} messages</div></div></div>
	</div>

	<div class="two ess-fill">
		<section class="ess-card ess-fill-card" aria-labelledby="up-h">
			<div class="ess-card-head">
				<h2 id="up-h" class="ess-h2">Coming up · next 14 days</h2>
				<span class="ess-caption">Shown on Home on the day. Change the words for one person, or skip it.</span>
			</div>
			<ul class="ess-scroll upcoming">
				{#each data.upcoming as u (u.key)}
					{@const Icon = ICON[u.kind]}
					<li class:muted={u.hidden}>
						<span class="ess-tile ess-tile--sm"><Icon size={15} /></span>
						<span class="who">
							<strong>{u.fullName}</strong>
							<small>{fmtDay(u.date)} · {CELEBRATION_LABEL[u.kind]}{u.years ? ` · ${u.years} ${u.years === 1 ? 'year' : 'years'}` : ''}{u.team ? ` · ${u.team}` : ''}</small>
						</span>
						{#if u.date === data.today}<span class="ess-badge ess-badge--accent">Today</span>{/if}
						{#if u.hidden}<span class="ess-badge ess-badge--cancelled">Skipped</span>{:else if u.edited}<span class="ess-badge ess-badge--info">Edited</span>{/if}
						<button type="button" class="ess-icon-btn" aria-label="Edit {u.fullName}'s {CELEBRATION_LABEL[u.kind].toLowerCase()}" onclick={() => (editing = editing === u.key ? null : u.key)}><Pencil size={14} /></button>
					</li>
					{#if editing === u.key}
						<li class="edit">
							<form method="POST" action="?/override" use:enhance={done(u.key)}>
								<input type="hidden" name="kind" value={u.kind} />
								<input type="hidden" name="userId" value={u.userId} />
								<input type="hidden" name="onDate" value={u.date} />
								<div class="edit-row">
									{#if u.motion && motionTemplate(u.motion.templateId)}
										<div class="frame xs"><MotionPlayer template={motionTemplate(u.motion.templateId)!} values={u.motion.values} {brand} /></div>
									{/if}
									<div class="edit-fields">
										<textarea class="ess-input" name="message" rows="3" maxlength="400" placeholder={u.message}>{u.edited ? u.message : ''}</textarea>
										<label class="check"><input type="checkbox" name="hidden" checked={u.hidden} /> Skip this one</label>
										<p class="ess-caption">Your words replace the template’s message for {u.fullName.split(' ')[0]} only. Leave empty to use the template.</p>
										<button type="submit" class="ess-btn ess-btn--primary ess-btn--sm" disabled={saving === u.key}>Save</button>
									</div>
								</div>
							</form>
						</li>
					{/if}
				{:else}
					<li class="empty">No celebrations in the next two weeks.</li>
				{/each}
			</ul>
		</section>
		<DeskStatsCard title="Ask Engagement desk" stats={data.desk} />
	</div>
{:else if tab === 'celebrations'}
	<p class="hint">
		The portal plays these by itself on the day, on everyone’s Home page, for every active person with the date on file. Placeholders like
		<code>{'{first_name}'}</code> <code>{'{years}'}</code> <code>{'{team}'}</code> are filled for each person.
	</p>
	<div class="cards ess-fill">
		{#each CELEBRATION_KINDS as kind (kind)}
			{@const c = cels[kind]}
			{@const mt = motionTemplate(c.templateId)!}
			{@const Icon = ICON[kind]}
			<form class="ess-card tpl" method="POST" action="?/template" enctype="multipart/form-data" use:enhance={done(`tpl:${kind}`)}>
				<input type="hidden" name="kind" value={kind} />
				<input type="hidden" name="headline" value={data.templates[kind].headline || CELEBRATION_LABEL[kind]} />
				<input type="hidden" name="message" value={data.templates[kind].message} />
				<input type="hidden" name="motionTemplate" value={c.templateId} />
				<input type="hidden" name="slotValues" value={JSON.stringify(c.values)} />
				<input type="hidden" name="durationSec" value={c.durationSec} />
				<div class="ess-card-head">
					<h2 class="ess-h2"><Icon size={16} /> {CELEBRATION_LABEL[kind]}</h2>
					<label class="check"><input type="checkbox" name="enabled" bind:checked={c.enabled} /> Show it</label>
				</div>
				<div class="frame" class:off={!c.enabled}>
					<MotionPlayer template={mt} values={personalise(c.values, kind)} {brand} mediaUrl={c.removeVideo ? null : c.videoUrl} />
				</div>
				<p class="ess-caption center">Preview: {sampleFor(kind).person.fullName}</p>
				<label class="ess-field">
					<span class="ess-label">Template</span>
					<select class="ess-select" value={c.templateId} onchange={(e) => switchTemplate(kind, e.currentTarget.value)}>
						{#each MOTION_TEMPLATES as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
					</select>
				</label>
				<SlotFields template={mt} bind:values={c.values} />
				{#if mt.scenes.some((sc) => sc.background.kind === 'media')}
					<label class="ess-field">
						<span class="ess-label">Background video (optional, up to {REEL_MAX_SECONDS} s)</span>
						<input type="file" name="video" accept="video/mp4,video/webm,video/quicktime" onchange={(e) => pickCelVideo(kind, e)} />
					</label>
					{#if data.templates[kind].mediaUrl}<label class="check"><input type="checkbox" name="removeVideo" bind:checked={c.removeVideo} /> Remove the video</label>{/if}
				{/if}
				{#if c.error}<p class="err">{c.error}</p>{/if}
				<div class="row">
					<button type="submit" class="ess-btn ess-btn--primary ess-btn--sm" disabled={saving === `tpl:${kind}`}>{saving === `tpl:${kind}` ? 'Saving…' : 'Save'}</button>
					<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => download(mt, personalise(c.values, kind), `${kind}-${sampleFor(kind).person.fullName}`)} disabled={exporting}><Download size={14} /> {exporting ? 'Recording…' : 'Download'}</button>
				</div>
			</form>
		{/each}
	</div>
{:else if tab === 'create'}
	{#if !pickedTemplate}
		<p class="hint">Pick a template, fill it in (or let the AI write it from a sentence), then put it on everyone’s Home page or download the video. Templates follow Champ Studio’s, in your brand kit.</p>
		<div class="gallery ess-fill">
			{#each MOTION_TEMPLATES as t (t.id)}
				<button type="button" class="ess-card pick" onclick={() => startCreate(t.id)}>
					<div class="frame sm"><MotionPlayer template={t} values={personalise(withDefaults(t, null), t.celebration ?? 'birthday')} {brand} /></div>
					<strong>{t.name}</strong>
					<small>{t.category} · {Math.round(totalSeconds(t))} s</small>
					<span class="desc">{t.description}</span>
				</button>
			{/each}
		</div>
	{:else}
		<form
			class="create ess-fill"
			method="POST"
			action="?/templateReel"
			enctype="multipart/form-data"
			use:enhance={() => {
				publishing = true;
				return async ({ update, result }) => {
					await update({ reset: false });
					publishing = false;
					if (result.type === 'success') {
						picked = null;
						editingReel = null;
					}
				};
			}}
		>
			<input type="hidden" name="templateId" value={pickedTemplate.id} />
			{#if editingReel}<input type="hidden" name="reelId" value={editingReel.id} />{/if}
			<input type="hidden" name="slotValues" value={JSON.stringify(createValues)} />
			<input type="hidden" name="durationSec" value={bgSecs} />
			<section class="ess-card">
				<div class="ess-card-head">
					<h2 class="ess-h2"><button type="button" class="ess-icon-btn" onclick={() => (picked = null)} aria-label="Back to templates"><ArrowLeft size={16} /></button> {pickedTemplate.name}</h2>
				</div>
				<div class="ai">
					<label class="ess-field">
						<span class="ess-label"><Sparkles size={14} /> Fill from a brief</span>
						<textarea class="ess-input" rows="2" bind:value={brief} placeholder="e.g. Annual day this Friday at 4 pm on the terrace, families welcome, dress code ethnic"></textarea>
					</label>
					<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={fillWithAi} disabled={filling || brief.trim().length < 5}><Sparkles size={14} /> {filling ? 'Writing…' : 'Fill with AI'}</button>
					{#if fillError}<p class="err">{fillError}</p>{/if}
				</div>
				<SlotFields template={pickedTemplate} bind:values={createValues} />
			</section>
			<section class="ess-card">
				<div class="frame lg"><MotionPlayer template={pickedTemplate} values={personalise(createValues, pickedTemplate.celebration ?? 'birthday')} {brand} mediaUrl={bgUrl} /></div>
				<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => download(pickedTemplate, personalise(createValues, pickedTemplate!.celebration ?? 'birthday'), pickedTemplate!.name)} disabled={exporting}><Download size={14} /> {exporting ? `Recording ${Math.round(totalSeconds(pickedTemplate))} s…` : 'Download video (.webm)'}</button>
			</section>
			<section class="ess-card publish">
				<div class="ess-card-head"><h2 class="ess-h2">{editingReel ? 'Update on Home' : 'Put it on Home'}</h2></div>
				{#if isSample}
					<p class="ess-alert ess-alert--warning">The fields still hold the template’s sample words. What’s on screen comes from the fields on the left, so change them (or use Fill with AI) first.</p>
				{/if}
				<label class="ess-field"><span class="ess-label">Title <small class="ess-caption">(names it in the list)</small></span><input class="ess-input" name="title" maxlength="80" required value={editingReel?.title ?? pickedTemplate.name} /></label>
				<label class="ess-field"><span class="ess-label">Note <small class="ess-caption">(for the studio, not shown)</small></span><input class="ess-input" name="caption" maxlength="200" value={editingReel?.caption ?? ''} /></label>
				<div class="dates">
					<label class="ess-field"><span class="ess-label">From</span><input class="ess-input" type="date" name="startsOn" value={editingReel?.startsOn ?? ''} /></label>
					<label class="ess-field"><span class="ess-label">Until</span><input class="ess-input" type="date" name="endsOn" value={editingReel?.endsOn ?? ''} /></label>
				</div>
				{#if hasMediaScene}
					<label class="ess-field"><span class="ess-label">Background video (optional)</span><input type="file" name="video" accept="video/mp4,video/webm,video/quicktime" onchange={pickBackground} /></label>
					{#if bgError}<p class="err">{bgError}</p>{/if}
				{/if}
				<button type="submit" class="ess-btn ess-btn--primary" disabled={publishing || isSample}><Upload size={16} /> {publishing ? 'Saving…' : editingReel ? 'Save changes' : 'Publish to Home'}</button>
			</section>
		</form>
	{/if}
{:else if tab === 'reels'}
	<div class="reels ess-fill">
		<form
			class="ess-card add-reel"
			method="POST"
			action="?/reel"
			enctype="multipart/form-data"
			use:enhance={() => {
				uploadingReel = true;
				return async ({ update, result }) => {
					await update({ reset: result.type === 'success' });
					uploadingReel = false;
					if (result.type === 'success') reelPreview = null;
				};
			}}
		>
			<div class="ess-card-head"><h2 class="ess-h2">Upload a video</h2></div>
			<p class="ess-caption">A short vertical clip (up to {REEL_MAX_SECONDS} s, 20 MB) that plays on everyone’s Home page, muted until they tap it. Or make one in Create.</p>
			<input type="hidden" name="durationSec" value={reelDuration} />
			<div class="add-body">
				<div class="frame">
					{#if reelPreview}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video src={reelPreview} muted autoplay loop playsinline></video>
					{:else}
						<span class="frame-empty">9:16 preview</span>
					{/if}
				</div>
				<div class="fields">
					<label class="ess-field"><span class="ess-label">Title</span><input class="ess-input" name="title" maxlength="80" required placeholder="Diwali celebrations" /></label>
					<label class="ess-field"><span class="ess-label">Caption</span><input class="ess-input" name="caption" maxlength="200" placeholder="Join us on the terrace at 4 pm" /></label>
					<div class="dates">
						<label class="ess-field"><span class="ess-label">From</span><input class="ess-input" type="date" name="startsOn" /></label>
						<label class="ess-field"><span class="ess-label">Until</span><input class="ess-input" type="date" name="endsOn" /></label>
					</div>
					<label class="ess-field"><span class="ess-label">Video</span><input type="file" name="video" accept="video/mp4,video/webm,video/quicktime" required onchange={pickReel} /></label>
					{#if reelError}<p class="err">{reelError}</p>{/if}
					<button type="submit" class="ess-btn ess-btn--primary" disabled={uploadingReel || !reelPreview}><Upload size={16} /> {uploadingReel ? 'Uploading…' : 'Publish to Home'}</button>
				</div>
			</div>
		</form>

		<section class="ess-card ess-fill-card" aria-labelledby="reels-h">
			<div class="ess-card-head"><h2 id="reels-h" class="ess-h2">On Home</h2><span class="ess-caption">{data.reels.length}</span></div>
			<ul class="ess-scroll list">
				{#each data.reels as r (r.id)}
					{@const mt = r.kind === 'template' ? motionTemplate(r.motionTemplate) : null}
					<li>
						<div class="thumb">
							{#if mt}
								<MotionPlayer template={mt} values={withDefaults(mt, r.slotValues)} {brand} mediaUrl={r.mediaUrl} />
							{:else if r.mediaUrl}
								<!-- svelte-ignore a11y_media_has_caption -->
								<video src={r.mediaUrl} muted preload="metadata" playsinline></video>
							{/if}
						</div>
						<span class="who">
							<strong>{r.title}</strong>
							<small>{mt ? `Template · ${mt.name}` : r.caption || 'Uploaded video'}</small>
							<small>{r.startsOn ? `from ${fmtDay(r.startsOn)}` : 'from now'}{r.endsOn ? ` until ${fmtDay(r.endsOn)}` : ''} · {r.views7d} viewers this week</small>
						</span>
						<span class="ess-badge ess-badge--{r.live ? 'ok' : r.active ? 'info' : 'neutral'}">{r.live ? 'Live' : r.active ? 'Scheduled' : 'Paused'}</span>
						{#if mt}<button type="button" class="ess-icon-btn" aria-label="Edit {r.title}" title="Edit" onclick={() => editReel(r)}><Pencil size={15} /></button>{/if}
						<form method="POST" action="?/reelUpdate" use:enhance={done(`r:${r.id}`)}>
							<input type="hidden" name="id" value={r.id} />
							<input type="hidden" name="active" value={String(!r.active)} />
							<button type="submit" class="ess-icon-btn" aria-label={r.active ? `Pause ${r.title}` : `Show ${r.title} again`} title={r.active ? 'Pause' : 'Show again'}>{#if r.active}<Pause size={15} />{:else}<Play size={15} />{/if}</button>
						</form>
						<form method="POST" action="?/reelUpdate" use:enhance={done(`d:${r.id}`)} onsubmit={(e) => { if (!confirm(`Delete “${r.title}”? It disappears from Home for everyone.`)) e.preventDefault(); }}>
							<input type="hidden" name="id" value={r.id} />
							<input type="hidden" name="remove" value="true" />
							<button type="submit" class="ess-icon-btn" aria-label="Delete {r.title}" title="Delete"><Trash2 size={15} /></button>
						</form>
					</li>
				{:else}
					<li class="empty">Nothing yet. Celebrations still play on Home by themselves.</li>
				{/each}
			</ul>
		</section>
	</div>
{:else}
	<form class="brand ess-fill" method="POST" action="?/brand" use:enhance={done('brand')}>
		<section class="ess-card">
			<div class="ess-card-head"><h2 class="ess-h2">Brand kit</h2></div>
			<p class="ess-caption">Every template and celebration uses these colours, like Champ Studio’s brand kits.</p>
			<label class="ess-field"><span class="ess-label">Name</span><input class="ess-input" name="name" maxlength="40" bind:value={brand.name} /></label>
			<div class="swatches">
				{#each Object.keys(COLOR_LABEL) as k (k)}
					{@const key = k as keyof BrandKit['colors']}
					<label class="swatch"><input type="color" name="c_{key}" bind:value={brand.colors[key]} /> {COLOR_LABEL[key]}</label>
				{/each}
			</div>
			<span class="ess-label">Hero gradient</span>
			<div class="swatches">
				{#each [0, 1, 2] as i (i)}
					<label class="swatch"><input type="color" name="g{i}" bind:value={brand.gradient[i]} /> {['Start', 'Middle', 'End'][i]}</label>
				{/each}
			</div>
			<div class="row">
				<button type="submit" class="ess-btn ess-btn--primary ess-btn--sm" disabled={saving === 'brand'}>Save brand kit</button>
				<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (brand = structuredClone(data.brand))}>Undo changes</button>
			</div>
		</section>
		<div class="brand-previews">
			{#each ['birthday-burst', 'milestone-years', 'company-news'] as id (id)}
				{@const t = motionTemplate(id)!}
				<div class="frame"><MotionPlayer template={t} values={personalise(withDefaults(t, null), t.celebration ?? 'work_anniversary')} {brand} /></div>
			{/each}
		</div>
	</form>
{/if}

<style>
	.top {
		margin-bottom: 12px;
	}
	.figures {
		margin-bottom: 12px;
		grid-template-columns: repeat(6, minmax(0, 1fr));
	}
	.two {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: 14px;
		align-items: start;
		min-height: 0;
	}
	.upcoming,
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
		max-height: 540px;
	}
	.upcoming li,
	.list li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 2px;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.upcoming li.muted {
		opacity: 0.55;
	}
	.upcoming li.edit {
		display: block;
		background: var(--ess-sunken);
		border-radius: 10px;
		padding: 10px;
	}
	.edit-row {
		display: flex;
		gap: 12px;
		align-items: flex-start;
	}
	.edit-fields {
		flex: 1;
		display: grid;
		gap: 8px;
		justify-items: start;
	}
	.edit-fields textarea {
		width: 100%;
	}
	.empty {
		color: var(--ess-text-muted);
		font-size: 13px;
	}
	.who {
		display: grid;
		flex: 1;
		min-width: 0;
		line-height: 1.3;
	}
	.who small {
		font-size: 12px;
		color: var(--ess-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
	}
	.hint {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.hint code {
		padding: 1px 6px;
		border-radius: 6px;
		background: var(--ess-sunken);
		font-size: 12px;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
		align-items: start;
		overflow: auto;
	}
	.tpl {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.frame {
		aspect-ratio: 9 / 16;
		width: 180px;
		margin: 0 auto;
		border-radius: 16px;
		overflow: hidden;
		background: var(--ess-sunken);
		display: grid;
		place-items: center;
		box-shadow: 0 10px 24px -14px rgba(0, 0, 0, 0.5);
	}
	.frame.xs {
		width: 96px;
		margin: 0;
		flex-shrink: 0;
	}
	.frame.sm {
		width: 150px;
	}
	.frame.lg {
		width: 260px;
	}
	.frame.off {
		filter: grayscale(1);
		opacity: 0.55;
	}
	.frame video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.frame-empty {
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.center {
		text-align: center;
		margin: -4px 0 0;
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}
	.err {
		margin: 0;
		color: var(--ess-danger);
		font-size: 13px;
	}
	.gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 14px;
		overflow: auto;
		align-content: start;
	}
	.pick {
		display: grid;
		gap: 4px;
		justify-items: center;
		text-align: center;
		font: inherit;
		color: inherit;
		cursor: pointer;
		border: 1px solid var(--ess-border);
	}
	.pick:hover {
		border-color: var(--ess-primary);
	}
	.pick small {
		color: var(--ess-text-muted);
		font-size: 12px;
	}
	.pick .desc {
		font-size: 12px;
		color: var(--ess-text-secondary);
		line-height: 1.4;
	}
	.create {
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) auto minmax(0, 0.9fr);
		gap: 14px;
		align-items: start;
		overflow: auto;
	}
	.create > section {
		display: grid;
		gap: 10px;
		justify-items: stretch;
	}
	.ai {
		display: grid;
		gap: 8px;
		justify-items: start;
		padding: 10px;
		border-radius: 12px;
		background: var(--ess-primary-softer);
	}
	.ai .ess-field {
		width: 100%;
	}
	.ai .ess-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.reels {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 14px;
		align-items: start;
	}
	.add-body {
		display: grid;
		grid-template-columns: 150px minmax(0, 1fr);
		gap: 14px;
		align-items: start;
	}
	.add-body .frame {
		width: 150px;
	}
	.fields {
		display: grid;
		gap: 10px;
	}
	.dates {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.thumb {
		width: 46px;
		aspect-ratio: 9 / 16;
		border-radius: 8px;
		overflow: hidden;
		background: #111;
		flex-shrink: 0;
	}
	.thumb video {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.brand {
		display: grid;
		grid-template-columns: minmax(0, 420px) minmax(0, 1fr);
		gap: 14px;
		align-items: start;
	}
	.brand section {
		display: grid;
		gap: 10px;
	}
	.swatches {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.swatch {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
	}
	.swatch input {
		width: 36px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--ess-border);
		border-radius: 6px;
		background: none;
	}
	.brand-previews {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
	}
	.brand-previews .frame {
		margin: 0;
	}
	.ess-h2 {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	@media (max-width: 1200px) {
		.cards,
		.two,
		.reels,
		.create,
		.brand {
			grid-template-columns: 1fr;
		}
		.figures {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
</style>
