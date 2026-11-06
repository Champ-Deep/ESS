<script lang="ts">
	import { goto } from '$app/navigation';
	import Mail from '@lucide/svelte/icons/mail';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Clock from '@lucide/svelte/icons/clock';
	import Search from '@lucide/svelte/icons/search';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import Headset from '@lucide/svelte/icons/headset';
	import Avatar from '$lib/components/Avatar.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	let { data } = $props();

	/*
		Only the job designation is shown. This used to fall back to the account's
		privilege level when no designation was on file, which published "Super
		Admin" or "Team Lead" to every employee who opened the page — a permissions
		setting standing in for a job title. A missing designation now shows
		nothing, which says less but says nothing wrong.
	*/

	let q = $state('');
	const needle = $derived(q.trim().toLowerCase());
	const contacts = $derived(
		needle
			? data.contacts.filter((c) => [c.fullName, c.designation, c.email, c.floorDetails, c.teamAndFloor].some((v) => (v ?? '').toLowerCase().includes(needle)))
			: data.contacts
	);
	const location = (c: (typeof data.contacts)[number]) => [c.floorDetails, c.teamAndFloor].filter(Boolean).join(' · ');

	let chatting = $state<string | null>(null);
	let chatError = $state('');

	/** Opens (or creates) the direct message with this person in Champ Hub. */
	async function chat(userId: string) {
		chatError = '';
		chatting = userId;
		try {
			const res = await fetch('/api/chat/dm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || !body.ok) {
				chatError = body.message ?? 'Could not open a chat with this person right now.';
				return;
			}
			await goto(`/hub/c/${body.id}`);
		} catch {
			chatError = 'You seem to be offline. Try again in a moment.';
		} finally {
			chatting = null;
		}
	}
</script>

<svelte:head>
	<title>HR contacts — Champ HR</title>
</svelte:head>

<PageHeader crumb={[{ label: 'Home', href: '/dashboard' }, 'HR contacts']} title="The right person to help." sub="Find and contact the HR team for quick support." compact />

<!-- One full-width column: the team card takes the spare height, contacts
     sit several to a row, and the help steps run across the bottom beside
     the quick links, so nothing is a tall, mostly empty side card. -->
