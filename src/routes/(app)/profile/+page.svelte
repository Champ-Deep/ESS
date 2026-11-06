<script lang="ts">
	import User from '@lucide/svelte/icons/user';
	import Briefcase from '@lucide/svelte/icons/briefcase';
	import Banknote from '@lucide/svelte/icons/banknote';
	import FileText from '@lucide/svelte/icons/file-text';
	import Users from '@lucide/svelte/icons/users';
	import Phone from '@lucide/svelte/icons/phone';
	import Shield from '@lucide/svelte/icons/shield';
	import GraduationCap from '@lucide/svelte/icons/graduation-cap';
	import Mail from '@lucide/svelte/icons/mail';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Building from '@lucide/svelte/icons/building-2';
	import UserRound from '@lucide/svelte/icons/user-round';
	import PenLine from '@lucide/svelte/icons/pen-line';
	import Lock from '@lucide/svelte/icons/lock';
	import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
	import Clock from '@lucide/svelte/icons/clock';
	import Info from '@lucide/svelte/icons/info';
	import Check from '@lucide/svelte/icons/check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ProfileCard from '$lib/components/ProfileCard.svelte';
	import AvatarUpload from '$lib/components/AvatarUpload.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { enhance } from '$app/forms';
	import { tenureFrom } from '$lib/tenure';

	let { data } = $props();

	// Recomputed whenever the profile changes, so tenure never goes stale
	// against a freshly loaded joining date.
	const tenure = $derived(tenureFrom(data.profile?.dateOfJoining));

	let editing = $state(false);
	let saving = $state(false);
	let saveError = $state('');
	let phone = $state(data.profile?.phone ?? '');
	let personalEmail = $state(data.profile?.personalEmail ?? '');
	let address = $state(data.profile?.address ?? '');
	let permanentAddress = $state(data.profile?.permanentAddress ?? '');
	let emergencyContactName = $state(data.profile?.emergencyContactName ?? '');
	let emergencyContactRelationship = $state(data.profile?.emergencyContactRelationship ?? '');
	let emergencyContactPhone = $state(data.profile?.emergencyContactPhone ?? '');
	let fatherName = $state(data.profile?.fatherName ?? '');
	let motherName = $state(data.profile?.motherName ?? '');
	let maritalStatus = $state(data.profile?.maritalStatus ?? '');
	let spouseName = $state(data.profile?.spouseName ?? '');
	let bankAccountNumber = $state(data.profile?.bankAccountNumber ?? '');
	let bankAccountHolderName = $state(data.profile?.bankAccountHolderName ?? '');
	let bankName = $state(data.profile?.bankName ?? '');
	let bankIfsc = $state(data.profile?.bankIfsc ?? '');
	let aadharNumber = $state(data.profile?.aadharNumber ?? '');
	let panNumber = $state(data.profile?.panNumber ?? '');
	let uanNumber = $state(data.profile?.uanNumber ?? '');
	let underGraduate = $state(data.profile?.underGraduate ?? '');
	let graduate = $state(data.profile?.graduate ?? '');
	let masters = $state(data.profile?.masters ?? '');
	let diplomaOthers = $state(data.profile?.diplomaOthers ?? '');
	let totalExperience = $state(data.profile?.totalExperience ?? '');

	/* ---------- tabs ----------
	   Every tab's fields stay in the one form (hidden, not removed), so edits
	   made on one tab are saved together with the others. */
	type Tab = 'personal' | 'employment' | 'bank' | 'family' | 'education';
	const TABS: { id: Tab; label: string }[] = [
		{ id: 'personal', label: 'Personal' },
		{ id: 'employment', label: 'Employment' },
		{ id: 'bank', label: 'Bank & IDs' },
		{ id: 'family', label: 'Family' },
		{ id: 'education', label: 'Education' }
	];
	let tab = $state<Tab>('personal');

	/* ---------- completion ----------
	   A section counts as complete when its main fields are on file. */
	const p = $derived(data.profile);
	const sections = $derived([
		{ id: 'personal' as Tab, label: 'Personal information', done: Boolean(p?.phone && p?.address) },
		{ id: 'employment' as Tab, label: 'Employment information', done: Boolean(p?.employeeCode && p?.designation) },
		{ id: 'bank' as Tab, label: 'Bank details', done: Boolean(p?.bankAccountNumber && p?.bankName && p?.bankIfsc) },
		{ id: 'family' as Tab, label: 'Family information', done: Boolean(p?.fatherName || p?.motherName) },
		{ id: 'education' as Tab, label: 'Education information', done: Boolean(p?.underGraduate || p?.graduate || p?.masters || p?.diplomaOthers) },
		{ id: 'personal' as Tab, label: 'Emergency contact', done: Boolean(p?.emergencyContactName && p?.emergencyContactPhone) }
	]);
	const doneCount = $derived(sections.filter((s) => s.done).length);
	const completion = $derived(Math.round((doneCount / sections.length) * 100));

	const mask = (value: string | null | undefined, keep = 4) => (value ? '•••• •••• ' + String(value).slice(-keep) : 'Not added');
	const maskShort = (value: string | null | undefined, keep = 4) => (value ? '••••••' + String(value).slice(-keep) : 'Not added');

	const location = $derived([p?.floorDetails, p?.teamAndFloor].filter(Boolean).join(' · ') || null);
	const lastUpdated = $derived(
		p?.updatedAt ? new Date(p.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null
	);
	const quals = $derived([p?.underGraduate, p?.graduate, p?.masters, p?.diplomaOthers].filter(Boolean) as string[]);

	function resetDraft() {
		phone = data.profile?.phone ?? '';
		personalEmail = data.profile?.personalEmail ?? '';
		address = data.profile?.address ?? '';
		permanentAddress = data.profile?.permanentAddress ?? '';
		emergencyContactName = data.profile?.emergencyContactName ?? '';
		emergencyContactRelationship = data.profile?.emergencyContactRelationship ?? '';
		emergencyContactPhone = data.profile?.emergencyContactPhone ?? '';
		fatherName = data.profile?.fatherName ?? '';
		motherName = data.profile?.motherName ?? '';
		maritalStatus = data.profile?.maritalStatus ?? '';
		spouseName = data.profile?.spouseName ?? '';
		bankAccountNumber = data.profile?.bankAccountNumber ?? '';
		bankAccountHolderName = data.profile?.bankAccountHolderName ?? '';
		bankName = data.profile?.bankName ?? '';
		bankIfsc = data.profile?.bankIfsc ?? '';
		aadharNumber = data.profile?.aadharNumber ?? '';
		panNumber = data.profile?.panNumber ?? '';
		uanNumber = data.profile?.uanNumber ?? '';
		underGraduate = data.profile?.underGraduate ?? '';
		graduate = data.profile?.graduate ?? '';
		masters = data.profile?.masters ?? '';
		diplomaOthers = data.profile?.diplomaOthers ?? '';
		totalExperience = data.profile?.totalExperience ?? '';
		saveError = '';
	}

	function startEditing() {
		resetDraft();
		editing = true;
	}

	function cancel() {
		resetDraft();
		editing = false;
	}
</script>

<svelte:head>
	<title>My profile — Champ HR</title>
</svelte:head>

<PageHeader
	crumb={['Profile', tab === 'bank' ? 'Bank and identity details' : 'Your details']}
	title={tab === 'bank' ? 'Keep your essentials up to date.' : 'Your details, in one place.'}
	sub={tab === 'bank' ? 'Your bank and identity details are used for salary processing and official records.' : 'View and manage your personal and employment information.'}
	compact
/>

<form
	class="ess-fill profile-form"
	method="POST"
	action="?/updateSelfService"
	use:enhance={({ cancel }) => {
		if (saving) { cancel(); return; }
		saving = true;
		saveError = '';
		return async ({ result, update }) => {
			try {
				if (result.type === 'success') {
					await update({ reset: false });
					editing = false;
				} else if (result.type === 'redirect') {
					await update();
				} else {
					saveError = 'Could not save your changes. Your edits are still here; please try again.';
				}
			} catch {
				saveError = 'Could not confirm the save. Refresh your profile before trying again.';
			} finally {
				saving = false;
			}
		};
	}}
>
	{#if saveError}<p class="ess-error" role="alert">{saveError}</p>{/if}

	<div class="ess-split layout">
		<div class="main">
			<!-- Identity header: sits above the tabs so the aside can run the full height. -->
			<section class="ess-card identity">
				<div class="identity-main">
					<AvatarUpload userId={data.userRow.id} fullName={data.userRow.fullName} hasPicture={data.hasProfilePicture} pictureVersion={data.profilePictureVersion} compact size="lg" />
					<div class="identity-text">
						<h2 class="name">{data.userRow.fullName}</h2>
						{#if p?.designation}<p class="designation">{p.designation}</p>{/if}
						{#if p?.employeeCode}<p class="code">{p.employeeCode}</p>{/if}
					</div>
				</div>
				<div class="identity-facts">
					<div class="fact">
						<UserRound size={16} strokeWidth={1.75} />
						<div>
							<span class="fact-label">Manager</span>
							<span class="fact-value">
								{#if data.managers?.direct}
									<span class="manager">{data.managers.direct.display}</span>
									{#if data.managers.direct.unlinked}<span class="unlinked">not in system</span>{/if}
								{:else}—{/if}
							</span>
						</div>
					</div>
					<div class="fact">
						<Building size={16} strokeWidth={1.75} />
						<div>
							<span class="fact-label">Location</span>
							<span class="fact-value">{location ?? '—'}</span>
						</div>
					</div>
				</div>
				<div class="identity-actions">
					{#if editing}
						<button type="button" class="ess-btn ess-btn--secondary" onclick={cancel} disabled={saving}>Cancel</button>
						<button type="submit" class="ess-btn ess-btn--primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
					{:else}
						<button type="button" class="ess-btn ess-btn--primary" onclick={startEditing}>
							<PenLine size={16} /> Edit details
						</button>
					{/if}
				</div>
			</section>
			<div class="ess-tabs tabs" role="tablist" aria-label="Profile sections">
				{#each TABS as t (t.id)}
					<button type="button" role="tab" class="ess-tab" aria-selected={tab === t.id} onclick={() => (tab = t.id)}>{t.label}</button>
				{/each}
			</div>

			<!-- ===== Personal ===== -->
			<div class="panel ess-stack" hidden={tab !== 'personal'} role="tabpanel">
				<ProfileCard icon={User} title="Contact information">
					<div class="fields">
						<div class="ess-field">
							<label class="ess-label" for="pf-phone">Phone number</label>
							{#if editing}
								<div class="ess-search"><Phone size={16} /><input id="pf-phone" class="ess-input" name="phone" bind:value={phone} /></div>
							{:else}
								<p class="value"><Phone size={16} /> {p?.phone || 'No phone on file'}</p>
							{/if}
							<span class="ess-help">Used for official communication</span>
						</div>
						<div class="ess-field">
							<label class="ess-label" for="pf-email">Personal email</label>
							{#if editing}
								<div class="ess-search"><Mail size={16} /><input id="pf-email" class="ess-input" name="personalEmail" bind:value={personalEmail} /></div>
							{:else}
								<p class="value"><Mail size={16} /> {p?.personalEmail || data.userRow.email}</p>
							{/if}
							<span class="ess-help">Used for account recovery and personal updates</span>
						</div>
						<div class="ess-field">
							<label class="ess-label" for="pf-address">Current address</label>
							{#if editing}
								<textarea id="pf-address" class="ess-textarea" name="address" rows="2" bind:value={address}></textarea>
							{:else}
								<p class="value value--multi"><MapPin size={16} /> {p?.address || 'No address on file'}</p>
							{/if}
						</div>
						<div class="ess-field">
							<label class="ess-label" for="pf-paddress">Permanent address</label>
							{#if editing}
								<textarea id="pf-paddress" class="ess-textarea" name="permanentAddress" rows="2" bind:value={permanentAddress}></textarea>
							{:else}
								<p class="value value--multi"><MapPin size={16} /> {p?.permanentAddress || p?.address || 'No address on file'}</p>
							{/if}
						</div>
					</div>
					{#if !editing && (p?.dobActual || p?.dobDocuments || p?.gender || p?.bloodGroup || p?.religion || p?.motherTongue)}
						<dl class="ess-kv extra">
							{#if p?.dobActual || p?.dobDocuments}<dt>Date of birth</dt><dd>{p.dobActual || p.dobDocuments}</dd>{/if}
							{#if p?.gender}<dt>Gender</dt><dd>{p.gender}</dd>{/if}
							{#if p?.bloodGroup}<dt>Blood group</dt><dd>{p.bloodGroup}</dd>{/if}
							{#if p?.religion}<dt>Religion</dt><dd>{p.religion}</dd>{/if}
							{#if p?.motherTongue}<dt>Mother tongue</dt><dd>{p.motherTongue}</dd>{/if}
						</dl>
					{/if}
				</ProfileCard>

				<!-- Employment summary and security side by side, so the tab fits. -->
				<div class="pair">
				<ProfileCard icon={Briefcase} title="Employment information" note="Maintained by HR.">
					<div class="kv-cols">
						<dl class="ess-kv">
							<dt>Employee ID</dt><dd class="mono">{p?.employeeCode || '—'}</dd>
							<dt>Department</dt><dd>{p?.subProcessDepartment || '—'}</dd>
							<dt>Job title</dt><dd>{p?.designation || '—'}</dd>
							<dt>Date of joining</dt><dd>{p?.dateOfJoining || '—'}</dd>
						</dl>
						<dl class="ess-kv">
							<dt>Work location</dt><dd>{location ?? '—'}</dd>
							<dt>Team</dt><dd>{p?.teamAndFloor || '—'}</dd>
							<dt>Work email</dt><dd class="official-email">{data.userRow.email}</dd>
							<dt>Reporting manager</dt>
							<dd>
								{#if data.managers?.direct}
									<span class="manager">{data.managers.direct.display}</span>
									{#if data.managers.direct.unlinked}<span class="unlinked">not in system</span>{/if}
								{:else}—{/if}
							</dd>
						</dl>
					</div>
				</ProfileCard>

				<ProfileCard icon={Lock} title="Security">
					<a href="/change-password" class="security-row">
						<span class="ess-tile ess-tile--sm ess-tile--neutral"><LockKeyhole size={16} /></span>
						<span class="ess-row__body">
							<span class="ess-row__title">Password</span>
							<span class="ess-row__meta">Keep your account secure with a strong password.</span>
						</span>
						<span class="ess-btn ess-btn--soft ess-btn--sm">Change password <ChevronRight size={14} /></span>
					</a>
				</ProfileCard>
				</div>
			</div>

			<!-- ===== Employment ===== -->
			<div class="panel ess-stack" hidden={tab !== 'employment'} role="tabpanel">
				<ProfileCard icon={Briefcase} title="Job information" note="These fields are maintained by HR and cannot be edited here.">
					<div class="kv-cols">
						<dl class="ess-kv">
							<dt>Employee code</dt><dd class="mono">{p?.employeeCode || '—'}</dd>
							<dt>Official email</dt><dd class="official-email">{data.userRow.email}</dd>
							<dt>Designation</dt><dd>{p?.designation || '—'}</dd>
							<dt>Department</dt><dd>{p?.subProcessDepartment || '—'}</dd>
							<dt>Team</dt><dd>{p?.teamAndFloor || '—'}</dd>
							<dt>Floor</dt><dd>{p?.floorDetails || '—'}</dd>
						</dl>
						<dl class="ess-kv">
							<dt>Joined</dt><dd>{p?.dateOfJoining || '—'}</dd>
							{#if tenure}<dt>Tenure</dt><dd>{tenure}</dd>{/if}
							<dt>Confirmed</dt><dd>{p?.dateOfConfirmation || '—'}</dd>
							<dt>Shift</dt><dd>{p?.shiftType || '—'} ({p?.officeTimings || '—'})</dd>
							<dt>Reports to</dt>
							<dd>
								{#if data.managers?.direct}
									<span class="manager">{data.managers.direct.display}</span>
									{#if data.managers.direct.unlinked}<span class="unlinked">not in system</span>{/if}
								{:else}—{/if}
							</dd>
							<!-- Only shown when there is a second manager to name; the server
							     suppresses a dotted line that repeats the direct one. -->
							{#if data.managers?.dotted}
								<dt>Dotted line</dt>
								<dd>
									<span class="manager">{data.managers.dotted.display}</span>
									{#if data.managers.dotted.unlinked}<span class="unlinked">not in system</span>{/if}
								</dd>
							{/if}
						</dl>
					</div>
				</ProfileCard>

				<ProfileCard icon={Shield} title="Benefits">
					<p class="plain">Insurance, PF, ESI, Gratuity</p>
				</ProfileCard>
			</div>

			<!-- ===== Bank & IDs ===== -->
			<div class="panel ess-stack" hidden={tab !== 'bank'} role="tabpanel">
				<div class="pair pair--even">
				<ProfileCard icon={Banknote} title="Bank details" note="Your salary will be credited to this account.">
					<div class="form-rows">
						<label class="form-row">
							<span>Account holder name</span>
							{#if editing}<input class="ess-input" name="bankAccountHolderName" bind:value={bankAccountHolderName} />{:else}<span class="ro">{p?.bankAccountHolderName || data.userRow.fullName}</span>{/if}
						</label>
						<label class="form-row">
							<span>Bank name</span>
							{#if editing}<input class="ess-input" name="bankName" bind:value={bankName} />{:else}<span class="ro">{p?.bankName || 'Not added'}</span>{/if}
						</label>
						<label class="form-row">
							<span>Account number</span>
							{#if editing}<input class="ess-input" name="bankAccountNumber" bind:value={bankAccountNumber} inputmode="numeric" />{:else}<span class="ro">{mask(p?.bankAccountNumber)}</span>{/if}
						</label>
						<label class="form-row">
							<span>IFSC code</span>
							{#if editing}<input class="ess-input" name="bankIfsc" bind:value={bankIfsc} />{:else}<span class="ro">{p?.bankIfsc ? p.bankIfsc.slice(0, 4) + '•••• ••••' : 'Not added'}</span>{/if}
						</label>
					</div>
				</ProfileCard>

				<ProfileCard icon={FileText} title="Identity details" note="These details are used for statutory and compliance purposes.">
					<div class="form-rows">
						<label class="form-row">
							<span>Aadhaar number</span>
							{#if editing}<input class="ess-input" name="aadharNumber" bind:value={aadharNumber} inputmode="numeric" />{:else}<span class="ro">{mask(p?.aadharNumber)}</span>{/if}
						</label>
						<label class="form-row">
							<span>PAN number</span>
							{#if editing}<input class="ess-input" name="panNumber" bind:value={panNumber} />{:else}<span class="ro">{maskShort(p?.panNumber)}</span>{/if}
						</label>
						<label class="form-row">
							<span>UAN number</span>
							{#if editing}<input class="ess-input" name="uanNumber" bind:value={uanNumber} inputmode="numeric" />{:else}<span class="ro">{maskShort(p?.uanNumber)}</span>{/if}
						</label>
					</div>
				</ProfileCard>
				</div>
			</div>

			<!-- ===== Family ===== -->
			<div class="panel ess-stack" hidden={tab !== 'family'} role="tabpanel">
				<ProfileCard icon={Users} title="Family details">
					<div class="fields">
						<div class="ess-field">
							<label class="ess-label" for="pf-father">Father's name</label>
							{#if editing}<input id="pf-father" class="ess-input" name="fatherName" bind:value={fatherName} />{:else}
								<p class="value">{p?.fatherName || 'Not added'}{#if p?.fatherContact}<span class="muted"> · {p.fatherContact}</span>{/if}</p>{/if}
						</div>
						<div class="ess-field">
							<label class="ess-label" for="pf-mother">Mother's name</label>
							{#if editing}<input id="pf-mother" class="ess-input" name="motherName" bind:value={motherName} />{:else}
								<p class="value">{p?.motherName || 'Not added'}{#if p?.motherContact}<span class="muted"> · {p.motherContact}</span>{/if}</p>{/if}
						</div>
						<div class="ess-field">
							<label class="ess-label" for="pf-marital">Marital status</label>
							{#if editing}<input id="pf-marital" class="ess-input" name="maritalStatus" bind:value={maritalStatus} />{:else}<p class="value">{p?.maritalStatus || 'Not added'}</p>{/if}
						</div>
						<div class="ess-field">
							<label class="ess-label" for="pf-spouse">Spouse name</label>
							{#if editing}<input id="pf-spouse" class="ess-input" name="spouseName" bind:value={spouseName} />{:else}<p class="value">{p?.spouseName || 'Not added'}</p>{/if}
						</div>
					</div>
					{#if !editing && (p?.anniversaryDate || p?.children?.length)}
						<dl class="ess-kv extra">
							{#if p?.anniversaryDate}<dt>Anniversary</dt><dd>{p.anniversaryDate}</dd>{/if}
							{#if p?.children?.length}
								<dt>Children</dt>
								<dd>{p.children.map((c) => (c.dob ? `${c.name} (${c.dob})` : c.name)).join(', ')}</dd>
							{/if}
						</dl>
					{/if}
				</ProfileCard>
			</div>

			<!-- ===== Education ===== -->
			<div class="panel ess-stack" hidden={tab !== 'education'} role="tabpanel">
				<ProfileCard icon={GraduationCap} title="Education & experience">
					{#if editing}
						<div class="fields">
							<div class="ess-field"><label class="ess-label" for="pf-ug">Under graduate</label><input id="pf-ug" class="ess-input" name="underGraduate" bind:value={underGraduate} /></div>
							<div class="ess-field"><label class="ess-label" for="pf-g">Graduate</label><input id="pf-g" class="ess-input" name="graduate" bind:value={graduate} /></div>
							<div class="ess-field"><label class="ess-label" for="pf-m">Masters</label><input id="pf-m" class="ess-input" name="masters" bind:value={masters} /></div>
							<div class="ess-field"><label class="ess-label" for="pf-d">Diploma / others</label><input id="pf-d" class="ess-input" name="diplomaOthers" bind:value={diplomaOthers} /></div>
							<div class="ess-field"><label class="ess-label" for="pf-exp">Total experience</label><input id="pf-exp" class="ess-input" name="totalExperience" bind:value={totalExperience} /></div>
						</div>
					{:else}
						<dl class="fields edu">
							<div class="ess-field"><dt class="ess-label">Under graduate</dt><dd class="value">{p?.underGraduate || '—'}</dd></div>
							<div class="ess-field"><dt class="ess-label">Graduate</dt><dd class="value">{p?.graduate || '—'}</dd></div>
							<div class="ess-field"><dt class="ess-label">Masters</dt><dd class="value">{p?.masters || '—'}</dd></div>
							<div class="ess-field"><dt class="ess-label">Diploma / others</dt><dd class="value">{p?.diplomaOthers || '—'}</dd></div>
							<div class="ess-field"><dt class="ess-label">Total experience</dt><dd class="value">{p?.totalExperience || '—'}</dd></div>
						</dl>
						{#if quals.length === 0}<p class="muted">No qualifications added yet.</p>{/if}
					{/if}
				</ProfileCard>
			</div>
		</div>

		<!-- ===== Aside ===== -->
		<aside class="ess-stack aside">
			<section class="ess-card" aria-labelledby="reports-to-heading">
				<h3 id="reports-to-heading" class="ess-h2 aside-h">Reports to</h3>
				<p class="plain">{data.managers?.direct?.display ?? 'No manager on file'}</p>
				{#if data.managers?.direct && data.canTeam}
					<a class="ess-btn ess-btn--secondary team-link" href="/team">See your team <ChevronRight size={14} /></a>
				{/if}
			</section>
			{#if tab === 'bank'}
				<section class="ess-card grow-card">
					<h3 class="ess-h2 aside-h">Visibility &amp; updates</h3>
					<div class="privacy">
						<span class="ess-tile ess-tile--round"><Lock size={20} strokeWidth={1.75} /></span>
						<strong>Only you and authorised HR can view these details.</strong>
						<p>Your bank and identity information is kept confidential and is accessible only to you and the designated HR team for legitimate work purposes.</p>
					</div>
					{#if lastUpdated}
						<div class="aside-row">
							<Clock size={16} strokeWidth={1.75} />
							<div><span class="fact-label">Last updated</span><span class="fact-value">{lastUpdated}</span></div>
						</div>
					{/if}
					<div class="aside-row">
						<Info size={16} strokeWidth={1.75} />
						<p class="aside-note">To update any of these details, choose <strong>Edit details</strong> and save the changes.</p>
					</div>
				</section>
			{:else}
				<section class="ess-card">
					<div class="completion-head">
						<h3 class="ess-h2 aside-h">Profile completion</h3>
						<span class="pct">{completion}%</span>
					</div>
					<div class="ess-meter" role="progressbar" aria-valuenow={completion} aria-valuemin="0" aria-valuemax="100"><span style="width:{completion}%"></span></div>
					<p class="muted">{doneCount} of {sections.length} sections complete</p>
					<div class="checklist">
						<strong>Complete your profile</strong>
						<ul>
							{#each sections as s (s.label)}
								<li>
									<button type="button" class="check-row" onclick={() => (tab = s.id)}>
										<span class="check" class:done={s.done}>{#if s.done}<Check size={12} strokeWidth={3} />{/if}</span>
										<span>{s.label}</span>
										{#if !s.done}<ChevronRight size={14} class="chev" />{/if}
									</button>
								</li>
							{/each}
						</ul>
					</div>
				</section>

				<section class="ess-card grow-card">
					<h3 class="ess-h2 aside-h">Emergency contact</h3>
					<div class="form-rows form-rows--narrow">
						<label class="form-row">
							<span>Name</span>
							{#if editing}<input class="ess-input" name="emergencyContactName" bind:value={emergencyContactName} />{:else}<span class="ro">{p?.emergencyContactName || 'Not added'}</span>{/if}
						</label>
						<label class="form-row">
							<span>Relationship</span>
							{#if editing}<input class="ess-input" name="emergencyContactRelationship" bind:value={emergencyContactRelationship} />{:else}<span class="ro">{p?.emergencyContactRelationship || '—'}</span>{/if}
						</label>
						<label class="form-row">
							<span>Phone number</span>
							{#if editing}<input class="ess-input" name="emergencyContactPhone" bind:value={emergencyContactPhone} />{:else}<span class="ro">{p?.emergencyContactPhone || '—'}</span>{/if}
						</label>
					</div>
				</section>
			{/if}

			{#if editing}
				<div class="footer-actions">
					<button type="button" class="ess-btn ess-btn--secondary" onclick={cancel} disabled={saving}>Cancel</button>
					<button type="submit" class="ess-btn ess-btn--primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
				</div>
			{/if}
		</aside>
	</div>
</form>

<style>
	.team-link {
		min-height: 44px;
	}

	/* ---------- identity header ---------- */
	.identity {
		display: flex;
		align-items: center;
		gap: 20px;
		padding: 12px 16px;
		flex-wrap: wrap;
	}
	.identity-main {
		display: flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
	}
	.identity-text {
		display: grid;
		gap: 1px;
		min-width: 0;
	}
	.name {
		font-family: var(--ess-font-display);
		font-size: 20px;
		font-weight: 600;
		line-height: 1.15;
		color: var(--ess-text);
	}
	.designation {
		font-size: 13.5px;
		color: var(--ess-text-secondary);
	}
	.code {
		font-family: var(--ess-font-mono);
		font-size: 12px;
		letter-spacing: 0.03em;
		color: var(--ess-text-muted);
	}
	.identity-facts {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 28px;
		padding-left: 20px;
		border-left: 1px solid var(--ess-border);
	}
	.fact,
	.aside-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		color: var(--ess-text-muted);
	}
	.fact > div,
	.aside-row > div {
		display: grid;
		gap: 1px;
	}
	.fact-label {
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.fact-value {
		font-size: 13.5px;
		font-weight: 500;
		color: var(--ess-text);
	}
	.identity-actions {
		margin-left: auto;
		display: flex;
		gap: 8px;
		flex: none;
	}

	/* ---------- layout ---------- */
	.layout {
		--ess-aside-width: 340px;
	}
	.main {
		display: grid;
		gap: 10px;
		align-content: start;
	}
	.tabs {
		align-self: flex-start;
	}
	.panel {
		gap: 10px;
	}
	.panel[hidden] {
		display: none;
	}
	.aside {
		gap: 10px;
	}

	/* ---------- fields ---------- */
	.fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px 16px;
	}
	.fields .ess-field {
		gap: 4px;
	}
	.fields .ess-label {
		font-size: 12.5px;
	}
	.fields .ess-help {
		font-size: 11.5px;
	}
	.value {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 34px;
		padding: 6px 10px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-sm);
		background: var(--ess-sunken);
		font-size: 13.5px;
		color: var(--ess-text);
		overflow-wrap: anywhere;
	}
	.value--multi {
		align-items: flex-start;
		white-space: pre-line;
	}
	.value :global(svg) {
		flex: none;
		width: 15px;
		height: 15px;
		color: var(--ess-text-muted);
		margin-top: 1px;
	}
	.edu {
		margin: 0;
	}
	.edu dd {
		margin: 0;
	}
	.extra {
		padding-top: 8px;
		border-top: 1px solid var(--ess-border-subtle);
	}
	.ess-kv {
		margin: 0;
		align-content: start;
		font-size: 13.5px;
		row-gap: 6px;
	}
	.kv-cols {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px 24px;
	}
	.plain {
		font-size: 13.5px;
		color: var(--ess-text-secondary);
	}
	.mono {
		font-family: var(--ess-font-mono);
		letter-spacing: 0.02em;
	}
	.official-email {
		overflow-wrap: anywhere;
	}
	/* "Deepak Guduru(CIPL0225)" is one unit — without this the code wraps onto
	   its own line in a narrow column and reads as a separate field. */
	.manager {
		display: inline-block;
	}
	/* Marks a manager who exists only as a name in the HR sheet, so a missing
	   employee code reads as "we don't have them" rather than an error. */
	.unlinked {
		font-size: 11px;
		color: var(--ess-text-muted);
		border: 1px solid var(--ess-border);
		border-radius: 999px;
		padding: 1px 7px;
		margin-left: 6px;
		white-space: nowrap;
	}
	.muted {
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}

	/* Label on the left, value box on the right (Bank & IDs, emergency contact). */
	.form-rows {
		display: grid;
		gap: 6px;
	}
	.form-row {
		display: grid;
		grid-template-columns: 160px minmax(0, 1fr);
		align-items: center;
		gap: 12px;
		font-size: 13.5px;
		color: var(--ess-text-secondary);
	}
	.form-rows--narrow .form-row {
		grid-template-columns: 96px minmax(0, 1fr);
	}
	.ro {
		display: flex;
		align-items: center;
		min-height: 32px;
		padding: 5px 12px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-sm);
		background: var(--ess-sunken);
		color: var(--ess-text);
		font-size: 13.5px;
		letter-spacing: 0.02em;
	}

	.pair {
		display: grid;
		grid-template-columns: minmax(0, 5fr) minmax(0, 2fr);
		gap: 10px;
	}
	.pair--even {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.pair--even .form-row {
		grid-template-columns: 124px minmax(0, 1fr);
	}
	.pair .kv-cols {
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
		column-gap: 16px;
	}
	.pair .ess-kv {
		column-gap: 16px;
	}
	.pair .security-row :global(.ess-row__meta) {
		white-space: normal;
	}
	.security-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px 12px;
		color: var(--ess-text);
	}
	.pair .security-row .ess-row__body {
		flex: 1 1 140px;
	}
	.security-row .ess-tile {
		width: 30px;
		height: 30px;
	}

	/* ---------- aside ---------- */
	.aside .ess-card {
		padding: 14px 16px;
	}
	.aside-h {
		font-size: 16px;
		margin-bottom: 8px;
	}
	.completion-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}
	.pct {
		font-family: var(--ess-font-display);
		font-size: 20px;
		font-weight: 600;
	}
	.completion-head + .ess-meter {
		margin-bottom: 6px;
	}
	.checklist {
		margin-top: 8px;
		padding: 8px 12px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-primary-softer);
	}
	.checklist strong {
		font-family: var(--ess-font-display);
		font-size: 14px;
		font-weight: 600;
	}
	.checklist ul {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: grid;
		gap: 0;
	}
	.check-row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 3px 4px;
		border: none;
		border-radius: var(--ess-radius-sm);
		background: transparent;
		font: inherit;
		font-size: 13px;
		color: var(--ess-text);
		text-align: left;
		cursor: pointer;
	}
	.check-row:hover {
		background: var(--ess-primary-soft);
	}
	.check-row :global(.chev) {
		margin-left: auto;
		color: var(--ess-text-muted);
	}
	.check {
		flex: none;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 2px solid var(--ess-border-strong);
		background: var(--ess-surface);
		color: #fff;
	}
	.check.done {
		background: var(--ess-success);
		border-color: var(--ess-success);
	}

	.privacy {
		display: grid;
		justify-items: center;
		text-align: center;
		gap: 6px;
		padding: 4px 0 12px;
		border-bottom: 1px solid var(--ess-border-subtle);
		margin-bottom: 6px;
	}
	.privacy strong {
		font-family: var(--ess-font-display);
		font-size: 15px;
		font-weight: 600;
		line-height: 1.25;
	}
	.privacy p {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.aside-row {
		padding: 8px 0;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.aside-row:last-child {
		border-bottom: none;
		padding-bottom: 0;
	}
	.aside-note {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.aside-note strong {
		color: var(--ess-text);
	}

	.footer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	/* ---------- fit the screen (desktop) ----------
	   The form is the page's .ess-fill block: the identity bar keeps its
	   height, the tabs and aside take the rest, and a tab whose cards are
	   taller than that scrolls inside its own panel. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.profile-form {
				display: flex;
				flex-direction: column;
			}
			.profile-form > :not(.layout) {
				flex: none;
			}
			.layout {
				flex: 1 1 0%;
				min-height: 0;
				grid-template-rows: minmax(0, 1fr);
			}
			.main {
				display: flex;
				flex-direction: column;
				min-height: 0;
			}
			.identity,
			.tabs {
				flex: none;
			}
			/* A few px of padding so the scroll box does not clip card shadows. */
			.panel,
			.aside {
				flex: 1 1 0%;
				padding: 1px 3px 3px;
				margin: -1px -3px -3px;
			}
			.aside > .footer-actions {
				flex: none;
			}
			.aside > .grow-card {
				flex: 1 0 auto;
			}
		}
	}

	@media (min-width: 1101px) {
		/* Personal tab: employment summary gets the room, security stays slim. */
		.pair:not(.pair--even) {
			grid-template-columns: minmax(0, 2.3fr) minmax(0, 1fr);
		}
		.pair .kv-cols {
			grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr);
			column-gap: 14px;
		}
		.pair .ess-kv {
			column-gap: 12px;
		}
		.pair .security-row {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			gap: 4px 10px;
		}
		.pair .security-row .ess-tile {
			width: 26px;
			height: 26px;
			grid-row: 1;
		}
		.pair .security-row .ess-row__body {
			display: contents;
		}
		.pair .security-row :global(.ess-row__title) {
			grid-column: 2;
			grid-row: 1;
			align-self: center;
		}
		.pair .security-row :global(.ess-row__meta) {
			grid-column: 1 / -1;
			font-size: 12px;
		}
		.pair .security-row > .ess-btn {
			grid-column: 1 / -1;
			justify-self: start;
		}
	}

	/* ---------- short laptop screens (e.g. 1280x580) ----------
	   A slim identity strip, label + hint on one line, tighter boxes — so
	   each tab and the aside fit without scrolling inside. */
	@media (min-width: 1101px) and (max-height: 760px) {
		.identity {
			padding: 8px 14px;
			gap: 16px;
		}
		.identity :global(.avatar--lg) {
			width: 42px;
			height: 42px;
			font-size: 15px;
		}
		.identity :global(.avatar-frame.small .change-btn) {
			width: 20px;
			height: 20px;
			right: -3px;
			bottom: -3px;
		}
		.identity :global(.avatar-frame.small .remove-btn) {
			width: 20px;
			height: 20px;
			left: -3px;
			bottom: -3px;
		}
		.identity :global(.avatar-frame.small svg) {
			width: 11px;
			height: 11px;
		}
		.identity-main {
			gap: 12px;
		}
		.name {
			font-size: 17px;
		}
		.designation {
			font-size: 12.5px;
		}
		.code {
			font-size: 11px;
		}
		.identity-facts {
			padding-left: 16px;
			gap: 4px 24px;
		}
		.fact-label {
			font-size: 11.5px;
		}
		.fact-value {
			font-size: 13px;
		}
		.main,
		.panel,
		.aside {
			gap: 8px;
		}

		/* Field label on the left, its hint on the right, value below. */
		.fields {
			gap: 6px 14px;
		}
		.fields .ess-field {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: baseline;
			column-gap: 10px;
			row-gap: 3px;
		}
		.fields .ess-field > :global(*) {
			grid-column: 1 / -1;
		}
		.fields .ess-field > .ess-label {
			grid-column: 1;
			grid-row: 1;
		}
		.fields .ess-field > .ess-help {
			grid-column: 2;
			grid-row: 1;
			justify-self: end;
			text-align: right;
			min-width: 0;
		}
		.value {
			min-height: 29px;
			padding: 3px 10px;
			font-size: 13px;
		}
		.ess-kv {
			font-size: 13px;
			row-gap: 4px;
		}
		.extra {
			padding-top: 6px;
		}
		.form-rows {
			gap: 5px;
		}
		.form-row {
			font-size: 13px;
		}
		.ro {
			min-height: 30px;
			padding: 4px 10px;
			font-size: 13px;
		}

		/* Bank & IDs: label above its value, so long labels never wrap. */
		.pair--even .form-row {
			grid-template-columns: minmax(0, 1fr);
			gap: 3px;
			font-size: 12.5px;
		}
		.pair--even .form-rows {
			gap: 8px;
		}
		.grow-card {
			display: flex;
			flex-direction: column;
		}
		.grow-card > .privacy {
			flex: 1 1 auto;
			align-content: center;
		}

		/* Save / Cancel already sit in the identity strip, which never scrolls. */
		.aside > .footer-actions {
			display: none;
		}

		/* aside */
		.aside .ess-card {
			padding: 10px 14px;
		}
		.aside-h {
			font-size: 15px;
			margin-bottom: 6px;
		}
		.pct {
			font-size: 18px;
		}
		.completion-head + .ess-meter {
			margin-bottom: 4px;
		}
		.checklist {
			margin-top: 6px;
			padding: 6px 10px;
		}
		.checklist strong {
			font-size: 13px;
		}
		.checklist ul {
			margin-top: 3px;
		}
		.check-row {
			padding: 2px 4px;
			font-size: 12.5px;
		}
		.check {
			width: 16px;
			height: 16px;
		}
		.privacy {
			gap: 4px;
			padding: 0 0 8px;
		}
		.privacy strong {
			font-size: 14px;
		}
		.privacy p,
		.aside-note {
			font-size: 12.5px;
		}
		.aside-row {
			padding: 6px 0;
		}
	}

	@media (max-width: 900px) {
		.identity {
			align-items: flex-start;
		}
		.identity-facts {
			padding-left: 0;
			border-left: none;
		}
		.identity-actions {
			margin-left: 0;
			width: 100%;
		}
		.fields,
		.kv-cols,
		.pair {
			grid-template-columns: 1fr;
		}
		.form-row {
			grid-template-columns: 1fr;
			gap: 4px;
		}
		.tabs {
			align-self: stretch;
		}
		/* Tabs share the row but never squeeze their labels; the strip
		   scrolls sideways on its own when they do not fit. */
		.tabs .ess-tab {
			min-width: 0;
			flex: 1 0 auto;
			padding-left: 12px;
			padding-right: 12px;
		}
	}
</style>
