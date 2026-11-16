<script lang="ts">
	import KeyRound from '@lucide/svelte/icons/key-round';
	import UserCheck from '@lucide/svelte/icons/user-check';
	import Mail from '@lucide/svelte/icons/mail';
	import Fingerprint from '@lucide/svelte/icons/fingerprint';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import DeskStatsCard from '$lib/components/DeskStatsCard.svelte';

	let { data } = $props();
	const f = $derived(data.figures);
	const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
	const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
</script>

<svelte:head><title>IT dashboard — Champ HR ESS Portal</title></svelte:head>

<div class="ess-figures figures">
	<div class="ess-figure">
		<span class="ess-tile ess-tile--sm"><UserCheck size={18} /></span>
		<div><div class="ess-figure__value">{f.activeLogins}</div><div class="ess-figure__label">Active logins · {f.signedInShare}% have signed in</div></div>
	</div>
	<div class="ess-figure">
		<span class="ess-figure__dot" class:ess-figure__dot--warn={f.neverSignedIn > 0}></span>
		<div><div class="ess-figure__value">{f.neverSignedIn}</div><div class="ess-figure__label">Never signed in</div></div>
	</div>
	<div class="ess-figure">
		<span class="ess-figure__dot" class:ess-figure__dot--bad={f.staleTemporary > 0}></span>
		<div><div class="ess-figure__value">{f.staleTemporary}</div><div class="ess-figure__label">Temporary password over 2 weeks old</div></div>
	</div>
	<div class="ess-figure">
		<span class="ess-tile ess-tile--sm"><KeyRound size={18} /></span>
		<div><div class="ess-figure__value">{f.resets30d}</div><div class="ess-figure__label">Resets · {f.changes30d} changes, 30 days</div></div>
	</div>
	<div class="ess-figure">
		<span class="ess-tile ess-tile--sm"><Mail size={18} /></span>
		<div><div class="ess-figure__value">{f.emailsWaiting}</div><div class="ess-figure__label">Login emails waiting{f.emailsFailed ? ` · ${f.emailsFailed} failed` : ''}</div></div>
	</div>
</div>

<div class="grid ess-fill">
	<DeskStatsCard title="Ask IT desk" stats={data.desk} />

	<section class="ess-card" aria-labelledby="stale-h">
		<div class="ess-card-head">
			<h2 id="stale-h" class="ess-h2">Still on a temporary password</h2>

		</div>
		{#if data.staleList.length}
			<ul class="rows">
				{#each data.staleList as p (p.id)}
					<li><span class="who"><strong>{p.fullName}</strong><small>{p.email}</small></span><span class="meta">since {day(p.since)}</span></li>
				{/each}
			</ul>
			<p class="ess-caption">Over two weeks without signing in. Check their login email reached them; HR can resend it or reset the password.</p>
		{:else}
			<p class="ess-caption">Everyone given a temporary password more than two weeks ago has signed in.</p>
		{/if}
	</section>

	<section class="ess-card" aria-labelledby="bio-h">
		<div class="ess-card-head">
			<h2 id="bio-h" class="ess-h2"><Fingerprint size={16} /> Biometric sync</h2>
			<a class="ess-link" href="/admin/biometric">Attendance <ChevronRight size={14} /></a>
		</div>
		<dl class="kv">
			<dt>Last import</dt>
			<dd>{data.lastImport ? when(data.lastImport.at) : 'Nothing imported yet'}</dd>
			{#if data.lastImport}
				<dt>Rows · not matched</dt>
				<dd>{data.lastImport.rows} · <span class:warn={data.lastImport.unmatched > 0}>{data.lastImport.unmatched}</span></dd>
			{/if}
			<dt>Logins with no employee code</dt>
			<dd class:warn={f.withoutCode > 0}>{f.withoutCode}</dd>
			<dt>Blue-collar staff (no login)</dt>
			<dd>{f.blueCollar}</dd>
		</dl>
		{#if data.noCode.length}
			<p class="ess-caption">Without a code their punches can't be matched, for example:</p>
			<ul class="rows">
				{#each data.noCode as p (p.id)}
					<li><span class="who"><strong>{p.fullName}</strong><small>{p.email}</small></span></li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.figures {
		margin-bottom: 12px;
		grid-template-columns: repeat(5, minmax(0, 1fr));
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
		align-items: start;
	}
	@media (max-width: 1100px) {
		.grid,
		.figures {
			grid-template-columns: 1fr;
		}
	}
	.rows {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.rows li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 2px;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.who {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.who small,
	.meta {
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.who small {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.kv {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 8px 12px;
		margin: 0 0 10px;
		font-size: 13px;
	}
	.kv dt {
		color: var(--ess-text-secondary);
	}
	.kv dd {
		margin: 0;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.warn {
		color: var(--ess-warning-text, #b45309);
	}
	.ess-h2 {
		display: flex;
		align-items: center;
		gap: 8px;
	}
</style>
