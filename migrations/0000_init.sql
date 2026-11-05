CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`details` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_log_created_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `activity_log_action_idx` ON `activity_log` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_log_actor_idx` ON `activity_log` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_log_target_idx` ON `activity_log` (`target_id`);--> statement-breakpoint
CREATE TABLE `announcement_reads` (
	`announcement_id` text NOT NULL,
	`user_id` text NOT NULL,
	`read_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`acknowledged_at` integer,
	`dismissed_at` integer,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcement_reads_announcement_user` ON `announcement_reads` (`announcement_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`body` text DEFAULT '' NOT NULL,
	`event_date` text,
	`event_time` text(5),
	`audience_all` integer DEFAULT true NOT NULL,
	`audience_team_ids` text DEFAULT '[]' NOT NULL,
	`audience_shift_group_ids` text DEFAULT '[]' NOT NULL,
	`requires_ack` integer DEFAULT false NOT NULL,
	`urgent_days` integer DEFAULT 3 NOT NULL,
	`email_copy` integer DEFAULT false NOT NULL,
	`email_sent_at` integer,
	`attachment_id` text,
	`attachment_name` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`publish_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`edited_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`check_in_at` integer,
	`check_out_at` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`check_in_lat` numeric,
	`check_in_lng` numeric,
	`check_out_lat` numeric,
	`check_out_lng` numeric,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `attendance_deviations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`reason` text NOT NULL,
	`description` text NOT NULL,
	`claimed_check_in` text,
	`claimed_check_out` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`ai_summary` text,
	`ai_suggested_reason` text,
	`ai_confidence` numeric,
	`ai_evidence_note` text,
	`ai_flags` text,
	`ai_model` text,
	`ai_ran_at` integer,
	`evidence_snapshot` text,
	`counts_toward_monthly_cap` integer DEFAULT true NOT NULL,
	`month_key` text(7) NOT NULL,
	`supporting_document_id` text,
	`reviewer_id` text,
	`reviewed_at` integer,
	`review_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `attendance_import_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_import_tokens_token_hash_unique` ON `attendance_import_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `attendance_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text,
	`uploaded_by` text,
	`filename` text,
	`row_count` integer NOT NULL,
	`matched_count` integer NOT NULL,
	`unmatched_count` integer NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `attendance_import_tokens`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bulk_import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`employee_code` text,
	`full_name` text NOT NULL,
	`designation` text,
	`official_email` text NOT NULL,
	`team_and_floor` text,
	`reporting_authority_raw` text,
	`dotted_line_authority_raw` text,
	`profile_data` text,
	`repair_notes` text,
	`reports_to_row_id` text,
	`role` text DEFAULT 'employee' NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`existing_user_id` text,
	`created_user_id` text,
	`blue_collar` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `bulk_imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reports_to_row_id`) REFERENCES `bulk_import_rows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`existing_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bulk_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`uploaded_by` text,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`row_count` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`applied_at` integer,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `champ_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`from_user` text NOT NULL,
	`to_user` text NOT NULL,
	`title` text NOT NULL,
	`due_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`from_user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_celebrations` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`on_date` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_celebrations_user_kind_date` ON `chat_celebrations` (`user_id`,`kind`,`on_date`);--> statement-breakpoint
CREATE TABLE `chat_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_id` text,
	`is_private` integer DEFAULT false NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`team_id` text,
	`unique_key` text,
	`desk_owner_id` text,
	`desk_status` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_message_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`desk_owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_channels_unique_key_unique` ON `chat_channels` (`unique_key`);--> statement-breakpoint
CREATE TABLE `chat_members` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`added_by` text DEFAULT 'person' NOT NULL,
	`last_read_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`muted_until` integer,
	`notify` text DEFAULT 'all' NOT NULL,
	`last_digest_at` integer,
	`joined_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_members_channel_user` ON `chat_members` (`channel_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`thread_root_id` text,
	`author_id` text,
	`kind` text DEFAULT 'text' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`card` text,
	`file_id` text,
	`file_name` text,
	`file_mime` text,
	`file_size` integer,
	`mentions` text DEFAULT '[]' NOT NULL,
	`mentions_all` integer DEFAULT false NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`visible_to` text,
	`edited_at` integer,
	`deleted_at` integer,
	`hidden_at` integer,
	`hidden_by` text,
	`pinned_at` integer,
	`pinned_by` text,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`last_reply_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`visible_to`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hidden_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pinned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_poll_votes` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`option_index` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_poll_votes_message_user_option` ON `chat_poll_votes` (`message_id`,`user_id`,`option_index`);--> statement-breakpoint
CREATE TABLE `chat_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email_digest` integer DEFAULT true NOT NULL,
	`sound` integer DEFAULT true NOT NULL,
	`celebrations` integer DEFAULT true NOT NULL,
	`push` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_reactions` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_reactions_message_user_emoji` ON `chat_reactions` (`message_id`,`user_id`,`emoji`);--> statement-breakpoint
CREATE TABLE `chat_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text,
	`text` text NOT NULL,
	`remind_at` integer NOT NULL,
	`sent_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `chat_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`reported_by` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reported_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_saved` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_saved_message_user` ON `chat_saved` (`message_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `chat_todos` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`text` text NOT NULL,
	`created_by` text,
	`done_by` text,
	`done_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`done_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `comp_off_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`worked_date` text NOT NULL,
	`worked_minutes` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_on` text NOT NULL,
	`used_on` text,
	`used_application_id` text,
	`evidence_snapshot` text,
	`note` text,
	`approver_id` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`used_application_id`) REFERENCES `leave_applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `custom_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`base_role` text DEFAULT 'employee' NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_roles_name_unique` ON `custom_roles` (`name`);--> statement-breakpoint
CREATE TABLE `delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`reason` text,
	`created_by` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "delegations_window_valid" CHECK("delegations"."ends_on" >= "delegations"."starts_on"),
	CONSTRAINT "delegations_not_self" CHECK("delegations"."from_id" <> "delegations"."to_id")
);
--> statement-breakpoint
CREATE INDEX `delegations_from_window` ON `delegations` (`from_id`,`starts_on`,`ends_on`);--> statement-breakpoint
CREATE INDEX `delegations_to` ON `delegations` (`to_id`);--> statement-breakpoint
CREATE TABLE `departments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_punches` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text,
	`emp_code` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`dept_code` text,
	`dept_name` text,
	`punched_at` integer NOT NULL,
	`verify_type` text,
	`punch_state` text,
	`direction` text,
	`work_code` text,
	`card_number` text,
	`area_name` text,
	`terminal_alias` text,
	`terminal_sn` text,
	`temperature` text,
	`mask_flag` text,
	`raw_line` text NOT NULL,
	`matched_user_id` text,
	`attendance_id` text,
	`dedupe_key` text,
	`received_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `attendance_imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attendance_id`) REFERENCES `attendance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_punches_dedupe_key` ON `device_punches` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `employee_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pink_leave_eligible_override` integer,
	`employee_code` text(32),
	`phone` text,
	`personal_email` text,
	`address` text,
	`permanent_address` text,
	`facebook_id` text,
	`linkedin_url` text,
	`instagram_handle` text,
	`emergency_contact_name` text,
	`emergency_contact_relationship` text,
	`emergency_contact_phone` text,
	`gender` text,
	`blood_group` text,
	`dob_documents` text,
	`dob_actual` text,
	`father_name` text,
	`father_dob` text,
	`father_contact` text,
	`mother_name` text,
	`mother_dob` text,
	`mother_contact` text,
	`religion` text,
	`mother_tongue` text,
	`marital_status` text,
	`spouse_name` text,
	`spouse_dob` text,
	`spouse_contact` text,
	`anniversary_date` text,
	`children` text,
	`under_graduate` text,
	`graduate` text,
	`masters` text,
	`diploma_others` text,
	`total_experience` text,
	`aadhar_number` text,
	`pan_number` text,
	`uan_number` text,
	`driving_license_number` text,
	`voters_id_number` text,
	`passport_number` text,
	`bank_account_number` text,
	`bank_account_holder_name` text,
	`bank_name` text,
	`bank_ifsc` text,
	`designation` text,
	`team_and_floor` text,
	`sub_process_department` text,
	`floor_details` text,
	`date_of_joining` text,
	`date_of_confirmation` text,
	`last_working_day` text,
	`office_timings` text,
	`shift_type` text,
	`shift_group_id` text,
	`direct_reporting_authority` text,
	`dotted_line_reporting_authority` text,
	`dotted_line_manager_id` text,
	`reports_to_chief` integer DEFAULT false NOT NULL,
	`top_position` text DEFAULT 'chief' NOT NULL,
	`hr_user_id` text,
	`source_referred_by` text,
	`salary_band` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_group_id`) REFERENCES `shift_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dotted_line_manager_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hr_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_profiles_user_id_unique` ON `employee_profiles` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `employee_profiles_employee_code_unique` ON `employee_profiles` (`employee_code`);--> statement-breakpoint
CREATE INDEX `employee_profiles_dotted_manager` ON `employee_profiles` (`dotted_line_manager_id`);--> statement-breakpoint
CREATE INDEX `employee_profiles_hr_user` ON `employee_profiles` (`hr_user_id`);--> statement-breakpoint
CREATE TABLE `holiday_calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_group_id` text NOT NULL,
	`year` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`source_document_id` text,
	`published_by` text,
	`published_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`shift_group_id`) REFERENCES `shift_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `holidays` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'PUBLIC' NOT NULL,
	FOREIGN KEY (`calendar_id`) REFERENCES `holiday_calendars`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hub_dismissals` (
	`user_id` text NOT NULL,
	`need_key` text NOT NULL,
	`until` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hub_dismissals_user_key` ON `hub_dismissals` (`user_id`,`need_key`);--> statement-breakpoint
CREATE TABLE `leave_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`year` integer NOT NULL,
	`allocated_days` numeric NOT NULL,
	`used_days` numeric DEFAULT '0' NOT NULL,
	`is_hr_set` integer DEFAULT false NOT NULL,
	`hr_set_by` text,
	`hr_set_at` integer,
	`hr_set_note` text,
	`hr_set_days` numeric,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hr_set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `leave_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`days` numeric NOT NULL,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approver_id` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `leave_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`delta` numeric NOT NULL,
	`reason` text NOT NULL,
	`related_application_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leave_type_id`) REFERENCES `leave_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`related_application_id`) REFERENCES `leave_applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `leave_types` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text(32),
	`name` text NOT NULL,
	`accrual_per_month` numeric DEFAULT '0' NOT NULL,
	`carry_forward_cap` integer DEFAULT 0 NOT NULL,
	`encashment_eligible` integer DEFAULT false NOT NULL,
	`eligibility` text,
	`requires_documentation` integer DEFAULT false NOT NULL,
	`documentation_note` text,
	`fixed_days` integer,
	`monthly_quota_days` numeric,
	`monthly_usage_cap` numeric,
	`gender_eligibility` text,
	`notes` text,
	`source_document_id` text,
	`policy_version` integer DEFAULT 1 NOT NULL,
	`effective_from` text,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`import_id` text,
	`send_to` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`approved_by` text,
	`approved_at` integer,
	`attempted_at` integer,
	`sent_at` integer,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `bulk_imports`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `meeting_items` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`title` text NOT NULL,
	`owner_id` text,
	`owner_heard` text,
	`due_date` text,
	`priority` text DEFAULT 'medium' NOT NULL,
	`step_index` integer,
	`confidence` numeric,
	`included` integer DEFAULT true NOT NULL,
	`task_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`zoom_uuid` text,
	`zoom_meeting_id` text,
	`host_id` text,
	`host_email` text,
	`topic` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_min` integer,
	`join_url` text,
	`agenda` text,
	`state` text DEFAULT 'waiting' NOT NULL,
	`summary` text,
	`extraction` text,
	`source` text DEFAULT 'zoom' NOT NULL,
	`attendee_ids` text DEFAULT '[]' NOT NULL,
	`guest_names` text DEFAULT '[]' NOT NULL,
	`published_at` integer,
	`published_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_zoom_uuid_unique` ON `meetings` (`zoom_uuid`);--> statement-breakpoint
CREATE TABLE `payroll_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`cycle_key` text(7) NOT NULL,
	`salary_action` text,
	`comment` text,
	`remarks` text,
	`opening_balance` numeric,
	`updated_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payroll_adjustments_user_cycle` ON `payroll_adjustments` (`user_id`,`cycle_key`);--> statement-breakpoint
CREATE TABLE `payroll_cell_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`cycle_key` text(7) NOT NULL,
	`sheet` text(32) NOT NULL,
	`row_key` text(96) NOT NULL,
	`column` text NOT NULL,
	`value` text,
	`original` text,
	`updated_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payroll_cell_overrides_cell` ON `payroll_cell_overrides` (`cycle_key`,`sheet`,`row_key`,`column`);--> statement-breakpoint
CREATE TABLE `payroll_reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`cycle_key` text(7) NOT NULL,
	`file_name` text NOT NULL,
	`compared_cells` integer NOT NULL,
	`matched_cells` integer NOT NULL,
	`result` text NOT NULL,
	`uploaded_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `policy_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`file_id` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`extracted_json` text,
	`extraction_model` text,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE INDEX `policy_documents_created_idx` ON `policy_documents` (`created_at`);--> statement-breakpoint
CREATE TABLE `prohance_days` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_id` text,
	`emp_code` text NOT NULL,
	`console_login_id` text,
	`user_name` text,
	`session_date` text NOT NULL,
	`first_login` integer,
	`last_logout` integer,
	`logged_minutes` integer,
	`active_minutes` integer,
	`idle_minutes` integer,
	`time_on_system_minutes` integer,
	`time_away_minutes` integer,
	`day_type` text,
	`raw` text,
	`matched_user_id` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`sync_id`) REFERENCES `prohance_syncs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prohance_days_emp_code_session_date` ON `prohance_days` (`emp_code`,`session_date`);--> statement-breakpoint
CREATE TABLE `prohance_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text DEFAULT 'poll' NOT NULL,
	`range_from` text NOT NULL,
	`range_to` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`matched_count` integer DEFAULT 0 NOT NULL,
	`unmatched_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `shift_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text(64) NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shift_groups_key_unique` ON `shift_groups` (`key`);--> statement-breakpoint
CREATE TABLE `stored_files` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`uploaded_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stored_files_avatar_owner_idx` ON `stored_files` (`owner_id`) WHERE kind = 'avatar';--> statement-breakpoint
CREATE INDEX `stored_files_kind_idx` ON `stored_files` (`kind`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`actor_id` text,
	`kind` text DEFAULT 'activity' NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_subtasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`assignee_id` text,
	`created_by` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`due_date` text,
	`blocked` integer DEFAULT false NOT NULL,
	`request_state` text,
	`request_note` text,
	`approver_id` text,
	`rank` text DEFAULT 'i' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`meeting_id` text,
	`source_message_id` text,
	`source_channel_id` text,
	`source_quote` text,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`department_id` text,
	`team_lead_id` text,
	`can_approve_leave` integer DEFAULT true NOT NULL,
	`max_leave_days_auto_approve` integer DEFAULT 2 NOT NULL,
	`can_edit_team_shift_window` integer DEFAULT true NOT NULL,
	`can_view_team_payroll_cost` integer DEFAULT false NOT NULL,
	`can_create_employee_logins` integer DEFAULT true NOT NULL,
	`can_resolve_grievances` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_lead_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text(255) NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`full_name` text NOT NULL,
	`team_id` text,
	`reports_to` text,
	`is_active` integer DEFAULT true NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`temporary_password` text,
	`clerk_user_id` text(64),
	`custom_role_id` text,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reports_to`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`custom_role_id`) REFERENCES `custom_roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_clerk_user_id_unique` ON `users` (`clerk_user_id`);--> statement-breakpoint
CREATE INDEX `users_reports_to` ON `users` (`reports_to`);--> statement-breakpoint
CREATE TABLE `week_off_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`roster_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`assigned_by` text,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`roster_id`) REFERENCES `week_off_rosters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `week_off_rosters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`pattern` text NOT NULL,
	`weekdays` text,
	`rotation_weeks` text,
	`cycle_weeks` integer,
	`rotation_anchor_date` text,
	`team_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by` text,
	`published_by` text,
	`published_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `zoom_user_links` (
	`id` text PRIMARY KEY NOT NULL,
	`zoom_key` text NOT NULL,
	`user_id` text NOT NULL,
	`linked_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zoom_user_links_zoom_key_unique` ON `zoom_user_links` (`zoom_key`);