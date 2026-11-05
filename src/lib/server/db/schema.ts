import { sqliteTable, text, integer, numeric, uniqueIndex, index, check } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

/*
 * The portal's database is Cloudflare D1 (SQLite). How Postgres types map:
 *   uuid         text, filled with crypto.randomUUID()
 *   timestamptz  integer milliseconds since epoch, read as a JS Date
 *   date         text 'YYYY-MM-DD' (sorts and compares correctly as text)
 *   numeric      numeric, read as a string exactly as before
 *   boolean      integer 0/1, read as true/false
 *   jsonb, arrays  text holding JSON
 *   enums        text, limited to the listed values by TypeScript
 */

/** Current time in epoch milliseconds, as a column default. */
const NOW_MS = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/**
 * Stand-in for Postgres enums: `roleEnum('role')` makes a text column limited
 * to the values, and `roleEnum.enumValues` lists them, as pgEnum did.
 */
function sqliteEnum<const T extends readonly [string, ...string[]]>(_name: string, values: T) {
	const column = (name: string) => text(name, { enum: values as unknown as [T[number], ...T[number][]] });
	return Object.assign(column, { enumValues: values });
}

export const roleEnum = sqliteEnum('role', ['super_admin', 'admin', 'team_lead', 'employee']);

export const leaveStatusEnum = sqliteEnum('leave_status', [
	'pending',
	'approved',
	'rejected',
	'escalated',
	'cancelled'
]);

export const attendanceSourceEnum = sqliteEnum('attendance_source', ['manual', 'biometric']);

// SOP §2/§4 — the fixed reason list an attendance correction can be raised under.
// Kept as an enum so the monthly cap can be scoped to biometric-only reasons.
export const deviationReasonEnum = sqliteEnum('deviation_reason', [
	'login_not_captured',
	'logout_not_captured',
	'missing_biometric_punch',
	'biometric_system_mismatch',
	'prohance_mismatch',
	'system_server_issue',
	'machine_malfunction',
	'technical_error',
	'wrong_half_day',
	'wrong_absent',
	'incorrect_working_hours'
]);

export const deviationStatusEnum = sqliteEnum('deviation_status', [
	'pending',
	'approved',
	'rejected',
	'needs_manager_approval', // SOP §2: 4th+ biometric request in a month
	// Manager has signed off; waiting on HR. Attendance corrections run
	// manager → HR → approved, so this is the middle of the chain rather than a
	// decision. Comp-off deliberately has no equivalent: it is one step.
	'manager_approved',
	'cancelled'
]);

export const compOffStatusEnum = sqliteEnum('comp_off_status', [
	'pending',
	// The reporting manager has confirmed the day was worked; the concerned HR
	// has yet to credit it. Comp-off runs the same manager → HR chain as leave
	// and attendance corrections, so a credit only becomes spendable once HR
	// signs off — 'approved' still means exactly that.
	'manager_approved',
	'approved',
	'rejected',
	'used',
	'lapsed'
]);

export const calendarStatusEnum = sqliteEnum('calendar_status', ['draft', 'published', 'archived']);

// A week-off roster is either the same weekdays off every week, or an N-week
// rotation that repeats. Rotational is what makes a roster worth saving at all —
// a fixed pattern could be a column, but a rotation needs an anchor date and a
// per-week weekday set.
export const weekOffPatternEnum = sqliteEnum('week_off_pattern', ['fixed', 'rotational']);

// --- Org structure ---

