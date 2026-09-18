-- hand-edited: role privileges are not modelled by drizzle-kit (the same
-- reason migrations/0004_database_roles.sql, migrations/0006_run_leases.sql,
-- migrations/0008_approval_grants.sql, migrations/0009_watchdog_grants.sql,
-- migrations/0012_routine_grants.sql and migrations/0015_notification_grants.sql
-- are hand-written). Slice 9.1 makes the encrypted credential table the
-- operator's secrets surface and the provider path's resolve read:
--
--   porkbot_api     the operator's half: SELECT to list masked summaries and
--                   read for a resolve, INSERT and UPDATE for the encrypting
--                   upsert and the rotation pass. There is no DELETE because
--                   revoking a credential is slice 9.3's surface, and it will
--                   take its grant with it.
--   porkbot_worker  the provider half: SELECT only, one named credential
--                   resolved through the job's space. A job can never enumerate
--                   or rewrite the store.
grant select, insert, update on "encrypted_credential" to porkbot_api;--> statement-breakpoint
grant select on "encrypted_credential" to porkbot_worker;
