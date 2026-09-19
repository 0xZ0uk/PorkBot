-- hand-edited: role privileges are not modelled by drizzle-kit (the same
-- reason migrations/0004_database_roles.sql, migrations/0006_run_leases.sql,
-- migrations/0008_approval_grants.sql, migrations/0009_watchdog_grants.sql,
-- migrations/0012_routine_grants.sql, migrations/0015_notification_grants.sql,
-- migrations/0017_credentials_grants.sql, migrations/0019_mcp_grants.sql and
-- migrations/0021_model_connection_grants.sql are hand-written). Slice 9.6
-- makes the bot secret table the operator's per-bot secrets surface and the
-- run's resolve-and-forget path:
--
--   porkbot_api     the operator's half: SELECT to list destinations and
--                   statuses, INSERT and UPDATE for the encrypting upsert and
--                   the forget. A bot's deletion cascades its rows away as the
--                   table owner, so the API needs no DELETE of its own.
--   porkbot_worker  the run's half: SELECT to resolve one named credential
--                   through the job's space, and UPDATE because the agent's
--                   forget clears the envelope. A job can never enumerate or
--                   rewrite a value it has not named.
grant select, insert, update on "bot_secret" to porkbot_api;--> statement-breakpoint
grant select, update on "bot_secret" to porkbot_worker;
