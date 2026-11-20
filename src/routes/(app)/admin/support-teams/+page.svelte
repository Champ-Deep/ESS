<script lang="ts">
	import { enhance } from '$app/forms';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Headset from '@lucide/svelte/icons/headset';
	import Laptop from '@lucide/svelte/icons/laptop';
	import PartyPopper from '@lucide/svelte/icons/party-popper';
	import Shield from '@lucide/svelte/icons/shield';
	import Avatar from '$lib/components/Avatar.svelte';
	import { CAPABILITIES, SUPPORT_TEAMS, type SupportTeamKey } from '$lib/capabilities';

	let { data, form } = $props();

	const ICON: Record<SupportTeamKey, typeof Shield> = { hr: Shield, engagement: PartyPopper, it: Laptop };
	const label = (key: string) => CAPABILITIES.find((c) => c.key === key)?.label ?? key;

	/** The add-people search per team. */
	const query = $state<Record<SupportTeamKey, string>>({ hr: '', engagement: '', it: '' });
	let busy = $state<string | null>(null);

	function matches(team: SupportTeamKey) {
		const q = query[team].trim().toLowerCase();
		if (q.length < 2) return [];
		const inTeam = new Set(data.roster[team].map((m) => m.id));
		return data.people.filter((p) => !inTeam.has(p.id) && (p.fullName.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))).slice(0, 6);
	}

	const submit = (key: string) => () => {
		busy = key;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = null;
		};
	};
</script>

<svelte:head>
	<title>HR, IT & Engagement — Champ HR ESS Portal</title>
</svelte:head>

{#if form?.error}
	<p class="ess-alert ess-alert--danger" role="alert">{form.error}</p>
{:else if form?.message}
	<p class="ess-alert ess-alert--success" role="status">{form.message}</p>
{/if}

<p class="intro">
	Put people in a team and they get its controls straight away (within 30 seconds), on top of whatever role they already have. Everyone else gets a private
	<strong>Ask HR</strong>, <strong>Ask IT</strong> and <strong>Ask Engagement</strong> thread in Champ Hub › Chats; each one goes only to that team, who answer it and mark it
	resolved.{#if !data.canManage} Only a Super Admin can change who is in a team.{/if}
</p>

<div class="teams ess-fill">
	{#each SUPPORT_TEAMS as t (t.key)}
		{@const Icon = ICON[t.key]}
		{@const members = data.roster[t.key]}
		<section class="ess-card ess-fill-card team" aria-labelledby="team-{t.key}">
			<div class="ess-card-head head">
				<span class="ess-tile ess-tile--sm"><Icon size={17} /></span>
				<div class="title">
					<h2 id="team-{t.key}" class="ess-h2">{t.name}</h2>
					<span class="ess-caption">{t.description}</span>
				</div>
			</div>

			<div class="desk">
				<Headset size={14} />
				<span><strong>{t.deskName}</strong> · {t.askAbout}</span>
				{#if data.openByTeam[t.key] > 0}
					<span class="ess-badge ess-badge--pending">{data.openByTeam[t.key]} open</span>
				{/if}
			</div>

			<div class="ess-scroll body">
				<h3 class="sub">Members <span class="n">{members.length}</span></h3>
				{#if members.length === 0}
					<p class="empty">
						Nobody yet. {t.key === 'hr' ? 'Until someone is added, Ask HR goes to each person’s concerned HR, else every HR admin.' : `Until someone is added, ${t.deskName} goes to the Super Admins.`}
					</p>
				{:else}
					<ul class="members">
						{#each members as m (m.id)}
							<li>
								<Avatar userId={m.id} fullName={m.fullName} size="sm" />
								<span class="who"><span class="name">{m.fullName}</span><span class="mail">{m.email}</span></span>
								{#if data.canManage}
									<form method="POST" action="?/remove" use:enhance={submit(`rm:${t.key}:${m.id}`)}>
										<input type="hidden" name="team" value={t.key} />
										<input type="hidden" name="userId" value={m.id} />
										<button type="submit" class="ess-icon-btn" aria-label="Remove {m.fullName} from {t.name}" title="Remove from {t.name}" disabled={busy === `rm:${t.key}:${m.id}`}>
											<X size={15} />
										</button>
									</form>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#if data.canManage}
					<div class="add">
						<label class="ess-search">
							<Search size={15} />
							<input class="ess-input" type="search" placeholder="Add someone to {t.name}…" bind:value={query[t.key]} aria-label="Find a person to add to {t.name}" />
						</label>
						{#if matches(t.key).length}
							<ul class="results">
								{#each matches(t.key) as p (p.id)}
									<li>
										<form method="POST" action="?/add" use:enhance={submit(`add:${t.key}:${p.id}`)}>
											<input type="hidden" name="team" value={t.key} />
											<input type="hidden" name="userId" value={p.id} />
											<button type="submit" class="pick" disabled={busy === `add:${t.key}:${p.id}`} onclick={() => setTimeout(() => (query[t.key] = ''), 0)}>
												<Avatar userId={p.id} fullName={p.fullName} size="sm" />
												<span class="who"><span class="name">{p.fullName}</span><span class="mail">{p.email}</span></span>
												<Plus size={15} />
											</button>
										</form>
									</li>
								{/each}
							</ul>
						{:else if query[t.key].trim().length >= 2}
							<p class="empty">No one else matches.</p>
						{/if}
					</div>
				{/if}

				<h3 class="sub">Controls they get</h3>
				<div class="caps">
					{#each t.capabilities as c (c)}
						<span class="cap">{label(c)}</span>
					{/each}
				</div>
			</div>
		</section>
	{/each}
</div>

<style>
	.intro {
		margin: 0 0 12px;
		max-width: 920px;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--ess-text-secondary);
	}
	.teams {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
		min-height: 0;
	}
	@media (max-width: 1100px) {
		.teams {
			grid-template-columns: 1fr;
		}
	}
	.team {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.head {
		align-items: flex-start;
		gap: 10px;
		justify-content: flex-start;
	}
	.title {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.desk {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 2px 0 10px;
		padding: 8px 10px;
		border-radius: 10px;
		background: var(--ess-sunken);
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}
	.desk span:first-of-type {
		flex: 1;
		min-width: 0;
	}
	.body {
		flex: 1;
		min-height: 0;
		display: grid;
		align-content: start;
		gap: 10px;
	}
	.sub {
		margin: 4px 0 0;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--ess-text-muted);
	}
	.sub .n {
		margin-left: 4px;
		font-variant-numeric: tabular-nums;
	}
	.empty {
		margin: 0;
		font-size: 13px;
		color: var(--ess-text-muted);
	}
	.members,
	.results {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}
	.members li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 4px;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.who {
		display: grid;
		flex: 1;
		min-width: 0;
		line-height: 1.25;
		text-align: left;
	}
	.name {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--ess-text);
	}
	.mail {
		font-size: 12px;
		color: var(--ess-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.add {
		display: grid;
		gap: 6px;
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 6px 8px;
		border: 1px solid var(--ess-border);
		border-radius: 10px;
		background: var(--ess-surface);
		color: var(--ess-primary-text);
		font: inherit;
		cursor: pointer;
	}
	.pick:hover {
		background: var(--ess-surface-hover);
	}
	.caps {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.cap {
		padding: 3px 9px;
		border-radius: 999px;
		background: var(--ess-primary-softer);
		color: var(--ess-primary-text);
		font-size: 12px;
	}
</style>
