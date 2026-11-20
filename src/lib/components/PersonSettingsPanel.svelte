<script lang="ts">
	import { CHIEF_LABEL, CHIEF_PICK, MAM_LABEL, MAM_PICK, topFromPick, topLabel, topPick } from '$lib/chief';
	import X from '@lucide/svelte/icons/x';
	import Avatar from '$lib/components/Avatar.svelte';
	import { lockPageScroll } from '$lib/scroll-lock';
	import { overlayIn, overlayOut } from '$lib/motion';

	/**
	 * Every org setting for one employee, edited together and saved once.
	 *
	 * A slide-over rather than a page: the roster stays behind it, so closing
	 * returns you exactly where you were instead of losing your place in a
	 * thirteen-row table. Edits are held locally until Save, so backing out of a
	 * half-made change costs nothing.
	 */

	interface Person {
		id: string;
		fullName: string;
		email: string;
		employeeCode: string | null;
		hasPicture: boolean;
		role: string;
		reportsTo: string | null;
		/** Reports to a top-level position (Chief or Mam), which has no login. */
		reportsToChief?: boolean;
		/** Which one, when reportsToChief is set: 'chief' or 'mam'. */
		topPosition?: string | null;
		hrUserId: string | null;
		shiftGroupId: string | null;
		officeTimings: string | null;
		shiftType: string | null;
		weekOffRosterId: string | null;
	}

	interface Props {
		person: Person;
		people: Array<{ id: string; fullName: string; role: string }>;
		shiftGroups: Array<{ id: string; name: string }>;
		rosters: Array<{ id: string; name: string; summary: string; status: string }>;
		roles: readonly string[];
		/**
		 * Whether this viewer may change the privilege level. Super Admin only —
		 * a Team Lead manages their team's shifts, week offs and reporting lines,
		 * but granting privileges is not theirs to do, least of all to themselves.
		 */
		canEditRole: boolean;
		/** Whether this viewer may set someone to report to Chief. Admins only. */
		canPickChief?: boolean;
		currentUserId: string;
		onclose: () => void;
		onsaved: () => void;
		/** Called when saving had a side effect the admin needs to know about. */
		onnotice?: (message: string) => void;
	}

	let {
		person,
		people,
		shiftGroups,
		rosters,
		roles,
		canEditRole,
		canPickChief = false,
		currentUserId,
		onclose,
		onsaved,
		onnotice
	}: Props = $props();

	// Deliberately a one-time seed: these are draft values the user edits until
	// they hit Save, so they must NOT track the prop. The call site wraps this
	// component in {#key person.id}, which remounts it when a different row is
	// selected — that is what refreshes the fields.
	// svelte-ignore state_referenced_locally
	let role = $state(person.role);
	// svelte-ignore state_referenced_locally
	let reportsTo = $state(person.reportsToChief ? topPick(person.topPosition) : (person.reportsTo ?? ''));
	// svelte-ignore state_referenced_locally
	const initialReportsTo = person.reportsToChief ? topPick(person.topPosition) : (person.reportsTo ?? '');
	const pickedTop = $derived(topFromPick(reportsTo));
	// svelte-ignore state_referenced_locally
	let hrUserId = $state(person.hrUserId ?? '');
	// svelte-ignore state_referenced_locally
	let shiftGroupId = $state(person.shiftGroupId ?? '');
	// svelte-ignore state_referenced_locally
	let officeTimings = $state(person.officeTimings ?? '');
	// svelte-ignore state_referenced_locally
	let shiftType = $state(person.shiftType ?? '');
	// svelte-ignore state_referenced_locally
	let weekOffRosterId = $state(person.weekOffRosterId ?? '');

	let saving = $state(false);
	let saveError = $state('');

	let scrimEl: HTMLElement;
	let panelEl: HTMLElement;
	/** The one exit animation, shared by every route out. */
	let exit: Promise<void> | null = null;

	/*
		The page is held still for as long as this panel is up. It is a fixed
		overlay, so without the lock a wheel gesture anywhere over the scrim
		scrolls the roster behind it — and the panel's whole reason for being a
		slide-over rather than a page is that closing it returns you to the row you
		opened, not to wherever the scroll happened to drift.

		Releasing is the effect's teardown, so every route out of here — the close
		button, the scrim, Escape, a successful save, the parent simply dropping the
		component — gives the page back its scroll exactly once.
	*/
	$effect(() => {
		const release = lockPageScroll();
		void overlayIn(scrimEl, panelEl);
		return release;
	});

	/**
	 * Plays the panel out, then hands control back to the parent.
	 *
	 * The animation is started once and memoised; a second caller awaits the
	 * same one rather than restarting it or bailing out. Bailing out would lose
	 * work: hitting Escape while a save is still in flight would leave the save's
	 * own callback — the one that reloads the roster — never called, so a change
	 * that did reach the server would not show up in the table behind.
	 */
	async function requestClose(then: () => void) {
		exit ??= overlayOut(scrimEl, panelEl);
		await exit;
		then();
	}

	const isSelf = $derived(person.id === currentUserId);

	// Nobody can be their own manager or their own HR contact.
	const candidates = $derived(people.filter((p) => p.id !== person.id));

	/*
		The role appears beside a candidate's name only for the viewer who assigns
		roles. A Super Admin picking a manager out of the whole company needs it to
		tell two similar names apart; a Team Lead picking from their own handful of
		people does not, and showing it would put the team's privilege levels back
		on screen through a side door.
	*/
	function optionLabel(p: { fullName: string; role: string }) {
		return canEditRole ? `${p.fullName} (${p.role.replace('_', ' ')})` : p.fullName;
	}

	const dirty = $derived(
		(canEditRole && role !== person.role) ||
			reportsTo !== initialReportsTo ||
			hrUserId !== (person.hrUserId ?? '') ||
			shiftGroupId !== (person.shiftGroupId ?? '') ||
			officeTimings !== (person.officeTimings ?? '') ||
			shiftType !== (person.shiftType ?? '') ||
			weekOffRosterId !== (person.weekOffRosterId ?? '')
	);

	async function save() {
		saveError = '';
		saving = true;
		try {
			const res = await fetch(`/api/admin/users/${person.id}/settings`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					// Omitted on your own row and for anyone who may not set it: the
					// server refuses both, and sending an unchanged value would be a
					// needless no-op.
					...(isSelf || !canEditRole ? {} : { role }),
					reportsTo: pickedTop ? null : reportsTo || null,
					reportsToChief: pickedTop !== null,
					...(pickedTop ? { topPosition: pickedTop } : {}),
					hrUserId: hrUserId || null,
					shiftGroupId: shiftGroupId || null,
					officeTimings,
					shiftType,
					weekOffRosterId: weekOffRosterId || null
				})
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				saveError = body.message ?? 'Could not save these settings';
				return;
			}
			// Inverting a reporting line clears whoever's line would have closed the
			// loop. That is intended, but the admin has to be told — silently
			// dropping someone's manager would be discovered much later.
			const body = await res.json().catch(() => ({}));
			const broken: { fullName: string }[] = body.loopBroken ?? [];
			if (broken.length > 0) {
				onnotice?.(
					`${broken.map((b) => b.fullName).join(', ')} no longer ${
						broken.length === 1 ? 'has a reporting manager' : 'have reporting managers'
					} — that line was cleared to make room for this one. Set it from their card.`
				);
			}
			await requestClose(onsaved);
		} finally {
			saving = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') void requestClose(onclose);
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Clicking the backdrop closes, matching how every other slide-over behaves. -->
<div
	bind:this={scrimEl}
	class="backdrop"
	role="button"
	tabindex="-1"
	aria-label="Close panel"
	onclick={() => requestClose(onclose)}
	onkeydown={(e) => e.key === 'Enter' && requestClose(onclose)}
></div>

<aside bind:this={panelEl} class="panel" aria-label="Settings for {person.fullName}">
	<header class="panel-head">
		<div class="who">
			<Avatar userId={person.id} fullName={person.fullName} hasPicture={person.hasPicture} size="md" />
			<div class="who-text">
				<h2 class="ess-h2">{person.fullName}</h2>
				<span class="meta">{person.employeeCode ?? 'No code'} · {person.email}</span>
			</div>
		</div>
		<button type="button" class="ess-icon-btn" onclick={() => requestClose(onclose)} aria-label="Close">
			<X size={18} />
		</button>
	</header>

	<div class="panel-body">
		<section class="group">
			<h3>Organisation</h3>

			<!--
				Hidden outright rather than shown disabled for anyone who may not set
				it: a greyed-out "employee" still tells the viewer their own standing,
				which is the thing the portal deliberately no longer says out loud.
			-->
			{#if canEditRole}
				<label class="ess-field field">
					<span class="ess-label">Role</span>
					{#if isSelf}
						<span class="static-value">{role.replace('_', ' ')}</span>
						<span class="ess-help">You cannot change your own role.</span>
					{:else}
						<select class="ess-select" bind:value={role}>
							{#each roles as r (r)}
								<option value={r}>{r.replace('_', ' ')}</option>
							{/each}
						</select>
					{/if}
				</label>
			{/if}

			<label class="ess-field field">
				<span class="ess-label">Reports to</span>
				<select class="ess-select" bind:value={reportsTo}>
					<option value="">— not set —</option>
					{#if canPickChief || initialReportsTo === CHIEF_PICK}
						<option value={CHIEF_PICK} disabled={!canPickChief}>{CHIEF_LABEL}</option>
					{/if}
					{#if canPickChief || initialReportsTo === MAM_PICK}
						<option value={MAM_PICK} disabled={!canPickChief}>{MAM_LABEL}</option>
					{/if}
					{#each candidates as p (p.id)}
						<option value={p.id}>{optionLabel(p)}</option>
					{/each}
				</select>
				<span class="ess-help">
					{#if pickedTop}
						Leave, comp-off and attendance corrections go straight to the
						concerned HR{hrUserId ? '' : ' (any admin while none is set)'} for a single approval.
						An Employee reporting to {topLabel(pickedTop)} becomes a Team Lead.
					{:else}
						Gives the first approval on leave, comp-off and attendance corrections. An
						Employee picked here becomes a Team Lead; a Super Admin can change that back.
					{/if}
				</span>
			</label>

			<label class="ess-field field">
				<span class="ess-label">Concerned HR</span>
				<select class="ess-select" bind:value={hrUserId}>
					<option value="">— any admin —</option>
					{#each candidates as p (p.id)}
						<option value={p.id}>{optionLabel(p)}</option>
					{/each}
				</select>
				<span class="ess-help">
					Handles the second approval. Other admins can still act, so nothing stalls if they are away.
				</span>
			</label>
		</section>

		<section class="group">
			<h3>Schedule</h3>

			<label class="ess-field field">
				<span class="ess-label">Shift group</span>
				<select class="ess-select" class:unset={!shiftGroupId} bind:value={shiftGroupId}>
					<option value="">— not set —</option>
					{#each shiftGroups as g (g.id)}
						<option value={g.id}>{g.name}</option>
					{/each}
				</select>
				<span class="ess-help">Resolves which holiday calendar applies.</span>
			</label>

			<label class="ess-field field">
				<span class="ess-label">Shift type</span>
				<input class="ess-input" bind:value={shiftType} placeholder="e.g. Day Shift" />
			</label>

			<label class="ess-field field">
				<span class="ess-label">Office timings</span>
				<input class="ess-input" bind:value={officeTimings} placeholder="e.g. 9:00 AM - 6:00 PM" />
				<span class="ess-help">Bounds how far a check-out may sit from its check-in on a night shift.</span>
			</label>

			<label class="ess-field field">
				<span class="ess-label">Week-off roster</span>
				<select class="ess-select" bind:value={weekOffRosterId}>
					<option value="">Saturday + Sunday (default)</option>
					{#each rosters as r (r.id)}
						<option value={r.id}>
							{r.name}{r.status === 'published' ? '' : ' (draft)'} — {r.summary}
						</option>
					{/each}
				</select>
				<span class="ess-help">Reflects on this employee's leave and attendance calendars.</span>
			</label>
		</section>
	</div>

	<footer class="panel-foot">
		{#if saveError}
			<p class="ess-error">{saveError}</p>
		{/if}
		<div class="actions">
			<button
				type="button"
				class="ess-btn ess-btn--secondary"
				onclick={() => requestClose(onclose)}
				disabled={saving}
			>
				Cancel
			</button>
			<button
				type="button"
				class="ess-btn ess-btn--primary"
				onclick={save}
				disabled={saving || !dirty}
			>
				{saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
			</button>
		</div>
	</footer>
</aside>

<style>
	/* z-index is high enough to cover the sticky sidebar: a sticky element with
	   z-index:auto still paints above non-positioned content, so a lower value
	   left the nav undimmed and clickable while the panel was open. */
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(27, 31, 59, 0.42);
		border: none;
		padding: 0;
		z-index: 900;
		/* Opacity is Motion's to drive (see $lib/motion) — a CSS entry animation
		   has no exit half to await before the page is unlocked. */
	}

	.panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(500px, 100vw);
		background: var(--ess-modal-bg);
		border-left: 1px solid var(--ess-border);
		box-shadow: var(--ess-elev-4);
		display: flex;
		flex-direction: column;
		z-index: 901;
		/* Motion drives the slide in and out, and honours a reduced-motion
		   preference by fading the panel in without travel. */
	}

	/* The page is locked while this is open, so a wheel gesture over the scrim
	   does nothing. Containing the panel's own scroll stops it chaining out. */
	.panel,
	.backdrop {
		overscroll-behavior: contain;
	}

	.panel-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 20px 24px;
		border-bottom: 1px solid var(--ess-border);
	}

	.who {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.who-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.who-text .ess-h2 {
		font-size: 22px;
	}

	.who-text .meta {
		font-size: var(--ess-fs-caption);
		color: var(--ess-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.panel-body {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 20px 24px;
	}

	.group + .group {
		margin-top: 24px;
		padding-top: 20px;
		border-top: 1px solid var(--ess-border-subtle);
	}

	.group h3 {
		font-family: var(--ess-font-display);
		font-size: 18px;
		font-weight: 600;
		color: var(--ess-text);
		margin-bottom: 12px;
	}

	.field {
		margin-bottom: 14px;
	}

	.static-value {
		text-transform: capitalize;
		color: var(--ess-text-secondary);
		padding: 6px 0;
	}

	/* Unassigned leaves the employee with no holiday calendar — a real problem,
	   so it reads as a warning rather than a neutral empty value. */
	.unset {
		color: var(--ess-warning);
		border-color: var(--ess-warning);
	}

	.panel-foot {
		border-top: 1px solid var(--ess-border);
		padding: 14px 24px;
		background: var(--ess-sunken);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.panel-foot .ess-error {
		margin-bottom: 10px;
	}

	@media (max-width: 520px) {
		.panel {
			width: 100vw;
		}
	}
</style>
