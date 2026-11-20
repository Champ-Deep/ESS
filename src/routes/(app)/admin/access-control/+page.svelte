<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Info from '@lucide/svelte/icons/info';
	import User from '@lucide/svelte/icons/user';
	import Users from '@lucide/svelte/icons/users';
	import Shield from '@lucide/svelte/icons/shield';
	import Crown from '@lucide/svelte/icons/crown';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import Avatar from '$lib/components/Avatar.svelte';
	import {
		BASE_ROLE_LABEL,
		CAPABILITIES,
		grantableFor,
		ROLE_PRESETS,
		defaultCapabilities,
		effectiveCapabilities,
		type CapabilityGroup
	} from '$lib/capabilities';

	let { data, form } = $props();

	type Tab = 'roles' | 'matrix' | 'teams';
	let tab = $state<Tab>('roles');

	const BUILT_IN = ['employee', 'team_lead', 'admin', 'super_admin'] as const;
	type BuiltIn = (typeof BUILT_IN)[number];
	const BUILT_IN_BLURB: Record<BuiltIn, string> = {
		employee: 'Their own leave, attendance, profile and chat.',
		team_lead: 'Approves their team and keeps its shifts and reporting lines right.',
		admin: 'HR: people, balances, uploads, announcements and the HR desk.',
		super_admin: 'Everything, including roles, policies and data cleanup.'
	};
	const BUILT_IN_ICON: Record<BuiltIn, typeof User> = { employee: User, team_lead: Users, admin: Shield, super_admin: Crown };

	const GROUPS = [...new Set(CAPABILITIES.map((c) => c.group))] as CapabilityGroup[];

	/* ---------- which role the aside describes ---------- */
	type Selection = { kind: 'builtin'; id: BuiltIn } | { kind: 'named'; id: string };
	let selection = $state<Selection>({ kind: 'builtin', id: 'admin' });
	const selectedNamed = $derived(selection.kind === 'named' ? (data.namedRoles.find((r) => r.id === selection.id) ?? null) : null);
	const selectedCaps = $derived(
		selection.kind === 'builtin' ? effectiveCapabilities(selection.id) : selectedNamed ? effectiveCapabilities(selectedNamed.baseRole, selectedNamed.capabilities) : []
	);
	const selectedName = $derived(selection.kind === 'builtin' ? BASE_ROLE_LABEL[selection.id] : (selectedNamed?.name ?? ''));
	const selectedBlurb = $derived(selection.kind === 'builtin' ? BUILT_IN_BLURB[selection.id] : (selectedNamed?.description ?? ''));
	const selectedPeople = $derived(
		selection.kind === 'builtin' ? data.people.filter((p) => !p.customRoleId && p.role === selection.id).map((p) => ({ id: p.id, fullName: p.fullName })) : (selectedNamed?.members ?? [])
	);
	const isSelected = (s: Selection) => selection.kind === s.kind && selection.id === s.id;

	/* ---------- editor ---------- */
	type Draft = { id: string; name: string; description: string; baseRole: 'employee' | 'team_lead' | 'admin'; capabilities: string[] };
	const blank = (): Draft => ({ id: '', name: '', description: '', baseRole: 'employee', capabilities: [] });
	let editing = $state<Draft | null>(page.url.searchParams.has('new') && data.canManage ? blank() : null);

	function edit(r: (typeof data.namedRoles)[number]) {
		editing = { id: r.id, name: r.name, description: r.description, baseRole: r.baseRole as Draft['baseRole'], capabilities: [...r.capabilities] };
		tab = 'roles';
	}
	function fromPreset(p: (typeof ROLE_PRESETS)[number]) {
		editing = { id: '', name: p.name, description: p.description, baseRole: p.baseRole as Draft['baseRole'], capabilities: [...p.capabilities] };
	}
	/** Privileges the base role already gives, shown ticked and locked. */
	const inherited = $derived(editing ? defaultCapabilities(editing.baseRole) : []);
	const grantable = $derived(editing ? grantableFor(editing.baseRole) : []);

	let confirmDelete = $state<string | null>(null);
	const pick = $state<Record<string, string>>({});
</script>

