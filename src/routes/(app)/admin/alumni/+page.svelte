<script lang="ts">
	import { enhance } from '$app/forms';
	import Search from '@lucide/svelte/icons/search';
	import Upload from '@lucide/svelte/icons/upload';
	import Download from '@lucide/svelte/icons/download';
	import GraduationCap from '@lucide/svelte/icons/graduation-cap';
	import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
	import Lock from '@lucide/svelte/icons/lock';
	import LockOpen from '@lucide/svelte/icons/lock-open';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { tenureYears } from '$lib/alumni';

	let { data, form } = $props();

	type Alum = (typeof data.alumni)[number];

	const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
	const thisYear = today.slice(0, 4);
	const monthAgo = new Date(Date.now() - 30 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

	const fmt = (iso: string | null) =>
		iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';

	/* ---------- figures ---------- */
	const leftThisYear = $derived(data.alumni.filter((a) => a.lastWorkingDay?.startsWith(thisYear)).length);
	const leftLast30 = $derived(data.alumni.filter((a) => a.lastWorkingDay && a.lastWorkingDay >= monthAgo && a.lastWorkingDay <= today).length);
	const avgTenure = $derived.by(() => {
		const t = data.alumni.map((a) => tenureYears(a.dateOfJoining, a.lastWorkingDay)).filter((n): n is number => n !== null);
		return t.length ? Math.round((t.reduce((s, n) => s + n, 0) / t.length) * 10) / 10 : null;
	});
	/** Left (on or before today, or no date given) and can still sign in. */
	const stillOpen = $derived(data.alumni.filter((a) => a.login === 'open' && !a.superAdmin && (!a.lastWorkingDay || a.lastWorkingDay <= today)));
	/** Leaving later: their login stays until their last day. */
	const servingNotice = $derived(data.alumni.filter((a) => a.login === 'open' && !a.superAdmin && a.lastWorkingDay && a.lastWorkingDay > today));

	/* ---------- filters ---------- */
	let q = $state('');
	let year = $state('');
	let exitType = $state('');
	let loginFilter = $state('');
	const years = $derived([...new Set(data.alumni.map((a) => a.lastWorkingDay?.slice(0, 4)).filter(Boolean) as string[])].sort().reverse());
	const exitTypes = $derived([...new Set(data.alumni.map((a) => a.natureOfExit).filter(Boolean) as string[])].sort());

	const shown = $derived.by(() => {
		const text = q.trim().toLowerCase();
		return data.alumni.filter((a) => {
			if (year && !a.lastWorkingDay?.startsWith(year)) return false;
			if (exitType && a.natureOfExit !== exitType) return false;
			if (loginFilter && a.login !== loginFilter) return false;
			if (!text) return true;
			return [a.fullName, a.employeeCode, a.officialEmail, a.personalEmail, a.designation, a.team, a.department, a.reason]
				.filter(Boolean)
				.some((v) => v!.toLowerCase().includes(text));
		});
	});

	const PAGE = 50;
	let pageNo = $state(0);
	$effect(() => {
		void q;
		void year;
		void exitType;
		void loginFilter;
		pageNo = 0;
	});
	const pages = $derived(Math.max(1, Math.ceil(shown.length / PAGE)));
	const pageRows = $derived(shown.slice(pageNo * PAGE, pageNo * PAGE + PAGE));

	let openId = $state<string | null>(null);

	/* ---------- export ---------- */
	function exportCsv() {
		const cols: [string, (a: Alum) => string | number | null][] = [
			['Emp Code', (a) => a.employeeCode],
			['Name', (a) => a.fullName],
			['Designation', (a) => a.designation],
			['Team', (a) => a.team],
			['Department', (a) => a.department],
			['Company', (a) => a.company],
			['Date of Joining', (a) => a.dateOfJoining],
			['Date of Resignation', (a) => a.resignationDate],
			['Last Working Day', (a) => a.lastWorkingDay],
			['Tenure (years)', (a) => tenureYears(a.dateOfJoining, a.lastWorkingDay)],
			['Nature of Exit', (a) => a.natureOfExit],
			['Reason', (a) => a.reason],
			['Rehire', (a) => a.rehireEligible],
			['F&F', (a) => a.fnfStatus],
			['Official Email', (a) => a.officialEmail],
			['Personal Email', (a) => a.personalEmail],
			['Contact Number', (a) => a.phone],
			['Remarks', (a) => a.remarks],
			['Portal login', (a) => (a.login === 'open' ? 'Open' : a.login === 'closed' ? 'Closed' : 'Not in portal')]
		];
		const esc = (v: unknown) => {
			const s = v === null || v === undefined ? '' : String(v);
			return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
		};
		const csv = [cols.map(([h]) => h).join(','), ...shown.map((a) => cols.map(([, f]) => esc(f(a))).join(','))].join('\r\n');
		const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
		const link = Object.assign(document.createElement('a'), { href: url, download: `alumni-${today}.csv` });
		link.click();
		URL.revokeObjectURL(url);
	}

	/* ---------- forms ---------- */
	let uploading = $state(false);
	let fileName = $state('');
	let closing = $state(false);
	let picked = $state<string[]>([]);
	$effect(() => {
		// Everyone still open is ticked to start with.
		picked = stillOpen.map((a) => a.userId!).filter(Boolean);
	});

	const LOGIN: Record<Alum['login'], { label: string; tone: string }> = {
		open: { label: 'Login open', tone: 'warn' },
		closed: { label: 'Login closed', tone: 'neutral' },
		none: { label: 'Not in portal', tone: 'cancelled' }
	};
	const loginLook = (a: Alum) =>
		a.login === 'open' && a.lastWorkingDay && a.lastWorkingDay > today ? { label: 'Serving notice', tone: 'info' } : LOGIN[a.login];
</script>

<svelte:head>
	<title>Alumni — Champ HR ESS Portal</title>
</svelte:head>

{#if form?.error}
	<p class="ess-alert ess-alert--danger" role="alert">{form.error}</p>
{:else if form?.message}
	<p class="ess-alert ess-alert--success" role="status">{form.message}</p>
{:else if form?.imported}
	{@const r = form.imported}
	<p class="ess-alert ess-alert--success" role="status">
		Read {r.rows} {r.rows === 1 ? 'person' : 'people'} from “{r.sheetName}”: {r.created} new, {r.updated} updated, {r.matched} matched to a portal login{r.lwdFilled
			? `, ${r.lwdFilled} last working ${r.lwdFilled === 1 ? 'day' : 'days'} filled in for payroll`
			: ''}{r.skipped ? `. ${r.skipped} rows without a name were skipped` : ''}.{r.stillOpen ? ` ${r.stillOpen} still ${r.stillOpen === 1 ? 'has' : 'have'} an open login — see the right.` : ''}
	</p>
{/if}

<div class="ess-figures figures">
	<div class="ess-figure">
		<span class="ess-tile ess-tile--sm"><GraduationCap size={18} /></span>
		<div><div class="ess-figure__value">{data.alumni.length}</div><div class="ess-figure__label">Former employees</div></div>
	</div>
	<div class="ess-figure">
		<span class="ess-figure__dot"></span>
		<div><div class="ess-figure__value">{leftThisYear}</div><div class="ess-figure__label">Left in {thisYear}</div></div>
	</div>
	<div class="ess-figure">
		<span class="ess-figure__dot"></span>
		<div><div class="ess-figure__value">{leftLast30}</div><div class="ess-figure__label">Left in the last 30 days</div></div>
	</div>
	<div class="ess-figure">
		<span class="ess-figure__dot ess-figure__dot--ok"></span>
		<div><div class="ess-figure__value">{avgTenure ?? '—'}{#if avgTenure !== null}<small> yrs</small>{/if}</div><div class="ess-figure__label">Average tenure</div></div>
	</div>
	<div class="ess-figure">
		<span class="ess-figure__dot" class:ess-figure__dot--warn={stillOpen.length > 0}></span>
		<div><div class="ess-figure__value">{stillOpen.length}</div><div class="ess-figure__label">Left, login still open</div></div>
	</div>
</div>

<div class="ess-split ess-fill split">
	<section class="ess-card ess-fill-card list" aria-labelledby="alumni-h">
		<div class="ess-card-head">
			<div>
				<h2 id="alumni-h" class="ess-h2">Former employees</h2>
				<span class="ess-caption">{shown.length} of {data.alumni.length}</span>
			</div>
			<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={exportCsv} disabled={shown.length === 0}><Download size={15} /> Export</button>
		</div>

		<div class="toolbar">
			<label class="ess-search grow">
				<Search size={15} />
				<input class="ess-input" type="search" placeholder="Search name, code, email, team or reason…" bind:value={q} aria-label="Search alumni" />
			</label>
			<select class="ess-select" bind:value={year} aria-label="Year they left">
				<option value="">All years</option>
				{#each years as y (y)}<option value={y}>{y}</option>{/each}
			</select>
			<select class="ess-select" bind:value={exitType} aria-label="Nature of exit">
				<option value="">Every exit type</option>
				{#each exitTypes as t (t)}<option value={t}>{t}</option>{/each}
			</select>
			<select class="ess-select" bind:value={loginFilter} aria-label="Portal login">
				<option value="">Any login</option>
				<option value="open">Login open</option>
				<option value="closed">Login closed</option>
				<option value="none">Not in portal</option>
			</select>
		</div>

		{#if data.alumni.length === 0}
			<div class="ess-empty fill-empty">
				<span class="ess-empty__icon"><FileSpreadsheet size={20} /></span>
				<span>No one yet. Upload the left-employee tracker on the right to start the alumni record.</span>
			</div>
		{:else}
			<div class="ess-scroll table-wrap">
				<table class="ess-table">
					<thead>
						<tr>
							<th>Name</th>
							<th>Role</th>
							<th>Joined</th>
							<th>Left</th>
							<th class="ess-num">Tenure</th>
							<th>Exit</th>
							<th>Portal login</th>
						</tr>
					</thead>
					<tbody>
						{#each pageRows as a (a.id)}
							{@const look = loginLook(a)}
							{@const tenure = tenureYears(a.dateOfJoining, a.lastWorkingDay)}
							<tr class:is-selected={openId === a.id} onclick={() => (openId = openId === a.id ? null : a.id)}>
								<td>
									<span class="who"><strong>{a.fullName}</strong><small>{a.employeeCode ?? 'No code'}</small></span>
								</td>
								<td><span class="who"><span>{a.designation ?? '—'}</span><small>{a.team ?? a.department ?? ''}</small></span></td>
								<td class="nowrap">{fmt(a.dateOfJoining)}</td>
								<td class="nowrap">{fmt(a.lastWorkingDay)}</td>
								<td class="ess-num">{tenure !== null ? `${tenure} y` : '—'}</td>
								<td><span class="who"><span>{a.natureOfExit ?? '—'}</span>{#if a.reason}<small class="clip" title={a.reason}>{a.reason}</small>{/if}</span></td>
								<td><span class="ess-badge ess-badge--{look.tone}">{look.label}</span></td>
							</tr>
							{#if openId === a.id}
								<tr class="detail">
									<td colspan="7">
										<dl class="kv">
											{#each [['Official email', a.officialEmail], ['Personal email', a.personalEmail], ['Contact number', a.phone], ['Company', a.company], ['Department', a.department], ['Resigned on', a.resignationDate ? fmt(a.resignationDate) : null], ['Rehire', a.rehireEligible], ['F&F', a.fnfStatus], ['Reason', a.reason], ['Remarks', a.remarks], ...Object.entries(a.details)] as [k, v] (k)}
												{#if v}<div><dt>{k}</dt><dd>{v}</dd></div>{/if}
											{/each}
										</dl>
										{#if a.userId && !a.superAdmin}
											<div class="detail-actions">
												{#if a.login === 'open'}
													<form method="POST" action="?/close" use:enhance={() => async ({ update }) => update({ reset: false })}>
														<input type="hidden" name="userId" value={a.userId} />
														<button type="submit" class="ess-btn ess-btn--secondary ess-btn--sm"><Lock size={14} /> Close their login</button>
													</form>
												{:else if a.login === 'closed'}
													<form method="POST" action="?/reopen" use:enhance={() => async ({ update }) => update({ reset: false })}>
														<input type="hidden" name="userId" value={a.userId} />
														<button type="submit" class="ess-btn ess-btn--ghost ess-btn--sm"><LockOpen size={14} /> Reopen their login</button>
													</form>
												{/if}
											</div>
										{/if}
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
				{#if shown.length === 0}<p class="none">No one matches these filters.</p>{/if}
			</div>
			{#if pages > 1}
				<div class="ess-table-foot pager">
					<span>{pageNo * PAGE + 1}–{Math.min(shown.length, pageNo * PAGE + PAGE)} of {shown.length}</span>
					<span class="pager-btns">
						<button type="button" class="ess-icon-btn" onclick={() => (pageNo = Math.max(0, pageNo - 1))} disabled={pageNo === 0} aria-label="Previous page"><ChevronLeft size={16} /></button>
						<button type="button" class="ess-icon-btn" onclick={() => (pageNo = Math.min(pages - 1, pageNo + 1))} disabled={pageNo >= pages - 1} aria-label="Next page"><ChevronRight size={16} /></button>
					</span>
				</div>
			{/if}
		{/if}
	</section>

	<aside class="ess-stack side">
		<form
			class="ess-card upload"
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			use:enhance={() => {
				uploading = true;
				return async ({ update }) => {
					await update();
					uploading = false;
					fileName = '';
				};
			}}
		>
			<div class="ess-card-head"><h2 class="ess-h2">Upload the left-employee tracker</h2></div>
			<p class="ess-caption">
				The master tracker’s columns plus the leaving date (LWD, Date of Leaving or Relieving Date), Nature of Exit and Reason. Uploading again updates the people already here. Aadhaar, PAN, UAN, bank and other ID numbers are never kept.
			</p>
			<label class="file">
				<input type="file" name="file" accept=".xlsx,.csv" required onchange={(e) => (fileName = (e.currentTarget as HTMLInputElement).files?.[0]?.name ?? '')} />
				<span class="file-face"><FileSpreadsheet size={16} /> {fileName || 'Choose .xlsx or .csv'}</span>
			</label>
			<button type="submit" class="ess-btn ess-btn--primary" disabled={uploading || !fileName}><Upload size={16} /> {uploading ? 'Reading the tracker…' : 'Upload'}</button>
		</form>

		<section class="ess-card ess-fill-card open-card" aria-labelledby="open-h">
			<div class="ess-card-head">
				<h2 id="open-h" class="ess-h2">Left, login still open</h2>
				{#if stillOpen.length}<span class="ess-badge ess-badge--warn">{stillOpen.length}</span>{/if}
			</div>
			{#if stillOpen.length === 0}
				<p class="ess-caption">Everyone on the alumni list who has left has their login closed.</p>
			{:else}
				<form
					method="POST"
					action="?/close"
					class="open-form"
					use:enhance={() => {
						closing = true;
						return async ({ update }) => {
							await update({ reset: false });
							closing = false;
						};
					}}
				>
					<p class="ess-caption">They can still sign in. Closing a login stops access; their records stay and payroll still covers their final cycle. You can reopen one from the list.</p>
					<ul class="ess-scroll people">
						{#each stillOpen as a (a.id)}
							<li>
								<label>
									<input type="checkbox" name="userId" value={a.userId} bind:group={picked} />
									<span class="who"><strong>{a.fullName}</strong><small>{a.employeeCode ?? ''}{a.lastWorkingDay ? ` · left ${fmt(a.lastWorkingDay)}` : ''}</small></span>
								</label>
							</li>
						{/each}
					</ul>
					<button type="submit" class="ess-btn ess-btn--primary ess-btn--sm" disabled={closing || picked.length === 0}>
						<Lock size={14} /> {closing ? 'Closing…' : `Close ${picked.length} ${picked.length === 1 ? 'login' : 'logins'}`}
					</button>
				</form>
			{/if}
			{#if servingNotice.length}
				<p class="notice">
					<strong>Serving notice:</strong>
					{servingNotice.map((a) => `${a.fullName} (until ${fmt(a.lastWorkingDay)})`).join(', ')}. Their logins stay open until their last day.
				</p>
			{/if}
		</section>

		{#if data.imports.length}
			<section class="ess-card" aria-labelledby="up-h">
				<div class="ess-card-head"><h2 id="up-h" class="ess-h2">Recent uploads</h2></div>
				<ul class="uploads">
					{#each data.imports as i (i.id)}
						<li>
							<strong class="clip" title={i.filename}>{i.filename}</strong>
							<small>{new Date(i.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{i.by ? ` · ${i.by}` : ''} · {i.rows} rows, {i.created} new, {i.updated} updated</small>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</aside>
</div>

<style>
	.figures {
		margin-bottom: 12px;
		grid-template-columns: repeat(5, minmax(0, 1fr));
	}
	.split {
		grid-template-columns: minmax(0, 1fr) 340px;
		min-height: 0;
	}
	@media (max-width: 1100px) {
		.split {
			grid-template-columns: 1fr;
		}
		.figures {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.list {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 10px;
	}
	.toolbar .grow {
		flex: 1 1 240px;
	}
	.toolbar .ess-select {
		width: auto;
		min-width: 130px;
	}
	.table-wrap {
		flex: 1;
		min-height: 0;
		margin-inline: calc(-1 * var(--card-px, var(--ess-space-4)));
	}
	.ess-table th:first-child,
	.ess-table td:first-child {
		padding-left: var(--card-px, var(--ess-space-4));
	}
	.ess-table tbody tr:not(.detail) {
		cursor: pointer;
	}
	.who {
		display: grid;
		line-height: 1.3;
		min-width: 0;
	}
	.who small {
		color: var(--ess-text-muted);
		font-size: 12px;
	}
	.clip {
		max-width: 220px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.nowrap {
		white-space: nowrap;
	}
	.detail td {
		background: var(--ess-sunken);
		cursor: default;
	}
	.kv {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 8px 18px;
		margin: 4px 0 8px;
	}
	.kv dt {
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
	.kv dd {
		margin: 0;
		font-size: 13px;
		word-break: break-word;
	}
	.detail-actions {
		display: flex;
		gap: 8px;
	}
	.none {
		padding: 16px;
		color: var(--ess-text-muted);
		font-size: 13px;
	}
	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.pager-btns {
		display: flex;
		gap: 4px;
	}
	.side {
		min-height: 0;
	}
	.upload {
		display: grid;
		gap: 10px;
	}
	.file {
		position: relative;
		display: block;
		cursor: pointer;
	}
	.file input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.file-face {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border: 1px dashed var(--ess-border-strong);
		border-radius: 10px;
		background: var(--ess-sunken);
		font-size: 13px;
		color: var(--ess-text-secondary);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.file:focus-within .file-face {
		outline: 2px solid var(--ess-primary-ring);
	}
	.open-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
	}
	.open-form {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
	}
	.people {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
		max-height: 260px;
	}
	.people label {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 4px;
		border-bottom: 1px solid var(--ess-border-subtle);
		cursor: pointer;
	}
	.notice {
		margin: 0;
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}
	.uploads {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.uploads li {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.uploads small {
		color: var(--ess-text-muted);
		font-size: 12px;
	}
</style>
