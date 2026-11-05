-- What the Postgres migrations did besides creating tables, redone for SQLite.

-- Managers get Team Lead access on their own (was drizzle/0030_auto_team_lead.sql):
-- a plain Employee becomes a Team Lead when someone's reporting line is newly
-- pointed at them, or when they are newly set to report to Chief. It fires only
-- when the line actually changes, so a Super Admin who sets the role back by
-- hand is not overridden by later saves. Admins, Super Admins and people on a
-- named role keep the access they have.
CREATE TRIGGER IF NOT EXISTS users_promote_reporting_manager_insert
AFTER INSERT ON users
WHEN NEW.reports_to IS NOT NULL
BEGIN
	UPDATE users SET role = 'team_lead'
	WHERE id = NEW.reports_to AND role = 'employee' AND custom_role_id IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS users_promote_reporting_manager_update
AFTER UPDATE OF reports_to ON users
WHEN NEW.reports_to IS NOT NULL AND NEW.reports_to IS NOT OLD.reports_to
BEGIN
	UPDATE users SET role = 'team_lead'
	WHERE id = NEW.reports_to AND role = 'employee' AND custom_role_id IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS employee_profiles_promote_chief_report_insert
AFTER INSERT ON employee_profiles
WHEN NEW.reports_to_chief = 1
BEGIN
	UPDATE users SET role = 'team_lead'
	WHERE id = NEW.user_id AND role = 'employee' AND custom_role_id IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS employee_profiles_promote_chief_report_update
AFTER UPDATE OF reports_to_chief ON employee_profiles
WHEN NEW.reports_to_chief = 1 AND OLD.reports_to_chief = 0
BEGIN
	UPDATE users SET role = 'team_lead'
	WHERE id = NEW.user_id AND role = 'employee' AND custom_role_id IS NULL;
END;
--> statement-breakpoint

-- Pink Leave (was drizzle/0008_pink_leave.sql).
INSERT INTO leave_types (
	id, code, name, accrual_per_month, carry_forward_cap,
	encashment_eligible, eligibility, requires_documentation,
	monthly_quota_days, gender_eligibility, notes, is_active
)
SELECT
	'8d0c1f52-6b0e-4a51-9a7e-5f2b1c3d4e01', 'PINK', 'Pink Leave', 0, 0,
	0, 'post_probation', 0,
	1, 'female',
	'One day per calendar month for confirmed female employees. Does not carry over — unused days expire at month end.',
	1
WHERE NOT EXISTS (SELECT 1 FROM leave_types WHERE upper(code) = 'PINK');
--> statement-breakpoint

-- The two built-in named roles (was drizzle/0021_chat_and_roles.sql).
INSERT INTO custom_roles (id, name, description, base_role, capabilities) VALUES
	('8d0c1f52-6b0e-4a51-9a7e-5f2b1c3d4e02', 'IT Support', 'Looks after logins, passwords and the biometric devices.', 'employee',
		'["people.directory","people.create_login","people.reset_password","people.password_activity","people.employee_code","attendance.biometric_upload","attendance.device_sync","chat.dm_anyone"]'),
	('8d0c1f52-6b0e-4a51-9a7e-5f2b1c3d4e03', 'Operations', 'Runs day-to-day operations across teams: rosters, attendance and channels.', 'employee',
		'["people.directory","org.view","attendance.biometric_upload","leave.week_off_rosters","chat.dm_anyone","chat.create_channels","chat.mention_all"]')
ON CONFLICT (name) DO NOTHING;