// Shift group is the key that makes holiday calendars & leave policy rules render
// differently per employee (§ Leave Policy & Holiday Calendar design doc). An
// employee's shiftGroupId on employeeProfiles is set manually by HR/admin and is
// the join key the resolver uses — never hardcode calendar data per employee.
export const shiftGroups = sqliteTable('shift_groups', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	key: text('key', { length: 64 }).notNull().unique(), // e.g. 'day_shift', 'night_shift', 'singapore'
	name: text('name').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const departments = sqliteTable('departments', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	name: text('name').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const teams = sqliteTable('teams', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	name: text('name').notNull(),
	departmentId: text('department_id').references(() => departments.id),
	teamLeadId: text('team_lead_id').references((): any => users.id),
	// Team Lead privilege template, set by Super Admin at team-creation time
	canApproveLeave: integer('can_approve_leave', { mode: 'boolean' }).default(true).notNull(),
	maxLeaveDaysAutoApprove: integer('max_leave_days_auto_approve').default(2).notNull(),
	canEditTeamShiftWindow: integer('can_edit_team_shift_window', { mode: 'boolean' }).default(true).notNull(),
	canViewTeamPayrollCost: integer('can_view_team_payroll_cost', { mode: 'boolean' }).default(false).notNull(),
	canCreateEmployeeLogins: integer('can_create_employee_logins', { mode: 'boolean' }).default(true).notNull(),
	canResolveGrievances: integer('can_resolve_grievances', { mode: 'boolean' }).default(true).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

// --- Users / auth ---

export const users = sqliteTable('users', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	email: text('email', { length: 255 }).notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	role: roleEnum('role').notNull(),
	fullName: text('full_name').notNull(),
	teamId: text('team_id').references(() => teams.id),
	reportsTo: text('reports_to').references((): any => users.id),
	isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
	mustChangePassword: integer('must_change_password', { mode: 'boolean' }).default(true).notNull(),
	/**
	 * The issued temporary password, readable, for exactly as long as it is still
	 * the account's password.
	 *
	 * A hash is one-way, so before this column the plaintext existed only inside
	 * the request that created the account: if the credentials mail didn't land —
	 * no Resend key configured yet, an unverified sending domain, the provider's
	 * rate limit part-way through a master-tracker import, an address the sheet
	 * got wrong — the account was stranded, and nobody, Super Admin included,
	 * could say what its password was. A roster of people who cannot sign in and
	 * cannot be told why is worse than holding a value that is single-use by
	 * construction.
	 *
	 * It is not a credential store. `passwordHash` remains the only thing login
	 * checks; this is never read during authentication. It is set null the moment
	 * the person chooses their own password, so it only ever describes an account
	 * still sitting on `mustChangePassword`, and it is only ever shown to someone
	 * who could reset that same account anyway.
	 */
	temporaryPassword: text('temporary_password'),
	/**
	 * The person's Clerk user id (`user_…`) once their login exists in Clerk.
	 * The Clerk user carries this row's `id` as its `externalId`, so the two are
	 * linked from both sides; see src/lib/server/clerk.ts and
	 * scripts/migrate-to-clerk.ts.
	 */
	clerkUserId: text('clerk_user_id', { length: 64 }).unique(),
	/**
	 * A named role a Super Admin created ("IT Support", "Operations"), adding
	 * privileges on top of the base `role`. Null = base role only. See
	 * src/lib/capabilities.ts.
	 */
	customRoleId: text('custom_role_id').references((): any => customRoles.id),
	/**
	 * A system login, not a person: the developer's Super Admin
	 * (DEVELOPER_EMAIL, see db/ensure-developer.ts). It signs in and has every
	 * privilege, but no list, count, chart or picker shows it, and nobody else —
	 * other Super Admins included — can open, edit or delete it. Filter lists
	 * with `notHidden` from $lib/server/hidden-users.
	 */
	hidden: integer('hidden', { mode: 'boolean' }).default(false).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
}, (t) => [index('users_reports_to').on(t.reportsTo)]);

// --- Employee profile (My Profile widget, §4.1) ---
// Field set expanded to match the company's "Personal Master Data" HR record format.

export const employeeProfiles = sqliteTable('employee_profiles', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull()
		.unique(),

	// HR override for gender/tenure-restricted leave (pink leave). null = follow
	// the automatic rule; true/false = HR has explicitly granted or withheld it.
	// Exists because gender and joining dates are missing for most employees, so
	// the automatic rule alone would silently exclude people.
	pinkLeaveEligibleOverride: integer('pink_leave_eligible_override', { mode: 'boolean' }),

	// HR-locked — the company employee code (e.g. "CIPL2666"). This is the single
	// source of truth for identifying a person across the portal, the HR master
	// spreadsheets, and EasyTime Pro (where it is the device-side {emp_code}).
	// Attendance ingestion joins on this value, so it must stay unique.
	employeeCode: text('employee_code', { length: 32 }).unique(),

	// self-editable — personal & contact
	phone: text('phone'),
	personalEmail: text('personal_email'),
	address: text('address'),
	permanentAddress: text('permanent_address'),
	facebookId: text('facebook_id'),
	linkedinUrl: text('linkedin_url'),
	instagramHandle: text('instagram_handle'),

	// self-editable — emergency contact
	emergencyContactName: text('emergency_contact_name'),
	emergencyContactRelationship: text('emergency_contact_relationship'),
	emergencyContactPhone: text('emergency_contact_phone'),

	// self-editable — family
	gender: text('gender'),
	bloodGroup: text('blood_group'),
	dobDocuments: text('dob_documents'),
	dobActual: text('dob_actual'),
	fatherName: text('father_name'),
	fatherDob: text('father_dob'),
	fatherContact: text('father_contact'),
	motherName: text('mother_name'),
	motherDob: text('mother_dob'),
	motherContact: text('mother_contact'),
	religion: text('religion'),
	motherTongue: text('mother_tongue'),
	maritalStatus: text('marital_status'),
	spouseName: text('spouse_name'),
	spouseDob: text('spouse_dob'),
	spouseContact: text('spouse_contact'),
	anniversaryDate: text('anniversary_date'),
	// The HR tracker carries three fixed "Kids Name #n / Date of Birth" column
	// pairs, but the real count varies per person. Stored as a list rather than
	// six rigid columns so the sheet's arbitrary cap isn't baked into the schema:
	// [{ name: 'Aarav', dob: '2019-04-02' }, …]
	children: text('children', { mode: 'json' }).$type<{ name: string; dob: string | null }[]>(),

	// self-editable — education
	underGraduate: text('under_graduate'),
	graduate: text('graduate'),
	masters: text('masters'),
	diplomaOthers: text('diploma_others'),
	totalExperience: text('total_experience'),

	// self-editable — government IDs
	aadharNumber: text('aadhar_number'),
	panNumber: text('pan_number'),
	uanNumber: text('uan_number'),
	drivingLicenseNumber: text('driving_license_number'),
	votersIdNumber: text('voters_id_number'),
	passportNumber: text('passport_number'),

	// self-editable — bank details
	bankAccountNumber: text('bank_account_number'),
	bankAccountHolderName: text('bank_account_holder_name'),
	bankName: text('bank_name'),
	bankIfsc: text('bank_ifsc'),

	// HR-locked — job / org info
	designation: text('designation'),
	teamAndFloor: text('team_and_floor'),
	subProcessDepartment: text('sub_process_department'),
	floorDetails: text('floor_details'),
	dateOfJoining: text('date_of_joining'),
	dateOfConfirmation: text('date_of_confirmation'),
	// Last working day, set when someone leaves. Payroll reads it: days after
	// it are unpaid, and a leaver lands on the Stop Salary list for that cycle.
	lastWorkingDay: text('last_working_day'),
	officeTimings: text('office_timings'),
	shiftType: text('shift_type'),
	shiftGroupId: text('shift_group_id').references(() => shiftGroups.id),
	// The names exactly as written in the HR sheet. Kept verbatim even after a
	// match, so the source stays auditable and an unresolvable manager (senior
	// staff outside this roster, or a title like "Chief") still has something
	// to display.
	directReportingAuthority: text('direct_reporting_authority'),
	dottedLineReportingAuthority: text('dotted_line_reporting_authority'),
	// Resolved counterpart of dottedLineReportingAuthority. The direct manager's
	// resolved link lives on users.reportsTo; this one has no equivalent there
	// because a dotted line does not carry approval rights.
	dottedLineManagerId: text('dotted_line_manager_id').references(() => users.id),
	// Reports to a top-level position — Chief or Mam, the heads of the company.
	// Neither has a login, so this stands in for a users.reportsTo link:
	// users.reportsTo stays null, and the person's requests go straight to their
	// concerned HR (see src/lib/chief.ts). topPosition says which of the two;
	// it is only read while reportsToChief is true.
	reportsToChief: integer('reports_to_chief', { mode: 'boolean' }).default(false).notNull(),
	topPosition: text('top_position').default('chief').notNull(),
	// The HR person who handles this employee's second-stage approvals. Set by a
	// Super Admin from the roster; when null, any admin picks the request up.
	// Assigning it puts the request in that person's queue first — it does not
	// lock others out, so nothing stalls when they are away.
	hrUserId: text('hr_user_id').references(() => users.id),
	sourceReferredBy: text('source_referred_by'),
	salaryBand: text('salary_band'),

	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
}, (t) => [index('employee_profiles_dotted_manager').on(t.dottedLineManagerId), index('employee_profiles_hr_user').on(t.hrUserId)]);

// --- Leave (§4.2) ---

export const leaveTypes = sqliteTable('leave_types', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	code: text('code', { length: 32 }), // e.g. 'EL', 'SL', 'MATERNITY' — stable key from the source policy doc
	name: text('name').notNull(),
	accrualPerMonth: numeric('accrual_per_month').default('0').notNull(),
	carryForwardCap: integer('carry_forward_cap').default(0).notNull(),
	encashmentEligible: integer('encashment_eligible', { mode: 'boolean' }).default(false).notNull(),
	// Fields populated when a leave type comes from a Super-Admin-published policy document
	eligibility: text('eligibility'), // 'post_probation' | 'pre_probation' | 'all'
	requiresDocumentation: integer('requires_documentation', { mode: 'boolean' }).default(false).notNull(),
	documentationNote: text('documentation_note'),
	fixedDays: integer('fixed_days'), // for event-based leave (maternity/paternity/bereavement), null if accrual-based
	// Monthly-quota leave (pink/menstrual): the entitlement refreshes every month
	// and does NOT accumulate — unused days expire at month end rather than
	// building a balance the way accrual leave does.
	monthlyQuotaDays: numeric('monthly_quota_days'),
	/**
	 * Ceiling on how much of this type one person may TAKE in a calendar month.
	 *
	 * Distinct from `monthlyQuotaDays`, which is an entitlement that refreshes
	 * and lapses and holds no balance. This one sits on top of an accumulating
	 * balance: someone with 127 days of earned leave still has 127 days, they
	 * just cannot spend them all in October. The balance is what they own; this
	 * is how fast they may draw it down.
	 *
	 * Null means no ceiling, which is the shipped default and what the written
	 * policy currently says — it states an accrual rate and a carry-forward cap,
	 * and nothing about a per-month limit. Set it per type from
	 * Admin → Publish Policies when that changes.
	 */
	monthlyUsageCap: numeric('monthly_usage_cap'),
	// Restricts who may apply. 'female' is used by pink leave; null = everyone.
	genderEligibility: text('gender_eligibility'), // 'female' | 'male' | null
	notes: text('notes'),
	sourceDocumentId: text('source_document_id'), // Mongo policy_documents._id this rule was extracted from
	policyVersion: integer('policy_version').default(1).notNull(),
	effectiveFrom: text('effective_from'),
	isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull()
});

// --- Holiday Calendar (Super Admin publishes; resolved per employee's shift group) ---

