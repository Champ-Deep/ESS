<script lang="ts">
	import UploadCloud from '@lucide/svelte/icons/upload-cloud';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import FileText from '@lucide/svelte/icons/file-text';
	import FileImage from '@lucide/svelte/icons/file-image';
	import CheckCircle from '@lucide/svelte/icons/check-circle';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Plus from '@lucide/svelte/icons/plus';
	import X from '@lucide/svelte/icons/x';
	import CloudUpload from '@lucide/svelte/icons/cloud-upload';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	type Kind = 'holiday_calendar' | 'leave_policy';

	let kind = $state<Kind>('holiday_calendar');
	let file = $state<File | null>(null);
	let uploading = $state(false);
	let extracting = $state(false);
	let publishing = $state(false);
	let errorMsg = $state('');
	let successMsg = $state('');

	let documentId = $state<string | null>(null);
	let holidayTables = $state<Array<{ shift_group_key: string; shift_group_label: string; holidays: Array<{ date: string; name: string; type: string }> }>>([]);
	let leaveTypesDraft = $state<
		Array<{
			code: string;
			name: string;
			accrual_per_month: number | null;
			eligibility: string | null;
			carry_forward_cap_days: number | null;
			requires_documentation: boolean;
			documentation_note: string | null;
			fixed_days: number | null;
			notes: string | null;
		}>
	>([]);

	let calendarYear = $state(new Date().getFullYear() + 1);
	let effectiveFrom = $state(`${new Date().getFullYear() + 1}-01-01`);

	let archivingId = $state<string | null>(null);

	/* A preview of the chosen file, so what was read can be checked against
	   the page it came from. Revoked when the file changes. */
	let previewUrl = $state<string | null>(null);
	$effect(() => {
		if (!file) {
			previewUrl = null;
			return;
		}
		const url = URL.createObjectURL(file);
		previewUrl = url;
		return () => URL.revokeObjectURL(url);
	});
	const isPdf = $derived(file?.type === 'application/pdf');

	function onFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		file = input.files?.[0] ?? null;
	}

	function clearFile() {
		file = null;
		documentId = null;
		holidayTables = [];
		leaveTypesDraft = [];
		errorMsg = '';
	}

	async function archiveCalendar(calendarId: string) {
		if (!confirm('Archive this holiday calendar? Employees will stop resolving to it immediately.')) return;
		archivingId = calendarId;
		try {
			const res = await fetch(`/api/admin/holiday-calendars/${calendarId}/archive`, { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				errorMsg = body.message ?? 'Could not archive calendar';
				return;
			}
			location.reload();
		} finally {
			archivingId = null;
		}
	}

	// Two-step inline confirm; deleting a leave type also removes every
	// application and allocation that used it.
	let confirmingDeleteType = $state<string | null>(null);
	let deletingTypeId = $state<string | null>(null);

	async function deleteLeaveType(leaveTypeId: string) {
		errorMsg = '';
		deletingTypeId = leaveTypeId;
		try {
			const res = await fetch(`/api/admin/leave-types/${leaveTypeId}`, { method: 'DELETE' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				errorMsg = body.message ?? 'Could not delete leave type';
				return;
			}
			location.reload();
		} finally {
			deletingTypeId = null;
			confirmingDeleteType = null;
		}
	}

	/* Delete and restore. Each delete is a two-step inline confirm, like leave
	   types: the first click arms it, the second does it. */
	let confirmingDelete = $state<string | null>(null);
	let busyId = $state<string | null>(null);

	async function act(id: string, url: string, method: 'POST' | 'DELETE', failure: string) {
		errorMsg = '';
		busyId = id;
		try {
			const res = await fetch(url, { method });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				errorMsg = body.message ?? failure;
				return;
			}
			confirmingDelete = null;
			await invalidateAll();
		} finally {
			busyId = null;
		}
	}
	const deleteCalendar = (id: string) => act(id, `/api/admin/holiday-calendars/${id}`, 'DELETE', 'Could not delete calendar');
	const restoreCalendar = (id: string) => act(id, `/api/admin/holiday-calendars/${id}/restore`, 'POST', 'Could not restore calendar');
	const restoreLeaveType = (id: string) => act(id, `/api/admin/leave-types/${id}/restore`, 'POST', 'Could not restore leave type');
	const deleteDocument = (id: string) => act(id, `/api/admin/policy-documents/${id}`, 'DELETE', 'Could not delete document');

	const kindDocuments = $derived(data.documents.filter((d) => d.kind === kind));
	const DOC_STATUS: Record<string, { label: string; tone: string }> = {
		published: { label: 'Published', tone: 'ok' },
		extracted: { label: 'Read, not published', tone: 'pending' },
		uploaded: { label: 'Uploaded', tone: 'neutral' },
		extraction_failed: { label: 'Could not read', tone: 'rejected' }
	};

	let savingCapId = $state<string | null>(null);
	let capError = $state<Record<string, string>>({});

	/**
	 * Sets the per-month ceiling on a leave type, or clears it when the field is
	 * emptied. Nothing is done to anyone's balance — this only limits how much of
	 * it can be taken in one month.
	 */
	async function saveMonthlyCap(leaveTypeId: string, raw: string) {
		savingCapId = leaveTypeId;
		try {
			const res = await fetch(`/api/admin/leave-types/${leaveTypeId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ monthlyUsageCap: raw.trim() === '' ? null : raw.trim() })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				capError = { ...capError, [leaveTypeId]: body.message ?? 'Could not save the limit' };
				return;
			}
			const { [leaveTypeId]: _cleared, ...rest } = capError;
			capError = rest;
			await invalidateAll();
		} finally {
			savingCapId = null;
		}
	}

	async function archiveLeaveType(leaveTypeId: string) {
		if (!confirm('Archive this leave type? It will no longer be selectable when employees apply for leave.')) return;
		archivingId = leaveTypeId;
		try {
			const res = await fetch(`/api/admin/leave-types/${leaveTypeId}/archive`, { method: 'POST' });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				errorMsg = body.message ?? 'Could not archive leave type';
				return;
			}
			location.reload();
		} finally {
			archivingId = null;
		}
	}

	async function handleUpload(e: SubmitEvent) {
		e.preventDefault();
		if (!file) return;
		errorMsg = '';
		successMsg = '';
		documentId = null;
		holidayTables = [];
		leaveTypesDraft = [];
		uploading = true;
		extracting = true;
		try {
			const form = new FormData();
			form.set('file', file);
			form.set('kind', kind);
			const res = await fetch('/api/admin/policy-documents', { method: 'POST', body: form });
			const body = await res.json();
			if (!res.ok) {
				errorMsg = body.message ?? 'Upload failed';
				return;
			}
			documentId = body.documentId;
			if (kind === 'holiday_calendar') {
				holidayTables = body.extracted.tables;
			} else {
				leaveTypesDraft = body.extracted.leave_types;
			}
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Upload failed';
		} finally {
			uploading = false;
			extracting = false;
		}
	}

	async function handlePublishHolidayCalendar() {
		if (!documentId) return;
		publishing = true;
		errorMsg = '';
		try {
			const res = await fetch(`/api/admin/policy-documents/${documentId}/publish-holiday-calendar`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ year: calendarYear, effectiveFrom, tables: holidayTables })
			});
			const body = await res.json();
			if (!res.ok) {
				errorMsg = body.message ?? 'Publish failed';
				return;
			}
			successMsg = `Published ${body.publishedCalendars.length} shift-group calendar(s) for ${calendarYear}.`;
			documentId = null;
			holidayTables = [];
			file = null;
			await invalidateAll();
		} finally {
			publishing = false;
		}
	}

	async function handlePublishLeavePolicy() {
		if (!documentId) return;
		publishing = true;
		errorMsg = '';
		try {
			const res = await fetch(`/api/admin/policy-documents/${documentId}/publish-leave-policy`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ effectiveFrom, leaveTypes: leaveTypesDraft })
			});
			const body = await res.json();
			if (!res.ok) {
				errorMsg = body.message ?? 'Publish failed';
				return;
			}
			successMsg = `Published ${body.leaveTypes.length} leave type(s).`;
			documentId = null;
			leaveTypesDraft = [];
			file = null;
			await invalidateAll();
		} finally {
			publishing = false;
		}
	}

	function addHolidayRow(tableIdx: number) {
		holidayTables[tableIdx].holidays.push({ date: '', name: '', type: 'PUBLIC' });
	}

	function removeHolidayRow(tableIdx: number, rowIdx: number) {
		holidayTables[tableIdx].holidays.splice(rowIdx, 1);
	}

	function switchKind(next: Kind) {
		if (next === kind) return;
		kind = next;
		successMsg = '';
		errorMsg = '';
	}

	/* Upload → review extraction → published, for the step indicator. */
	const extracted = $derived(kind === 'holiday_calendar' ? holidayTables.length > 0 : leaveTypesDraft.length > 0);
	const step = $derived(extracted ? 1 : successMsg ? 3 : 0);
	const STEPS = ['Upload', 'Review extraction', 'Publish'];

	const fmtDate = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
	const fmtDays = (n: unknown) => (n == null || n === '' ? '—' : Number.isInteger(Number(n)) ? `${Number(n)} ${Number(n) === 1 ? 'day' : 'days'}` : `${Number(n).toFixed(1)} days`);
</script>

<svelte:head>
	<title>Publish policies — Champ HR</title>
</svelte:head>

<!-- Title and description come from the Admin Controls layout (src/lib/admin-tabs.ts). -->

<nav class="ess-tabs ess-tabs--line kinds" aria-label="What to publish" data-tour="policy-kinds">
	<button type="button" class="ess-tab" aria-selected={kind === 'holiday_calendar'} onclick={() => switchKind('holiday_calendar')}>
		<CalendarDays size={16} strokeWidth={1.75} /> Holiday calendars
	</button>
	<button type="button" class="ess-tab" aria-selected={kind === 'leave_policy'} onclick={() => switchKind('leave_policy')}>
		<FileText size={16} strokeWidth={1.75} /> Leave policies
	</button>
</nav>

<div class="ess-fill pol-body">
<section class="ess-card publish" aria-labelledby="pub-h">
	<div class="pub-head">
		<div>
			<h2 class="ess-h2" id="pub-h">Publish a new {kind === 'holiday_calendar' ? 'holiday calendar' : 'leave policy'}</h2>
			<p class="ess-caption">Upload the source document and review what was read from it before publishing.</p>
		</div>
		<ol class="ess-stepper steps" aria-label="Progress">
			{#each STEPS as label, i (label)}
				<li class="ess-step" data-state={i < step ? 'done' : i === step ? 'current' : 'todo'}>
					<span class="ess-step__dot">{#if i < step}✓{/if}</span>
					<span class="ess-step__label">{i + 1}. {label}</span>
				</li>
			{/each}
		</ol>
	</div>

	{#if errorMsg}
		<p class="ess-error msg"><AlertTriangle size={15} /> {errorMsg}</p>
	{/if}
	{#if successMsg}
		<div class="ess-notice ess-notice--success">
			<span class="ess-notice__icon"><CheckCircle size={15} /></span>
			<div class="ess-notice__body"><strong>Published.</strong> {successMsg}</div>
		</div>
	{/if}

	<div class="pub-grid">
		<!-- ---------- left: the document ---------- -->
		<div class="doc">
			<h3 class="ess-h3">Uploaded document</h3>
			{#if file}
				<div class="file-row">
					<span class="ess-tile" class:ess-tile--bad={isPdf} class:ess-tile--info={!isPdf}>
						{#if isPdf}<FileText size={20} strokeWidth={1.75} />{:else}<FileImage size={20} strokeWidth={1.75} />{/if}
					</span>
					<span class="file-text">
						<strong>{file.name}</strong>
						<span>{(file.size / 1024).toFixed(0)} KB · {isPdf ? 'PDF' : 'image'}</span>
					</span>
					<button type="button" class="ess-icon-btn" onclick={clearFile} aria-label="Remove file" title="Remove file"><Trash2 size={17} /></button>
				</div>
				{#if previewUrl}
					<div class="doc-preview">
						{#if isPdf}
							<iframe src={previewUrl} title="Document preview"></iframe>
						{:else}
							<img src={previewUrl} alt="Document preview" />
						{/if}
					</div>
				{/if}
				{#if !extracted}
					<form onsubmit={handleUpload} class="extract-row">
						<button type="submit" class="ess-btn ess-btn--primary" disabled={uploading}>
							<UploadCloud size={16} /> {extracting ? 'Reading with AI…' : 'Upload & read'}
						</button>
						<label class="ess-btn ess-btn--secondary">
							Replace file
							<input type="file" accept="image/jpeg,image/png,application/pdf" onchange={onFileChange} hidden />
						</label>
					</form>
				{/if}
			{:else}
				<label class="file-drop">
					<span class="ess-tile"><UploadCloud size={22} strokeWidth={1.75} /></span>
					<strong>Choose the {kind === 'holiday_calendar' ? 'holiday calendar' : 'leave policy'}</strong>
					<span>JPEG, PNG or PDF. It is read by AI; you review every value before anything is published.</span>
					<span class="ess-btn ess-btn--secondary ess-btn--sm">Browse</span>
					<input type="file" accept="image/jpeg,image/png,application/pdf" onchange={onFileChange} hidden />
				</label>
			{/if}
		</div>

		<!-- ---------- right: what was read ---------- -->
		<div class="fields">
			{#if extracted}
				<div class="ess-notice">
					<span class="ess-notice__icon"><AlertTriangle size={15} /></span>
					<div class="ess-notice__body">
						<strong>Review extracted values</strong>
						These were read from your document by AI. Check and correct each one before publishing.
					</div>
				</div>

				{#if kind === 'holiday_calendar'}
					<div class="fields-head">
						<h3 class="ess-h3">Extracted holidays</h3>
						<span class="ess-badge ess-badge--accent">Extracted values</span>
					</div>
					<div class="meta-row">
						<label class="ess-field">
							<span class="ess-label">Calendar year</span>
							<input class="ess-input" type="number" bind:value={calendarYear} />
						</label>
						<label class="ess-field">
							<span class="ess-label">Effective from</span>
							<input class="ess-input" type="date" bind:value={effectiveFrom} />
						</label>
					</div>
					<p class="ess-help">Each table becomes its own shift-group calendar. Edit any row before publishing.</p>

					{#each holidayTables as table, tableIdx (table.shift_group_key)}
						<div class="table-block">
							<div class="table-head">
								<input class="group-label" bind:value={table.shift_group_label} aria-label="Shift group name" />
								<code>{table.shift_group_key}</code>
							</div>
							<div class="ess-table-shell">
								<table class="ess-table edit">
									<thead>
										<tr><th>Date</th><th>Name</th><th>Type</th><th></th></tr>
									</thead>
									<tbody>
										{#each table.holidays as row, rowIdx (rowIdx)}
											<tr>
												<td><input class="ess-input" type="date" bind:value={row.date} /></td>
												<td><input class="ess-input" type="text" bind:value={row.name} /></td>
												<td>
													<select class="ess-select" bind:value={row.type}>
														<option value="PUBLIC">Public</option>
														<option value="RESTRICTED">Restricted</option>
														<option value="OPTIONAL">Optional</option>
													</select>
												</td>
												<td class="row-act">
													<button type="button" class="ess-icon-btn" onclick={() => removeHolidayRow(tableIdx, rowIdx)} aria-label="Remove row"><X size={16} /></button>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
							<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => addHolidayRow(tableIdx)}><Plus size={14} /> Add holiday row</button>
						</div>
					{/each}

					<div class="publish-row">
						<button type="button" class="ess-btn ess-btn--primary" onclick={handlePublishHolidayCalendar} disabled={publishing}>
							<CloudUpload size={17} /> {publishing ? 'Publishing…' : 'Publish calendar'}
						</button>
					</div>
				{:else}
					<div class="fields-head">
						<h3 class="ess-h3">Extracted policy details</h3>
						<span class="ess-badge ess-badge--accent">Extracted values</span>
					</div>
					<label class="ess-field eff">
						<span class="ess-label">Effective from</span>
						<input class="ess-input" type="date" bind:value={effectiveFrom} />
					</label>
					<p class="ess-help">Publishing upserts by leave type code.</p>

					{#each leaveTypesDraft as lt, idx (idx)}
						<div class="lt-block">
							<div class="lt-grid">
								<label class="ess-field">
									<span class="ess-label">Leave code</span>
									<input class="ess-input" type="text" bind:value={lt.code} />
									<span class="ess-help">Unique code used in the system</span>
								</label>
								<label class="ess-field">
									<span class="ess-label">Policy name</span>
									<input class="ess-input" type="text" bind:value={lt.name} />
									<span class="ess-help">Name as it will appear to employees</span>
								</label>
								<label class="ess-field">
									<span class="ess-label">Accrual per month (days)</span>
									<input class="ess-input" type="number" step="0.1" bind:value={lt.accrual_per_month} />
									<span class="ess-help">Number of days accrued each month</span>
								</label>
								<label class="ess-field">
									<span class="ess-label">Carry-forward cap (days)</span>
									<input class="ess-input" type="number" bind:value={lt.carry_forward_cap_days} />
									<span class="ess-help">Maximum balance carried into the next year</span>
								</label>
								<label class="ess-field">
									<span class="ess-label">Fixed days</span>
									<input class="ess-input" type="number" bind:value={lt.fixed_days} />
									<span class="ess-help">For types granted as a fixed block</span>
								</label>
								<label class="ess-field">
									<span class="ess-label">Eligibility</span>
									<input class="ess-input" type="text" bind:value={lt.eligibility} />
								</label>
							</div>
							<label class="check">
								<input type="checkbox" bind:checked={lt.requires_documentation} />
								<span>Requires documentation</span>
							</label>
							{#if lt.requires_documentation}
								<label class="ess-field">
									<span class="ess-label">Documentation note</span>
									<input class="ess-input" type="text" bind:value={lt.documentation_note} />
								</label>
							{/if}
							<label class="ess-field">
								<span class="ess-label">Notes</span>
								<textarea class="ess-textarea" rows="3" bind:value={lt.notes}></textarea>
							</label>
						</div>
					{/each}

					<div class="publish-row">
						<button type="button" class="ess-btn ess-btn--primary" onclick={handlePublishLeavePolicy} disabled={publishing}>
							<CloudUpload size={17} /> {publishing ? 'Publishing…' : 'Publish policy'}
						</button>
					</div>
				{/if}
			{:else}
				<div class="waiting">
					<span class="ess-tile ess-tile--neutral"><FileText size={20} strokeWidth={1.75} /></span>
					<strong>Nothing to review yet</strong>
					<span>Choose a document on the left and read it. The values found appear here for you to check and edit before publishing.</span>
				</div>
			{/if}
		</div>
	</div>
</section>

<!-- ---------- currently published ---------- -->
{#if kind === 'holiday_calendar'}
	<section class="ess-card current" aria-labelledby="cur-h">
		<div class="ess-card-head">
			<div>
				<h2 class="ess-h2" id="cur-h">Currently published holiday calendars</h2>
				<p class="ess-caption">The calendars employees resolve to, one per shift group.</p>
			</div>
		</div>
		{#if data.publishedCalendars.length === 0}
			<p class="ess-help">No holiday calendar published yet.</p>
		{:else}
			<div class="ess-table-shell current-table">
				<table class="ess-table">
					<thead>
						<tr>
							<th>Version</th>
							<th>Shift group</th>
							<th class="ess-num">Year</th>
							<th class="ess-num">Holidays</th>
							<th>Status</th>
							<th>Effective from</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each data.publishedCalendars as cal (cal.id)}
							<tr>
								<td class="muted">v{cal.version}</td>
								<td><strong>{cal.shiftGroupName}</strong></td>
								<td class="ess-num">{cal.year}</td>
								<td class="ess-num">{cal.holidays.length}</td>
								<td><span class="ess-badge ess-badge--ok">Published</span></td>
								<td>{fmtDate(cal.effectiveFrom)}</td>
								<td>
									{#if confirmingDelete === cal.id}
										<span class="acts">
											<button type="button" class="ess-btn ess-btn--danger ess-btn--sm" onclick={() => deleteCalendar(cal.id)} disabled={busyId === cal.id}>
												{busyId === cal.id ? 'Deleting…' : 'Confirm delete'}
											</button>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (confirmingDelete = null)}>Cancel</button>
										</span>
									{:else}
										<span class="acts">
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => archiveCalendar(cal.id)} disabled={archivingId === cal.id}>
												{archivingId === cal.id ? 'Archiving…' : 'Archive'}
											</button>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm danger" onclick={() => (confirmingDelete = cal.id)} title="Permanently delete this calendar and its holidays">
												Delete
											</button>
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if data.otherCalendars.length > 0}
			<h3 class="ess-h3 sub-h">Archived calendars</h3>
			<p class="ess-caption">Not shown to employees. Restore one to publish it again (it replaces the live calendar for that shift group and year), or delete it for good.</p>
			<div class="ess-table-shell current-table">
				<table class="ess-table">
					<thead>
						<tr>
							<th>Version</th>
							<th>Shift group</th>
							<th class="ess-num">Year</th>
							<th class="ess-num">Holidays</th>
							<th>Status</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each data.otherCalendars as cal (cal.id)}
							<tr>
								<td class="muted">v{cal.version}</td>
								<td><strong>{cal.shiftGroupName}</strong></td>
								<td class="ess-num">{cal.year}</td>
								<td class="ess-num">{cal.holidays.length}</td>
								<td><span class="ess-badge">{cal.status === 'archived' ? 'Archived' : 'Draft'}</span></td>
								<td>
									{#if confirmingDelete === cal.id}
										<span class="acts">
											<button type="button" class="ess-btn ess-btn--danger ess-btn--sm" onclick={() => deleteCalendar(cal.id)} disabled={busyId === cal.id}>
												{busyId === cal.id ? 'Deleting…' : 'Confirm delete'}
											</button>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (confirmingDelete = null)}>Cancel</button>
										</span>
									{:else}
										<span class="acts">
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => restoreCalendar(cal.id)} disabled={busyId === cal.id}>
												{busyId === cal.id ? 'Restoring…' : 'Restore'}
											</button>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm danger" onclick={() => (confirmingDelete = cal.id)}>Delete</button>
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{:else}
	<section class="ess-card current" aria-labelledby="curl-h">
		<div class="ess-card-head">
			<div>
				<h2 class="ess-h2" id="curl-h">Currently published policies</h2>
				<p class="ess-caption">The leave types currently in effect. "Max per month" limits how fast a balance may be drawn down; blank is no limit.</p>
			</div>
		</div>
		{#if data.leaveTypes.length === 0}
			<p class="ess-help">No leave policy published yet.</p>
		{:else}
			<div class="ess-table-shell current-table">
				<table class="ess-table">
					<thead>
						<tr>
							<th>Version</th>
							<th>Policy name</th>
							<th>Code</th>
							<th>Accrual per month</th>
							<th>Carry-forward cap</th>
							<th>Max per month</th>
							<th>Status</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each data.leaveTypes as lt (lt.id)}
							<tr>
								<td class="muted">v{lt.policyVersion}</td>
								<td><strong>{lt.name}</strong></td>
								<td class="mono">{lt.code ?? '—'}</td>
								<td>{lt.monthlyQuotaDays != null ? `${fmtDays(lt.monthlyQuotaDays)} quota` : lt.fixedDays != null ? `${lt.fixedDays} fixed` : fmtDays(lt.accrualPerMonth)}</td>
								<td>{fmtDays(lt.carryForwardCap)}</td>
								<td>
									<span class="cap">
										<input
											class="ess-input cap-input"
											type="number"
											min="0.5"
											step="0.5"
											placeholder="no limit"
											value={lt.monthlyUsageCap ?? ''}
											disabled={savingCapId === lt.id}
											onchange={(e) => saveMonthlyCap(lt.id, e.currentTarget.value)}
											aria-label="Max per month for {lt.name}"
										/>
										<span class="muted">days</span>
									</span>
									{#if capError[lt.id]}<span class="ess-error">{capError[lt.id]}</span>{/if}
								</td>
								<td><span class="ess-badge ess-badge--ok">Published</span></td>
								<td>
									{#if confirmingDeleteType === lt.id}
										<span class="acts">
											<button type="button" class="ess-btn ess-btn--danger ess-btn--sm" onclick={() => deleteLeaveType(lt.id)} disabled={deletingTypeId === lt.id}>
												{deletingTypeId === lt.id ? 'Deleting…' : 'Confirm delete'}
											</button>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (confirmingDeleteType = null)}>Cancel</button>
										</span>
									{:else}
										<span class="acts">
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => archiveLeaveType(lt.id)} disabled={archivingId === lt.id}>
												{archivingId === lt.id ? 'Archiving…' : 'Archive'}
											</button>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm danger" onclick={() => (confirmingDeleteType = lt.id)} title="Permanently delete this leave type and all leave taken under it">
												Delete
											</button>
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if data.archivedLeaveTypes.length > 0}
			<h3 class="ess-h3 sub-h">Archived leave types</h3>
			<p class="ess-caption">Not offered when applying for leave. Restore one to offer it again, or delete it with every allocation and application under it. Re-uploading a policy with the same code also restores it.</p>
			<div class="ess-table-shell current-table">
				<table class="ess-table">
					<thead>
						<tr><th>Version</th><th>Policy name</th><th>Code</th><th>Status</th><th>Actions</th></tr>
					</thead>
					<tbody>
						{#each data.archivedLeaveTypes as lt (lt.id)}
							<tr>
								<td class="muted">v{lt.policyVersion}</td>
								<td><strong>{lt.name}</strong></td>
								<td class="mono">{lt.code ?? '—'}</td>
								<td><span class="ess-badge">Archived</span></td>
								<td>
									{#if confirmingDeleteType === lt.id}
										<span class="acts">
											<button type="button" class="ess-btn ess-btn--danger ess-btn--sm" onclick={() => deleteLeaveType(lt.id)} disabled={deletingTypeId === lt.id}>
												{deletingTypeId === lt.id ? 'Deleting…' : 'Confirm delete'}
											</button>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (confirmingDeleteType = null)}>Cancel</button>
										</span>
									{:else}
										<span class="acts">
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => restoreLeaveType(lt.id)} disabled={busyId === lt.id}>
												{busyId === lt.id ? 'Restoring…' : 'Restore'}
											</button>
											<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm danger" onclick={() => (confirmingDeleteType = lt.id)} title="Permanently delete this leave type and all leave taken under it">Delete</button>
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}

<!-- ---------- uploaded source documents ---------- -->
<section class="ess-card current" aria-labelledby="docs-h">
	<div class="ess-card-head">
		<div>
			<h2 class="ess-h2" id="docs-h">Uploaded {kind === 'holiday_calendar' ? 'calendar' : 'policy'} documents</h2>
			<p class="ess-caption">The files calendars and policies were read from. Deleting a file keeps what was published from it; to replace a published {kind === 'holiday_calendar' ? 'calendar' : 'policy'}, upload the corrected file above and publish it.</p>
		</div>
	</div>
	{#if kindDocuments.length === 0}
		<p class="ess-help">No {kind === 'holiday_calendar' ? 'calendar' : 'policy'} documents uploaded yet.</p>
	{:else}
		<div class="ess-table-shell current-table">
			<table class="ess-table">
				<thead>
					<tr><th>File</th><th>Uploaded</th><th>Status</th><th>Actions</th></tr>
				</thead>
				<tbody>
					{#each kindDocuments as doc (doc.id)}
						{@const st = DOC_STATUS[doc.status] ?? { label: doc.status, tone: 'neutral' }}
						<tr>
							<td><a class="doc-link" href="/api/admin/policy-documents/{doc.id}" target="_blank" rel="noopener">{doc.filename}</a></td>
							<td>{fmtDate(doc.createdAt)}</td>
							<td><span class="ess-badge ess-badge--{st.tone}">{st.label}</span></td>
							<td>
								{#if confirmingDelete === doc.id}
									<span class="acts">
										<button type="button" class="ess-btn ess-btn--danger ess-btn--sm" onclick={() => deleteDocument(doc.id)} disabled={busyId === doc.id}>
											{busyId === doc.id ? 'Deleting…' : 'Confirm delete'}
										</button>
										<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm" onclick={() => (confirmingDelete = null)}>Cancel</button>
									</span>
								{:else}
									<button type="button" class="ess-btn ess-btn--ghost ess-btn--sm danger" onclick={() => (confirmingDelete = doc.id)}>Delete</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>
</div>

<style>
	.kinds {
		margin-bottom: 0;
	}
	.sub-h {
		margin: 18px 0 2px;
	}
	.doc-link {
		color: var(--ess-primary-text);
		overflow-wrap: anywhere;
	}
	.pol-body {
		display: grid;
		gap: 14px;
		min-width: 0;
	}

	.pub-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		margin-bottom: 10px;
	}
	.steps {
		min-width: 420px;
		flex: 0 1 460px;
	}
	.msg {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 10px;
	}
	.ess-notice {
		margin-bottom: 10px;
		padding: 9px 12px;
		gap: 10px;
		font-size: 13px;
	}

	.pub-grid {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
		gap: 14px;
		align-items: start;
	}
	.doc,
	.fields {
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		padding: 12px 14px;
		display: grid;
		gap: 10px;
		align-content: start;
		min-width: 0;
	}
	.file-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
	}
	.file-text {
		flex: 1;
		display: grid;
		min-width: 0;
	}
	.file-text strong {
		font-size: 14.5px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.file-text span {
		font-size: 12.5px;
		color: var(--ess-text-muted);
	}
	.doc-preview {
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
		background: var(--ess-sunken);
		overflow: hidden;
		max-height: 520px;
	}
	.doc-preview iframe {
		display: block;
		width: 100%;
		height: 520px;
		border: 0;
	}
	.doc-preview img {
		display: block;
		width: 100%;
		max-height: 520px;
		object-fit: contain;
	}
	.extract-row {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.file-drop {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 18px 16px;
		border: 1px dashed var(--ess-border-strong);
		border-radius: var(--ess-radius-md);
		background: var(--ess-sunken);
		text-align: center;
		cursor: pointer;
		transition: border-color var(--ess-t-fast);
	}
	.file-drop:hover {
		border-color: var(--ess-primary);
	}
	.file-drop strong {
		font-size: 14px;
		font-weight: 500;
	}
	.file-drop > span:not(.ess-tile):not(.ess-btn) {
		font-size: 13px;
		color: var(--ess-text-secondary);
		max-width: 36ch;
	}

	.fields-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.meta-row,
	.lt-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px 12px;
	}
	.eff {
		max-width: 260px;
	}
	.table-block {
		display: grid;
		gap: 10px;
	}
	.table-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.group-label {
		flex: 1;
		font-family: var(--ess-font-display);
		font-size: 15px;
		font-weight: 600;
		border: none;
		border-bottom: 1px dashed transparent;
		background: transparent;
		color: var(--ess-text);
		padding: 2px 0;
	}
	.group-label:hover,
	.group-label:focus {
		border-bottom-color: var(--ess-border-strong);
		outline: none;
		box-shadow: none;
	}
	code,
	.mono {
		font-family: var(--ess-font-mono);
		font-size: 12px;
		color: var(--ess-text-muted);
	}
	.edit td {
		padding: 6px 10px;
	}
	.edit th {
		padding: 8px 10px;
	}
	.edit .ess-input,
	.edit .ess-select {
		padding: 7px 10px;
		font-size: 13px;
	}
	.row-act {
		width: 48px;
	}
	.lt-block {
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--ess-border);
		border-radius: var(--ess-radius-md);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
	}
	.check input {
		accent-color: var(--ess-primary);
	}
	.publish-row {
		display: flex;
		justify-content: flex-end;
		padding-top: 4px;
	}
	.waiting {
		display: grid;
		justify-items: center;
		gap: 6px;
		padding: 20px 16px;
		text-align: center;
		color: var(--ess-text-secondary);
		font-size: 13px;
	}
	.waiting strong {
		color: var(--ess-text);
		font-size: 14px;
	}
	.waiting span:not(.ess-tile) {
		max-width: 40ch;
	}

	.muted {
		color: var(--ess-text-muted);
	}
	.cap {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.cap-input {
		width: 88px;
		padding: 6px 8px;
		font-size: 13px;
	}
	.acts {
		display: inline-flex;
		gap: 4px;
	}
	.danger {
		color: var(--ess-danger);
	}
	.danger:hover:not(:disabled) {
		background: var(--ess-danger-bg);
		color: var(--ess-danger);
	}

	/* Desktop fill: the publish card takes the height left over and its two
	   panes scroll on their own; the published list keeps its natural height
	   up to a cap and scrolls inside after that. */
	@media (min-width: 1101px) and (min-height: 480px) {
		@container ess-fill (min-width: 0px) {
			.pol-body {
				display: flex;
				flex-direction: column;
			}
			.publish {
				flex: 1 1 0%;
				min-height: 230px;
				display: flex;
				flex-direction: column;
				overflow: hidden;
			}
			.pub-grid {
				flex: 1 1 0%;
				min-height: 0;
				align-items: stretch;
			}
			.doc,
			.fields {
				min-height: 0;
				overflow: auto;
				overscroll-behavior: contain;
				scrollbar-width: thin;
			}
			.doc {
				display: flex;
				flex-direction: column;
			}
			.doc > :global(*) {
				flex-shrink: 0;
			}
			.doc .doc-preview {
				flex: 1 1 0%;
				min-height: 180px;
				max-height: none;
			}
			.doc-preview iframe {
				height: 100%;
			}
			.doc-preview img {
				height: 100%;
				max-height: none;
			}
			.doc,
			.fields {
				padding: 10px 12px;
				gap: 8px;
			}
			.doc .file-drop {
				flex: 1 1 auto;
				padding: 10px 14px;
				grid-template-columns: auto minmax(0, 1fr);
				justify-items: start;
				align-content: center;
				column-gap: 14px;
				text-align: left;
			}
			.file-drop .ess-tile {
				grid-row: span 3;
				align-self: center;
			}
			.file-drop > :global(*:not(.ess-tile)) {
				grid-column: 2;
			}
			.fields:has(> .waiting) {
				align-content: center;
			}
			.fields .waiting {
				min-height: 100%;
				align-content: center;
				padding: 8px 12px;
			}
			.current {
				flex: 0 1 auto;
				min-height: 96px;
				max-height: 42%;
				display: flex;
				flex-direction: column;
				overflow: hidden;
			}
			.current-table {
				flex: 1 1 auto;
				min-height: 0;
				overflow: auto;
				overscroll-behavior: contain;
				scrollbar-width: thin;
			}
			.current-table th {
				position: sticky;
				top: 0;
				z-index: 1;
			}
		}
	}

	/* Short desktop screens (laptops at 150% scaling): the stepper sits on
	   one line, headings share a line with their captions and the empty
	   states lie flat, so both cards fit without scrolling. */
	@media (min-width: 1101px) and (min-height: 480px) and (max-height: 760px) {
		@container ess-fill (min-width: 0px) {
			.pol-body {
				gap: 10px;
			}
			.kinds :global(.ess-tab) {
				padding-top: 4px;
				padding-bottom: 4px;
			}
			.publish {
				min-height: 170px;
			}
			.pub-head {
				margin-bottom: 8px;
				align-items: center;
			}
			.pub-head .ess-caption,
			.current .ess-caption {
				font-size: 12px;
			}
			.steps .ess-step {
				display: flex;
				align-items: center;
				gap: 0;
			}
			.steps .ess-step__label {
				position: relative;
				z-index: 1;
				padding: 0 10px 0 6px;
				background: var(--ess-surface);
				font-size: 13px;
				white-space: nowrap;
			}
			.pub-grid {
				gap: 10px;
			}
			.doc,
			.fields {
				padding: 8px 12px;
				gap: 6px;
			}
			.doc .ess-h3 {
				font-size: 14px;
			}
			.doc .doc-preview {
				min-height: 110px;
			}
			.doc .file-drop {
				grid-template-columns: auto minmax(0, 1fr) auto;
				padding: 8px 12px;
				row-gap: 2px;
			}
			.file-drop .ess-tile {
				grid-row: span 2;
			}
			.file-drop > :global(.ess-btn) {
				grid-column: 3;
				grid-row: 1 / span 2;
				align-self: center;
			}
			.file-drop > span:not(.ess-tile):not(.ess-btn) {
				font-size: 12.5px;
				max-width: 48ch;
			}
			.fields .waiting {
				grid-template-columns: auto minmax(0, 1fr);
				justify-items: start;
				column-gap: 12px;
				row-gap: 2px;
				text-align: left;
			}
			.waiting .ess-tile {
				grid-row: span 2;
				align-self: center;
			}
			.waiting span:not(.ess-tile) {
				font-size: 12.5px;
				max-width: 52ch;
			}
			.current {
				min-height: 0;
			}
			.current .ess-card-head > div {
				display: flex;
				align-items: baseline;
				flex-wrap: wrap;
				gap: 2px 10px;
			}
		}
	}

	@media (max-width: 1100px) {
		.pub-grid {
			grid-template-columns: 1fr;
		}
		.steps {
			min-width: 0;
			flex: 1 1 100%;
		}
	}
	@media (max-width: 640px) {
		.meta-row,
		.lt-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
