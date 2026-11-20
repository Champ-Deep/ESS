<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Mail from '@lucide/svelte/icons/mail';
	import Search from '@lucide/svelte/icons/search';
	import Send from '@lucide/svelte/icons/send';

	/**
	 * Login emails waiting for approval, in Admin Controls › People. New logins
	 * are never emailed on their own: someone with "Approve login emails"
	 * approves them here, and approved ones go out one at a time at the
	 * cadence below (src/lib/server/login-emails.ts).
	 */

	type Row = {
		id: string;
		fullName: string;
		email: string;
		sendTo: string | null;
		source: 'single' | 'bulk' | 'reissue' | 'champ';
		status: 'pending' | 'approved' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'skipped';
		requestedBy: string | null;
		approvedBy: string | null;
		createdAt: string;
		approvedAt: string | null;
		sentAt: string | null;
		error: string | null;
		position: number | null;
		waitingToSignIn: boolean;
	};
	type Data = { rows: Row[]; settings: { cadenceSeconds: number }; mailerConfigured: boolean; nextSendAt: string | null };

	let data = $state<Data | null>(null);
	let picked = $state<string[]>([]);
	let busy = $state(false);
	let message = $state<{ tone: 'ok' | 'bad'; text: string } | null>(null);
	let cadenceValue = $state(1);
	let cadenceUnit = $state<'seconds' | 'minutes' | 'hours'>('minutes');
	let showDone = $state(false);

	/* ---------- find anyone: filters every list, and searches the roster ---------- */
	let q = $state('');
	type Person = { id: string; fullName: string; email: string; mustChange: boolean; isActive: boolean; lastStatus: string | null; lastError: string | null; lastAt: string | null };
	let people = $state<Person[]>([]);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const text = q.trim();
		if (searchTimer) clearTimeout(searchTimer);
		if (text.length < 2) {
			people = [];
			return;
		}
		searchTimer = setTimeout(async () => {
			const r = await fetch(`/api/admin/login-emails?q=${encodeURIComponent(text)}`);
			if (r.ok && q.trim() === text) people = (await r.json()).people ?? [];
		}, 250);
	});
	const matches = (r: Row) => {
		const t = q.trim().toLowerCase();
		return !t || r.fullName.toLowerCase().includes(t) || r.email.toLowerCase().includes(t) || (r.sendTo ?? '').toLowerCase().includes(t);
	};
	/* ---------- change a mistyped email, then send ---------- */
	let editingEmail = $state<string | null>(null);
	let newEmail = $state('');
	async function changeEmail(p: Person, sendNow: boolean) {
		busy = true;
		message = null;
		const r = await fetch('/api/admin/login-emails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'change_email', userId: p.id, email: newEmail, sendNow }) });
		const body = await r.json().catch(() => ({}));
		busy = false;
		if (!r.ok) {
			message = { tone: 'bad', text: body.message ?? 'That did not work' };
			return;
		}
		const results = (body.results ?? []) as { fullName: string; outcome: string; note: string | null }[];
		const sendText = sendNow
			? results.some((x) => x.outcome === 'sent')
				? ` Login details sent to ${newEmail.trim().toLowerCase()}.`
				: ` Not sent: ${body.sendError ?? results[0]?.note ?? 'nothing to send'}.`
			: '';
		message = { tone: body.clerk ? 'bad' : 'ok', text: `${body.message}${sendText}${body.clerk ? ` ${body.clerk}` : ''}` };
		editingEmail = null;
		q = newEmail.trim().toLowerCase();
		await load();
	}

	const STATUS: Record<string, string> = { pending: 'Waiting for approval', approved: 'Approved, in the queue', sending: 'Sending', sent: 'Sent', failed: "Couldn't send", cancelled: 'Cancelled', skipped: 'Skipped' };

	const UNIT = { seconds: 1, minutes: 60, hours: 3600 } as const;

	async function load() {
		const r = await fetch('/api/admin/login-emails');
		if (!r.ok) return;
		data = await r.json();
		const c = data!.settings.cadenceSeconds;
		if (c % 3600 === 0) [cadenceValue, cadenceUnit] = [c / 3600, 'hours'];
		else if (c % 60 === 0) [cadenceValue, cadenceUnit] = [c / 60, 'minutes'];
		else [cadenceValue, cadenceUnit] = [c, 'seconds'];
		picked = picked.filter((id) => data!.rows.some((x) => x.id === id));
	}

	$effect(() => {
		void load();
		// The queue moves on its own as emails go out.
		const t = setInterval(load, 15_000);
		return () => clearInterval(t);
	});

	async function act(action: string, ids: string[] = picked, extra: Record<string, unknown> = {}) {
		busy = true;
		message = null;
		const r = await fetch('/api/admin/login-emails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ids, ...extra }) });
		const body = await r.json().catch(() => ({}));
		busy = false;
		if (!r.ok) {
			message = { tone: 'bad', text: body.message ?? 'That did not work' };
			return;
		}
		const n = body.count ?? 0;
		if (action === 'send_now' || action === 'send_now_people') {
			const results = (body.results ?? []) as { fullName: string; outcome: string; note: string | null }[];
			const sent = results.filter((x) => x.outcome === 'sent');
			const other = results.filter((x) => x.outcome !== 'sent');
			message = {
				tone: other.length && !sent.length ? 'bad' : 'ok',
				text: [
					sent.length ? `Sent now to ${sent.map((x) => x.fullName).join(', ')}.` : '',
					...other.map((x) => `${x.fullName}: not sent${x.note ? ` (${x.note})` : ''}.`),
					results.length ? '' : 'Nothing to send.'
				]
					.filter(Boolean)
					.join(' ')
			};
			picked = [];
			await load();
			if (q.trim().length >= 2) q = q + '';
			return;
		}
		message = {
			tone: 'ok',
			text:
				action === 'approve' || action === 'approve_all'
					? `Approved ${n}. They go out one at a time, ${cadenceText(data?.settings.cadenceSeconds ?? 60)} apart.`
					: action === 'hold'
						? `Held back ${n}. They wait for approval again.`
						: action === 'cancel'
							? `Cancelled ${n}. Those people won't be emailed; their password is still on the roster.`
							: `Saved. Approved emails now go out ${cadenceText(Number(extra.cadenceSeconds))} apart.`
		};
		picked = [];
		await load();
		await invalidateAll();
	}

	function cadenceText(s: number) {
		if (s % 3600 === 0) return `${s / 3600} ${s === 3600 ? 'hour' : 'hours'}`;
		if (s % 60 === 0) return `${s / 60} ${s === 60 ? 'minute' : 'minutes'}`;
		return `${s} seconds`;
	}

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
	const SOURCE = { single: 'Created one login', bulk: 'Bulk import', reissue: 'Re-issued', champ: 'Created through Champ' };

	const pending = $derived(data?.rows.filter((r) => r.status === 'pending' && matches(r)) ?? []);
	const approved = $derived((data?.rows.filter((r) => (r.status === 'approved' || r.status === 'sending') && matches(r)) ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
	const failed = $derived(data?.rows.filter((r) => r.status === 'failed' && matches(r)) ?? []);
	const done = $derived(data?.rows.filter((r) => (r.status === 'sent' || r.status === 'skipped' || r.status === 'cancelled') && matches(r)) ?? []);

	function toggle(id: string, on: boolean) {
		picked = on ? [...picked, id] : picked.filter((x) => x !== id);
	}
	const allPicked = (list: Row[]) => list.length > 0 && list.every((r) => picked.includes(r.id));
	function pickAll(list: Row[], on: boolean) {
		const ids = list.map((r) => r.id);
		picked = on ? [...new Set([...picked, ...ids])] : picked.filter((x) => !ids.includes(x));
	}
</script>

<section class="ess-card queue" id="login-emails">
	<header class="head">
		<div>
			<h2 class="ess-h2">Login delivery</h2>
			<p class="ess-caption">
				New logins are not emailed until you approve them here. Approved emails go out one at a time, so a large import never floods inboxes or the mail provider.
			</p>
		</div>
		<form
			class="cadence"
			onsubmit={(e) => {
				e.preventDefault();
				void act('cadence', [], { cadenceSeconds: cadenceValue * UNIT[cadenceUnit] });
			}}
		>
			<label class="ess-label" for="le-cadence">Send one every</label>
			<div class="row">
				<input id="le-cadence" class="ess-input num" type="number" min="1" step="1" bind:value={cadenceValue} />
				<select class="ess-select" bind:value={cadenceUnit} aria-label="Unit">
					<option value="seconds">seconds</option>
					<option value="minutes">minutes</option>
					<option value="hours">hours</option>
				</select>
				<button class="ess-btn ess-btn--secondary ess-btn--sm" disabled={busy}>Save</button>
			</div>
		</form>
	</header>

	{#if data && !data.mailerConfigured}
		<p class="ess-alert ess-alert--warning" role="status">No mail provider is set up (RESEND_API_KEY), so approved emails will wait here until it is. Pass logins on by hand meanwhile.</p>
	{/if}
	{#if message}<p class="ess-alert {message.tone === 'ok' ? 'ess-alert--success' : 'ess-alert--danger'}" role="status">{message.text}</p>{/if}

	<label class="ess-search find">
		<Search size={15} />
		<input class="ess-input" type="search" placeholder="Find an employee by name, email or employee code…" bind:value={q} aria-label="Find an employee" />
	</label>

	{#if q.trim().length >= 2}
		<div class="block">
			<div class="bar"><h3 class="ess-h3">On the roster <span class="n">{people.length}</span></h3></div>
			{#if people.length}
				<div class="ess-table-shell">
					<table class="ess-table">
						<thead><tr><th>Person</th><th>Login email so far</th><th></th></tr></thead>
						<tbody>
							{#each people as p (p.id)}
								<tr>
									<td><strong>{p.fullName}</strong><br /><small class="muted">{p.email}{p.mustChange ? '' : ' · has signed in'}{p.isActive ? '' : ' · login closed'}</small></td>
									<td>{p.lastStatus ? `${STATUS[p.lastStatus] ?? p.lastStatus}${p.lastAt ? ` · ${when(p.lastAt)}` : ''}` : 'Never queued'}{#if p.lastError}<br /><small class="err">{p.lastError}</small>{/if}</td>
									<td class="right">
										<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" disabled={busy} onclick={() => { editingEmail = editingEmail === p.id ? null : p.id; newEmail = p.email; }}>Change email</button>
										<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" disabled={busy || !p.isActive} onclick={() => act('send_now_people', [], { userIds: [p.id] })}><Send size={14} /> Send login email now</button>
									</td>
								</tr>
								{#if editingEmail === p.id}
									<tr class="edit-email">
										<td colspan="3">
											<form class="email-form" onsubmit={(e) => { e.preventDefault(); void changeEmail(p, true); }}>
												<label class="ess-field">
													<span class="ess-label">Correct email for {p.fullName} (also their username)</span>
													<input class="ess-input" type="email" required bind:value={newEmail} />
												</label>
												<button type="submit" class="ess-btn ess-btn--primary ess-btn--sm" disabled={busy || !newEmail.trim() || newEmail.trim().toLowerCase() === p.email}><Send size={14} /> Save and send login details</button>
												<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" disabled={busy || !newEmail.trim() || newEmail.trim().toLowerCase() === p.email} onclick={() => changeEmail(p, false)}>Save only</button>
												<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (editingEmail = null)}>Cancel</button>
											</form>
											<p class="ess-help">Was {p.email}. They sign in with the new address from now on{p.mustChange ? '' : '; their own password stays the same'}.</p>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
				<p class="ess-help">Sends at once, without waiting for the queue. Someone still on their first password gets it; someone who has already set their own gets their username and how to sign in.</p>
			{:else}
				<p class="ess-help">No one matches “{q.trim()}”.</p>
			{/if}
		</div>
	{/if}

	{#if !data}
		<div class="ess-skeleton" style="width:60%"></div>
	{:else}
		<div class="block">
			<div class="bar">
				<h3 class="ess-h3">Pending review <span class="n">{pending.length}</span></h3>
				<div class="btns">
					<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" disabled={busy || !pending.some((r) => picked.includes(r.id))} onclick={() => act('send_now', pending.filter((r) => picked.includes(r.id)).map((r) => r.id))}><Send size={14} /> Send selected now</button>
					<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" disabled={busy || !pending.some((r) => picked.includes(r.id))} onclick={() => act('approve', pending.filter((r) => picked.includes(r.id)).map((r) => r.id))}>Approve selected</button>
					<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" disabled={busy || pending.length === 0} onclick={() => act('approve_all', [])}>Approve all {pending.length}</button>
					<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" disabled={busy || !pending.some((r) => picked.includes(r.id))} onclick={() => act('cancel', pending.filter((r) => picked.includes(r.id)).map((r) => r.id))}>Don't send</button>
				</div>
			</div>
			{#if pending.length}
				<div class="ess-table-shell">
					<table class="ess-table">
						<thead>
							<tr>
								<th><input type="checkbox" aria-label="Select all waiting" checked={allPicked(pending)} onchange={(e) => pickAll(pending, e.currentTarget.checked)} /></th>
								<th>Person</th>
								<th>Goes to</th>
								<th>From</th>
								<th>Queued</th>
							</tr>
						</thead>
						<tbody>
							{#each pending as r (r.id)}
								<tr>
									<td><input type="checkbox" aria-label="Select {r.fullName}" checked={picked.includes(r.id)} onchange={(e) => toggle(r.id, e.currentTarget.checked)} /></td>
									<td><strong>{r.fullName}</strong></td>
									<td>{r.sendTo ? `${r.sendTo} (test inbox, instead of ${r.email})` : r.email}</td>
									<td>{SOURCE[r.source]}{r.requestedBy ? ` · ${r.requestedBy}` : ''}</td>
									<td>{when(r.createdAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<div class="ess-empty quiet">
					<span class="ess-empty__icon"><Mail size={20} /></span>
					<span class="ess-empty__title">Nothing is waiting</span>
					<span>New logins' emails appear here for approval before anything is sent.</span>
				</div>
			{/if}
		</div>

		{#if approved.length}
			<div class="block">
				<div class="bar">
					<h3 class="ess-h3">Approved, going out <span class="n">{approved.length}</span></h3>
					<div class="btns">
						<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" disabled={busy || !approved.some((r) => picked.includes(r.id))} onclick={() => act('send_now', approved.filter((r) => picked.includes(r.id)).map((r) => r.id))}><Send size={14} /> Send selected now</button>
						<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" disabled={busy || !approved.some((r) => picked.includes(r.id))} onclick={() => act('hold', approved.filter((r) => picked.includes(r.id)).map((r) => r.id))}>Hold back</button>
					</div>
				</div>
				<p class="ess-help">One every {cadenceText(data.settings.cadenceSeconds)}{data.nextSendAt ? `; the next goes at about ${when(data.nextSendAt)}` : ''}. The last of these goes out in about {cadenceText(Math.max(1, approved.length) * data.settings.cadenceSeconds)}.</p>
				<div class="ess-table-shell">
					<table class="ess-table">
						<thead><tr><th><input type="checkbox" aria-label="Select all approved" checked={allPicked(approved)} onchange={(e) => pickAll(approved, e.currentTarget.checked)} /></th><th>#</th><th>Person</th><th>Goes to</th><th>Approved by</th></tr></thead>
						<tbody>
							{#each approved as r (r.id)}
								<tr>
									<td>{#if r.status === 'approved'}<input type="checkbox" aria-label="Select {r.fullName}" checked={picked.includes(r.id)} onchange={(e) => toggle(r.id, e.currentTarget.checked)} />{/if}</td>
									<td class="ess-num">{r.status === 'sending' ? 'Sending' : r.position}</td>
									<td><strong>{r.fullName}</strong></td>
									<td>{r.sendTo ?? r.email}</td>
									<td>{r.approvedBy ?? ''} · {when(r.approvedAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/if}

		{#if failed.length}
			<div class="block">
				<div class="bar">
					<h3 class="ess-h3">Couldn't send <span class="n bad">{failed.length}</span></h3>
					<div class="btns">
						<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" disabled={busy || !failed.some((r) => picked.includes(r.id))} onclick={() => act('send_now', failed.filter((r) => picked.includes(r.id)).map((r) => r.id))}><Send size={14} /> Resend selected now</button>
						<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" disabled={busy || !failed.some((r) => picked.includes(r.id))} onclick={() => act('approve', failed.filter((r) => picked.includes(r.id)).map((r) => r.id))}>Retry in the queue</button>
						<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" disabled={busy || !failed.some((r) => picked.includes(r.id))} onclick={() => act('cancel', failed.filter((r) => picked.includes(r.id)).map((r) => r.id))}>Don't send</button>
					</div>
				</div>
				<div class="ess-table-shell">
					<table class="ess-table">
						<thead><tr><th><input type="checkbox" aria-label="Select all failed" checked={allPicked(failed)} onchange={(e) => pickAll(failed, e.currentTarget.checked)} /></th><th>Person</th><th>Address</th><th>Why</th></tr></thead>
						<tbody>
							{#each failed as r (r.id)}
								<tr>
									<td><input type="checkbox" aria-label="Select {r.fullName}" checked={picked.includes(r.id)} onchange={(e) => toggle(r.id, e.currentTarget.checked)} /></td>
									<td><strong>{r.fullName}</strong></td>
									<td>{r.sendTo ?? r.email}</td>
									<td class="err">{r.error} <button type="button" class="ess-link as-link" onclick={() => (q = r.fullName)}>Wrong email? Fix it</button></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="ess-help">Their temporary password is on the roster until they sign in, so a login can still be passed on by hand.</p>
			</div>
		{/if}

		{#if done.length}
			<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (showDone = !showDone)}>{showDone ? 'Hide' : 'Show'} the last two weeks ({done.length})</button>
			{#if showDone || q.trim().length >= 2}
				<div class="ess-table-shell">
					<table class="ess-table">
						<thead><tr><th>Person</th><th>Status</th><th>When</th><th>Note</th><th></th></tr></thead>
						<tbody>
							{#each done as r (r.id)}
								<tr>
									<td>{r.fullName}</td>
									<td><span class="ess-badge {r.status === 'sent' ? 'ess-badge--approved' : 'ess-badge--cancelled'}">{r.status === 'sent' ? 'Sent' : r.status === 'skipped' ? 'Not needed' : 'Cancelled'}</span></td>
									<td>{when(r.sentAt ?? r.createdAt)}</td>
									<td>{r.error ?? (r.sendTo ? `Sent to ${r.sendTo}` : '')}</td>
									<td class="right"><button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" disabled={busy} onclick={() => act('send_now', [r.id])}><Send size={13} /> Resend</button></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/if}
	{/if}
</section>

<style>
	.find {
		max-width: 520px;
	}
	.email-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 8px;
	}
	.email-form .ess-field {
		flex: 1 1 320px;
	}
	.as-link {
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		font-size: 12.5px;
		cursor: pointer;
	}
	.muted {
		color: var(--ess-text-muted);
	}
	.right {
		text-align: right;
		white-space: nowrap;
	}
	.queue {
		display: grid;
		gap: 18px;
	}
	.head {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		align-items: flex-end;
	}
	.head p {
		max-width: 64ch;
		margin-top: 4px;
	}
	.cadence {
		display: grid;
		gap: 6px;
		padding: 12px 14px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		background: var(--ess-sunken);
	}
	.cadence .row {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.cadence .num {
		width: 80px;
	}
	.cadence .ess-select {
		width: auto;
	}
	.block {
		display: grid;
		gap: 10px;
	}
	.block + .block {
		padding-top: 16px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.btns {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.n {
		margin-left: 6px;
		padding: 0 7px;
		border-radius: 99px;
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
		font-size: 12px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}
	.n.bad {
		background: var(--ess-danger-bg);
		color: var(--ess-danger);
	}
	.err {
		color: var(--ess-danger);
	}
	.quiet {
		padding: 24px;
	}
	.ess-table input[type='checkbox'] {
		accent-color: var(--ess-primary);
		width: 16px;
		height: 16px;
	}
</style>