export const holidayCalendars = sqliteTable('holiday_calendars', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	shiftGroupId: text('shift_group_id')
		.references(() => shiftGroups.id)
		.notNull(),
	year: integer('year').notNull(),
	version: integer('version').default(1).notNull(),
	status: calendarStatusEnum('status').default('draft').notNull(),
	effectiveFrom: text('effective_from').notNull(),
	effectiveTo: text('effective_to'),
	sourceDocumentId: text('source_document_id'), // Mongo policy_documents._id (the uploaded jpeg/pdf)
	publishedBy: text('published_by').references(() => users.id),
	publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const holidays = sqliteTable('holidays', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	calendarId: text('calendar_id')
		.references(() => holidayCalendars.id)
		.notNull(),
	date: text('date').notNull(),
	name: text('name').notNull(),
	type: text('type').default('PUBLIC').notNull() // 'PUBLIC' | 'RESTRICTED' | 'OPTIONAL'
});

export const leaveAllocations = sqliteTable('leave_allocations', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	leaveTypeId: text('leave_type_id')
		.references(() => leaveTypes.id)
		.notNull(),
	year: integer('year').notNull(),
	allocatedDays: numeric('allocated_days').notNull(),
	usedDays: numeric('used_days').default('0').notNull(),

	// --- HR-set balances (Admin → Leave Balances CSV upload) ---
	// Set when HR uploads a figure by hand, which pins the row: the monthly
	// accrual recompute (src/lib/server/leave-accrual.ts) runs on every page load
	// and overwrites allocatedDays, so without this flag an uploaded balance would
	// silently revert the next time the employee opened the portal. Carry-forward
	// from HRone is exactly the case the policy accrual cannot derive on its own.
	isHrSet: integer('is_hr_set', { mode: 'boolean' }).default(false).notNull(),
	hrSetBy: text('hr_set_by').references(() => users.id),
	hrSetAt: integer('hr_set_at', { mode: 'timestamp_ms' }),
	hrSetNote: text('hr_set_note'),
	/**
	 * The figure HR uploaded, kept apart from the running `allocatedDays`.
	 *
	 * An uploaded balance is an OPENING balance, not a final one: earned leave
	 * keeps accruing on top of it at the policy's monthly rate. The recompute
	 * therefore has to answer "baseline plus the months since" every time it
	 * runs, and it runs on every page load — so it needs the baseline to still
	 * be there. Reading it back out of `allocatedDays` would compound: 39 would
	 * become 40.5, then 42 on the next load, then 43.5, all within one month.
	 *
	 * Null on rows uploaded before this column existed. Those keep the older
	 * behaviour of pinning `allocatedDays` exactly as given, because their
	 * baseline is genuinely unknown and inventing one would move real balances.
	 */
	hrSetDays: numeric('hr_set_days')
});

