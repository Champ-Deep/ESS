<script lang="ts">
	import Users from '@lucide/svelte/icons/users';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import UploadCloud from '@lucide/svelte/icons/upload-cloud';
	import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import Mail from '@lucide/svelte/icons/mail';
	import Plus from '@lucide/svelte/icons/plus';
	import Clock from '@lucide/svelte/icons/clock';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Building2 from '@lucide/svelte/icons/building-2';
	import UserRound from '@lucide/svelte/icons/user-round';
	import Briefcase from '@lucide/svelte/icons/briefcase';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { enhance } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import Avatar from '$lib/components/Avatar.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import Settings from '@lucide/svelte/icons/settings';
	import HardHat from '@lucide/svelte/icons/hard-hat';
	import PersonSettingsPanel from '$lib/components/PersonSettingsPanel.svelte';
	import LoginEmailQueue from '$lib/components/LoginEmailQueue.svelte';
	import { WEEKDAY_LABELS, DEFAULT_WEEKDAYS_OFF, weekdaysOffOn } from '$lib/week-off';
	import { BASE_ROLE_LABEL } from '$lib/capabilities';
	import { CHIEF_PICK, MAM_PICK, topFromPick, topLabel, topPick, topPositionReference } from '$lib/chief';
	import { isNoLoginEmail } from '$lib/no-login';

	import type { ActionData, PageData } from './$types';

	/* `embedded`: rendered as the People tab inside Admin Controls, whose
	   layout already titles the page. */
	let {
		data,
		form,
		embedded = false
	}: { data: PageData; form: ActionData; embedded?: boolean } = $props();

	type View = 'roster' | 'weekoff' | 'bulk' | 'logins' | 'passwords';

	/* The employee-facing /team shows People and Week-off schedules. Login
	   import, login delivery and password activity are administration and only
	   appear on the People tab of Admin Controls. */
	const views = $derived<{ id: View; label: string; count?: number }[]>([
		{ id: 'roster', label: embedded ? 'Directory' : 'People' },
		{ id: 'weekoff', label: embedded ? 'Week-off rosters' : 'Week-off schedules' },
		...(embedded && data.canBulkImport ? [{ id: 'bulk' as const, label: 'Bulk import' }] : []),
		...(embedded && data.canApproveLogins ? [{ id: 'logins' as const, label: 'Login delivery', count: data.pendingLoginEmails }] : []),
		...(embedded && data.canSeePasswordActivity ? [{ id: 'passwords' as const, label: 'Password activity' }] : [])
	]);

	function initialView(): View {
		// A bulk-import form result only renders inside that view, so a post
		// back from it has to land there even though the action URL drops ?view.
		if (form && Object.keys(form).some((k) => k.startsWith('bulkImport'))) return 'bulk';
		const asked = page.url.searchParams.get('view');
		if (asked === 'weekoff') return 'weekoff';
		if (!embedded) return 'roster';
		if (asked === 'bulk' && data.canBulkImport) return asked;
		if (asked === 'logins' && data.canApproveLogins) return asked;
		if (asked === 'passwords' && data.canSeePasswordActivity) return asked;
		return 'roster';
	}

	let view = $state<View>(initialView());

	function setView(next: View) {
		view = next;
		const url = new URL(page.url);
		if (next === 'roster') url.searchParams.delete('view');
		else url.searchParams.set('view', next);
		url.searchParams.delete('create');
		replaceState(url, {});
	}

	let showCreateForm = $state(page.url.searchParams.has('create'));

	// svelte-ignore state_referenced_locally
	let newAccess = $state(`base:${data.creatableRoles.at(-1) ?? 'employee'}`);
	const accessHint = $derived.by(() => {
		if (newAccess.startsWith('named:')) {
			const named = data.namedRoles.find((r) => `named:${r.id}` === newAccess);
			return named
				? `${named.description || 'A named role.'} Starts as ${BASE_ROLE_LABEL[named.baseRole]}.`
				: '';
		}
		const role = newAccess.slice(5) as keyof typeof BASE_ROLE_LABEL;
		return {
			employee: 'Their own leave, attendance and profile.',
			team_lead: 'Also approves their team and manages its settings.',
			admin: 'HR: people, balances, uploads and announcements.',
			super_admin: 'Everything, including roles and data cleanup.'
		}[role] ?? '';
	});
	let search = $state('');
	let filter = $state<'all' | 'present' | 'absent'>('all');

	// Which row's temporary password was last copied, for the button's confirmation.
	let copiedPasswordFor = $state<string | null>(null);

	async function copyTemporaryPassword(personId: string, password: string) {
		try {
			await navigator.clipboard.writeText(password);
			copiedPasswordFor = personId;
			setTimeout(() => {
				if (copiedPasswordFor === personId) copiedPasswordFor = null;
			}, 2000);
		} catch {
			// Clipboard access can be refused (an insecure origin, a locked-down
			// browser). The password is on screen either way, so this is not worth
			// an error state — the button simply doesn't say "Copied".
		}
	}

	// --- Bulk import (Super Admin only) ---
	const ROLES = ['employee', 'team_lead', 'admin', 'super_admin'] as const;

	let showBulkImport = $state(false);
	let bulkImportFile = $state<File | null>(null);
	let uploadingBulk = $state(false);
	/** "Replace file" swaps out the import under review; "Upload another" adds one. */
	// Add person: a blank email asks whether they are blue collar.
	let newEmail = $state('');
	// Unanswered until they pick, so the required radio makes them choose.
	let newBlueCollar = $state<boolean | null>(null);
	const askBlueCollar = $derived(!newEmail.trim());

	let replacing = $state(false);
	function openUpload(replace: boolean) {
		replacing = replace;
		showBulkImport = true;
	}
	let selectedImportId = $state<string | null>(null);

	type ReviewRow = {
		id: string;
		employeeCode: string | null;
		fullName: string;
		designation: string | null;
		officialEmail: string;
		reportingAuthorityRaw: string | null;
		reportsToRowId: string | null;
		existingUserId: string | null;
		existingUser: { id: string; fullName: string; email: string } | null;
		role: 'super_admin' | 'admin' | 'team_lead' | 'employee';
		status: 'ready' | 'needs_review' | 'created' | 'skipped_existing';
		/** Parser findings for this row — a drifted column, or an unusable login id. */
		repairNotes: string[] | null;
		/** No work email, confirmed as a blue-collar worker (src/lib/no-login.ts). */
		blueCollar: boolean;
	};

	let reviewImport = $state<{ id: string; filename: string; status: string; appliedAt: string | null } | null>(null);
	const replaceable = $derived(reviewImport?.status === 'pending_review');
	let issuesFirst = $state<string[]>([]);
	const displayRows = $derived(issuesFirst.map((id) => rowById.get(id)).filter((r): r is ReviewRow => Boolean(r)));
	let reviewRows = $state<ReviewRow[]>([]);
	let loadingReview = $state(false);
	let savingRowId = $state<string | null>(null);
	let applyingBulk = $state(false);
	let reissuingBulk = $state(false);

	let needsReviewCount = $derived(reviewRows.filter((r) => r.status === 'needs_review').length);
	let readyCount = $derived(reviewRows.filter((r) => r.status === 'ready').length);
	// Rows that actually became accounts — what the re-issue button acts on.
	let createdCount = $derived(reviewRows.filter((r) => r.status === 'created').length);
	let rowById = $derived(new Map(reviewRows.map((r) => [r.id, r])));

	function onBulkFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		bulkImportFile = input.files?.[0] ?? null;
	}

	async function loadReview(importId: string) {
		loadingReview = true;
		try {
			const res = await fetch(`/api/admin/bulk-imports/${importId}`);
			const body = await res.json();
			if (res.ok) {
				reviewImport = body.import;
				reviewRows = body.rows;
				// Rows that need attention first. Fixed once per load, so a row
				// doesn't jump away the moment it is fixed.
				issuesFirst = [...(body.rows as ReviewRow[])]
					.sort((a, b) => Number(b.status === 'needs_review') - Number(a.status === 'needs_review'))
					.map((r) => r.id);
				selectedImportId = importId;
			}
		} finally {
			loadingReview = false;
		}
	}

	// A rejected edit, per row. The API refuses an email that isn't an address or
	// that another row has already claimed, and those are exactly the edits someone
	// is making when a row is flagged — swallowing the refusal would leave them
	// retyping into a field that silently keeps reverting.
	let rowErrors = $state<Record<string, string>>({});

	async function patchRow(rowId: string, patch: Record<string, unknown>) {
		if (!selectedImportId) return;
		savingRowId = rowId;
		try {
			const res = await fetch(`/api/admin/bulk-imports/${selectedImportId}/rows/${rowId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(patch)
			});
			const body = await res.json();
			if (res.ok) {
				// Picking a manager can make that row a Team Lead too.
				const manager = body.promotedManager;
				reviewRows = reviewRows.map((r) => (r.id === rowId ? { ...r, ...body.row } : manager && r.id === manager.id ? { ...r, ...manager } : r));
				const { [rowId]: _cleared, ...rest } = rowErrors;
				rowErrors = rest;
			} else {
				rowErrors = { ...rowErrors, [rowId]: body.message ?? 'Could not save this change' };
			}
		} finally {
			savingRowId = null;
		}
	}

	function onEmailBlur(rowId: string, e: FocusEvent) {
		const value = (e.target as HTMLInputElement).value.trim();
		const row = rowById.get(rowId);
		if (row && value && value !== row.officialEmail) patchRow(rowId, { officialEmail: value });
	}

	function onRoleChange(rowId: string, e: Event) {
		patchRow(rowId, { role: (e.target as HTMLSelectElement).value });
	}

	function onManagerChange(rowId: string, e: Event) {
		const value = (e.target as HTMLSelectElement).value;
		const top = topFromPick(value);
		if (top) patchRow(rowId, { reportsToChief: true, topPosition: top });
		else patchRow(rowId, { reportsToRowId: value === '' ? null : value });
	}

	/** The top position (Chief or Mam) the sheet put this row under, unless a person was picked instead. */
	function topOfRow(row: ReviewRow) {
		return row.reportsToRowId ? null : topPositionReference(row.reportingAuthorityRaw);
	}

	/** No work email and still waiting for the blue-collar question. */
	const awaitingBlueCollar = $derived(
		reviewRows.filter((r) => r.status === 'needs_review' && isNoLoginEmail(r.officialEmail) && !r.blueCollar && !r.existingUserId)
	);
	let confirmingAll = $state(false);
	/** Says yes for every waiting row that already has a manager; the rest stay listed. */
	async function confirmAllBlueCollar() {
		confirmingAll = true;
		try {
			for (const row of awaitingBlueCollar.filter((r) => r.reportsToRowId)) {
				await patchRow(row.id, { blueCollar: true });
			}
		} finally {
			confirmingAll = false;
		}
	}

	function resolveDuplicate(rowId: string, decision: 'link' | 'create_new') {
		patchRow(rowId, { duplicateDecision: decision });
	}

	// Opens a blue-collar worker's portal as them (src/lib/act-as.ts).
	let openingPortal = $state<string | null>(null);
	let portalError = $state('');
	async function openPortal(userId: string) {
		openingPortal = userId;
		portalError = '';
		const res = await fetch('/api/act-as', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId })
		});
		if (res.ok) {
			location.href = '/dashboard';
			return;
		}
		portalError = (await res.json().catch(() => null))?.message ?? 'Could not open their portal';
		openingPortal = null;
	}

	/** "12 Mar 2024" from a 'YYYY-MM-DD' profile date. */
	function shortDate(iso: string | null): string | null {
		if (!iso) return null;
		const d = new Date(`${iso}T00:00:00`);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
	}

	function managerName(row: ReviewRow): string {
		if (!row.reportsToRowId) {
			const top = topOfRow(row);
			return top ? topLabel(top) : '—';
		}
		return rowById.get(row.reportsToRowId)?.fullName ?? 'Unknown';
	}

	const statusLabel: Record<string, string> = {
		present: 'Present',
		left: 'Checked out',
		absent: 'Absent'
	};

	// Two-step inline confirm rather than a native confirm() dialog — deleting
	// someone should take a deliberate second click, not a reflexive OK.
	let confirmingDelete = $state<string | null>(null);
	let deletingId = $state<string | null>(null);
	let deleteError = $state('');

	async function deleteEmployee(userId: string) {
		deleteError = '';
		deletingId = userId;
		try {
			const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				deleteError = body.message ?? 'Could not delete this employee';
				return;
			}
			confirmingDelete = null;
			await invalidateAll();
		} finally {
			deletingId = null;
		}
	}

	/* Admin-issued password reset. Passwords are Argon2-hashed and cannot be
	   read back, so the only recovery path is to set a new one — issued here,
	   shown once for hand-off, and forced to change on the user's next login. */
	let resettingId = $state<string | null>(null);
	let resetFor = $state<{ id: string; name: string } | null>(null);
	let resetValue = $state('');
	let resetError = $state('');
	let resetIssued = $state<{ name: string; password: string } | null>(null);

	function openReset(person: { id: string; fullName: string }) {
		resetFor = { id: person.id, name: person.fullName };
		resetValue = generatePassword();
		resetError = '';
		resetIssued = null;
	}

	function generatePassword() {
		const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
		const pick = new Uint32Array(12);
		crypto.getRandomValues(pick);
		return 'Champ@' + [...pick].map((n) => chars[n % chars.length]).join('').slice(0, 8);
	}

	async function submitReset() {
		if (!resetFor) return;
		resetError = '';
		if (resetValue.length < 8) {
			resetError = 'Password must be at least 8 characters';
			return;
		}
		resettingId = resetFor.id;
		try {
			const res = await fetch(`/api/admin/users/${resetFor.id}/password`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ newPassword: resetValue })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				resetError = body.message ?? 'Could not reset this password';
				return;
			}
			resetIssued = { name: resetFor.name, password: resetValue };
			resetFor = null;
			resetValue = '';
			await invalidateAll();
		} finally {
			resettingId = null;
		}
	}

	/* Role, reporting line, HR, shift and week off are all edited together in the
	   person panel rather than as inline dropdowns: they are related settings,
	   and one Save is both easier to reason about and one write instead of six.
	   Selecting a row opens it; `person` is keyed by id so switching rows
	   remounts the panel with that person's values. */
	let editingPerson = $state<(typeof data.roster)[number] | null>(null);
	// Side effects of a save that the admin needs to see after the panel closes —
	// currently: whose reporting line was cleared to make room for a new one.
	let settingsNotice = $state('');

	// --- Roster authoring (Super Admin) ---
	let showRosterEditor = $state(false);
	let rosterName = $state('');
	let rosterDescription = $state('');
	let rosterPattern = $state<'fixed' | 'rotational'>('fixed');
	let rosterWeekdays = $state<number[]>([0, 6]);
	let rosterTeamId = $state('');
	let rosterAnchor = $state(new Date().toISOString().slice(0, 10));
	let rotationWeeks = $state<number[][]>([[0], [0, 6]]);
	let editingRosterId = $state<string | null>(null);
	let rosterSaving = $state(false);
	let rosterError = $state('');

	function toggleFixedDay(day: number) {
		rosterWeekdays = rosterWeekdays.includes(day)
			? rosterWeekdays.filter((d) => d !== day)
			: [...rosterWeekdays, day].sort();
	}

	function toggleRotationDay(weekIndex: number, day: number) {
		rotationWeeks = rotationWeeks.map((week, i) => {
			if (i !== weekIndex) return week;
			return week.includes(day) ? week.filter((d) => d !== day) : [...week, day].sort();
		});
	}

	function addRotationWeek() {
		if (rotationWeeks.length < 12) rotationWeeks = [...rotationWeeks, []];
	}

	function removeRotationWeek(index: number) {
		if (rotationWeeks.length > 2) rotationWeeks = rotationWeeks.filter((_, i) => i !== index);
	}

	function resetRosterForm() {
		editingRosterId = null;
		rosterName = '';
		rosterDescription = '';
		rosterPattern = 'fixed';
		rosterWeekdays = [0, 6];
		rosterTeamId = '';
		rosterAnchor = new Date().toISOString().slice(0, 10);
		rotationWeeks = [[0], [0, 6]];
		rosterError = '';
	}

	function editRoster(roster: (typeof data.weekOffRosters)[number]) {
		editingRosterId = roster.id;
		rosterName = roster.name;
		rosterDescription = roster.description ?? '';
		rosterPattern = roster.pattern;
		rosterWeekdays = roster.weekdays ?? [0, 6];
		rosterTeamId = roster.teamId ?? '';
		rosterAnchor = roster.rotationAnchorDate ?? new Date().toISOString().slice(0, 10);
		rotationWeeks = roster.rotationWeeks ?? [[0], [0, 6]];
		rosterError = '';
		showRosterEditor = true;
	}

	async function saveRoster() {
		rosterError = '';
		rosterSaving = true;
		try {
			const payload = {
				name: rosterName,
				description: rosterDescription,
				pattern: rosterPattern,
				weekdays: rosterWeekdays,
				rotationWeeks,
				rotationAnchorDate: rosterAnchor,
				teamId: rosterTeamId || null
			};
			const res = await fetch(
				editingRosterId ? `/api/admin/week-off-rosters/${editingRosterId}` : '/api/admin/week-off-rosters',
				{
					method: editingRosterId ? 'PUT' : 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload)
				}
			);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				rosterError = body.message ?? 'Could not save this roster';
				return;
			}
			resetRosterForm();
			showRosterEditor = false;
			await invalidateAll();
		} finally {
			rosterSaving = false;
		}
	}

	async function togglePublish(roster: (typeof data.weekOffRosters)[number]) {
		rosterError = '';
		const res = await fetch(`/api/admin/week-off-rosters/${roster.id}/publish`, {
			method: roster.status === 'published' ? 'DELETE' : 'POST'
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			rosterError = body.message ?? 'Could not change the published state';
			return;
		}
		await invalidateAll();
	}

	async function deleteRoster(roster: (typeof data.weekOffRosters)[number]) {
		rosterError = '';
		if (!confirm(`Delete the roster "${roster.name}"? You can create it again afterwards.`)) return;
		let res = await fetch(`/api/admin/week-off-rosters/${roster.id}`, { method: 'DELETE' });
		// People are still on it: say so, and delete anyway only if confirmed.
		if (res.status === 409) {
			const body = await res.json().catch(() => ({}));
			if (!confirm(`${body.message ?? 'Employees are still on this roster.'}

Delete it anyway? Those employees go back to Sat/Sun week offs until they are given another roster.`)) return;
			res = await fetch(`/api/admin/week-off-rosters/${roster.id}?force=1`, { method: 'DELETE' });
		}
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			rosterError = body.message ?? 'Could not delete this roster';
			return;
		}
		if (editingRosterId === roster.id) editingRosterId = null;
		await invalidateAll();
	}

	const filteredRoster = $derived(
		data.roster.filter((person) => {
			const q = search.trim().toLowerCase();
			// Employee code is the primary way HR looks someone up, so it searches
			// alongside name and email.
			if (
				q &&
				!person.fullName.toLowerCase().includes(q) &&
				!person.email.toLowerCase().includes(q) &&
				!(person.employeeCode ?? '').toLowerCase().includes(q)
			) {
				return false;
			}
			if (filter === 'present' && person.status !== 'present') return false;
			if (filter === 'absent' && person.status !== 'absent') return false;
			return true;
		})
	);

	/* ---------- selection, for the right-hand panel ---------- */

	let selectedId = $state<string | null>(null);
	const selected = $derived(data.roster.find((p) => p.id === selectedId) ?? null);
	const BADGE: Record<string, string> = { present: 'present', left: 'cancelled', absent: 'absent' };
	const roleLabel = (p: { role: string; customRoleName: string | null }) =>
		p.customRoleName ?? BASE_ROLE_LABEL[p.role as keyof typeof BASE_ROLE_LABEL] ?? p.role.replace('_', ' ');

	/* ---------- this week's roster grid ---------- */

	function dateKey(d: Date) {
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}
	/** Monday to Sunday of the current week. */
	const weekDays = (() => {
		const now = new Date();
		const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
		return Array.from({ length: 7 }, (_, i) => {
			const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
			return { key: dateKey(d), weekday: d.getDay(), label: WEEKDAY_LABELS[d.getDay()], day: d.getDate(), month: d.toLocaleDateString(undefined, { month: 'short' }) };
		});
	})();
	const weekRange = `${weekDays[0].day} – ${weekDays[6].day} ${weekDays[6].month} ${new Date().getFullYear()}`;
	const rosterById = $derived(new Map(data.weekOffRosters.map((r) => [r.id, r])));
	/** Which weekdays this person is off on a given date, from their roster. */
	function offOn(person: (typeof data.roster)[number], key: string): number[] {
		const roster = person.weekOffRosterId ? rosterById.get(person.weekOffRosterId) : null;
		if (!roster) return DEFAULT_WEEKDAYS_OFF;
		return weekdaysOffOn(roster, key);
	}
	let gridFilter = $state('');
	const gridRows = $derived(
		data.roster.filter((p) => !gridFilter || p.weekOffRosterId === gridFilter || (gridFilter === 'default' && !p.weekOffRosterId))
	);

	/* ---------- bulk import signpost ---------- */

	const bulkStep = $derived(reviewImport ? (reviewImport.status === 'applied' ? 3 : 1) : 0);
	const bulkStepHints = $derived([
		reviewImport?.filename ?? 'Choose a spreadsheet',
		reviewImport && reviewImport.status !== 'applied' ? 'Check and fix any issues' : 'Check each row',
		reviewImport?.status === 'applied' ? `${createdCount} created` : 'Set up the accounts'
	]);

	/* ---------- password activity ---------- */

	let pwSearch = $state('');
	let pwAction = $state('');
	let pwSelected = $state<number | null>(null);
	const pwActions = $derived([...new Set(data.passwordActivity.map((e) => e.label))]);
	const pwRows = $derived(
		data.passwordActivity
			.map((e, i) => ({ ...e, i }))
			.filter((e) => {
				const q = pwSearch.trim().toLowerCase();
				if (q && !(e.targetName ?? '').toLowerCase().includes(q) && !(e.targetEmail ?? '').toLowerCase().includes(q) && !(e.actorName ?? '').toLowerCase().includes(q)) return false;
				if (pwAction && e.label !== pwAction) return false;
				return true;
			})
	);
	const pwThisWeek = $derived(data.passwordActivity.filter((e) => Date.now() - new Date(e.createdAt).getTime() < 7 * 86_400_000).length);
	const pwEvent = $derived(pwSelected === null ? null : (data.passwordActivity[pwSelected] ?? null));
	const whenLong = (d: string | Date) => new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
</script>

<svelte:head>
	<title>{embedded ? 'People — Admin Controls' : 'Team'} — Champ HR ESS Portal</title>
</svelte:head>

{#if !embedded}
	<PageHeader crumb={['Team', view === 'weekoff' ? 'Schedules' : 'People']} title={view === 'weekoff' ? 'A balanced week for everyone.' : 'Know your people.'} sub={view === 'weekoff' ? 'Plan and manage team week-off schedules with ease.' : 'Find and manage your team members, their availability and schedules.'} compact>
		{#snippet actions()}
			{#if data.canCreateLogin && view === 'roster'}
				<button class="ess-btn ess-btn--primary" onclick={() => (showCreateForm = !showCreateForm)}>
					<UserPlus size={17} />
					Add person
				</button>
			{/if}
		{/snippet}
		{#snippet tabs()}{@render viewTabs()}{/snippet}
	</PageHeader>
{/if}

<!--
	The page used to be four stacked screens — roster, week-off rosters, bulk
	import, password activity — scrolling past 2,000 lines of markup. One
	switch shows one at a time; the choice is kept in the URL (?view=) so a
	refresh or a shared link lands on the same part.
-->
{#snippet viewTabs()}
	<div class="ess-tabs view-tabs" role="tablist" aria-label="Show">
		{#each views as v (v.id)}
			<button type="button" role="tab" class="ess-tab" aria-selected={view === v.id} onclick={() => setView(v.id)}>
				{v.label}
				{#if v.count}<span class="ess-count">{v.count}</span>{/if}
			</button>
		{/each}
	</div>
{/snippet}
{#if embedded}{@render viewTabs()}{/if}

<!-- ============================== PEOPLE ============================== -->
{#if view === 'roster'}
	<div class="ess-figures figures">
		<div class="ess-figure">
			<span class="ess-tile ess-tile--sm"><Users size={18} /></span>
			<div><div class="ess-figure__value">{data.teamSize}</div><div class="ess-figure__label">Total people</div></div>
		</div>
		<div class="ess-figure">
			<span class="ess-figure__dot ess-figure__dot--ok"></span>
			<div><div class="ess-figure__value">{data.presentNow}</div><div class="ess-figure__label">Present now</div></div>
		</div>
		<div class="ess-figure">
			<span class="ess-figure__dot ess-figure__dot--warn"></span>
			<div><div class="ess-figure__value">{data.onLeave}</div><div class="ess-figure__label">On leave today</div></div>
		</div>
		<div class="ess-figure">
			<span class="ess-figure__dot"></span>
			<div><div class="ess-figure__value">{data.pendingApprovals}</div><div class="ess-figure__label">Pending approvals</div></div>
		</div>
	</div>

	<div class="toolbar">
		<label class="ess-search grow">
			<Search size={17} />
			<input class="ess-input" placeholder="Search by name, code or email…" bind:value={search} aria-label="Search people" />
		</label>
		<select class="ess-select status-filter" bind:value={filter} aria-label="Filter by status">
			<option value="all">All statuses</option>
			<option value="present">Present now</option>
			<option value="absent">Not present</option>
		</select>
	</div>

	{#if deleteError}
		<p class="ess-alert ess-alert--danger">{deleteError}</p>
	{/if}

	{#if settingsNotice}
		<p class="ess-alert ess-alert--warning notice">
			<span>{settingsNotice}</span>
			<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (settingsNotice = '')}>Dismiss</button>
		</p>
	{/if}

	{#if resetIssued}
		<div class="ess-notice ess-notice--success">
			<span class="ess-notice__icon"><KeyRound size={15} /></span>
			<div class="ess-notice__body">
				<strong>Password reset for {resetIssued.name}.</strong>
				Share this once — it won't be shown again: <code class="code">{resetIssued.password}</code>
			</div>
			<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (resetIssued = null)}>Dismiss</button>
		</div>
	{/if}

	{#if form?.success && form.blueCollar}
		<div class="ess-notice ess-notice--success">
			<span class="ess-notice__icon"><HardHat size={15} /></span>
			<div class="ess-notice__body">
				<strong>Added {form.fullName} as blue collar.</strong>
				No login and no email. {form.managerName ?? 'Their manager'} (or an admin) opens their portal for them from the Team page.
			</div>
		</div>
	{:else if form?.success}
		<div class="ess-notice ess-notice--success">
			<span class="ess-notice__icon"><UserPlus size={15} /></span>
			<div class="ess-notice__body">
				<strong>Created {form.email}</strong>
				{#if form.tempPassword}
					Temporary password: <code class="code">{form.tempPassword}</code>.
				{:else}
					No password is set: they sign in with a code sent to their email, then choose their own.
				{/if}
				Their login email waits for an admin to approve it{data.canApproveLogins ? ' in Login delivery' : ''}. Nothing has been emailed yet.
			</div>
		</div>
	{:else if form?.message}
		<p class="ess-alert ess-alert--danger">{form.message}</p>
	{/if}

	{#if editingPerson}
		{#key editingPerson.id}
			<PersonSettingsPanel
				person={editingPerson}
				people={data.allPeople}
				shiftGroups={data.allShiftGroups}
				rosters={data.weekOffRosters}
				roles={ROLES}
				canEditRole={data.isSuperAdmin}
				canPickChief={data.canPickChief}
				currentUserId={data.currentUserId}
				onnotice={(m) => (settingsNotice = m)}
				onclose={() => (editingPerson = null)}
				onsaved={async () => {
					editingPerson = null;
					await invalidateAll();
				}}
			/>
		{/key}
	{/if}

	<div class="ess-split ess-split--narrow people-split ess-fill">
		<section class="ess-card directory ess-fill-card">
			<div class="ess-card-head">
				<div>
					<h2 class="ess-h2">{embedded ? 'Employee directory' : 'People'}</h2>
					<p class="ess-caption">{filteredRoster.length} of {data.teamSize} {data.teamSize === 1 ? 'person' : 'people'}</p>
				</div>
				{#if data.canCreateLogin && embedded}
					<button class="ess-btn ess-btn--primary" onclick={() => (showCreateForm = !showCreateForm)}>
						<Plus size={17} />
						Create login
					</button>
				{/if}
			</div>

			<div class="table-wrap ess-scroll">
				<table class="ess-table roster">
					<thead>
						<tr>
							<th>Name</th>
							<th>Reports to</th>
							<th>Concerned HR</th>
							<th>Shift</th>
							<th>Week off</th>
							<th>Today</th>
							<th class="ess-num">Leave left</th>
							<th><span class="ess-sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each filteredRoster as person (person.id)}
							<!-- The whole row selects the person for the panel on the right.
							     Keyboard users get the same via the View button. -->
							<tr class="person-row" class:is-selected={selectedId === person.id} onclick={() => (selectedId = person.id)}>
								<td>
									<span class="name-cell">
										<Avatar userId={person.id} fullName={person.fullName} hasPicture={person.hasPicture} size="md" />
										<span class="name-text">
											<strong>{person.fullName}</strong>
											<small title={person.noLogin ? 'No work email, so no login' : person.email}>
												{#if person.employeeCode}<span class="code-cell">{person.employeeCode}</span>{:else}<span class="missing" title="No employee code — biometric attendance can't be matched">No code</span>{/if}
												<span class="ess-dot-sep"></span>{#if person.noLogin}<span class="no-login">Blue collar · no login</span>{:else}{person.email}{/if}
											</small>
										</span>
									</span>
								</td>
								<td class="muted-cell">
									{#if person.reportsToName}
										{person.reportsToName}
									{:else if person.reportsToChief}
										<span class="chief" title="Approvals go straight to the concerned HR.">{topLabel(person.topPosition)}</span>
									{:else}
										<span class="missing" title="No reporting manager — approvals fall back to HR">Not set</span>
									{/if}
								</td>
								<td class="muted-cell">{person.hrName ?? 'Any admin'}</td>
								<td class="muted-cell">
									{#if person.shiftGroupName}
										{person.shiftGroupName}
										{#if person.officeTimings}<small class="sub">{person.officeTimings}</small>{/if}
									{:else}
										<span class="missing">Not set</span>
									{/if}
								</td>
								<td class="muted-cell">
									{person.weekOffName ?? 'Sat + Sun'}
									<small class="sub">{person.weekOffSummary}</small>
								</td>
								<td><span class="ess-badge ess-badge--{BADGE[person.status]}">{statusLabel[person.status]}</span></td>
								<td class="ess-num">{person.leaveLeft}</td>
								<!-- Buttons sit inside the clickable row, so each stops its click
								     from also changing the selection. -->
								<td class="actions-cell">
									<span class="row-actions" onclick={(e) => e.stopPropagation()} role="presentation">
										<button type="button" class="ess-btn ess-btn--secondary ess-btn--sm" onclick={() => (selectedId = person.id)}>View</button>
										{#if person.canEditSettings}
											<button type="button" class="ess-icon-btn" onclick={() => (editingPerson = person)} aria-label="Settings for {person.fullName}" title="Settings for {person.fullName}">
												<Settings size={16} />
											</button>
										{/if}
										{#if data.canDeletePeople && person.id !== data.currentUserId}
											{#if confirmingDelete === person.id}
												<span class="confirm-delete">
													<button type="button" class="ess-btn ess-btn--sm ess-btn--danger" onclick={() => deleteEmployee(person.id)} disabled={deletingId === person.id}>
														{deletingId === person.id ? 'Deleting…' : 'Confirm'}
													</button>
													<button type="button" class="ess-btn ess-btn--sm ess-btn--ghost" onclick={() => (confirmingDelete = null)} disabled={deletingId === person.id}>Cancel</button>
												</span>
											{:else}
												{#if !person.noLogin}
													<button type="button" class="ess-icon-btn" onclick={() => openReset(person)} aria-label="Reset password for {person.fullName}" title="Reset password for {person.fullName}">
														<KeyRound size={16} />
													</button>
												{/if}
												<button type="button" class="ess-icon-btn danger" onclick={() => (confirmingDelete = person.id)} aria-label="Delete {person.fullName}" title="Delete {person.fullName}">
													<Trash2 size={16} />
												</button>
											{/if}
										{/if}
									</span>
								</td>
							</tr>
							<!--
								The login this person has not used yet. Spans the whole row: it is
								present for a handful of people at a time, and it disappears on its
								own the moment they sign in and set their own password.
							-->
							{#if person.temporaryPassword}
								<tr class="pending-row">
									<td colspan="8">
										<span class="pending-login" onclick={(e) => e.stopPropagation()} role="presentation">
											<Mail size={14} />
											<span>Hasn't signed in yet — temporary password</span>
											<code class="code">{person.temporaryPassword}</code>
											<button type="button" class="ess-btn ess-btn--sm ess-btn--ghost" onclick={() => copyTemporaryPassword(person.id, person.temporaryPassword!)}>
												{copiedPasswordFor === person.id ? 'Copied' : 'Copy'}
											</button>
										</span>
									</td>
								</tr>
							{/if}
						{:else}
							<tr><td colspan="8"><div class="ess-empty">No one matches this search.</div></td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<aside class="ess-stack side">
			{#if showCreateForm && data.canCreateLogin}
				<!--
					Access is one choice: a base role, or a named role a Super Admin made
					(IT Support, Operations…). The named role decides the base role too, so the
					hint under the field says what the person will actually be able to do.
				-->
				<form method="POST" action="?/createEmployee" use:enhance class="ess-card create-panel">
					<div class="ess-card-head">
						<div>
							<h2 class="ess-h2">Create login</h2>
							<p class="ess-caption">Create an employee account; their login email waits for approval.</p>
						</div>
						<button type="button" class="ess-icon-btn" onclick={() => (showCreateForm = false)} aria-label="Close"><X size={18} /></button>
					</div>
					<label class="ess-field">
						<span class="ess-label">Full name <span class="req">*</span></span>
						<input class="ess-input" name="fullName" required />
					</label>
					<label class="ess-field">
						<span class="ess-label">Work email</span>
						<input class="ess-input" name="email" type="email" bind:value={newEmail} />
					</label>
					{#if askBlueCollar}
						<!-- No work email: only a blue-collar worker, who gets no login (src/lib/no-login.ts). -->
						<fieldset class="ess-field blue-collar-ask">
							<legend class="ess-label">No work email. Are they blue collar? <span class="req">*</span></legend>
							<label class="radio"><input type="radio" name="blueCollar" bind:group={newBlueCollar} value={true} required /> Yes, blue collar</label>
							<label class="radio"><input type="radio" name="blueCollar" bind:group={newBlueCollar} value={false} /> No, I'll add their email</label>
							<span class="ess-help">
								{#if newBlueCollar}
									They get no login. {data.teamLeadTeamId ? 'You' : 'The manager you pick below'} (or an admin) open their portal for them to apply leave, check attendance and keep their details.
								{:else}
									Everyone else needs a work email to sign in.
								{/if}
							</span>
						</fieldset>
						{#if newBlueCollar}
							<label class="ess-field">
								<span class="ess-label">Employee code</span>
								<input class="ess-input" name="employeeCode" placeholder="e.g. INFRATECH0230" />
								<span class="ess-help">Matches their biometric punches to attendance.</span>
							</label>
						{/if}
					{/if}
					{#if !(askBlueCollar && newBlueCollar)}
					<label class="ess-field">
						<span class="ess-label">Access role <span class="req">*</span></span>
						<select class="ess-select" name="access" bind:value={newAccess}>
							{#each data.creatableRoles as role (role)}
								<option value="base:{role}">{BASE_ROLE_LABEL[role]}</option>
							{/each}
							{#if data.namedRoles.length > 0}
								<optgroup label="Named roles">
									{#each data.namedRoles as named (named.id)}
										<option value="named:{named.id}">{named.name}</option>
									{/each}
								</optgroup>
							{/if}
						</select>
						<span class="ess-help">{accessHint}</span>
					</label>
					{/if}
					{#if !data.teamLeadTeamId}
						<label class="ess-field">
							<span class="ess-label">Team</span>
							<select class="ess-select" name="teamId">
								<option value="">— none yet —</option>
								{#each data.allTeams as team (team.id)}
									<option value={team.id}>{team.name}</option>
								{/each}
							</select>
						</label>
						<label class="ess-field">
							<span class="ess-label">Reports to{#if askBlueCollar && newBlueCollar} <span class="req">*</span>{/if}</span>
							<select class="ess-select" name="reportsTo" required={askBlueCollar && newBlueCollar}>
								<option value="">— not set —</option>
								{#if askBlueCollar && newBlueCollar}
									<!-- Their manager opens their portal, so it has to be someone who can sign in. -->
									{#each data.allPeople.filter((p) => !p.noLogin) as p (p.id)}
										<option value={p.id}>{p.fullName}</option>
									{/each}
								{:else}
									{#if data.canPickChief}<option value={CHIEF_PICK}>Chief</option><option value={MAM_PICK}>Mam</option>{/if}
									{#each data.allPeople as p (p.id)}
										<option value={p.id}>{p.fullName}</option>
									{/each}
								{/if}
							</select>
						</label>
						<label class="ess-field">
							<span class="ess-label">Concerned HR</span>
							<select class="ess-select" name="hrUserId">
								<option value="">— any admin —</option>
								{#each data.hrPeople as p (p.id)}
									<option value={p.id}>{p.fullName}</option>
								{/each}
							</select>
						</label>
					{/if}
					<label class="ess-field">
						<span class="ess-label">Shift group <span class="req">*</span></span>
						{#if data.shiftGroups.length > 0}
							<select class="ess-select" name="shiftGroupId" required>
								{#each data.shiftGroups as group (group.id)}
									<option value={group.id}>{group.name}</option>
								{/each}
							</select>
						{:else}
							<select class="ess-select" disabled>
								<option>No published holiday calendar yet</option>
							</select>
						{/if}
					</label>
					<div class="ess-alert ess-alert--info small">
						A secure temporary password is generated and shown once the login exists. The login email goes out only after an admin approves it.
					</div>
					{#if data.shiftGroups.length === 0}
						<p class="ess-error">Publish a holiday calendar for at least one shift group before creating logins.</p>
					{/if}
					<button type="submit" class="ess-btn ess-btn--primary wide" disabled={data.shiftGroups.length === 0}>Create login</button>
				</form>
			{:else if resetFor}
				<div class="ess-card">
					<div class="ess-card-head">
						<div>
							<h2 class="ess-h2">Reset password</h2>
							<p class="ess-caption">{resetFor.name}</p>
						</div>
						<button type="button" class="ess-icon-btn" onclick={() => (resetFor = null)} aria-label="Close"><X size={18} /></button>
					</div>
					<p class="ess-caption">
						Existing passwords are one-way hashed and can never be read back, so a reset issues a new one. It is shown once here for hand-off, and {resetFor.name} must change it at next login.
					</p>
					<label class="ess-field reset-field">
						<span class="ess-label">New temporary password</span>
						<input class="ess-input mono" bind:value={resetValue} spellcheck="false" autocomplete="off" />
					</label>
					{#if resetError}<p class="ess-error">{resetError}</p>{/if}
					<div class="btn-row">
						<button type="button" class="ess-btn ess-btn--secondary" onclick={() => (resetValue = generatePassword())}>Regenerate</button>
						<button type="button" class="ess-btn ess-btn--primary" onclick={submitReset} disabled={resettingId !== null}>
							{resettingId ? 'Resetting…' : 'Reset password'}
						</button>
					</div>
				</div>
			{:else if selected}
				<div class="ess-card person-panel">
					<div class="person-top">
						<Avatar userId={selected.id} fullName={selected.fullName} hasPicture={selected.hasPicture} size="lg" />
						<div class="person-id">
							<div class="person-name">
								<h2 class="ess-h2">{selected.fullName}</h2>
								<span class="ess-badge ess-badge--{BADGE[selected.status]}">{statusLabel[selected.status]}</span>
							</div>
							<p class="ess-caption">
								{#if selected.employeeCode}{selected.employeeCode}<span class="ess-dot-sep"></span>{/if}{#if selected.noLogin}Blue collar · no login{:else}{selected.email}{/if}
							</p>
						</div>
						<button type="button" class="ess-icon-btn" onclick={() => (selectedId = null)} aria-label="Close"><X size={18} /></button>
					</div>

					<dl class="facts">
						{#if data.isSuperAdmin}
							<div><dt><Briefcase size={16} /></dt><dd><span>Access</span><strong>{roleLabel(selected)}</strong></dd></div>
						{/if}
						<div>
							<dt><UserRound size={16} /></dt>
							<dd>
								<span>Reporting manager</span>
								<strong>
									{#if selected.reportsToName}{selected.reportsToName}{:else if selected.reportsToChief}{topLabel(selected.topPosition)}{:else}Not set{/if}
								</strong>
							</dd>
						</div>
						<div><dt><ShieldCheck size={16} /></dt><dd><span>Concerned HR</span><strong>{selected.hrName ?? 'Any admin'}</strong></dd></div>
						<div>
							<dt><Clock size={16} /></dt>
							<dd>
								<span>Assigned shift</span>
								<strong>{selected.shiftGroupName ?? 'Not set'}</strong>
								{#if selected.officeTimings || selected.shiftType}<small>{[selected.shiftType, selected.officeTimings].filter(Boolean).join(' · ')}</small>{/if}
							</dd>
						</div>
						<div>
							<dt><CalendarDays size={16} /></dt>
							<dd>
								<span>Week off</span>
								<strong>{selected.weekOffName ?? 'Sat + Sun'}</strong>
								<small>{selected.weekOffSummary}</small>
							</dd>
						</div>
						<div><dt><Building2 size={16} /></dt><dd><span>Leave left</span><strong>{selected.leaveLeft} {selected.leaveLeft === 1 ? 'day' : 'days'}</strong></dd></div>
					</dl>

					{#if selected.details}
						{@const d = selected.details}
						<!--
							No login, so nobody else keeps this for them: their reporting
							manager (and HR) see it here.
						-->
						<div class="no-login-details">
							<p class="ess-caption">Blue collar: no work email, no login. Their details, kept here for the people who look after them:</p>
							<dl class="ess-kv">
								{#if d.designation}<dt>Designation</dt><dd>{d.designation}</dd>{/if}
								{#if d.department || d.teamAndFloor}<dt>Department</dt><dd>{d.department ?? d.teamAndFloor}</dd>{/if}
								{#if d.dateOfJoining}<dt>Joined</dt><dd>{shortDate(d.dateOfJoining)}</dd>{/if}
								{#if d.phone}<dt>Phone</dt><dd><a href="tel:{d.phone}">{d.phone}</a></dd>{/if}
								{#if d.gender}<dt>Gender</dt><dd>{d.gender}</dd>{/if}
								{#if d.dateOfBirth}<dt>Date of birth</dt><dd>{shortDate(d.dateOfBirth)}</dd>{/if}
								{#if d.bloodGroup}<dt>Blood group</dt><dd>{d.bloodGroup}</dd>{/if}
								{#if d.address}<dt>Address</dt><dd>{d.address}</dd>{/if}
								{#if d.permanentAddress && d.permanentAddress !== d.address}<dt>Permanent address</dt><dd>{d.permanentAddress}</dd>{/if}
								{#if d.emergencyContactName || d.emergencyContactPhone}
									<dt>Emergency contact</dt>
									<dd>
										{[d.emergencyContactName, d.emergencyContactRelationship && `(${d.emergencyContactRelationship})`].filter(Boolean).join(' ')}
										{#if d.emergencyContactPhone}<br /><a href="tel:{d.emergencyContactPhone}">{d.emergencyContactPhone}</a>{/if}
									</dd>
								{/if}
							</dl>
							{#if selected.canOpenPortal}
								<button type="button" class="ess-btn ess-btn--primary wide" onclick={() => openPortal(selected!.id)} disabled={openingPortal === selected.id}>
									<HardHat size={16} /> {openingPortal === selected.id ? 'Opening…' : `Open ${selected.fullName.split(' ')[0]}'s portal`}
								</button>
								<span class="ess-help">Apply leave, check attendance or update their details as them.</span>
								{#if portalError}<span class="ess-help danger-text">{portalError}</span>{/if}
							{/if}
						</div>
					{/if}

					{#if selected.canEditSettings}
						<button type="button" class="ess-btn ess-btn--outline wide" onclick={() => (editingPerson = selected)}>
							<Settings size={16} /> Edit settings
						</button>
					{/if}

					<div class="today-card">
						<div class="today-head">
							<span class="label"><CalendarDays size={15} /> Today</span>
							<span class="ess-badge ess-badge--{BADGE[selected.status]}">{statusLabel[selected.status]}</span>
						</div>
						<p>
							{#if selected.status === 'present'}Checked in and at work.{:else if selected.status === 'left'}Checked out for the day.{:else}No check-in recorded today.{/if}
						</p>
					</div>

					{#if selected.temporaryPassword}
						<div class="ess-notice">
							<span class="ess-notice__icon"><Mail size={14} /></span>
							<div class="ess-notice__body">
								<strong>Hasn't signed in yet</strong>
								Temporary password <code class="code">{selected.temporaryPassword}</code>
							</div>
							<button type="button" class="ess-btn ess-btn--sm ess-btn--ghost" onclick={() => copyTemporaryPassword(selected!.id, selected!.temporaryPassword!)}>
								{copiedPasswordFor === selected.id ? 'Copied' : 'Copy'}
							</button>
						</div>
					{/if}

					{#if data.canDeletePeople && selected.id !== data.currentUserId}
						<div class="btn-row">
							{#if !selected.noLogin}
								<button type="button" class="ess-btn ess-btn--secondary" onclick={() => openReset(selected!)}><KeyRound size={15} /> Reset password</button>
							{/if}
							{#if confirmingDelete === selected.id}
								<button type="button" class="ess-btn ess-btn--danger" onclick={() => deleteEmployee(selected!.id)} disabled={deletingId === selected.id}>
									{deletingId === selected.id ? 'Deleting…' : 'Confirm delete'}
								</button>
								<button type="button" class="ess-btn ess-btn--ghost" onclick={() => (confirmingDelete = null)}>Cancel</button>
							{:else}
								<button type="button" class="ess-btn ess-btn--ghost danger-text" onclick={() => (confirmingDelete = selected!.id)}><Trash2 size={15} /> Delete</button>
							{/if}
						</div>
					{/if}
				</div>
			{:else}
				<div class="ess-card placeholder">
					<span class="ess-tile ess-tile--lg"><Users size={24} strokeWidth={1.5} /></span>
					<strong>Select a person</strong>
					<p class="ess-caption">Their reporting line, shift, week off and today's status show here.</p>
				</div>
			{/if}
		</aside>
	</div>
{/if}

<!-- ============================== WEEK OFF ============================== -->
{#if view === 'weekoff'}
	{#if rosterError}
		<p class="ess-alert ess-alert--danger">{rosterError}</p>
	{/if}

	<div class="ess-split weekoff-split ess-fill">
		<div class="ess-stack">
			<section class="ess-card ess-fill-card grid-card">
				<div class="ess-card-head">
					<div>
						<h2 class="ess-h2">Team weekly roster</h2>
						<p class="ess-caption">{gridRows.length} {gridRows.length === 1 ? 'person' : 'people'}<span class="ess-dot-sep"></span>{weekRange}</p>
					</div>
					<select class="ess-select grid-filter" bind:value={gridFilter} aria-label="Show people on">
						<option value="">All rosters</option>
						<option value="default">Saturday + Sunday (default)</option>
						{#each data.weekOffRosters as r (r.id)}
							<option value={r.id}>{r.name}</option>
						{/each}
					</select>
				</div>
				<div class="table-wrap ess-scroll">
					<table class="ess-table grid">
						<thead>
							<tr>
								<th>Employee</th>
								{#each weekDays as d (d.key)}
									<th class="day-head"><span>{d.label}</span><small>{d.day} {d.month}</small></th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each gridRows as person (person.id)}
								<tr>
									<td>
										<span class="name-cell">
											<Avatar userId={person.id} fullName={person.fullName} hasPicture={person.hasPicture} size="md" />
											<span class="name-text">
												<strong>{person.fullName}</strong>
												<small>{person.weekOffName ?? 'Sat + Sun'}</small>
											</span>
										</span>
									</td>
									{#each weekDays as d (d.key)}
										{@const off = offOn(person, d.key).includes(d.weekday)}
										<td class="day-cell"><span class="mark" class:off>{off ? 'Off' : 'Work'}</span></td>
									{/each}
								</tr>
							{:else}
								<tr><td colspan="8"><div class="ess-empty">Nobody is on this roster.</div></td></tr>
							{/each}
						</tbody>
					</table>
				</div>
				<div class="legend">
					<span><i class="mark-dot"></i> Work day</span>
					<span><i class="mark-dot off"></i> Week off</span>
				</div>
			</section>

			<section class="ess-card ess-fill-card templates-card">
				<div class="ess-card-head">
					<div>
						<h2 class="ess-h2">Schedule templates</h2>
						<p class="ess-caption">
							{#if data.canAuthorRosters}
								Save a week-off pattern once, then publish it so team managers can apply it from a person's settings.
							{:else}
								Patterns published by the Super Admin. Apply one from a person's settings on the People tab; their leave calendar updates immediately.
							{/if}
						</p>
					</div>
					{#if data.canAuthorRosters}
						<button
							class="ess-btn ess-btn--primary"
							onclick={() => {
								if (showRosterEditor) resetRosterForm();
								showRosterEditor = !showRosterEditor;
							}}
						>
							<Plus size={17} />
							{showRosterEditor ? 'Close editor' : 'New roster'}
						</button>
					{/if}
				</div>
				{#if data.weekOffRosters.length > 0}
					<div class="templates ess-scroll">
						{#each data.weekOffRosters as roster (roster.id)}
							<div class="template" class:is-editing={editingRosterId === roster.id}>
								<div class="template-main">
									<div class="template-head">
										<strong>{roster.name}</strong>
										<span class="ess-badge ess-badge--{roster.status === 'published' ? 'approved' : 'pending'}">{roster.status === 'published' ? 'Published' : 'Draft'}</span>
										<span class="ess-badge">{roster.teamId ? (data.allTeams.find((t) => t.id === roster.teamId)?.name ?? 'Team-specific') : 'All teams'}</span>
									</div>
									<span class="template-summary">{roster.summary}</span>
									{#if roster.pattern === 'rotational'}
										<span class="template-sub">{roster.weeks.join(' · ')}</span>
									{/if}
									{#if roster.description}
										<span class="template-sub">{roster.description}</span>
									{/if}
								</div>
								{#if data.canAuthorRosters}
									<div class="template-actions">
										<button type="button" class="ess-btn ess-btn--sm ess-btn--secondary" onclick={() => editRoster(roster)}>Edit</button>
										<button type="button" class="ess-btn ess-btn--sm ess-btn--ghost" onclick={() => togglePublish(roster)}>
											{roster.status === 'published' ? 'Unpublish' : 'Publish'}
										</button>
										<button type="button" class="ess-icon-btn danger" onclick={() => deleteRoster(roster)} aria-label="Delete {roster.name}" title="Delete {roster.name}">
											<Trash2 size={15} />
										</button>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{:else}
					<div class="ess-empty">
						<span class="ess-empty__icon"><CalendarDays size={22} /></span>
						<span class="ess-empty__title">No rosters yet</span>
						<span>{data.canAuthorRosters ? 'Everyone is on the default Saturday + Sunday.' : 'No published rosters yet. Everyone on your team is on the default Saturday + Sunday.'}</span>
					</div>
				{/if}
			</section>
		</div>

		<aside class="ess-stack side">
			{#if data.canAuthorRosters && showRosterEditor}
				<div class="ess-card editor">
					<div class="ess-card-head">
						<div>
							<h2 class="ess-h2">{editingRosterId ? 'Edit roster' : 'New roster'}</h2>
							<p class="ess-caption">Define the week-off schedule, then assign it from each person's settings.</p>
						</div>
					</div>
					<label class="ess-field">
						<span class="ess-label">Name <span class="req">*</span></span>
						<input class="ess-input" bind:value={rosterName} placeholder="e.g. Standard Sunday off" />
					</label>
					<label class="ess-field">
						<span class="ess-label">Description</span>
						<input class="ess-input" bind:value={rosterDescription} placeholder="Who this is for" />
					</label>
					<label class="ess-field">
						<span class="ess-label">Applies to</span>
						<select class="ess-select" bind:value={rosterTeamId}>
							<option value="">All teams</option>
							{#each data.allTeams as team (team.id)}
								<option value={team.id}>{team.name}</option>
							{/each}
						</select>
					</label>
					<label class="ess-field">
						<span class="ess-label">Cycle <span class="req">*</span></span>
						<select class="ess-select" bind:value={rosterPattern}>
							<option value="fixed">Same every week</option>
							<option value="rotational">Rotation over several weeks</option>
						</select>
					</label>

					{#if rosterPattern === 'fixed'}
						<div class="ess-field">
							<span class="ess-label">Days off every week</span>
							<div class="day-picker">
								{#each WEEKDAY_LABELS as label, day (label)}
									<button type="button" class="day-chip" class:selected={rosterWeekdays.includes(day)} onclick={() => toggleFixedDay(day)} aria-pressed={rosterWeekdays.includes(day)}>
										{label}
									</button>
								{/each}
							</div>
						</div>
					{:else}
						<label class="ess-field">
							<span class="ess-label">Effective from (week 1 starts)</span>
							<input class="ess-input" type="date" bind:value={rosterAnchor} />
							<span class="ess-help">The rotation counts from this date onwards.</span>
						</label>
						<div class="ess-field">
							<span class="ess-label">Rotation ({rotationWeeks.length} weeks, then repeats)</span>
							{#each rotationWeeks as week, i (i)}
								<div class="rotation-row">
									<span class="rotation-label">Week {i + 1}</span>
									<div class="day-picker">
										{#each WEEKDAY_LABELS as label, day (label)}
											<button type="button" class="day-chip" class:selected={week.includes(day)} onclick={() => toggleRotationDay(i, day)} aria-pressed={week.includes(day)}>
												{label}
											</button>
										{/each}
									</div>
									{#if rotationWeeks.length > 2}
										<button type="button" class="ess-icon-btn danger" onclick={() => removeRotationWeek(i)} aria-label="Remove week {i + 1}">
											<Trash2 size={14} />
										</button>
									{/if}
								</div>
							{/each}
							<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm add-week" onclick={addRotationWeek}><Plus size={14} /> Add week</button>
						</div>
					{/if}

					{#if editingRosterId}
						{@const n = data.roster.filter((p) => p.weekOffRosterId === editingRosterId).length}
						<div class="assigned">
							<span class="ess-label">Assigned people</span>
							<span class="assigned-row"><Users size={16} /> {n} {n === 1 ? 'person' : 'people'} on this roster</span>
						</div>
					{/if}

					<div class="btn-row end">
						<button type="button" class="ess-btn ess-btn--secondary" onclick={() => { resetRosterForm(); showRosterEditor = false; }}>Cancel</button>
						<button type="button" class="ess-btn ess-btn--primary" onclick={saveRoster} disabled={rosterSaving}>
							{rosterSaving ? 'Saving…' : editingRosterId ? 'Save changes' : 'Save roster'}
						</button>
					</div>
				</div>
			{:else}
				<div class="ess-card placeholder">
					<span class="ess-tile ess-tile--lg"><CalendarDays size={24} strokeWidth={1.5} /></span>
					<strong>{data.canAuthorRosters ? 'Author a roster' : 'Week-off rosters'}</strong>
					<p class="ess-caption">
						{#if data.canAuthorRosters}
							Create a pattern here, publish it, then assign it to people from their settings on the People tab.
						{:else}
							Assign a published roster to anyone on your team from their settings on the People tab.
						{/if}
					</p>
					{#if data.canAuthorRosters}
						<button class="ess-btn ess-btn--primary" onclick={() => (showRosterEditor = true)}><Plus size={16} /> New roster</button>
					{/if}
				</div>
				<div class="ess-card legend-card">
					<strong class="ess-h3">Legend</strong>
					<div class="legend col">
						<span><i class="mark-dot"></i> Work day</span>
						<span><i class="mark-dot off"></i> Week off, from the person's roster</span>
					</div>
					<p class="ess-caption">Anyone without a roster is on Saturday + Sunday.</p>
				</div>
			{/if}
		</aside>
	</div>
{/if}

<!-- ============================== BULK IMPORT ============================== -->
{#if view === 'bulk' && data.canBulkImport}
	<ol class="ess-stepper ess-stepper--center bulk-steps">
		{#each ['Upload', 'Review', 'Create logins'] as label, i (label)}
			<li class="ess-step" data-state={i < bulkStep ? 'done' : i === bulkStep ? 'current' : 'todo'}>
				<span class="ess-step__dot">{#if i < bulkStep}✓{/if}</span>
				<span class="ess-step__label">{i + 1}. {label}</span>
				<span class="ess-step__meta">{bulkStepHints[i]}</span>
			</li>
		{/each}
	</ol>

	<div class="ess-split bulk-split">
		<div class="ess-stack">
			<section class="ess-card">
				<div class="ess-card-head">
					<div>
						<h2 class="ess-h2">Import preview</h2>
						<p class="ess-caption">Upload any HR spreadsheet — the sheet and columns are detected automatically. Each new login gets its own temporary password and must be changed on first sign-in.</p>
					</div>
					{#if showBulkImport}
						<button class="ess-btn ess-btn--secondary" onclick={() => (showBulkImport = false)}>
							<X size={16} /> Close
						</button>
					{:else if replaceable}
						<div class="upload-actions">
							<button class="ess-btn ess-btn--secondary" onclick={() => openUpload(true)}>
								<UploadCloud size={16} /> Replace file
							</button>
							<button class="ess-btn ess-btn--ghost" onclick={() => openUpload(false)}>
								<Plus size={16} /> Upload another
							</button>
						</div>
					{:else}
						<button class="ess-btn ess-btn--secondary" onclick={() => openUpload(false)}>
							<UploadCloud size={16} /> Upload spreadsheet
						</button>
					{/if}
				</div>

				{#if showBulkImport}
					<form
						method="POST"
						action="?/uploadBulkImport"
						enctype="multipart/form-data"
						use:enhance={() => {
							uploadingBulk = true;
							return async ({ result, update }) => {
								uploadingBulk = false;
								await update({ reset: false });
								if (result.type === 'success' && result.data?.bulkImportUploaded) {
									await invalidateAll();
									await loadReview(result.data.bulkImportUploaded as string);
								}
							};
						}}
						class="upload-form"
					>
						{#if replacing && reviewImport}
							<input type="hidden" name="replaceImportId" value={reviewImport.id} />
							<p class="ess-caption grow">Replaces <strong>{reviewImport.filename}</strong>, which is removed from review once the new file is read.</p>
						{/if}
						<label class="ess-field grow">
							<span class="ess-label">Spreadsheet (.xlsx)</span>
							<input class="ess-input" type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange={onBulkFileChange} required />
						</label>
						<button type="submit" class="ess-btn ess-btn--primary" disabled={uploadingBulk}>
							{uploadingBulk ? 'Parsing…' : 'Upload & review'}
						</button>
					</form>
				{/if}

				{#if form?.bulkImportError}
					<p class="ess-alert ess-alert--danger">{form.bulkImportError}</p>
				{/if}
				{#if form?.bulkImportSheet}
					<p class="ess-alert ess-alert--info">
						Read sheet <strong>"{form.bulkImportSheet}"</strong>
						{#if form.bulkImportStrategy === 'ai-mapped'}
							— columns were matched automatically, so check the rows below carefully.
						{:else}
							using known column names.
						{/if}
						{#if form.bulkImportNote}<br /><em>{form.bulkImportNote}</em>{/if}
					</p>
				{/if}
				{#if form?.bulkImportApplied}
					<div class="ess-notice ess-notice--success">
						<span class="ess-notice__icon"><Users size={14} /></span>
						<div class="ess-notice__body">
							<strong>Created {form.bulkImportApplied.createdCount} login(s). {form.bulkImportApplied.skippedCount} already existed and were left untouched.</strong>
							{form.bulkImportApplied.queuedCount ?? 0} login email(s) are waiting for an admin to approve them{data.canApproveLogins ? ' in Login delivery' : ''}. Nothing has been emailed yet.
							{#if form.bulkImportApplied.redirectedTo}
								<br />Once approved, they go to <strong>{form.bulkImportApplied.redirectedTo}</strong>, not to the employees.
							{/if}
						</div>
					</div>
					<!--
						The accounts exist regardless of whether the mail went out, so a failed
						send is not an error state for the import — but each of these people is
						someone who cannot log in until HR passes their password on by hand.
						The password is shown here because this is the only moment it exists in
						plaintext; once this screen is left, only its hash remains.
					-->
					{#if !form.bulkImportApplied.mailerConfigured}
						<p class="ess-alert ess-alert--warning">No Resend API key is configured, so approved emails will wait until one is. Set <code>RESEND_API_KEY</code>, or pass these logins on manually.</p>
					{/if}
					{#if form.bulkImportApplied.emailFailures.length > 0}
						<div class="ess-alert ess-alert--warning col">
							<p>Could not email {form.bulkImportApplied.emailFailures.length} login(s) — copy these down now and pass them on directly. They are not recoverable after you leave this screen; re-issue the batch if you lose them.</p>
							<ul class="fail-list">
								{#each form.bulkImportApplied.emailFailures as failure (failure.email)}
									<li><strong>{failure.email}</strong>{#if failure.temporaryPassword} — <code class="code">{failure.temporaryPassword}</code>{/if}<span class="fail-reason">{failure.error}</span></li>
								{/each}
							</ul>
						</div>
					{/if}
				{/if}

				{#if form?.bulkImportReissued}
					<div class="ess-notice ess-notice--success">
						<span class="ess-notice__icon"><Mail size={14} /></span>
						<div class="ess-notice__body">
							<strong>Re-issued {form.bulkImportReissued.reissuedCount} login(s) with a fresh temporary password.</strong>
							{form.bulkImportReissued.queuedCount ?? 0} login email(s) are waiting for an admin to approve them. Nothing has been emailed yet.
							{#if form.bulkImportReissued.redirectedTo}
								<br />Once approved, they go to <strong>{form.bulkImportReissued.redirectedTo}</strong>, not to the employees.
							{/if}
							{#if form.bulkImportReissued.alreadyOnboardedCount > 0}
								<br />{form.bulkImportReissued.alreadyOnboardedCount} had already signed in and set their own password — those were left alone.
							{/if}
							{#if form.bulkImportReissued.inactiveCount > 0}
								<br />{form.bulkImportReissued.inactiveCount} deactivated account(s) skipped.
							{/if}
						</div>
					</div>
					{#if !form.bulkImportReissued.mailerConfigured}
						<p class="ess-alert ess-alert--warning">No Resend API key is configured, so approved emails will wait until one is. Set <code>RESEND_API_KEY</code>, or pass these logins on manually.</p>
					{/if}
					{#if form.bulkImportReissued.emailFailures.length > 0}
						<div class="ess-alert ess-alert--warning col">
							<p>{form.bulkImportReissued.emailFailures.length} of them have no usable email address, so nothing was queued for them — copy these down now and pass them on directly:</p>
							<ul class="fail-list">
								{#each form.bulkImportReissued.emailFailures as failure (failure.email)}
									<li><strong>{failure.email}</strong>{#if failure.temporaryPassword} — <code class="code">{failure.temporaryPassword}</code>{/if}<span class="fail-reason">{failure.error}</span></li>
								{/each}
							</ul>
						</div>
					{/if}
				{/if}

				{#if data.bulkImports.length > 0}
					<div class="imports">
						{#each data.bulkImports as imp (imp.id)}
							<button type="button" class="import-row" class:is-selected={selectedImportId === imp.id} onclick={() => loadReview(imp.id)}>
								<span class="ess-tile ess-tile--sm ess-tile--ok"><FileSpreadsheet size={17} /></span>
								<span class="import-main">
									<strong>{imp.filename}</strong>
									<small>{imp.rowCount} row(s)<span class="ess-dot-sep"></span>{whenLong(imp.createdAt)}</small>
								</span>
								<span class="ess-badge ess-badge--{imp.status === 'applied' ? 'approved' : 'pending'}">{imp.status === 'applied' ? 'Applied' : 'Pending review'}</span>
								<ChevronRight size={16} class="chev" />
							</button>
						{/each}
					</div>
				{/if}

				{#if loadingReview}
					<div class="ess-skeleton" style="width: 60%"></div>
				{/if}

				{#if reviewImport}
					{@const locked = reviewImport.status === 'applied'}
					<div class="review-block">
						{#if needsReviewCount > 0 && !locked}
							<div class="ess-notice">
								<span class="ess-notice__icon">!</span>
								<div class="ess-notice__body">
									<strong>{needsReviewCount} row(s) need a decision before applying</strong>
									A reporting-line manager couldn't be confidently matched, the name closely matches an existing account under a different email, the sheet's email column doesn't hold a usable login id, or there is no work email and someone has to say whether the person is blue collar. Each row says which below.
								</div>
							</div>
						{/if}
						{#if awaitingBlueCollar.length > 0 && !locked}
							<div class="ess-notice">
								<span class="ess-notice__icon"><HardHat size={14} /></span>
								<div class="ess-notice__body">
									<strong>{awaitingBlueCollar.length} {awaitingBlueCollar.length === 1 ? 'person has' : 'people have'} no work email. Are they blue collar?</strong>
									Blue-collar workers get no login. Their reporting manager, or an admin, opens their portal for them. Each needs a manager who can sign in; pick one on the row, or type a work email instead.
								</div>
								<button type="button" class="ess-btn ess-btn--sm ess-btn--secondary" onclick={confirmAllBlueCollar} disabled={confirmingAll || !awaitingBlueCollar.some((r) => r.reportsToRowId)}>
									{confirmingAll ? 'Confirming…' : `Yes, all ${awaitingBlueCollar.filter((r) => r.reportsToRowId).length} with a manager`}
								</button>
							</div>
						{/if}

						<div class="table-wrap">
							<table class="ess-table review">
								<thead>
									<tr>
										<th>Name</th>
										<th>Employee code</th>
										<th>Work email</th>
										<th>Role</th>
										<th>Reports to</th>
										<th>Validation</th>
									</tr>
								</thead>
								<tbody>
									{#each displayRows as row (row.id)}
										<tr class:attention={row.status === 'needs_review'}>
											<td><strong>{row.fullName}</strong></td>
											<td class="code-cell">{row.employeeCode ?? '—'}</td>
											<td>
												{#if locked || row.status === 'skipped_existing'}
													{#if isNoLoginEmail(row.officialEmail)}<span class="no-login">No login</span>{:else}{row.officialEmail}{/if}
												{:else if isNoLoginEmail(row.officialEmail)}
													<!-- No work email in the sheet: added without a login unless one is typed here. -->
													<input class="ess-input" type="email" value="" placeholder="No login — add a work email to give one" onblur={(e) => onEmailBlur(row.id, e)} disabled={savingRowId === row.id} />
												{:else}
													<input class="ess-input" type="email" value={row.officialEmail} onblur={(e) => onEmailBlur(row.id, e)} disabled={savingRowId === row.id} />
												{/if}
											</td>
											<td>
												{#if locked || row.status === 'skipped_existing'}
													{row.role.replace('_', ' ')}
												{:else}
													<select class="ess-select" value={row.role} onchange={(e) => onRoleChange(row.id, e)} disabled={savingRowId === row.id}>
														{#each ROLES as r (r)}
															<option value={r}>{r.replace('_', ' ')}</option>
														{/each}
													</select>
												{/if}
											</td>
											<td>
												{#if locked || row.status === 'skipped_existing'}
													{managerName(row)}
												{:else}
													<select class="ess-select" value={row.reportsToRowId ?? (topOfRow(row) ? topPick(topOfRow(row)) : '')} onchange={(e) => onManagerChange(row.id, e)} disabled={savingRowId === row.id}>
														<option value="">— none —</option>
														<option value={CHIEF_PICK}>Chief</option>
														<option value={MAM_PICK}>Mam</option>
														{#each reviewRows.filter((r) => r.id !== row.id) as candidate (candidate.id)}
															<option value={candidate.id}>{candidate.fullName}</option>
														{/each}
													</select>
													{#if row.reportingAuthorityRaw}
														<span class="raw-hint">sheet said: "{row.reportingAuthorityRaw}"</span>
													{/if}
												{/if}
											</td>
											<td>
												<span class="ess-badge ess-badge--{row.status === 'needs_review' ? 'pending' : row.status === 'skipped_existing' ? 'cancelled' : 'approved'}">
													{row.status === 'needs_review' ? 'Needs attention' : row.status === 'skipped_existing' ? 'Already exists' : row.status === 'created' ? 'Created' : 'Valid'}
												</span>
											</td>
										</tr>
										<!--
											What the parser noticed about this row. Shown on every row that has
											notes, not just flagged ones — "the email column is not an email" has
											to be readable here or the flag is a dead end.
										-->
										{#if rowErrors[row.id] || (row.repairNotes && row.repairNotes.length > 0 && row.status !== 'skipped_existing')}
											<tr class="notes-row">
												<td colspan="6">
													<ul class="row-notes">
														{#if rowErrors[row.id]}
															<li class="row-note-error">{rowErrors[row.id]}</li>
														{/if}
														{#each row.repairNotes ?? [] as note (note)}
															{#if row.status !== 'skipped_existing'}
																<li>{note}</li>
															{/if}
														{/each}
													</ul>
												</td>
											</tr>
										{/if}
										{#if !locked && isNoLoginEmail(row.officialEmail) && (row.status === 'needs_review' || row.status === 'ready') && !row.existingUser}
											<tr class="notes-row">
												<td colspan="6">
													<div class="duplicate-banner">
														{#if row.blueCollar}
															<span><strong>Blue collar</strong>: no login. {managerName(row)} opens their portal for them.</span>
															<button type="button" class="ess-btn ess-btn--sm ess-btn--ghost" onclick={() => patchRow(row.id, { blueCollar: false })} disabled={savingRowId === row.id}>Undo</button>
														{:else}
															<span>
																No work email. Is "{row.fullName}" blue collar?
																{#if !row.reportsToRowId}Pick their reporting manager first.{/if}
															</span>
															<div class="btn-row">
																<button type="button" class="ess-btn ess-btn--sm ess-btn--secondary" onclick={() => patchRow(row.id, { blueCollar: true })} disabled={savingRowId === row.id || !row.reportsToRowId}>Yes, blue collar</button>
															</div>
														{/if}
													</div>
												</td>
											</tr>
										{/if}
										{#if row.status === 'needs_review' && row.existingUser}
											<tr class="notes-row">
												<td colspan="6">
													<div class="duplicate-banner">
														<span>
															"{row.fullName}" closely matches an existing account: <strong>{row.existingUser.fullName}</strong> ({row.existingUser.email}). Same person?
														</span>
														<div class="btn-row">
															<button type="button" class="ess-btn ess-btn--sm ess-btn--secondary" onclick={() => resolveDuplicate(row.id, 'link')} disabled={savingRowId === row.id}>Yes, same person — skip</button>
															<button type="button" class="ess-btn ess-btn--sm ess-btn--ghost" onclick={() => resolveDuplicate(row.id, 'create_new')} disabled={savingRowId === row.id}>No, create as new</button>
														</div>
													</div>
												</td>
											</tr>
										{/if}
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{:else if !loadingReview && data.bulkImports.length === 0 && !showBulkImport}
					<div class="ess-empty">
						<span class="ess-empty__icon"><FileSpreadsheet size={22} /></span>
						<span class="ess-empty__title">No imports yet</span>
						<span>Upload the HR spreadsheet to create logins in bulk.</span>
					</div>
				{/if}
			</section>
		</div>

		<aside class="ess-stack side">
			<div class="ess-card">
				<h2 class="ess-h2 card-title">Import summary</h2>
				{#if reviewImport}
					{@const locked = reviewImport.status === 'applied'}
					<dl class="summary">
						<div><dt>File</dt><dd class="file">{reviewImport.filename}</dd></div>
						<div><dt>Total rows</dt><dd>{reviewRows.length}</dd></div>
						{#if locked}
							<div><dt>Logins created</dt><dd class="ok">{createdCount}</dd></div>
							<div><dt>Already existed</dt><dd>{reviewRows.filter((r) => r.status === 'skipped_existing').length}</dd></div>
						{:else}
							<div><dt>Ready to create logins</dt><dd class="ok">{readyCount}</dd></div>
							<div><dt>Need attention</dt><dd class:warn={needsReviewCount > 0}>{needsReviewCount}</dd></div>
							<div><dt>Already exist</dt><dd>{reviewRows.filter((r) => r.status === 'skipped_existing').length}</dd></div>
						{/if}
					</dl>
					{#if !locked && needsReviewCount > 0}
						<div class="ess-notice">
							<span class="ess-notice__icon">!</span>
							<div class="ess-notice__body">
								<strong>{needsReviewCount} row(s) need attention</strong>
								Fix the flagged rows in the preview before the logins can be created.
							</div>
						</div>
					{/if}
					{#if !locked}
						<form
							method="POST"
							action="?/applyBulkImport"
							class="apply-form"
							use:enhance={() => {
								applyingBulk = true;
								return async ({ update }) => {
									applyingBulk = false;
									await update();
									await invalidateAll();
									if (selectedImportId) await loadReview(selectedImportId);
								};
							}}
						>
							<input type="hidden" name="importId" value={reviewImport.id} />
							<!--
								Dry-run escape hatch: sends every credentials mail for this batch to one
								reviewer instead of to the employees, for checking the template and the
								Resend setup against a real inbox. The accounts are still created.
							-->
							<label class="ess-field">
								<span class="ess-label">Send all login emails to (optional)</span>
								<input class="ess-input" type="email" name="sendCredentialsTo" placeholder="A test inbox instead of the employees" />
							</label>
							<button type="submit" class="ess-btn ess-btn--primary wide" disabled={applyingBulk || needsReviewCount > 0 || readyCount === 0}>
								<Users size={17} />
								{applyingBulk ? 'Creating logins…' : `Create ${readyCount} login(s)`}
							</button>
							<p class="ess-help center">This creates the accounts and queues their login emails for approval.</p>
						</form>
					{:else}
						<!--
							Applied imports keep this: the credentials mail is the only copy of a
							temporary password ever made, so a batch whose mail didn't land leaves
							people holding a password that does not work. This mints a new one per
							account and queues it again.
						-->
						<form
							method="POST"
							action="?/resendBulkImportLogins"
							class="apply-form"
							use:enhance={() => {
								reissuingBulk = true;
								return async ({ update }) => {
									reissuingBulk = false;
									await update();
									await invalidateAll();
									if (selectedImportId) await loadReview(selectedImportId);
								};
							}}
						>
							<input type="hidden" name="importId" value={reviewImport.id} />
							<label class="ess-field">
								<span class="ess-label">Send all login emails to (optional)</span>
								<input class="ess-input" type="email" name="sendCredentialsTo" placeholder="A test inbox instead of the employees" />
							</label>
							<button type="submit" class="ess-btn ess-btn--secondary wide" disabled={reissuingBulk || createdCount === 0} title="Gives every account this import created a new temporary password and queues its email again. Anyone who has already set their own password is left alone.">
								<Mail size={16} />
								{reissuingBulk ? 'Re-issuing logins…' : `Re-issue & email ${createdCount} login(s)`}
							</button>
						</form>
					{/if}
				{:else}
					<p class="ess-caption">Upload a spreadsheet, or pick an earlier import, to see what it will create.</p>
				{/if}
			</div>

			{#if data.canApproveLogins}
				<div class="ess-card">
					<h2 class="ess-h2 card-title">Login email queue</h2>
					<div class="queue-hint">
						<span class="ess-tile"><Mail size={20} strokeWidth={1.75} /></span>
						<div>
							<strong>{data.pendingLoginEmails ? 'Pending review' : 'Nothing waiting'}</strong>
							<p class="ess-caption">
								{#if data.pendingLoginEmails}
									{data.pendingLoginEmails} login email(s) wait for approval before anything is sent.
								{:else}
									New logins' emails appear here for approval; they go out one at a time once approved.
								{/if}
							</p>
						</div>
					</div>
					<div class="queue-figure">
						<div><div class="ess-figure__value">{data.pendingLoginEmails}</div><div class="ess-figure__label">emails queued</div></div>
						<button type="button" class="ess-link" onclick={() => setView('logins')}>Review delivery <ChevronRight size={14} /></button>
					</div>
					<div class="next-steps">
						<strong>What happens next?</strong>
						<ol>
							<li><span>1</span> Accounts are created for the ready rows.</li>
							<li><span>2</span> An admin approves their login emails in Login delivery.</li>
							<li><span>3</span> People sign in and set their own password.</li>
						</ol>
					</div>
				</div>
			{/if}
		</aside>
	</div>
{/if}

<!-- ============================== LOGIN DELIVERY ============================== -->
{#if view === 'logins' && data.canApproveLogins}
	<LoginEmailQueue />
{/if}

<!-- ============================== PASSWORD ACTIVITY ============================== -->
{#if view === 'passwords' && data.canSeePasswordActivity}
	<div class="pw-figures">
		<div class="ess-metric">
			<span class="ess-tile"><ShieldCheck size={20} strokeWidth={1.75} /></span>
			<div class="ess-metric__body">
				<span class="ess-metric__value">{pwThisWeek}</span>
				<span class="ess-metric__label">{pwThisWeek === 1 ? 'change' : 'changes'} this week</span>
			</div>
		</div>
		<div class="ess-metric">
			<span class="ess-tile ess-tile--warn"><Clock size={20} strokeWidth={1.75} /></span>
			<div class="ess-metric__body">
				<span class="ess-metric__value">{data.passwordActivity.length}</span>
				<span class="ess-metric__label">events recorded</span>
			</div>
		</div>
	</div>

	<div class="ess-card toolbar-card">
		<label class="ess-search grow">
			<Search size={17} />
			<input class="ess-input" placeholder="Search by name or email…" bind:value={pwSearch} aria-label="Search password activity" />
		</label>
		<label class="ess-field inline">
			<span class="ess-label">Action type</span>
			<select class="ess-select" bind:value={pwAction}>
				<option value="">All actions</option>
				{#each pwActions as a (a)}
					<option value={a}>{a}</option>
				{/each}
			</select>
		</label>
		{#if pwSearch || pwAction}
			<button type="button" class="ess-btn ess-btn--ghost" onclick={() => { pwSearch = ''; pwAction = ''; }}>Reset filters</button>
		{/if}
	</div>

	<div class="ess-split pw-split">
		<section class="ess-card">
			<div class="ess-card-head">
				<div>
					<h2 class="ess-h2">Password activity</h2>
					<p class="ess-caption">
						Who changed or reset whose password, and when. A password someone has chosen for themselves is never stored or shown — it is one-way hashed and cannot be recovered by anyone, including a Super Admin.
					</p>
				</div>
				<span class="ess-caption nowrap">{pwRows.length} of {data.passwordActivity.length}</span>
			</div>
			<div class="table-wrap">
				<table class="ess-table">
					<thead>
						<tr>
							<th>Employee</th>
							<th>Action</th>
							<th>Performed by</th>
							<th>Date</th>
						</tr>
					</thead>
					<tbody>
						{#each pwRows as entry (entry.i)}
							<tr class="person-row" class:is-selected={pwSelected === entry.i} onclick={() => (pwSelected = entry.i)}>
								<td>
									<strong>{entry.targetName ?? entry.targetEmail ?? '—'}</strong>
									{#if entry.targetName && entry.targetEmail}<small class="sub">{entry.targetEmail}</small>{/if}
								</td>
								<td><span class="action-cell"><KeyRound size={15} /> {entry.label}</span></td>
								<td class="muted-cell">{entry.actorName ?? 'Unknown'}{#if entry.actorName && entry.actorName === entry.targetName}<small class="sub">Self</small>{/if}</td>
								<td class="muted-cell nowrap">{whenLong(entry.createdAt)}</td>
							</tr>
						{:else}
							<tr><td colspan="4"><div class="ess-empty">{data.passwordActivity.length ? 'Nothing matches these filters.' : 'No password activity recorded yet.'}</div></td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<aside class="ess-stack side">
			{#if pwEvent}
				<div class="ess-card">
					<div class="ess-card-head">
						<h2 class="ess-h2">Event details</h2>
						<button type="button" class="ess-icon-btn" onclick={() => (pwSelected = null)} aria-label="Close"><X size={18} /></button>
					</div>
					<div class="event-who">
						<span class="ess-avatar">{(pwEvent.targetName ?? pwEvent.targetEmail ?? '?').split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}</span>
						<div>
							<strong>{pwEvent.targetName ?? pwEvent.targetEmail ?? '—'}</strong>
							{#if pwEvent.targetEmail}<small class="sub">{pwEvent.targetEmail}</small>{/if}
						</div>
					</div>
					<dl class="ess-kv">
						<dt>Action</dt><dd>{pwEvent.label}</dd>
						<dt>Performed by</dt><dd>{pwEvent.actorName ?? 'Unknown'}{pwEvent.actorName && pwEvent.actorName === pwEvent.targetName ? ' (self)' : ''}</dd>
						<dt>Date &amp; time</dt><dd>{whenLong(pwEvent.createdAt)}</dd>
					</dl>
					<p class="ess-caption">
						{#if pwEvent.actorName && pwEvent.actorName === pwEvent.targetName}
							{pwEvent.actorName} changed their own password.
						{:else}
							{pwEvent.actorName ?? 'Someone'} performed "{pwEvent.label}" for {pwEvent.targetName ?? pwEvent.targetEmail ?? 'an account'}. An unused temporary password stays readable on the directory until that person signs in and sets their own.
						{/if}
					</p>
				</div>
			{:else}
				<div class="ess-card placeholder">
					<span class="ess-tile ess-tile--lg"><ShieldCheck size={24} strokeWidth={1.5} /></span>
					<strong>Select an event</strong>
					<p class="ess-caption">Who did what, and when, shows here.</p>
				</div>
			{/if}
		</aside>
	</div>
{/if}

<style>
	.view-tabs {
		margin-bottom: 12px;
	}

	.figures {
		margin-bottom: 12px;
	}
	.figures .ess-figure {
		gap: 10px;
		padding: 8px 16px;
	}
	.figures .ess-figure__value {
		font-size: 20px;
	}
	.figures .ess-figure__label {
		font-size: 12.5px;
	}
	.figures .ess-tile {
		width: 30px;
		height: 30px;
	}
	.figures .ess-figure__dot {
		width: 10px;
		height: 10px;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	.toolbar-card {
		display: flex;
		align-items: flex-end;
		gap: 12px;
		flex-wrap: wrap;
		padding: 14px 16px;
		margin-bottom: 16px;
	}
	.grow {
		flex: 1;
		min-width: 240px;
	}
	.status-filter {
		width: auto;
		min-width: 170px;
	}
	.ess-field.inline {
		min-width: 200px;
	}
	.ess-field.inline .ess-label {
		font-size: 12.5px;
		color: var(--ess-text-secondary);
	}

	.ess-alert {
		margin-bottom: 12px;
	}
	.ess-alert.notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.ess-alert.col {
		flex-direction: column;
	}
	.ess-alert.small {
		font-size: 13px;
	}
	.ess-notice {
		margin-bottom: 12px;
	}
	.ess-notice__icon {
		font-weight: 700;
	}

	.code {
		font-family: var(--ess-font-mono);
		font-size: 12.5px;
		letter-spacing: 0.02em;
		color: var(--ess-text);
		background: var(--ess-surface);
		border: 1px solid var(--ess-border);
		border-radius: 4px;
		padding: 1px 6px;
		user-select: all;
	}

	/* ---------- tables ---------- */

	/* Bleeds to the card's edges (the card pads by --ess-space-4). Positioned
	   so the visually-hidden "Actions" header is contained by it — otherwise
	   that absolute span sits past the table's right edge and the whole page
	   scrolls sideways on a narrow screen. */
	.table-wrap {
		position: relative;
		margin: 0 calc(-1 * var(--card-px, var(--ess-space-4)));
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}
	.table-wrap .ess-table th,
	.table-wrap .ess-table td {
		padding: 8px 12px;
	}
	.table-wrap .ess-table th:first-child,
	.table-wrap .ess-table td:first-child {
		padding-left: var(--card-px, var(--ess-space-4));
	}
	.table-wrap .ess-table th:last-child,
	.table-wrap .ess-table td:last-child {
		padding-right: var(--card-px, var(--ess-space-4));
	}
	/* The header stays put while a long list scrolls inside the card. */
	.table-wrap .ess-table thead th {
		position: sticky;
		top: 0;
		z-index: 1;
	}
	/* Fits beside the side panel on a laptop: the text columns may wrap and a
	   long email is cut short (the side panel shows it in full); only a
	   narrower screen scrolls the table sideways, inside its card. */
	.roster {
		min-width: 760px;
	}
	.roster .muted-cell,
	.roster .muted-cell .sub {
		white-space: normal;
		min-width: 72px;
	}
	.roster .name-cell {
		max-width: 250px;
	}
	.roster .name-text small {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.person-row {
		cursor: pointer;
	}
	.name-cell {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.name-text {
		display: grid;
		min-width: 0;
		line-height: 1.3;
	}
	.name-text strong {
		font-weight: 500;
		white-space: nowrap;
	}
	.name-text small,
	.sub {
		display: block;
		font-size: 12px;
		color: var(--ess-text-muted);
		white-space: nowrap;
	}
	.muted-cell {
		color: var(--ess-text-secondary);
		white-space: nowrap;
	}
	.nowrap {
		white-space: nowrap;
	}
	.code-cell {
		font-family: var(--ess-font-mono);
		font-size: 12.5px;
		letter-spacing: 0.02em;
	}
	.missing {
		color: var(--ess-warning);
	}
	.chief {
		font-weight: 500;
		color: var(--ess-primary-text);
	}
	.actions-cell {
		text-align: right;
	}
	.row-actions {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 2px;
	}
	.row-actions .ess-btn--secondary {
		margin-right: 6px;
	}
	.ess-icon-btn.danger:hover {
		color: var(--ess-danger);
		background: var(--ess-danger-bg);
	}
	.danger-text {
		color: var(--ess-danger);
	}
	.confirm-delete {
		display: inline-flex;
		gap: 6px;
	}
	.pending-row td {
		padding-top: 0;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.pending-login {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		padding: 6px 12px;
		border-radius: var(--ess-radius-sm);
		background: var(--ess-warning-bg);
		color: var(--ess-warning);
		font-size: 12.5px;
	}
	.action-cell {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.action-cell :global(svg) {
		color: var(--ess-text-muted);
	}

	/* ---------- right panel ---------- */

	.side {
		position: sticky;
		top: 20px;
	}
	.placeholder {
		display: grid;
		justify-items: center;
		align-content: center;
		text-align: center;
		gap: 8px;
		padding: 24px 20px;
	}
	.placeholder strong {
		font-size: 15px;
		font-weight: 600;
	}
	.placeholder p {
		max-width: 30ch;
	}
	.placeholder .ess-btn {
		margin-top: 6px;
	}

	.person-top {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.person-id {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.person-top .ess-icon-btn {
		align-self: flex-start;
	}
	.person-name {
		display: flex;
		align-items: center;
		gap: 6px 8px;
		flex-wrap: wrap;
	}
	/* Side-panel headers keep their close button beside the title. */
	.side .ess-card-head {
		flex-wrap: nowrap;
	}
	.person-name .ess-h2 {
		font-size: 18px;
	}
	/* Two columns of facts keep the panel short enough to sit beside the list. */
	.no-login {
		color: var(--ess-text-secondary);
		font-style: italic;
	}
	.blue-collar-ask {
		border: 0;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 6px;
	}
	.blue-collar-ask .radio {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 14px;
	}
	.no-login-details {
		display: grid;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--ess-border-subtle);
		border-radius: 12px;
	}
	.no-login-details .ess-kv {
		font-size: 13px;
		row-gap: 8px;
	}
	.no-login-details .ess-kv dd {
		overflow-wrap: anywhere;
	}
	.facts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px 12px;
		margin: 10px 0;
		padding: 10px 0;
		border-top: 1px solid var(--ess-border-subtle);
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.facts > div {
		display: flex;
		gap: 8px;
		min-width: 0;
	}
	.facts dt {
		margin: 0;
		color: var(--ess-text-muted);
		padding-top: 2px;
	}
	.facts dd {
		margin: 0;
		display: grid;
		min-width: 0;
		line-height: 1.3;
		font-size: 13.5px;
		overflow-wrap: anywhere;
	}
	.facts dd span {
		font-size: 12px;
		color: var(--ess-text-secondary);
	}
	.facts dd strong {
		font-weight: 500;
	}
	.facts dd small {
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.wide {
		width: 100%;
	}
	.today-card {
		margin-top: 10px;
		padding: 10px 12px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-primary-softer);
	}
	.today-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 4px;
	}
	.today-head .label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
	}
	.today-card p {
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.person-panel .ess-notice {
		margin: 10px 0 0;
	}
	.btn-row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.btn-row.end {
		justify-content: flex-end;
	}

	.create-panel,
	.editor {
		display: grid;
		gap: 10px;
		align-content: start;
	}
	.create-panel .ess-card-head,
	.editor .ess-card-head {
		margin-bottom: 0;
		align-items: flex-start;
	}
	.req {
		color: var(--ess-danger);
	}
	.mono {
		font-family: var(--ess-font-mono);
	}
	.reset-field {
		margin-top: 12px;
	}

	/* ---------- week-off grid ---------- */

	.grid-filter {
		width: auto;
		min-width: 200px;
	}
	.grid {
		min-width: 760px;
	}
	/* Desktop: the People and weekly roster tables fit their card exactly,
	   so neither shows a sideways scrollbar. Narrower screens keep the
	   minimum width and scroll inside the card. */
	@media (min-width: 1101px) {
		.roster,
		.grid {
			min-width: 0;
		}
		.table-wrap .ess-table th:not(:first-child):not(:last-child),
		.table-wrap .ess-table td:not(:first-child):not(:last-child) {
			padding-left: 8px;
			padding-right: 8px;
		}
	}
	.day-head span {
		display: block;
		color: var(--ess-text);
	}
	.day-head small {
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.day-cell {
		text-align: center;
	}
	.mark {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px;
		border-radius: var(--ess-radius-sm);
		background: var(--ess-sunken);
		color: var(--ess-text-secondary);
		font-size: 12.5px;
	}
	.mark::before,
	.mark-dot {
		content: '';
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ess-border-strong);
	}
	.mark.off {
		background: var(--ess-primary-soft);
		color: var(--ess-primary-text);
	}
	.mark.off::before,
	.mark-dot.off {
		background: var(--ess-primary);
	}
	.legend {
		display: flex;
		gap: 20px;
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px solid var(--ess-border-subtle);
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.legend.col {
		flex-direction: column;
		gap: 8px;
		border: none;
		padding: 0;
		margin: 10px 0;
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.legend-card .ess-h3 {
		display: block;
	}

	.templates-card .ess-empty {
		padding: 16px;
	}
	.templates-card .ess-empty__title {
		font-size: 16px;
	}
	.templates {
		display: grid;
		gap: 8px;
		align-content: start;
	}
	.template {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		padding: 10px 12px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
	}
	.template.is-editing {
		border-color: var(--ess-primary);
		background: var(--ess-primary-softer);
	}
	.template-main {
		display: grid;
		gap: 3px;
		min-width: 0;
	}
	.template-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.template-head strong {
		font-weight: 500;
		font-size: 14.5px;
	}
	.template-summary {
		font-size: 13.5px;
		color: var(--ess-text-secondary);
	}
	.template-sub {
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}
	.template-actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.day-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	/* A row of weekday toggles reads faster than a multi-select, and makes the
	   selected pattern legible at a glance while it's being built. */
	.day-chip {
		min-width: 44px;
		padding: 6px 10px;
		border-radius: var(--ess-radius-pill);
		border: 1px solid var(--ess-border);
		background: var(--ess-field-bg);
		color: var(--ess-text-secondary);
		font-size: 12.5px;
		font-weight: 500;
		font-family: inherit;
		cursor: pointer;
		transition:
			background var(--ess-t-fast),
			color var(--ess-t-fast),
			border-color var(--ess-t-fast);
	}
	.day-chip:hover {
		border-color: var(--ess-primary);
	}
	.day-chip.selected {
		background: var(--ess-primary);
		border-color: var(--ess-primary);
		color: var(--ess-text-on-primary);
	}
	.rotation-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 8px;
	}
	.rotation-label {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--ess-text-secondary);
		min-width: 3.6rem;
	}
	.add-week {
		justify-self: start;
		margin-top: 8px;
	}
	.assigned {
		display: grid;
		gap: 6px;
	}
	.assigned-row {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--ess-text-secondary);
		font-size: 13.5px;
	}

	/* ---------- bulk import ---------- */

	.bulk-steps {
		max-width: 760px;
		margin: 4px auto 24px;
	}
	.upload-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.upload-form {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
		padding: 16px;
		margin-bottom: 14px;
		border: 1px dashed var(--ess-border-strong);
		border-radius: var(--ess-radius-md);
		background: var(--ess-sunken);
	}
	.imports {
		display: grid;
		gap: 8px;
		margin-bottom: 14px;
	}
	.import-row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 12px 14px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		background: var(--ess-surface);
		color: var(--ess-text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: border-color var(--ess-t-fast);
	}
	.import-row:hover {
		border-color: var(--ess-border-strong);
	}
	.import-row.is-selected {
		border-color: var(--ess-primary);
		background: var(--ess-primary-softer);
	}
	.import-main {
		flex: 1;
		display: grid;
		min-width: 0;
	}
	.import-main strong {
		font-weight: 500;
	}
	.import-main small {
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}
	.import-row :global(.chev) {
		color: var(--ess-text-muted);
	}
	.review {
		min-width: 900px;
	}
	.review td .ess-input,
	.review td .ess-select {
		min-width: 160px;
		padding: 7px 10px;
	}
	.review td .ess-select {
		padding-right: 30px;
	}
	tr.attention td {
		background: var(--ess-warning-bg);
	}
	.raw-hint {
		display: block;
		font-size: 11.5px;
		color: var(--ess-text-muted);
		margin-top: 4px;
	}
	.notes-row td {
		padding: 0;
	}
	.row-notes {
		margin: 0;
		padding: 8px 20px 10px 40px;
		font-size: 12.5px;
		color: var(--ess-warning);
		background: var(--ess-warning-bg);
	}
	.row-note-error {
		color: var(--ess-danger);
		font-weight: 500;
	}
	.duplicate-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		padding: 10px 20px;
		font-size: 13px;
		background: var(--ess-warning-bg);
		color: var(--ess-text);
	}
	.duplicate-banner .btn-row {
		margin: 0;
	}
	.fail-list {
		margin: 8px 0 0;
		padding-left: 18px;
		font-size: 13px;
		color: var(--ess-text);
	}
	.fail-list li {
		margin-bottom: 4px;
	}
	.fail-reason {
		display: block;
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.card-title {
		margin-bottom: 14px;
	}
	.summary {
		display: grid;
		margin: 0 0 14px;
	}
	.summary > div {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 0;
		border-bottom: 1px solid var(--ess-border-subtle);
		font-size: 14px;
	}
	.summary dt {
		color: var(--ess-text-secondary);
	}
	.summary dd {
		margin: 0;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.summary dd.file {
		font-weight: 500;
		font-family: var(--ess-font-mono);
		font-size: 12.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 60%;
	}
	.summary dd.ok {
		color: var(--ess-success);
	}
	.summary dd.warn {
		color: var(--ess-warning);
	}
	.apply-form {
		display: grid;
		gap: 12px;
	}
	.center {
		text-align: center;
	}
	.queue-hint {
		display: flex;
		gap: 14px;
		align-items: flex-start;
		padding: 14px;
		border-radius: var(--ess-radius-md);
		background: var(--ess-primary-softer);
	}
	.queue-hint strong {
		font-weight: 600;
	}
	.queue-figure {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 0;
		margin: 6px 0;
		border-bottom: 1px solid var(--ess-border-subtle);
	}
	.queue-figure .ess-link {
		background: none;
		border: none;
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
	.next-steps strong {
		display: block;
		font-size: 13.5px;
		margin-bottom: 8px;
	}
	.next-steps ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.next-steps li {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
		color: var(--ess-text-secondary);
	}
	.next-steps li span {
		display: inline-grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: 1px solid var(--ess-primary-soft);
		color: var(--ess-primary-text);
		font-size: 12px;
		font-weight: 600;
		flex: none;
	}

	/* ---------- password activity ---------- */

	.pw-figures {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 260px));
		gap: 14px;
		margin-bottom: 16px;
	}
	.event-who {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}
	.event-who strong {
		font-weight: 500;
	}
	.pw-split .ess-kv {
		padding: 14px 0;
		border-top: 1px solid var(--ess-border-subtle);
		border-bottom: 1px solid var(--ess-border-subtle);
		margin-bottom: 12px;
	}

	/* ---------- fit the screen (desktop) ----------
	   The People and Week-off splits are the page's .ess-fill block: the list
	   cards and the side panel end on the same line at the bottom of the
	   workspace, and a long list scrolls inside its card. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.people-split,
			.weekoff-split {
				grid-template-rows: minmax(0, 1fr);
			}
			/* The side column already fills the height, so it no longer sticks. */
			.side {
				position: static;
				gap: 10px;
			}
			.directory .table-wrap,
			.grid-card .table-wrap {
				margin-bottom: calc(-1 * var(--card-py, var(--ess-space-4)));
			}
			/* Week-off: the roster grid and the templates share the column, each
			   scrolling inside its own card when it is long. */
			.weekoff-split > .ess-stack {
				gap: 10px;
				overflow: hidden;
			}
			.weekoff-split .ess-stack > .grid-card,
			.weekoff-split .ess-stack > .templates-card {
				flex: 1 1 auto;
				min-height: 150px;
			}
			.weekoff-split .templates-card > .ess-empty {
				flex: 1 1 auto;
				justify-content: center;
			}
			.weekoff-split .side > .placeholder {
				flex: 1 0 auto;
			}
			.weekoff-split .side > .legend-card {
				flex: none;
			}
		}
	}
	/* Short laptop screens (1280x580 up to 1366x768): tighter person panel and week-off
	   cards so the roster keeps at least one full row on show. */
	@media (min-width: 1101px) and (min-height: 480px) and (max-height: 800px) {
		@container ess-fill (min-width: 0px) {
			.person-panel {
				padding: 8px 14px 10px;
			}
			.person-top {
				gap: 10px;
			}
			.person-top :global(.avatar--lg) {
				width: 36px;
				height: 36px;
				font-size: 15px;
			}
			.person-name .ess-h2 {
				font-size: 16px;
			}
			.person-top .ess-caption {
				font-size: 12px;
			}
			.facts {
				gap: 3px 10px;
				margin: 5px 0;
				padding: 5px 0;
			}
			.facts dd {
				font-size: 13px;
				line-height: 1.15;
			}
			.facts dd span,
			.facts dd small {
				font-size: 11.5px;
			}
			.person-panel .wide {
				height: 28px;
			}
			.today-card {
				display: flex;
				align-items: center;
				flex-wrap: wrap;
				gap: 2px 10px;
				margin-top: 5px;
				padding: 3px 10px;
			}
			.today-head {
				margin-bottom: 0;
				gap: 8px;
			}
			.today-card p {
				font-size: 12px;
			}
			.person-panel .ess-notice {
				margin-top: 8px;
			}
			.person-panel .btn-row {
				margin-top: 8px;
			}
			.placeholder {
				padding: 14px 16px;
				gap: 6px;
			}
			.placeholder .ess-tile--lg {
				width: 44px;
				height: 44px;
			}
			.placeholder .ess-btn {
				margin-top: 2px;
			}
			.legend.col {
				gap: 6px;
				margin: 6px 0;
			}

			/* week-off */
			.weekoff-split .ess-stack > .grid-card {
				min-height: 192px;
			}
			.weekoff-split .ess-stack > .templates-card {
				min-height: 120px;
			}
			.day-head span {
				display: inline;
			}
			.day-head small {
				margin-left: 4px;
			}
			.grid-card .ess-card-head,
			.templates-card .ess-card-head {
				flex-wrap: nowrap;
				margin-bottom: 6px;
			}
			.templates-card .ess-card-head > .ess-btn {
				flex: none;
			}
			.legend {
				margin-top: 6px;
				padding-top: 6px;
				font-size: 12.5px;
			}
			.templates-card .ess-empty {
				padding: 4px 16px 8px;
				gap: 4px;
				font-size: 12.5px;
			}
			.templates-card .ess-empty__icon {
				width: 36px;
				height: 36px;
				margin-bottom: 0;
			}
			.templates-card .ess-empty__title {
				font-size: 14.5px;
			}
			.editor,
			.create-panel {
				gap: 8px;
			}
		}
	}
	@media (max-width: 1100px) {
		.side {
			position: static;
		}
	}
	@media (max-width: 720px) {
		.table-wrap {
			margin: 0 calc(-1 * var(--ess-space-4));
		}
		.table-wrap .ess-table th:first-child,
		.table-wrap .ess-table td:first-child {
			padding-left: var(--ess-space-4);
		}
		.table-wrap .ess-table th:last-child,
		.table-wrap .ess-table td:last-child {
			padding-right: var(--ess-space-4);
		}
		.view-tabs {
			width: 100%;
		}
		.view-tabs .ess-tab {
			min-width: 0;
			flex: 1;
		}
	}

	/* Short laptop screens (1280x580 up to 1366x768): Bulk import and
	   Password activity fit without their columns scrolling. */
	@media (min-width: 1101px) and (min-height: 480px) and (max-height: 800px) {
		@container ess-fill (min-width: 0px) {
			.bulk-steps {
				margin-bottom: 0;
			}
			.bulk-steps :global(.ess-step) {
				display: flex;
				align-items: center;
				gap: 8px;
			}
			.bulk-steps :global(.ess-step:not(:last-child)::before) {
				display: none;
			}
			.bulk-steps :global(.ess-step__dot) {
				width: 20px;
				height: 20px;
			}
			.bulk-steps :global(.ess-step__label) {
				font-size: 13px;
			}
			.bulk-steps :global(.ess-step__meta) {
				display: none;
			}
			.bulk-split {
				grid-template-columns: minmax(0, 1fr) 420px;
			}
			.bulk-split .ess-card-head {
				flex-wrap: nowrap;
				align-items: flex-start;
			}
			.bulk-split .side {
				gap: 8px;
			}
			.next-steps {
				padding-top: 6px;
			}
			.bulk-split .side .card-title {
				margin-bottom: 4px;
			}
			.queue-hint {
				gap: 8px;
				padding: 8px 10px;
			}
			.queue-figure {
				margin: 2px 0;
			}
			.next-steps strong {
				font-size: 12.5px;
				margin-bottom: 4px;
			}
			.queue-hint :global(.ess-tile) {
				display: none;
			}
			.queue-hint .ess-caption {
				font-size: 12px;
			}
			.queue-figure {
				padding: 4px 0;
				align-items: center;
			}
			.queue-figure > div {
				display: flex;
				align-items: baseline;
				gap: 6px;
			}
			.queue-figure :global(.ess-figure__value) {
				font-size: 18px;
			}
			.next-steps ol {
				gap: 3px;
			}
			.next-steps li {
				font-size: 12px;
			}
			.next-steps li span {
				width: 16px;
				height: 16px;
				font-size: 10px;
			}
		}
	}
</style>
