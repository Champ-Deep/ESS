-- Subhakar Rao is Chief and Hema Malini is Mam (src/lib/chief.ts). HR sheets
-- name them in the reporting column, and until now an import left anyone so
-- named with no reporting line at all. Move them under the position — only
-- where no real manager is linked, so a users.reports_to always wins. The
-- promote_chief_report trigger (0030) gives them Team Lead access, as for
-- anyone newly under Chief.
UPDATE employee_profiles p
SET reports_to_chief = true, top_position = 'chief'
FROM users u
WHERE u.id = p.user_id
	AND u.reports_to IS NULL
	AND NOT p.reports_to_chief
	AND lower(trim(p.direct_reporting_authority)) IN ('subhakar rao', 'subhakara rao');
--> statement-breakpoint
UPDATE employee_profiles p
SET reports_to_chief = true, top_position = 'mam'
FROM users u
WHERE u.id = p.user_id
	AND u.reports_to IS NULL
	AND NOT p.reports_to_chief
	AND lower(trim(p.direct_reporting_authority)) IN ('hema malini', 'hemamalini');