export const leaveApplications = sqliteTable('leave_applications', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	leaveTypeId: text('leave_type_id')
		.references(() => leaveTypes.id)
		.notNull(),
	startDate: text('start_date').notNull(),
	endDate: text('end_date').notNull(),
	days: numeric('days').notNull(),
	reason: text('reason'),
	status: leaveStatusEnum('status').default('pending').notNull(),
	approverId: text('approver_id').references((): any => users.id),
	decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
	decisionNote: text('decision_note'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const leaveLedger = sqliteTable('leave_ledger', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	leaveTypeId: text('leave_type_id')
		.references(() => leaveTypes.id)
		.notNull(),
	delta: numeric('delta').notNull(),
	reason: text('reason').notNull(),
	relatedApplicationId: text('related_application_id').references(() => leaveApplications.id),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

// --- Attendance (§4.3 — manual check-in only in Phase 1) ---

export const attendance = sqliteTable('attendance', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	date: text('date').notNull(),
	checkInAt: integer('check_in_at', { mode: 'timestamp_ms' }),
	checkOutAt: integer('check_out_at', { mode: 'timestamp_ms' }),
	source: attendanceSourceEnum('source').default('manual').notNull(),
	checkInLat: numeric('check_in_lat'),
	checkInLng: numeric('check_in_lng'),
	checkOutLat: numeric('check_out_lat'),
	checkOutLng: numeric('check_out_lng'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

// --- Relations ---

export const usersRelations = relations(users, ({ one, many }) => ({
	team: one(teams, { fields: [users.teamId], references: [teams.id] }),
	manager: one(users, { fields: [users.reportsTo], references: [users.id] }),
	profile: one(employeeProfiles, {
		fields: [users.id],
		references: [employeeProfiles.userId]
	}),
	leaveApplications: many(leaveApplications),
	attendance: many(attendance)
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
	department: one(departments, { fields: [teams.departmentId], references: [departments.id] }),
	teamLead: one(users, { fields: [teams.teamLeadId], references: [users.id] }),
	members: many(users)
}));

export const leaveApplicationsRelations = relations(leaveApplications, ({ one }) => ({
	user: one(users, { fields: [leaveApplications.userId], references: [users.id] }),
	leaveType: one(leaveTypes, {
		fields: [leaveApplications.leaveTypeId],
		references: [leaveTypes.id]
	}),
	approver: one(users, { fields: [leaveApplications.approverId], references: [users.id] })
}));

export const employeeProfilesRelations = relations(employeeProfiles, ({ one }) => ({
	user: one(users, { fields: [employeeProfiles.userId], references: [users.id] }),
	shiftGroup: one(shiftGroups, {
		fields: [employeeProfiles.shiftGroupId],
		references: [shiftGroups.id]
	})
}));

export const shiftGroupsRelations = relations(shiftGroups, ({ many }) => ({
	holidayCalendars: many(holidayCalendars),
	employeeProfiles: many(employeeProfiles)
}));

export const holidayCalendarsRelations = relations(holidayCalendars, ({ one, many }) => ({
	shiftGroup: one(shiftGroups, {
		fields: [holidayCalendars.shiftGroupId],
		references: [shiftGroups.id]
	}),
	publisher: one(users, { fields: [holidayCalendars.publishedBy], references: [users.id] }),
	holidays: many(holidays)
}));

export const holidaysRelations = relations(holidays, ({ one }) => ({
	calendar: one(holidayCalendars, { fields: [holidays.calendarId], references: [holidayCalendars.id] })
}));

// --- EasyTime Pro attendance ingestion ---
// EasyTime Pro exports a scheduled tab-separated file (see its "Data Template"
// screen) and a scheduled job on that machine POSTs it to
// /api/attendance/easytime-import. Auth is a shared token; only the hash is
// stored, and the plaintext is shown once at generation time.
export const attendanceImportTokens = sqliteTable('attendance_import_tokens', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	label: text('label').notNull(), // e.g. 'EasyTime Pro - Bangalore office'
	tokenHash: text('token_hash').notNull().unique(),
	createdBy: text('created_by').references(() => users.id),
	revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
	lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

// One row per uploaded export file — the audit trail of what was ingested when.
export const attendanceImports = sqliteTable('attendance_imports', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	tokenId: text('token_id').references(() => attendanceImportTokens.id),
	uploadedBy: text('uploaded_by').references(() => users.id),
	filename: text('filename'),
	rowCount: integer('row_count').notNull(),
	matchedCount: integer('matched_count').notNull(),
	unmatchedCount: integer('unmatched_count').notNull(),
	duplicateCount: integer('duplicate_count').default(0).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

// Every raw punch line from the export, kept for audit/replay whether or not its
// emp_code resolved to an employee. Unmatched rows stay here so HR can fix the
// employee code and re-apply rather than losing the punch.
export const devicePunches = sqliteTable(
	'device_punches',
	{
		id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
		importId: text('import_id').references(() => attendanceImports.id),
		// {emp_code} — the join key back to employee_profiles.employee_code
		empCode: text('emp_code').notNull(),
		firstName: text('first_name'),
		lastName: text('last_name'),
		deptCode: text('dept_code'),
		deptName: text('dept_name'),
		punchedAt: integer('punched_at', { mode: 'timestamp_ms' }).notNull(),
		verifyType: text('verify_type'),
		punchState: text('punch_state'), // raw {punch_state} from the device
		direction: text('direction'), // 'in' | 'out' | null once interpreted
		workCode: text('work_code'),
		cardNumber: text('card_number'),
		areaName: text('area_name'),
		terminalAlias: text('terminal_alias'),
		terminalSn: text('terminal_sn'),
		temperature: text('temperature'),
		maskFlag: text('mask_flag'),
		rawLine: text('raw_line').notNull(),
		matchedUserId: text('matched_user_id').references(() => users.id),
		attendanceId: text('attendance_id').references(() => attendance.id),
		dedupeKey: text('dedupe_key'),
		receivedAt: integer('received_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [uniqueIndex('device_punches_dedupe_key').on(t.dedupeKey)]
);

// --- ProHance activity ingestion (polled from the ProHance Web Services API) ---
// The portal POSTS to <PROHANCE_BASE_URL>/report/comprehensive/getdata
// (reportBy=User, viewBy=Day) on an interval and upserts one row per employee
// per day. "Employee ID" in ProHance is the same company employee code as
// employee_profiles.employee_code — that's the join key, exactly like EasyTime.

// One row per poll/manual run — the audit trail of what was pulled when.
export const prohanceSyncs = sqliteTable('prohance_syncs', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	trigger: text('trigger').default('poll').notNull(), // 'poll' | 'manual'
	rangeFrom: text('range_from').notNull(),
	rangeTo: text('range_to').notNull(),
	status: text('status').default('ok').notNull(), // 'ok' | 'error'
	rowCount: integer('row_count').default(0).notNull(),
	matchedCount: integer('matched_count').default(0).notNull(),
	unmatchedCount: integer('unmatched_count').default(0).notNull(),
	error: text('error'),
	startedAt: integer('started_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
});

// One employee-day of ProHance activity. Upserted on (emp_code, session_date):
// re-polling the same window refreshes rows in place, so the poller can safely
// re-cover "25th of last month → today" on every run. Rows whose employee code
// doesn't resolve to a user are kept unmatched, mirroring device_punches.
export const prohanceDays = sqliteTable(
	'prohance_days',
	{
		id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
		syncId: text('sync_id').references(() => prohanceSyncs.id), // last sync that touched this row
		empCode: text('emp_code').notNull(),
		consoleLoginId: text('console_login_id'),
		userName: text('user_name'),
		sessionDate: text('session_date').notNull(),
		firstLogin: integer('first_login', { mode: 'timestamp_ms' }),
		lastLogout: integer('last_logout', { mode: 'timestamp_ms' }),
		loggedMinutes: integer('logged_minutes'),
		activeMinutes: integer('active_minutes'),
		idleMinutes: integer('idle_minutes'),
		timeOnSystemMinutes: integer('time_on_system_minutes'),
		timeAwayMinutes: integer('time_away_minutes'),
		dayType: text('day_type'), // ProHance DayTypeAlias: Work Day / Weekly Off / Planned Leave…
		raw: text('raw', { mode: 'json' }), // flattened source row, for audit & future columns
		matchedUserId: text('matched_user_id').references(() => users.id),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [uniqueIndex('prohance_days_emp_code_session_date').on(t.empCode, t.sessionDate)]
);

export const bulkImportStatusEnum = sqliteEnum('bulk_import_status', ['pending_review', 'applied']);

export const bulkImportRowStatusEnum = sqliteEnum('bulk_import_row_status', [
	'ready',
	'needs_review',
	'created',
	'skipped_existing'
]);

// A single spreadsheet upload (e.g. "HR Team Master data" sheet), reviewed by the
// Super Admin before any login is actually created — nothing here touches `users`
// until POST .../apply. Reusable for any future sheet with the same column shape.
export const bulkImports = sqliteTable('bulk_imports', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	filename: text('filename').notNull(),
	uploadedBy: text('uploaded_by').references(() => users.id),
	status: bulkImportStatusEnum('status').default('pending_review').notNull(),
	rowCount: integer('row_count').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	appliedAt: integer('applied_at', { mode: 'timestamp_ms' })
});

// One row per person parsed from the sheet. reportsToRowId links to another row in the
// SAME import (reporting-line resolution happens within one batch); the Super Admin
// confirms/corrects this before applying. role/teamId are set by the Super Admin in the
// review step — this app has no automatic designation-to-role inference.
export const bulkImportRows = sqliteTable('bulk_import_rows', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	importId: text('import_id')
		.references(() => bulkImports.id)
		.notNull(),
	employeeCode: text('employee_code'),
	fullName: text('full_name').notNull(),
	designation: text('designation'),
	officialEmail: text('official_email').notNull(),
	teamAndFloor: text('team_and_floor'),
	reportingAuthorityRaw: text('reporting_authority_raw'),
	dottedLineAuthorityRaw: text('dotted_line_authority_raw'),
	/**
	 * The rest of the parsed spreadsheet row, verbatim. The tracker carries ~50
	 * profile fields; mirroring each as a column here would duplicate
	 * employeeProfiles for data that is transient by design — these rows exist
	 * only between upload and the Super Admin's approval, then stop being read.
	 */
	profileData: text('profile_data', { mode: 'json' }).$type<Record<string, unknown>>(),
	/** Data-quality notes from the parser, shown in the review screen. */
	repairNotes: text('repair_notes', { mode: 'json' }).$type<string[]>(),
	reportsToRowId: text('reports_to_row_id').references((): any => bulkImportRows.id),
	role: roleEnum('role').default('employee').notNull(),
	status: bulkImportRowStatusEnum('status').default('ready').notNull(),
	existingUserId: text('existing_user_id').references(() => users.id),
	createdUserId: text('created_user_id').references(() => users.id),
	/**
	 * Confirmed blue collar: a row with no work email that the reviewer said is
	 * a worker with no login, looked after by their reporting manager
	 * (src/lib/no-login.ts). Until this is set, such a row needs review.
	 */
	blueCollar: integer('blue_collar', { mode: 'boolean' }).default(false).notNull()
});

export const bulkImportsRelations = relations(bulkImports, ({ one, many }) => ({
	uploader: one(users, { fields: [bulkImports.uploadedBy], references: [users.id] }),
	rows: many(bulkImportRows)
}));

export const bulkImportRowsRelations = relations(bulkImportRows, ({ one }) => ({
	import: one(bulkImports, { fields: [bulkImportRows.importId], references: [bulkImports.id] }),
	reportsToRow: one(bulkImportRows, {
		fields: [bulkImportRows.reportsToRowId],
		references: [bulkImportRows.id]
	}),
	existingUser: one(users, { fields: [bulkImportRows.existingUserId], references: [users.id] }),
	createdUser: one(users, { fields: [bulkImportRows.createdUserId], references: [users.id] })
}));

// --- SOP: Attendance Deviations & Comp-Off ---------------------------------
//
// Both tables are request-and-approve records rather than derived state: the
// SOP makes HR the arbiter, so nothing here mutates attendance or leave
// balances until a decision is recorded.

export const attendanceDeviations = sqliteTable('attendance_deviations', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	// The working day whose attendance is wrong.
	date: text('date').notNull(),
	reason: deviationReasonEnum('reason').notNull(),
	// Free-text account from the employee; this is what the LLM reads.
	description: text('description').notNull(),
	// What the employee says the record should be, when they know.
	claimedCheckIn: text('claimed_check_in'), // 'HH:MM'
	claimedCheckOut: text('claimed_check_out'), // 'HH:MM'
	status: deviationStatusEnum('status').default('pending').notNull(),

	// --- LLM triage (advisory only; HR still decides) ---
	// Populated at submit time by src/lib/server/ai/triage-deviation.ts. Stored
	// so a decision can always be audited against what the model actually saw
	// and said, rather than re-running a non-deterministic call later.
	aiSummary: text('ai_summary'),
	aiSuggestedReason: deviationReasonEnum('ai_suggested_reason'),
	aiConfidence: numeric('ai_confidence'),
	aiEvidenceNote: text('ai_evidence_note'),
	aiFlags: text('ai_flags', { mode: 'json' }), // string[] — e.g. ["no_prohance_activity","outside_shift"]
	aiModel: text('ai_model'),
	aiRanAt: integer('ai_ran_at', { mode: 'timestamp_ms' }),

	// Snapshot of the corroborating data at submit time, so a later ProHance
	// re-sync can't silently change the basis of an approved request.
	evidenceSnapshot: text('evidence_snapshot', { mode: 'json' }),

	// SOP §2: counts toward the 3/month biometric cap.
	countsTowardMonthlyCap: integer('counts_toward_monthly_cap', { mode: 'boolean' }).default(true).notNull(),
	monthKey: text('month_key', { length: 7 }).notNull(), // 'YYYY-MM', for the cap query

	supportingDocumentId: text('supporting_document_id'), // Mongo policy_documents-style attachment
	reviewerId: text('reviewer_id').references((): any => users.id),
	reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
	reviewNote: text('review_note'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const compOffCredits = sqliteTable('comp_off_credits', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	// The holiday/weekend actually worked.
	workedDate: text('worked_date').notNull(),
	workedMinutes: integer('worked_minutes'), // from ProHance/biometric at claim time
	// SOP §1: 7+ hours on an eligible holiday or weekend earns one comp-off.
	status: compOffStatusEnum('status').default('pending').notNull(),
	// SOP §1: valid 3 months from the date earned, non-encashable.
	expiresOn: text('expires_on').notNull(),
	usedOn: text('used_on'),
	usedApplicationId: text('used_application_id').references(() => leaveApplications.id),
	evidenceSnapshot: text('evidence_snapshot', { mode: 'json' }),
	note: text('note'),
	approverId: text('approver_id').references((): any => users.id),
	decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
	decisionNote: text('decision_note'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

// --- Week-off rosters ------------------------------------------------------
//
// Two tables, deliberately: the *roster* is a reusable pattern the Super Admin
// authors once ("All Sundays", "Sat + Sun", "4-week rotation"), and the
// *assignment* is what actually gives one employee their days off for a date
// range. Separating them is what lets one roster be published to a team lead
// and applied to many people without copying the pattern per employee.

export const weekOffRosters = sqliteTable('week_off_rosters', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	name: text('name').notNull(),
	description: text('description'),
	pattern: weekOffPatternEnum('pattern').notNull(),

	// 'fixed': the weekdays off every week, 0 = Sunday … 6 = Saturday.
	// [0] is "all Sundays"; [0,6] is "Saturday + Sunday".
	weekdays: text('weekdays', { mode: 'json' }).$type<number[]>(),

	// 'rotational': one weekday set per week of the cycle, e.g.
	// [[0], [0,6], [0], [5,6]] is a 4-week rotation. cycleWeeks is
	// rotationWeeks.length, stored so the rotation can be queried without
	// unpacking the JSON.
	rotationWeeks: text('rotation_weeks', { mode: 'json' }).$type<number[][]>(),
	cycleWeeks: integer('cycle_weeks'),
	// Week 1 of the rotation is the week containing this date. Every assignment
	// counts elapsed weeks from here, so two employees on the same roster stay
	// in phase with each other regardless of when they were assigned.
	rotationAnchorDate: text('rotation_anchor_date'),

	// Team-specific rosters only appear to that team's manager; a null teamId is
	// an org-wide template any manager may apply.
	teamId: text('team_id').references(() => teams.id),

	// Drafts are editable and invisible to team leads. Publishing is what makes a
	// roster assignable — same lifecycle as a holiday calendar.
	status: calendarStatusEnum('status').default('draft').notNull(),
	createdBy: text('created_by').references((): any => users.id),
	publishedBy: text('published_by').references((): any => users.id),
	publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const weekOffAssignments = sqliteTable('week_off_assignments', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	rosterId: text('roster_id')
		.references(() => weekOffRosters.id)
		.notNull(),
	// Open-ended by default: effectiveTo is set when a later assignment supersedes
	// this one, so an employee's history stays readable rather than being
	// overwritten each time their roster changes.
	effectiveFrom: text('effective_from').notNull(),
	effectiveTo: text('effective_to'),
	assignedBy: text('assigned_by').references((): any => users.id),
	note: text('note'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const weekOffRostersRelations = relations(weekOffRosters, ({ one, many }) => ({
	team: one(teams, { fields: [weekOffRosters.teamId], references: [teams.id] }),
	creator: one(users, { fields: [weekOffRosters.createdBy], references: [users.id] }),
	publisher: one(users, { fields: [weekOffRosters.publishedBy], references: [users.id] }),
	assignments: many(weekOffAssignments)
}));

export const weekOffAssignmentsRelations = relations(weekOffAssignments, ({ one }) => ({
	user: one(users, { fields: [weekOffAssignments.userId], references: [users.id] }),
	roster: one(weekOffRosters, {
		fields: [weekOffAssignments.rosterId],
		references: [weekOffRosters.id]
	}),
	assigner: one(users, { fields: [weekOffAssignments.assignedBy], references: [users.id] })
}));

export const attendanceDeviationsRelations = relations(attendanceDeviations, ({ one }) => ({
	user: one(users, { fields: [attendanceDeviations.userId], references: [users.id] }),
	reviewer: one(users, { fields: [attendanceDeviations.reviewerId], references: [users.id] })
}));

export const compOffCreditsRelations = relations(compOffCredits, ({ one }) => ({
	user: one(users, { fields: [compOffCredits.userId], references: [users.id] }),
	approver: one(users, { fields: [compOffCredits.approverId], references: [users.id] })
}));

// --- Company announcements ---
// HR posts; employees see the ones meant for them. The kind decides where a
// post appears and when it goes away on its own: an urgent notice is shown
// first for `urgentDays`, an event is listed by its date and drops off the day
// after, an update sits in a quiet list and moves to "Earlier" after a week.
// See src/lib/announcements.ts for those rules.

export const announcementKindEnum = sqliteEnum('announcement_kind', ['urgent', 'event', 'update']);
export const announcementStatusEnum = sqliteEnum('announcement_status', ['draft', 'published', 'taken_down']);

export const announcements = sqliteTable('announcements', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	kind: announcementKindEnum('kind').notNull(),
	title: text('title').notNull(),
	/** The one line employees see. Null = first sentence of `body`. */
	summary: text('summary'),
	body: text('body').default('').notNull(),
	eventDate: text('event_date'),
	eventTime: text('event_time', { length: 5 }), // 'HH:MM', IST
	// Audience: everyone, or anyone in any of the listed teams or shift groups.
	audienceAll: integer('audience_all', { mode: 'boolean' }).default(true).notNull(),
	audienceTeamIds: text('audience_team_ids', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
	audienceShiftGroupIds: text('audience_shift_group_ids', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
	requiresAck: integer('requires_ack', { mode: 'boolean' }).default(false).notNull(),
	urgentDays: integer('urgent_days').default(3).notNull(),
	emailCopy: integer('email_copy', { mode: 'boolean' }).default(false).notNull(),
	/** Set when the email copy is claimed for sending, so it goes out once. */
	emailSentAt: integer('email_sent_at', { mode: 'timestamp_ms' }),
	attachmentId: text('attachment_id'), // Mongo announcement_files._id
	attachmentName: text('attachment_name'),
	status: announcementStatusEnum('status').default('draft').notNull(),
	/** When it becomes visible. In the future = scheduled. */
	publishAt: integer('publish_at', { mode: 'timestamp_ms' }),
	createdBy: text('created_by').references(() => users.id),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	/** Set when a published post is changed, so employees see "Edited". */
	editedAt: integer('edited_at', { mode: 'timestamp_ms' })
});

/** One row per person per announcement they have opened. */
export const announcementReads = sqliteTable(
	'announcement_reads',
	{
		announcementId: text('announcement_id')
			.references(() => announcements.id, { onDelete: 'cascade' })
			.notNull(),
		userId: text('user_id')
			.references(() => users.id)
			.notNull(),
		readAt: integer('read_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
		/** "I've read this", on posts that ask for it. */
		acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp_ms' }),
		/** "Got it" on an urgent post: it stops being shown first. */
		dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' })
	},
	(t) => [uniqueIndex('announcement_reads_announcement_user').on(t.announcementId, t.userId)]
);

// --- Named roles and privileges ---

export const customRoles = sqliteTable('custom_roles', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	name: text('name').notNull().unique(),
	description: text('description').default('').notNull(),
	/** The base role people with this named role start from. Never super_admin. */
	baseRole: roleEnum('base_role').default('employee').notNull(),
	/** Privilege keys from src/lib/capabilities.ts. */
	capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
	createdBy: text('created_by').references((): any => users.id),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

/**
 * Manager delegations — "act for me while I am away".
 *
 * Time-boxed and one hop: while live, `toId` reaches the people whose manager
 * stage `fromId` holds and may give that sign-off on their requests
 * (src/lib/org-scope.ts, src/lib/server/approval-chain.ts). Responsibility
 * stays with `fromId`; when the window closes nothing has to be undone.
 * Revoking sets `revokedAt` rather than deleting, so the audit trail keeps
 * who could approve what, and when.
 */
export const delegations = sqliteTable(
	'delegations',
	{
		id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
		fromId: text('from_id')
			.references(() => users.id, { onDelete: 'cascade' })
			.notNull(),
		toId: text('to_id')
			.references(() => users.id, { onDelete: 'cascade' })
			.notNull(),
		startsOn: text('starts_on').notNull(),
		endsOn: text('ends_on').notNull(),
		reason: text('reason'),
		createdBy: text('created_by').references((): any => users.id, { onDelete: 'set null' }),
		revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [
		index('delegations_from_window').on(t.fromId, t.startsOn, t.endsOn),
		index('delegations_to').on(t.toId),
		check('delegations_window_valid', sql`${t.endsOn} >= ${t.startsOn}`),
		check('delegations_not_self', sql`${t.fromId} <> ${t.toId}`)
	]
);

/** Small key-value settings the app owns, such as the web push keys. */
// --- Payroll (Payroll → tracker and salary report) ---

/**
 * What Finance decides per person per payroll cycle, on top of what the
 * portal computes from attendance and leave (src/lib/server/payroll.ts).
 * `cycleKey` is the cycle's end month, 'YYYY-MM' (26th → 25th, see
 * $lib/attendance-cycle). One row per person per cycle, only when something
 * was set — no row means "pay as computed".
 */
export const payrollAdjustments = sqliteTable(
	'payroll_adjustments',
	{
		id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.references(() => users.id, { onDelete: 'cascade' })
			.notNull(),
		cycleKey: text('cycle_key', { length: 7 }).notNull(),
		// 'pay' | 'stop' | 'hold' | 'sabbatical'. Null = decided by the portal:
		// a leaver whose last working day falls on or before the cycle's end is
		// stopped, everyone else is paid.
		salaryAction: text('salary_action'),
		// The HR Comments sheet: a short category ("Maternity Leave", "Salary
		// revert") and its detail.
		comment: text('comment'),
		remarks: text('remarks'),
		// Replaces the computed opening leave balance for this cycle, when
		// Finance has the figure from the previous month's report.
		openingBalance: numeric('opening_balance'),
		updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [uniqueIndex('payroll_adjustments_user_cycle').on(t.userId, t.cycleKey)]
);

/**
 * Manual edits to a payroll sheet before it is downloaded (Payroll → Preview).
 * One row per edited cell: `rowKey` is the sheet row's key (a user id, or
 * `<cycle>:<user id>` on Stop Salary, or `manual:<uuid>` for a row Finance
 * added) and `column` the sheet's header text. Two marker columns record a
 * whole-row change: `__removed__` drops a computed row, `__added__` creates a
 * manual one. `original` is what the portal had computed when the edit was made.
 */
export const payrollCellOverrides = sqliteTable(
	'payroll_cell_overrides',
	{
		id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
		cycleKey: text('cycle_key', { length: 7 }).notNull(),
		sheet: text('sheet', { length: 32 }).notNull(),
		rowKey: text('row_key', { length: 96 }).notNull(),
		column: text('column').notNull(),
		value: text('value'),
		original: text('original'),
		updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [uniqueIndex('payroll_cell_overrides_cell').on(t.cycleKey, t.sheet, t.rowKey, t.column)]
);

/**
 * The A/B check: HR's manually made report for a month compared with the
 * portal's own computation (before manual edits). One row per upload; the
 * file itself is not kept, only the comparison.
 */
export const payrollReconciliations = sqliteTable('payroll_reconciliations', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	cycleKey: text('cycle_key', { length: 7 }).notNull(),
	fileName: text('file_name').notNull(),
	comparedCells: integer('compared_cells').notNull(),
	matchedCells: integer('matched_cells').notNull(),
	result: text('result', { mode: 'json' }).notNull(),
	uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const appSettings = sqliteTable('app_settings', {
	key: text('key').primaryKey(),
	value: text('value', { mode: 'json' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

// --- Champ Chat ---
// Channels, DMs, group chats, the #ask-hr desk and each person's ESS notice
// feed are all rows here, so one message model serves them all. Team and
// shift channels are kept in step with the roster by src/lib/server/chat/sync.ts.

export const chatChannelKindEnum = sqliteEnum('chat_channel_kind', [
	'channel',
	'dm',
	'group',
	'desk',
	'system',
	'announcements'
]);
export const chatChannelSourceEnum = sqliteEnum('chat_channel_source', ['manual', 'team', 'shift', 'everyone']);

export const chatChannels = sqliteTable('chat_channels', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	kind: chatChannelKindEnum('kind').notNull(),
	name: text('name').default('').notNull(),
	topic: text('topic').default('').notNull(),
	source: chatChannelSourceEnum('source').default('manual').notNull(),
	/** The team or shift group an automatic channel mirrors. */
	sourceId: text('source_id'),
	isPrivate: integer('is_private', { mode: 'boolean' }).default(false).notNull(),
	readOnly: integer('read_only', { mode: 'boolean' }).default(false).notNull(),
	/** Set on a channel a Team Lead created for their team: members come from it. */
	teamId: text('team_id').references(() => teams.id),
	/**
	 * Uniqueness key for conversations there must only be one of: a DM
	 * ("dm:<id>:<id>", ids sorted), a person's ESS feed ("system:<id>"), their
	 * #ask-hr thread ("desk:<id>"), and the automatic channels.
	 */
	uniqueKey: text('unique_key').unique(),
	/** For a desk thread: whose question it is, and whether HR has closed it. */
	deskOwnerId: text('desk_owner_id').references(() => users.id),
	deskStatus: text('desk_status'),
	createdBy: text('created_by').references(() => users.id),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	lastMessageAt: integer('last_message_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	archivedAt: integer('archived_at', { mode: 'timestamp_ms' })
});

export const chatMembers = sqliteTable(
	'chat_members',
	{
		channelId: text('channel_id')
			.references(() => chatChannels.id, { onDelete: 'cascade' })
			.notNull(),
		userId: text('user_id')
			.references(() => users.id)
			.notNull(),
		role: text('role').default('member').notNull(), // 'member' | 'admin'
		/** 'sync' = put here by the roster, 'person' = added by someone. */
		addedBy: text('added_by').default('person').notNull(),
		lastReadAt: integer('last_read_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
		mutedUntil: integer('muted_until', { mode: 'timestamp_ms' }),
		/** 'all' | 'mentions' | 'none' */
		notify: text('notify').default('all').notNull(),
		lastDigestAt: integer('last_digest_at', { mode: 'timestamp_ms' }),
		joinedAt: integer('joined_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [uniqueIndex('chat_members_channel_user').on(t.channelId, t.userId)]
);

export const chatMessages = sqliteTable('chat_messages', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	channelId: text('channel_id')
		.references(() => chatChannels.id, { onDelete: 'cascade' })
		.notNull(),
	threadRootId: text('thread_root_id'),
	/** Null for messages ESS or Champ posts. */
	authorId: text('author_id').references(() => users.id),
	/** 'text' | 'card' | 'system' | 'poll' | 'champ' */
	kind: text('kind').default('text').notNull(),
	body: text('body').default('').notNull(),
	/** Structured payload for cards and polls, e.g. { type: 'leave', id }. */
	card: text('card', { mode: 'json' }),
	fileId: text('file_id'),
	fileName: text('file_name'),
	fileMime: text('file_mime'),
	fileSize: integer('file_size'),
	mentions: text('mentions', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
	mentionsAll: integer('mentions_all', { mode: 'boolean' }).default(false).notNull(),
	/** Sent after the sender confirmed the "looks like Aadhaar/PAN" warning. */
	sensitive: integer('sensitive', { mode: 'boolean' }).default(false).notNull(),
	/** Set when only one person may see the message (a private Champ reply). */
	visibleTo: text('visible_to').references(() => users.id),
	editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
	deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
	hiddenAt: integer('hidden_at', { mode: 'timestamp_ms' }),
	hiddenBy: text('hidden_by').references(() => users.id),
	pinnedAt: integer('pinned_at', { mode: 'timestamp_ms' }),
	pinnedBy: text('pinned_by').references(() => users.id),
	replyCount: integer('reply_count').default(0).notNull(),
	lastReplyAt: integer('last_reply_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const chatReactions = sqliteTable(
	'chat_reactions',
	{
		messageId: text('message_id')
			.references(() => chatMessages.id, { onDelete: 'cascade' })
			.notNull(),
		userId: text('user_id')
			.references(() => users.id)
			.notNull(),
		emoji: text('emoji').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [uniqueIndex('chat_reactions_message_user_emoji').on(t.messageId, t.userId, t.emoji)]
);

export const chatSaved = sqliteTable(
	'chat_saved',
	{
		messageId: text('message_id')
			.references(() => chatMessages.id, { onDelete: 'cascade' })
			.notNull(),
		userId: text('user_id')
			.references(() => users.id)
			.notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [uniqueIndex('chat_saved_message_user').on(t.messageId, t.userId)]
);

export const chatReports = sqliteTable('chat_reports', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	messageId: text('message_id')
		.references(() => chatMessages.id, { onDelete: 'cascade' })
		.notNull(),
	reportedBy: text('reported_by')
		.references(() => users.id)
		.notNull(),
	reason: text('reason').notNull(),
	status: text('status').default('open').notNull(), // 'open' | 'hidden' | 'dismissed'
	decidedBy: text('decided_by').references(() => users.id),
	decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const chatPollVotes = sqliteTable(
	'chat_poll_votes',
	{
		messageId: text('message_id')
			.references(() => chatMessages.id, { onDelete: 'cascade' })
			.notNull(),
		userId: text('user_id')
			.references(() => users.id)
			.notNull(),
		optionIndex: integer('option_index').notNull()
	},
	(t) => [uniqueIndex('chat_poll_votes_message_user_option').on(t.messageId, t.userId, t.optionIndex)]
);

export const chatTodos = sqliteTable('chat_todos', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	channelId: text('channel_id')
		.references(() => chatChannels.id, { onDelete: 'cascade' })
		.notNull(),
	text: text('text').notNull(),
	createdBy: text('created_by').references(() => users.id),
	doneBy: text('done_by').references(() => users.id),
	doneAt: integer('done_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const chatReminders = sqliteTable('chat_reminders', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	/** Where it was set, so the reminder can link back. */
	channelId: text('channel_id').references(() => chatChannels.id, { onDelete: 'set null' }),
	text: text('text').notNull(),
	remindAt: integer('remind_at', { mode: 'timestamp_ms' }).notNull(),
	sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const chatPrefs = sqliteTable('chat_prefs', {
	userId: text('user_id')
		.primaryKey()
		.references(() => users.id),
	emailDigest: integer('email_digest', { mode: 'boolean' }).default(true).notNull(),
	sound: integer('sound', { mode: 'boolean' }).default(true).notNull(),
	/** Birthday and work-anniversary posts about this person. */
	celebrations: integer('celebrations', { mode: 'boolean' }).default(true).notNull(),
	push: integer('push', { mode: 'boolean' }).default(true).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const pushSubscriptions = sqliteTable('push_subscriptions', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	endpoint: text('endpoint').notNull().unique(),
	p256dh: text('p256dh').notNull(),
	auth: text('auth').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

/** One row per celebration posted, so a restart never posts it twice. */
export const chatCelebrations = sqliteTable(
	'chat_celebrations',
	{
		userId: text('user_id')
			.references(() => users.id)
			.notNull(),
		kind: text('kind').notNull(), // 'birthday' | 'anniversary'
		onDate: text('on_date').notNull()
	},
	(t) => [uniqueIndex('chat_celebrations_user_kind_date').on(t.userId, t.kind, t.onDate)]
);

// --- Champ tasks (the Requests tab) ---

export const champTasks = sqliteTable('champ_tasks', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	fromUser: text('from_user')
		.references(() => users.id)
		.notNull(),
	toUser: text('to_user')
		.references(() => users.id)
		.notNull(),
	title: text('title').notNull(),
	dueAt: integer('due_at', { mode: 'timestamp_ms' }),
	status: text('status').default('open').notNull(), // 'open' | 'done' | 'declined' | 'withdrawn'
	note: text('note'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	decidedAt: integer('decided_at', { mode: 'timestamp_ms' })
});

// --- Champ Hub: tasks, meetings and Zoom ---
// One task model for everything: a task someone writes for themselves, one a
// lead gives a report, one made from a chat message, and one published from a
// meeting's minutes. Where a task came from is kept on the row (meetingId or
// sourceMessageId, plus the exact line as sourceQuote) so it still reads right
// after the minutes or the message are gone. Who may give whom a task lives in
// src/lib/tasks/rules.ts.

export const taskStatusEnum = sqliteEnum('task_status', ['todo', 'in_progress', 'in_review', 'done']);
export const taskPriorityEnum = sqliteEnum('task_priority', ['low', 'medium', 'high']);
export const meetingStateEnum = sqliteEnum('meeting_state', ['upcoming', 'waiting', 'ready', 'published', 'no_summary', 'cancelled']);

export const meetings = sqliteTable('meetings', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	/** Zoom's per-occurrence UUID. A recurring meeting shares its id, never this. Null for pasted notes. */
	zoomUuid: text('zoom_uuid').unique(),
	zoomMeetingId: text('zoom_meeting_id'),
	hostId: text('host_id').references(() => users.id),
	/** As Zoom gave it, for a host who has no login linked yet. */
	hostEmail: text('host_email'),
	topic: text('topic').notNull(),
	startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
	durationMin: integer('duration_min'),
	/** Set for meetings scheduled from ESS: where people join. */
	joinUrl: text('join_url'),
	agenda: text('agenda'),
	state: meetingStateEnum('state').default('waiting').notNull(),
	/** { overview, details: [{ label, text }], nextSteps: string[] } */
	summary: text('summary', { mode: 'json' }).$type<{ overview: string; details: { label: string; text: string }[]; nextSteps: string[] }>(),
	/** The model's raw output and name, kept so a review can be audited later. */
	extraction: text('extraction', { mode: 'json' }),
	/** 'zoom' | 'pasted' */
	source: text('source').default('zoom').notNull(),
	/** Attendees ESS could match to a login. */
	attendeeIds: text('attendee_ids', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
	/** Attendees it could not, as Zoom named them. */
	guestNames: text('guest_names', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
	publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
	publishedBy: text('published_by').references(() => users.id),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const tasks = sqliteTable('tasks', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	title: text('title').notNull(),
	description: text('description').default('').notNull(),
	/** Null = Unassigned, on the creator's team board. */
	assigneeId: text('assignee_id').references(() => users.id),
	createdBy: text('created_by')
		.references(() => users.id)
		.notNull(),
	status: taskStatusEnum('status').default('todo').notNull(),
	priority: taskPriorityEnum('priority').default('medium').notNull(),
	dueDate: text('due_date'),
	blocked: integer('blocked', { mode: 'boolean' }).default(false).notNull(),
	/**
	 * Lead approval. 'pending' while the assignee's lead has yet to approve a
	 * task someone else gave them; 'declined' once the lead said no (the task
	 * goes back to whoever made it, with requestNote as the reason).
	 */
	requestState: text('request_state'), // null | 'pending' | 'declined'
	requestNote: text('request_note'),
	/** The lead who must approve it: the assignee's manager when it was given. */
	approverId: text('approver_id').references((): any => users.id),
	/** Fractional index within a column (src/lib/tasks/rules.ts rankBetween). */
	rank: text('rank').default('i').notNull(),
	/** Bumped on every change; a write that names an older version is refused. */
	version: integer('version').default(1).notNull(),
	meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
	sourceMessageId: text('source_message_id').references(() => chatMessages.id, { onDelete: 'set null' }),
	sourceChannelId: text('source_channel_id').references(() => chatChannels.id, { onDelete: 'set null' }),
	/** The line from the minutes or the message, kept verbatim. */
	sourceQuote: text('source_quote'),
	completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const taskSubtasks = sqliteTable('task_subtasks', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	taskId: text('task_id')
		.references(() => tasks.id, { onDelete: 'cascade' })
		.notNull(),
	title: text('title').notNull(),
	done: integer('done', { mode: 'boolean' }).default(false).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

/** Comments and the activity line ("moved this to In review") share one list. */
export const taskEvents = sqliteTable('task_events', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	taskId: text('task_id')
		.references(() => tasks.id, { onDelete: 'cascade' })
		.notNull(),
	actorId: text('actor_id').references(() => users.id),
	/** 'comment' | 'activity' */
	kind: text('kind').default('activity').notNull(),
	body: text('body').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

export const meetingItems = sqliteTable('meeting_items', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	meetingId: text('meeting_id')
		.references(() => meetings.id, { onDelete: 'cascade' })
		.notNull(),
	title: text('title').notNull(),
	ownerId: text('owner_id').references(() => users.id),
	/** The name the minutes used, shown when no login matched it. */
	ownerHeard: text('owner_heard'),
	dueDate: text('due_date'),
	priority: taskPriorityEnum('priority').default('medium').notNull(),
	/** Which next step it came from; null for one the host added. */
	stepIndex: integer('step_index'),
	confidence: numeric('confidence'),
	included: integer('included', { mode: 'boolean' }).default(true).notNull(),
	taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
	position: integer('position').default(0).notNull()
});

/** A Zoom user who is not matched by work email, linked to a login by hand. */
export const zoomUserLinks = sqliteTable('zoom_user_links', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	/** Lower-cased email or Zoom display name. */
	zoomKey: text('zoom_key').notNull().unique(),
	userId: text('user_id')
		.references(() => users.id)
		.notNull(),
	linkedBy: text('linked_by').references(() => users.id),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

/** "Later" on a Today item: hidden for this person until `until`. */
export const hubDismissals = sqliteTable(
	'hub_dismissals',
	{
		userId: text('user_id')
			.references(() => users.id)
			.notNull(),
		needKey: text('need_key').notNull(),
		until: integer('until', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [uniqueIndex('hub_dismissals_user_key').on(t.userId, t.needKey)]
);

// --- Login emails waiting for an admin ---
// A new login's welcome email (username + temporary password) is never sent
// the moment the login is made. It waits here until someone with "Approve
// login emails" approves it, then goes out one at a time at the cadence set
// in Admin Controls › People (app_settings 'login_email_settings'). The
// password itself is not stored here: it is read from users.temporary_password
// at send time, so a person who has already set their own is simply skipped.

export const loginEmailStatusEnum = sqliteEnum('login_email_status', ['pending', 'approved', 'sending', 'sent', 'failed', 'cancelled', 'skipped']);

export const loginEmails = sqliteTable('login_emails', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	userId: text('user_id')
		.references(() => users.id, { onDelete: 'cascade' })
		.notNull(),
	/** 'single' | 'bulk' | 'reissue' | 'champ' */
	source: text('source').notNull(),
	importId: text('import_id').references(() => bulkImports.id, { onDelete: 'set null' }),
	/** Deliver to this address instead of the login email (a test inbox). */
	sendTo: text('send_to'),
	status: loginEmailStatusEnum('status').default('pending').notNull(),
	requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
	approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
	approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
	attemptedAt: integer('attempted_at', { mode: 'timestamp_ms' }),
	sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
	error: text('error'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
});

// --- Records that used to live in MongoDB (Cloudflare migration) ---
// What used to live in MongoDB: the activity log and the records of uploaded
// files. The file bytes themselves are in R2 (the FILES bucket) under
// `files/<id>` (src/lib/server/db/store.ts). Ids carried over from Mongo keep their
// ObjectId string so existing references (chat_messages.file_id,
// announcements.attachment_id, *.source_document_id) still resolve.

export const activityLog = sqliteTable(
	'activity_log',
	{
		id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
		actorUserId: text('actor_user_id').notNull(),
		action: text('action').notNull(),
		targetType: text('target_type').notNull(),
		targetId: text('target_id'),
		details: text('details', { mode: 'json' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [
		index('activity_log_created_idx').on(t.createdAt),
		index('activity_log_action_idx').on(t.action, t.createdAt),
		index('activity_log_actor_idx').on(t.actorUserId, t.createdAt),
		index('activity_log_target_idx').on(t.targetId)
	]
);

/** 'policy' | 'avatar' | 'announcement' | 'chat' */
export const storedFiles = sqliteTable(
	'stored_files',
	{
		id: text('id').primaryKey(),
		kind: text('kind').notNull(),
		/** For avatars, the user the picture belongs to (one per user). */
		ownerId: text('owner_id'),
		filename: text('filename').notNull(),
		mimeType: text('mime_type').notNull(),
		byteSize: integer('byte_size').notNull(),
		uploadedBy: text('uploaded_by'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull()
	},
	(t) => [uniqueIndex('stored_files_avatar_owner_idx').on(t.ownerId).where(sql`kind = 'avatar'`), index('stored_files_kind_idx').on(t.kind)]
);

export const policyDocuments = sqliteTable(
	'policy_documents',
	{
		id: text('id').primaryKey(),
		/** 'holiday_calendar' | 'leave_policy' */
		kind: text('kind').notNull(),
		fileId: text('file_id').notNull(),
		uploadedBy: text('uploaded_by').notNull(),
		extractedJson: text('extracted_json', { mode: 'json' }),
		extractionModel: text('extraction_model'),
		/** 'uploaded' | 'extracted' | 'extraction_failed' | 'published' */
		status: text('status').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(NOW_MS).notNull(),
		publishedAt: integer('published_at', { mode: 'timestamp_ms' })
	},
	(t) => [index('policy_documents_created_idx').on(t.createdAt)]
);