<div class="ess-fill layout">
	<div class="ess-search">
		<Search size={18} />
		<input class="ess-input big" type="search" placeholder="Search by name, role or location" bind:value={q} aria-label="Search HR contacts" />
	</div>

	<section class="ess-card ess-fill-card grow team-card">
		<div class="head">
			<h2 class="ess-h2">Your HR team</h2>
			<p>Your manager and the HR team who handle leave, attendance records, logins and policy questions.</p>
		</div>
		{#if chatError}<p class="ess-error" role="alert">{chatError}</p>{/if}
		<div class="ess-scroll people">
			{#each contacts as contact (contact.id)}
				<div class="ess-row person">
					<Avatar userId={contact.id} fullName={contact.fullName} hasPicture={contact.hasPicture} size="lg" />
					<div class="ess-row__body">
						<span class="name">{contact.fullName}{#if contact.isManager}<span class="ess-badge ess-badge--accent tag">Your manager</span>{/if}</span>
						{#if contact.designation}<span class="role">{contact.designation}</span>{/if}
						<span class="line"><Mail size={14} /> <a href="mailto:{contact.email}">{contact.email}</a></span>
						{#if location(contact)}<span class="line"><MapPin size={14} /> {location(contact)}</span>{/if}
						{#if contact.officeTimings}<span class="line"><Clock size={14} /> {contact.officeTimings}</span>{/if}
						<div class="actions">
							<a href="mailto:{contact.email}" class="ess-btn ess-btn--secondary ess-btn--sm"><Mail size={15} /> Email</a>
							<button type="button" class="ess-btn ess-btn--primary ess-btn--sm" onclick={() => chat(contact.id)} disabled={chatting === contact.id}>
								<MessageCircle size={15} /> {chatting === contact.id ? 'Opening…' : 'Chat'}
							</button>
						</div>
					</div>
				</div>
			{:else}
				<div class="ess-empty fill-empty">
					<span class="ess-empty__icon"><Headset size={20} /></span>
					<span class="ess-empty__title">{data.contacts.length === 0 ? 'No HR contacts on file yet' : 'No one matches that'}</span>
					<span>{data.contacts.length === 0 ? 'Your manager and HR team appear here once HR sets them up.' : 'Try a name, a role or an office.'}</span>
				</div>
			{/each}
		</div>
	</section>

	<div class="help-row">
		<section class="ess-card help-card">
			<div class="help-head">
				<h2 class="ess-h2 aside-h">How to get help</h2>
				<p class="aside-sub">Follow these steps to reach the right person.</p>
			</div>
			<ol class="steps">
				<li>
					<span class="num">1</span>
					<div><strong>Find your contact</strong><span>Search by name or role, or pick your manager for anything about your own team.</span></div>
				</li>
				<li>
					<span class="num">2</span>
					<div><strong>Check who handles what</strong><span>Leave, attendance corrections and logins go to HR; day-to-day questions go to your manager.</span></div>
				</li>
				<li>
					<span class="num">3</span>
					<div><strong>Start a conversation</strong><span>Use Email or Chat to get in touch directly. Chat opens in Champ Hub.</span></div>
				</li>
			</ol>
		</section>
		<section class="ess-card before-card">
			<h2 class="ess-h2 aside-h">Before you ask</h2>
			<div class="ess-rows">
				<a class="ess-row" href="/policies?tab=leave"><span class="ess-row__body"><span class="ess-row__title">Leave policy</span><span class="ess-row__meta">Entitlements, carry-forward and documentation</span></span></a>
				<a class="ess-row" href="/attendance"><span class="ess-row__body"><span class="ess-row__title">Raise an attendance correction</span><span class="ess-row__meta">For a missing or wrong punch</span></span></a>
			</div>
		</section>
	</div>
</div>

<style>
	.layout {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}
	.big {
		height: 38px;
		font-size: 14px;
		border-radius: var(--ess-radius-md);
	}
	.head {
		padding-bottom: 10px;
		border-bottom: 1px solid var(--ess-border);
		margin-bottom: 10px;
	}
	.head p {
		margin-top: 2px;
		font-size: 13px;
		color: var(--ess-text-secondary);
	}

	/* Contacts as tiles, as many to a row as fit. */
	.people {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		align-content: start;
		gap: 10px;
	}
	.person {
		align-items: flex-start;
		padding: 12px 14px;
		gap: 12px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		min-width: 0;
	}
	.person .ess-row__body {
		gap: 2px;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-family: var(--ess-font-display);
		font-size: 15px;
		font-weight: 600;
		color: var(--ess-text);
	}
	.tag {
		font-family: var(--ess-font-sans);
	}
	.role {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.line {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: 12.5px;
		color: var(--ess-text-secondary);
		overflow-wrap: anywhere;
	}
	.line :global(svg) {
		flex: none;
		color: var(--ess-text-muted);
	}
	.actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
	.fill-empty {
		padding: 16px;
		gap: 6px;
	}
	.fill-empty .ess-empty__icon {
		width: 42px;
		height: 42px;
	}
	.fill-empty .ess-empty__title {
		font-size: 17px;
	}
	.people > .fill-empty {
		grid-column: 1 / -1;
	}

	/* Help steps across the bottom, beside the quick links. */
	.help-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		gap: 12px;
		align-items: stretch;
	}
	.help-head {
		display: flex;
		align-items: baseline;
		gap: 4px 10px;
		flex-wrap: wrap;
	}
	.aside-h {
		font-size: 15px;
	}
	.aside-sub {
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}
	.steps {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}
	.steps li {
		display: flex;
		gap: 10px;
		padding: 10px 12px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-sunken);
	}
	.num {
		flex: none;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
		font-family: var(--ess-font-display);
		font-size: 13px;
		font-weight: 600;
	}
	.steps div {
		display: grid;
		gap: 2px;
		align-content: start;
		padding-top: 3px;
	}
	.steps strong {
		font-family: var(--ess-font-display);
		font-size: 13.5px;
		font-weight: 600;
	}
	.steps span:not(.num) {
		font-size: 12.5px;
		line-height: 1.4;
		color: var(--ess-text-secondary);
	}
	.before-card a.ess-row {
		padding: 8px 0;
	}
	.before-card a.ess-row .ess-row__title {
		font-size: 13.5px;
	}
	.before-card a.ess-row .ess-row__meta {
		font-size: 12px;
	}

	/* ---------- fit-to-screen layout ----------
	   The team card takes the height left after the search and the help
	   row; a long contact list scrolls inside it. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.layout > :not(.grow) {
				flex: none;
			}
			.layout > .grow {
				flex: 1 1 0%;
				min-height: 120px;
			}
			.people:has(> .fill-empty) {
				display: flex;
				flex-direction: column;
			}
			.people > .fill-empty {
				margin: auto 0;
			}
		}
	}
	@media (min-width: 1101px) and (max-height: 760px) {
		.big {
			height: 34px;
		}
		.layout,
		.help-row {
			gap: 10px;
		}
		.steps {
			margin-top: 8px;
			gap: 8px;
		}
		.steps li {
			padding: 8px 10px;
		}
		.head {
			padding-bottom: 8px;
			margin-bottom: 8px;
		}
	}

	@media (max-width: 1100px) {
		.help-row {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (max-width: 720px) {
		.steps,
		.people {
			grid-template-columns: minmax(0, 1fr);
		}
		.person {
			flex-wrap: wrap;
		}
		.actions .ess-btn {
			flex: 1;
		}
	}
</style>
