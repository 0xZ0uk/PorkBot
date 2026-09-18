-- hand-edited: role privileges are not modelled by drizzle-kit (the same
-- reason migrations/0004_database_roles.sql, migrations/0006_run_leases.sql,
-- migrations/0008_approval_grants.sql, migrations/0009_watchdog_grants.sql and
-- migrations/0012_routine_grants.sql are hand-written). Slice 8.6 makes the
-- notification preference table the operator's settings surface and the
-- delivery path's read:
--
--   porkbot_api     the operator's own switches: SELECT to read the effective
--                   set, INSERT and UPDATE for the upsert that flips one kind.
--                   There is no DELETE because a preference is a switch, not a
--                   resource: turning it off writes `enabled = false`.
--   porkbot_worker  the delivery path's eligibility read, which joins
--                   `space_member` to `notification_preference`. SELECT only:
--                   a job decides whether to notify, never what the operator
--                   chose.
grant select, insert, update on "notification_preference" to porkbot_api;--> statement-breakpoint
grant select on "notification_preference" to porkbot_worker;
