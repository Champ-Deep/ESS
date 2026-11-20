-- Bulk imports never set employee_profiles.shift_group_id, so everyone
-- imported from the HR sheet saw no holiday calendar (Policies, Today,
-- Leave) and had no holidays counted in attendance or payroll. Fill it in
-- the same way imports now do (src/lib/shift-group-match.ts), only where it
-- is still empty: first from the sheet's "Type of shift" text when it names a
-- group exactly; then, in a company with a single shift group, that group.
UPDATE employee_profiles p
SET shift_group_id = g.id, updated_at = now()
FROM shift_groups g
WHERE p.shift_group_id IS NULL
	AND p.shift_type IS NOT NULL
	AND (
		lower(trim(p.shift_type)) = lower(trim(g.name))
		OR lower(trim(p.shift_type)) = lower(g.key)
	);
--> statement-breakpoint
UPDATE employee_profiles
SET shift_group_id = (SELECT id FROM shift_groups LIMIT 1), updated_at = now()
WHERE shift_group_id IS NULL
	AND (SELECT count(*) FROM shift_groups) = 1;