<svelte:head>
	<title>Roles & access — Champ HR ESS Portal</title>
</svelte:head>

<div class="top">
	<div class="ess-tabs" role="tablist">
		<button class="ess-tab" role="tab" aria-selected={tab === 'roles'} onclick={() => (tab = 'roles')}>Roles</button>
		<button class="ess-tab" role="tab" aria-selected={tab === 'matrix'} onclick={() => (tab = 'matrix')}>Permissions matrix</button>
		{#if data.teamRows.length > 0}
			<button class="ess-tab" role="tab" aria-selected={tab === 'teams'} onclick={() => (tab = 'teams')}>Teams</button>
		{/if}
	</div>
	{#if data.canManage && !editing}
		<button type="button" class="ess-btn ess-btn--primary" onclick={() => { editing = blank(); tab = 'roles'; }}>
			<Plus size={17} /> Create role
		</button>
	{/if}
</div>

{#if form?.error}
	<p class="ess-alert ess-alert--danger" role="alert">{form.error}</p>
{:else if form?.message}
	<p class="ess-alert ess-alert--success" role="status">{form.message}</p>
{/if}

<div class="ess-split ess-fill ac">
	<div class="ess-stack main-col">
		{#if tab === 'roles'}
			{#if editing}
				<form
					class="ess-card editor"
					method="POST"
					action="?/saveRole"
					use:enhance={() => async ({ result, update }) => {
						await update({ reset: false });
						if (result.type === 'success') editing = null;
					}}
				>
					<div class="ess-card-head">
						<h2 class="ess-h2">{editing.id ? `Edit ${editing.name}` : 'New named role'}</h2>
						{#if !editing.id}
							<span class="presets">
								<span class="ess-caption">Start from:</span>
								{#each ROLE_PRESETS as p (p.name)}
									<button type="button" class="ess-btn ess-btn--soft ess-btn--sm" onclick={() => fromPreset(p)}><Sparkles size={13} /> {p.name}</button>
								{/each}
							</span>
						{/if}
					</div>
					<input type="hidden" name="id" value={editing.id} />
					<div class="fields">
						<label class="ess-field">
							<span class="ess-label">Name</span>
							<input class="ess-input" name="name" maxlength="60" bind:value={editing.name} required placeholder="IT Support" />
						</label>
						<label class="ess-field">
							<span class="ess-label">Starts from</span>
							<select class="ess-select" name="baseRole" bind:value={editing.baseRole}>
								<option value="employee">Employee</option>
								<option value="team_lead">Team Lead</option>
								<option value="admin">HR Admin</option>
							</select>
						</label>
						<label class="ess-field wide">
							<span class="ess-label">What it is for</span>
							<input class="ess-input" name="description" maxlength="160" bind:value={editing.description} placeholder="Looks after logins, passwords and the biometric devices." />
						</label>
					</div>

					<div class="cap-groups">
						{#each GROUPS as g (g)}
							{@const items = grantable.filter((c) => c.group === g)}
							{#if items.length}
								<fieldset class="cap-group">
									<legend>{g}</legend>
									{#each items as c (c.key)}
										{@const locked = inherited.includes(c.key)}
										<label class="cap" class:locked>
											<input
												type="checkbox"
												name="capabilities"
												value={c.key}
												checked={locked || editing.capabilities.includes(c.key)}
												disabled={locked}
												onchange={(e) => {
													const on = (e.currentTarget as HTMLInputElement).checked;
													editing!.capabilities = on ? [...editing!.capabilities, c.key] : editing!.capabilities.filter((k) => k !== c.key);
												}}
											/>
											<span>
												<strong>{c.label}</strong>
												<small>{locked ? `Already part of ${BASE_ROLE_LABEL[editing.baseRole]}` : c.description}</small>
											</span>
										</label>
									{/each}
								</fieldset>
							{/if}
						{/each}
					</div>
					<p class="ess-help">Deleting data, managing roles and exporting conversations stay with Super Admins and cannot be given.</p>
					<div class="actions">
						<button class="ess-btn ess-btn--primary" type="submit">Save role</button>
						<button class="ess-btn ess-btn--secondary" type="button" onclick={() => (editing = null)}>Cancel</button>
					</div>
				</form>
			{/if}

			<section class="ess-card builtin-card">
				<div class="ess-card-head">
					<h2 class="ess-h2">Built-in roles</h2>
					<span class="ess-badge ess-badge--neutral">Protected</span>
				</div>
				<p class="ess-caption">Every login has one of these. It decides approvals: who a person's leave goes to, and who counts as HR.</p>
				<div class="builtins">
					{#each BUILT_IN as r (r)}
						{@const Icon = BUILT_IN_ICON[r]}
						<button type="button" class="role-card" class:selected={isSelected({ kind: 'builtin', id: r })} onclick={() => (selection = { kind: 'builtin', id: r })}>
							<span class="ess-tile ess-tile--sm"><Icon size={16} /></span>
							<span class="role-card__body">
								<strong>{BASE_ROLE_LABEL[r]}</strong>
								<small>{BUILT_IN_BLURB[r]}</small>
								<span class="role-card__meta">
									<span class="ess-num">{data.byRole[r] ?? 0} {(data.byRole[r] ?? 0) === 1 ? 'person' : 'people'}</span>
									<span class="ess-badge ess-badge--neutral">Built-in</span>
								</span>
							</span>
						</button>
					{/each}
				</div>
			</section>

			<section class="ess-card ess-fill-card named-card-wrap">
				<div class="ess-card-head">
					<h2 class="ess-h2">Named roles</h2>
					<span class="ess-caption">{data.namedRoles.length} {data.namedRoles.length === 1 ? 'role' : 'roles'}</span>
				</div>
				<p class="ess-caption">
					A name and a set of privileges on top of a built-in role, such as IT Support. Give one to anyone from here, from their settings, or when you create their login.
				</p>

				{#if data.namedRoles.length === 0}
					<div class="ess-empty">
						<span class="ess-empty__icon"><Shield size={22} /></span>
						<p class="ess-empty__title">No named roles yet.</p>
						{#if data.canManage}<p class="ess-caption">Create one to bundle privileges for a job such as IT Support.</p>{/if}
					</div>
				{:else}
					<div class="named ess-scroll">
						{#each data.namedRoles as r (r.id)}
							<article class="named-card" class:selected={isSelected({ kind: 'named', id: r.id })}>
								<button type="button" class="named-pick" onclick={() => (selection = { kind: 'named', id: r.id })}>
									<span class="ess-tile ess-tile--sm"><Sparkles size={16} /></span>
									<span class="role-card__body">
										<strong>{r.name}</strong>
										<small>{r.description || `Starts as ${BASE_ROLE_LABEL[r.baseRole]}`}</small>
										<span class="role-card__meta">
											<span class="ess-num">{r.members.length} {r.members.length === 1 ? 'person' : 'people'}</span>
											<span class="ess-badge ess-badge--accent">starts as {BASE_ROLE_LABEL[r.baseRole]}</span>
											<span class="ess-caption">{r.capabilities.length} extra {r.capabilities.length === 1 ? 'privilege' : 'privileges'}</span>
										</span>
									</span>
								</button>
								{#if data.canManage}
									<div class="named-actions">
										<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => edit(r)}><Pencil size={13} /> Edit</button>
										{#if confirmDelete === r.id}
											<form method="POST" action="?/deleteRole" use:enhance={() => async ({ update }) => { await update(); confirmDelete = null; }}>
												<input type="hidden" name="id" value={r.id} />
												<button class="ess-btn ess-btn--danger ess-btn--sm" type="submit">Delete {r.name}</button>
											</form>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (confirmDelete = null)}>Keep</button>
										{:else}
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (confirmDelete = r.id)}>Delete</button>
										{/if}
									</div>
								{/if}
								<div class="members">
									<div class="chips">
										{#each r.members as m (m.id)}
											<span class="member">
												{m.fullName}
												{#if data.canManage && m.id !== data.viewerId}
													<form method="POST" action="?/assign" use:enhance>
														<input type="hidden" name="userId" value={m.id} />
														<input type="hidden" name="roleId" value="" />
														<button type="submit" class="x" aria-label="Take {r.name} from {m.fullName}"><X size={12} /></button>
													</form>
												{/if}
											</span>
										{:else}
											<span class="ess-caption">Nobody holds this role yet.</span>
										{/each}
									</div>
									{#if data.canManage}
										<form class="assign" method="POST" action="?/assign" use:enhance={() => async ({ update }) => { await update(); pick[r.id] = ''; }}>
											<input type="hidden" name="roleId" value={r.id} />
											<select class="ess-select" name="userId" bind:value={pick[r.id]} aria-label="Give {r.name} to">
												<option value="">Give this role to…</option>
												{#each data.people.filter((p) => p.customRoleId !== r.id && p.id !== data.viewerId) as p (p.id)}
													<option value={p.id}>{p.fullName}{p.customRoleId ? ` (now ${data.namedRoles.find((n) => n.id === p.customRoleId)?.name})` : ` (${BASE_ROLE_LABEL[p.role]})`}</option>
												{/each}
											</select>
											<button class="ess-btn ess-btn--secondary ess-btn--sm" type="submit" disabled={!pick[r.id]}>Give role</button>
										</form>
									{/if}
								</div>
							</article>
						{/each}
					</div>
				{/if}
				<p class="ess-help foot">
					Giving someone a named role moves their built-in role to the one it starts from. Changes reach them within 30 seconds.
					{#if !data.canManage}Only a Super Admin can change roles.{/if}
				</p>
			</section>
		{:else if tab === 'matrix'}
			<section class="ess-card ess-fill-card matrix-card">
				<div class="ess-card-head">
					<h2 class="ess-h2">Role permissions matrix</h2>
				</div>
				<p class="ess-caption">
					Compare what each role can do. Worked out from the same privilege list the portal checks, so this table cannot drift from what people can actually do. Select a column to see the role's details.
				</p>
				<div class="ess-table-shell matrix-shell ess-scroll">
					<table class="ess-table matrix">
						<thead>
							<tr>
								<th>Capability</th>
								{#each BUILT_IN as r (r)}
									{@const Icon = BUILT_IN_ICON[r]}
									<th class="role-col" class:on={isSelected({ kind: 'builtin', id: r })}>
										<button type="button" class="col-pick" onclick={() => (selection = { kind: 'builtin', id: r })}>
											<Icon size={18} strokeWidth={1.75} />
											<span>{BASE_ROLE_LABEL[r]}</span>
											<span class="ess-badge ess-badge--neutral">Built-in</span>
										</button>
									</th>
								{/each}
								{#each data.namedRoles as n (n.id)}
									<th class="role-col" class:on={isSelected({ kind: 'named', id: n.id })}>
										<button type="button" class="col-pick" onclick={() => (selection = { kind: 'named', id: n.id })}>
											<Sparkles size={18} strokeWidth={1.75} />
											<span>{n.name}</span>
											<span class="ess-badge ess-badge--accent">Named</span>
										</button>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each GROUPS as g (g)}
								<tr class="group-row"><td colspan={5 + data.namedRoles.length}>{g}</td></tr>
								{#each CAPABILITIES.filter((c) => c.group === g) as c (c.key)}
									<tr>
										<td><span class="cap-label">{c.label}</span><span class="cap-detail">{c.description}</span></td>
										{#each BUILT_IN as r (r)}
											<td class="role-col" class:on={isSelected({ kind: 'builtin', id: r })}>
												{#if effectiveCapabilities(r).includes(c.key)}<span class="yes"><Check size={13} strokeWidth={3} /></span>{:else}<span class="no"><X size={11} strokeWidth={3} /></span>{/if}
											</td>
										{/each}
										{#each data.namedRoles as n (n.id)}
											<td class="role-col" class:on={isSelected({ kind: 'named', id: n.id })}>
												{#if effectiveCapabilities(n.baseRole, n.capabilities).includes(c.key)}<span class="yes"><Check size={13} strokeWidth={3} /></span>{:else}<span class="no"><X size={11} strokeWidth={3} /></span>{/if}
											</td>
										{/each}
									</tr>
								{/each}
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{:else}
			<section class="ess-card ess-fill-card teams-card">
				<div class="ess-card-head">
					<h2 class="ess-h2">Team privileges</h2>
				</div>
				<div class="ess-alert ess-alert--info">
					<Info size={16} />
					<span>These flags are set when a team is created. Read-only here.</span>
				</div>
				<div class="ess-table-shell teams-shell ess-scroll">
					<table class="ess-table">
						<thead>
							<tr>
								<th>Team</th><th>Team lead</th>
								<th class="role-col">Approve leave</th><th class="role-col">Edit shift window</th><th class="role-col">View payroll cost</th>
								<th class="role-col">Create logins</th><th class="role-col">Resolve grievances</th><th class="role-col">Auto-approve up to</th>
							</tr>
						</thead>
						<tbody>
							{#each data.teamRows as team (team.id)}
								<tr>
									<td><span class="cap-label">{team.name}</span></td>
									<td>{team.teamLeadName ?? '—'}</td>
									{#each [team.canApproveLeave, team.canEditTeamShiftWindow, team.canViewTeamPayrollCost, team.canCreateEmployeeLogins, team.canResolveGrievances] as on, i (i)}
										<td class="role-col">{#if on}<span class="yes"><Check size={13} strokeWidth={3} /></span>{:else}<span class="no"><X size={11} strokeWidth={3} /></span>{/if}</td>
									{/each}
									<td class="role-col ess-num">{team.maxLeaveDaysAutoApprove ?? '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
					{#if data.teamRows.length === 0}<div class="ess-empty"><p class="ess-empty__title">No teams yet.</p></div>{/if}
				</div>
			</section>
		{/if}
	</div>

	<aside class="ess-stack">
		<section class="ess-card ess-fill-card role-detail">
			<div class="ess-card-head">
				<h2 class="ess-h2">{selectedName}</h2>
				{#if selection.kind === 'builtin'}
					<span class="ess-badge ess-badge--neutral">Built-in role</span>
				{:else}
					<span class="ess-badge ess-badge--accent">Named role</span>
				{/if}
			</div>
			<p class="ess-caption">{selectedBlurb}{#if selectedNamed} Starts as {BASE_ROLE_LABEL[selectedNamed.baseRole]}.{/if}</p>

			<div class="ess-scroll detail-scroll">
			<h3 class="ess-h3 sub">Key capabilities <span class="ess-caption">({selectedCaps.length})</span></h3>
			<ul class="caps">
				{#each CAPABILITIES.filter((c) => selectedCaps.includes(c.key)) as c (c.key)}
					<li><CircleCheck size={16} class="ok" /> <span>{c.label}</span></li>
				{:else}
					<li class="none"><CircleX size={16} class="muted" /> <span>No privileges beyond their own records.</span></li>
				{/each}
			</ul>

			<h3 class="ess-h3 sub">Assigned people <span class="ess-caption">({selectedPeople.length})</span></h3>
			<div class="ess-rows">
				{#each selectedPeople.slice(0, 6) as m (m.id)}
					<div class="ess-row person">
						<Avatar userId={m.id} fullName={m.fullName} size="sm" />
						<span class="ess-row__body">
							<span class="ess-row__title">{m.fullName}</span>
						</span>
					</div>
				{:else}
					<p class="ess-caption">Nobody holds this role yet.</p>
				{/each}
				{#if selectedPeople.length > 6}
					<p class="ess-caption">and {selectedPeople.length - 6} more</p>
				{/if}
			</div>
			</div>

			{#if selectedNamed && data.canManage}
				<button type="button" class="ess-btn ess-btn--outline edit-btn" onclick={() => edit(selectedNamed!)}><Pencil size={15} /> Edit role</button>
			{:else if selection.kind === 'builtin'}
				<p class="ess-help">Built-in roles are protected. Create a named role to add privileges on top of one.</p>
			{/if}
		</section>
	</aside>
</div>

<style>
	.top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.top .ess-tabs {
		max-width: 100%;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.top .ess-tab {
		flex-shrink: 0;
		white-space: nowrap;
	}
	.builtins {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
		gap: 10px;
		margin-top: 10px;
	}
	.role-card,
	.named-pick {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		background: var(--ess-surface);
		color: var(--ess-text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			border-color var(--ess-t-fast),
			background var(--ess-t-fast);
	}
	.role-card:hover,
	.named-pick:hover {
		border-color: var(--ess-border-strong);
	}
	.role-card.selected,
	.named-card.selected .named-pick {
		border-color: var(--ess-primary);
		background: var(--ess-primary-softer);
	}
	.role-card__body {
		display: grid;
		gap: 3px;
		min-width: 0;
	}
	.role-card__body strong {
		font-size: 14px;
		font-weight: 600;
	}
	.role-card__body small {
		font-size: 12.5px;
		line-height: 1.35;
		color: var(--ess-text-secondary);
	}
	.role-card__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
		font-size: 12px;
		color: var(--ess-text-muted);
	}

	.named {
		display: grid;
		align-content: start;
		gap: 12px;
		margin-top: 10px;
	}
	.named-card {
		display: grid;
		gap: 10px;
	}
	.named-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
	.named-actions form {
		display: inline;
	}
	.members {
		display: grid;
		gap: 8px;
		padding: 10px 0 4px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.member {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12.5px;
		font-weight: 500;
		padding: 3px 10px;
		border-radius: var(--ess-radius-pill);
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	.member form {
		display: inline-flex;
	}
	.x {
		border: 0;
		background: none;
		padding: 0;
		color: inherit;
		cursor: pointer;
		display: inline-flex;
	}
	.assign {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	.assign select {
		max-width: 320px;
	}
	.foot {
		margin-top: 10px;
	}

	/* ---------- editor ---------- */
	.editor {
		display: grid;
		gap: 16px;
	}
	.presets {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 12px;
	}
	.fields .wide {
		grid-column: 1 / -1;
	}
	.cap-groups {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 12px;
	}
	.cap-group {
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		padding: 10px 12px;
		margin: 0;
		display: grid;
		gap: 8px;
		align-content: start;
	}
	.cap-group legend {
		font-size: var(--ess-fs-eyebrow);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ess-text-muted);
		padding: 0 4px;
	}
	.cap {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		cursor: pointer;
	}
	.cap input {
		margin-top: 3px;
		accent-color: var(--ess-primary);
	}
	.cap span {
		display: grid;
	}
	.cap strong {
		font-size: 13px;
		font-weight: 500;
	}
	.cap small {
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.cap.locked {
		opacity: 0.7;
		cursor: default;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	/* ---------- matrix ---------- */
	.matrix-shell,
	.teams-shell {
		margin-top: 10px;
	}
	.matrix th,
	.teams-shell th {
		position: sticky;
		top: 0;
		z-index: 1;
		padding: 8px 12px;
	}
	.matrix td,
	.teams-shell td {
		padding: 7px 12px;
	}
	.matrix th {
		vertical-align: bottom;
	}
	.role-col {
		text-align: center;
		white-space: nowrap;
	}
	.matrix td.role-col,
	.matrix th.role-col {
		border-left: 1px solid var(--ess-border-subtle);
	}
	.role-col.on {
		background: var(--ess-primary-softer);
	}
	.col-pick {
		display: grid;
		justify-items: center;
		gap: 4px;
		width: 100%;
		padding: 2px 4px;
		border: 0;
		background: transparent;
		color: var(--ess-text);
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
	.col-pick:hover,
	.role-col.on .col-pick {
		color: var(--ess-primary-text);
	}
	.group-row td {
		font-size: var(--ess-fs-eyebrow);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ess-text-muted);
		background: var(--ess-sunken);
		padding-top: 6px;
		padding-bottom: 6px;
	}
	.cap-label {
		font-weight: 500;
		display: block;
	}
	.cap-detail {
		display: block;
		font-size: var(--ess-fs-caption);
		color: var(--ess-text-muted);
	}
	.yes,
	.no {
		display: inline-grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: 50%;
	}
	.yes {
		background: var(--ess-success);
		color: #fff;
	}
	.no {
		background: var(--ess-neutral-bg);
		color: var(--ess-text-muted);
	}

	/* ---------- aside ---------- */
	.sub {
		margin: 12px 0 6px;
		padding-top: 10px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.caps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 5px;
		font-size: 13px;
	}
	.caps li {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.caps :global(.ok) {
		color: var(--ess-success);
		flex: none;
	}
	.caps :global(.muted) {
		color: var(--ess-text-muted);
		flex: none;
	}
	.caps .none {
		color: var(--ess-text-secondary);
	}
	.person {
		padding: 6px 0;
	}
	.edit-btn {
		width: 100%;
		margin-top: 12px;
		flex: none;
	}

	/* Fill layout: both columns end on the workspace's bottom edge. The
	   named roles, the matrix, the teams table and the role's capability list
	   scroll inside their cards. While the role editor is open the left column
	   scrolls as a whole. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.ac .builtins {
				grid-template-columns: repeat(4, minmax(0, 1fr));
			}
			.ac .builtins .role-card {
				gap: 8px;
				padding: 8px 10px;
			}
			.ac .builtins .ess-tile {
				width: 28px;
				height: 28px;
			}
			.ac .named {
				grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
				align-items: start;
			}
			.ac .main-col > :not(.ess-fill-card) {
				flex-shrink: 0;
			}
			.ac .main-col > .ess-fill-card {
				flex: 1 1 0px;
				min-height: 220px;
			}
			.ac .main-col:has(> .editor) > .ess-fill-card {
				flex: 0 0 auto;
				overflow: visible;
			}
			.ac .main-col:has(> .editor) .named {
				overflow: visible;
			}
			.ac .role-detail {
				flex: 1 1 0px;
				min-height: 0;
			}
			.detail-scroll {
				margin-right: -6px;
				padding-right: 6px;
			}
			.detail-scroll > .sub:first-child {
				margin-top: 10px;
			}
		}
	}

	/* Short desktop screens (a 1280x580 browser): each built-in role card
	   puts its icon beside the name and lets the blurb use the full card
	   width, so the four cards are about half as tall and the named roles
	   keep room below them. */
	@media (min-width: 1101px) and (min-height: 480px) and (max-height: 800px) {
		@container ess-fill (min-width: 0px) {
			/* Title, caption and badge share the card's first row. */
			.ac .builtin-card {
				display: grid;
				grid-template-columns: auto minmax(0, 1fr) auto;
				align-items: center;
				column-gap: 14px;
			}
			.ac .builtin-card > .ess-card-head {
				display: contents;
			}
			.ac .builtin-card > .ess-card-head > .ess-badge {
				grid-column: 3;
				grid-row: 1;
			}
			.ac .builtin-card > .ess-caption {
				grid-column: 2;
				grid-row: 1;
				font-size: 12px;
				line-height: 1.3;
			}
			.ac .builtins {
				grid-column: 1 / -1;
				margin-top: 8px;
				gap: 8px;
			}
			.ac .builtins .role-card {
				display: grid;
				grid-template-columns: auto minmax(0, 1fr);
				grid-template-rows: auto 1fr auto;
				align-items: center;
				column-gap: 8px;
				row-gap: 3px;
				padding: 7px 10px;
			}
			/* The selected role's full blurb is in the panel on the right. */
			.ac .builtins .role-card small {
				display: -webkit-box;
				-webkit-box-orient: vertical;
				-webkit-line-clamp: 2;
				line-clamp: 2;
				overflow: hidden;
				align-self: start;
			}
			.ac .builtins .role-card .role-card__body {
				display: contents;
			}
			.ac .builtins .role-card small,
			.ac .builtins .role-card .role-card__meta {
				grid-column: 1 / -1;
			}
			.ac .builtins .role-card small {
				font-size: 12px;
				line-height: 1.3;
			}
			.ac .builtins .role-card .role-card__meta {
				margin-top: 1px;
			}
			.ac .builtins .ess-tile {
				width: 24px;
				height: 24px;
			}
			.ac .main-col > .ess-fill-card {
				min-height: 150px;
			}
			.ac .named {
				gap: 10px;
				margin-top: 8px;
			}
			.ac .named-pick {
				padding: 8px 10px;
			}
			.ac .foot {
				margin-top: 8px;
			}
		}
	}
</style>
