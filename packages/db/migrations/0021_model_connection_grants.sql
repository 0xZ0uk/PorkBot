-- hand-edited: role privileges are not modelled by drizzle-kit (the same
-- reason migrations/0004_database_roles.sql, migrations/0006_run_leases.sql,
-- migrations/0008_approval_grants.sql, migrations/0009_watchdog_grants.sql,
-- migrations/0012_routine_grants.sql, migrations/0015_notification_grants.sql,
-- migrations/0017_credentials_grants.sql and migrations/0019_mcp_grants.sql
-- are hand-written). Slice 9.2 makes the model connection the operator's model
-- endpoint row and the job path's model selection read:
--
--   porkbot_api     the operator's half: SELECT to list, INSERT and UPDATE for
--                   create, edit and the one-default swap, and DELETE to
--                   disconnect. A deleted connection nulls its bots'
--                   `model_connection_id`, which is the column's foreign key
--                   behavior and needs no write here.
--   porkbot_worker  the provider half: SELECT only, so a run resolves the
--                   connection its bot selected without taking the settings
--                   surface with it. The credential itself stays in the
--                   encrypted credential table, granted by 0017.
grant select, insert, update, delete on "model_connection" to porkbot_api;--> statement-breakpoint
grant select on "model_connection" to porkbot_worker;
