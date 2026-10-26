<script lang="ts">
	import { page } from '$app/state';
	import SidebarNav from '$lib/components/SidebarNav.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import ApprovalPopup from '$lib/components/hub/ApprovalPopup.svelte';
	import ShiftReminder from '$lib/components/ShiftReminder.svelte';
	import { chat } from '$lib/chat/client.svelte';
	import { hub } from '$lib/hub/client.svelte';
	import { cardSpotlight } from '$lib/ui/spotlight';
	import HardHat from '@lucide/svelte/icons/hard-hat';

	let { data, children } = $props();

	// page.data, not data: under /admin the admin layout returns a fresher
	// count under the same key, and child layout data wins in the merge.
	const adminIssueCount = $derived((page.data.adminIssueCount as number | undefined) ?? data.adminIssueCount);

	// One live Champ Chat connection per tab, for every page.
	let started = $state(false);
	$effect(() => {
		chat.start(data.chatBadge.count);
		// Champ Hub's counts (requests, minutes, due work) ride the same stream.
		hub.start();
		started = true;
	});
	// Cards glow under the mouse pointer (visual only).
	$effect(() => cardSpotlight());

	const chatBadge = $derived({
		count: (started ? chat.badge : data.chatBadge.count) + hub.counts.work,
		urgent: (started ? chat.channels.some((c) => c.kind === 'announcements' && c.mentions > 0) : data.chatBadge.urgent) || hub.counts.urgent
	});

	// Leaving a blue-collar worker's portal: back to the Team page as yourself.
	let leaving = $state(false);
	async function leavePortal() {
		leaving = true;
		await fetch('/api/act-as', { method: 'DELETE' }).catch(() => {});
		location.href = '/team';
	}

	// What the person is here as. A base role is an access setting, not a job
	// title, so it is phrased as the kind of access rather than a rank.
	const roleLabel = $derived(
		data.user.role === 'super_admin' ? 'Administrator' : data.user.role === 'admin' ? 'HR admin' : data.user.role === 'team_lead' ? 'Team lead' : 'Employee'
	);
</script>

<div class="ess-shell">
	<SidebarNav
		activePath={page.url.pathname}
		role={data.user.role}
		fullName={data.user.fullName}
		userId={data.user.id}
		hasPicture={data.hasProfilePicture}
		pictureVersion={data.profilePictureVersion}
		canAdmin={data.canAdmin}
		canPayroll={data.canPayroll}
		canTeam={data.canTeam}
		{adminIssueCount}
		{chatBadge}
	/>
	<main class="ess-main">
		<TopBar
			fullName={data.user.fullName}
			userId={data.user.id}
			hasPicture={data.hasProfilePicture}
			pictureVersion={data.profilePictureVersion}
			{roleLabel}
			notifications={data.announcementBadge}
			activePath={page.url.pathname}
			role={data.user.role}
			canAdmin={data.canAdmin}
			canTeam={data.canTeam}
			teamPeek={data.teamPeek}
			addEmployeeHref={data.addEmployeeHref}
		/>
		<div class="ess-content" tabindex="0" role="region" aria-label="Page content">
			{@render children()}
		</div>
	</main>
</div>

{#if data.actingFor}
	<!--
		Someone has a blue-collar worker's portal open (src/lib/server/act-as.ts).
		Pinned to the screen so it never scrolls out of sight.
	-->
	<div class="acting-bar" role="status">
		<HardHat size={16} />
		<span>
			You're in <strong>{data.user.fullName}</strong>'s portal. They have no login, so whatever you do here is done as them.
		</span>
		<button type="button" class="ess-btn ess-btn--sm" onclick={leavePortal} disabled={leaving}>
			{leaving ? 'Going back…' : `Back to ${data.actingFor.fullName}`}
		</button>
	</div>
{/if}

<!-- Leads: tasks waiting for approval pop up on whatever page they are on. -->
<ApprovalPopup />
<!-- Checked in: punch-out reminder at 9h, missed-punch prompt at 9h 30m. -->
<ShiftReminder />

<style>
	.acting-bar {
		position: fixed;
		left: 50%;
		bottom: 16px;
		transform: translateX(-50%);
		z-index: 60;
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: min(760px, calc(100vw - 32px));
		padding: 10px 12px 10px 16px;
		border-radius: 14px;
		background: var(--ess-text);
		color: var(--ess-surface, #fff);
		font-size: 13.5px;
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.25);
	}
	.acting-bar span {
		flex: 1;
		min-width: 0;
	}
</style>
