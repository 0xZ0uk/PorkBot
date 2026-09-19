-- hand-edited: role privileges are not modelled by drizzle-kit (the same
-- reason migrations/0004_database_roles.sql, migrations/0006_run_leases.sql,
-- migrations/0008_approval_grants.sql, migrations/0009_watchdog_grants.sql,
-- migrations/0012_routine_grants.sql, migrations/0015_notification_grants.sql,
-- migrations/0017_credentials_grants.sql, migrations/0019_mcp_grants.sql,
-- migrations/0021_model_connection_grants.sql, migrations/0024_liveness_grants.sql,
-- migrations/0028_computer_lease_grants.sql and
-- migrations/0031_computer_snapshot_grants.sql are hand-written). Slice 7.6
-- makes the stored-file rows the index of bytes that outlive a chat and a
-- computer. Both are written once and read afterwards — an attachment by the
-- send path and the download route, an artifact by the run path and the
-- download route — so neither role is granted UPDATE, and deleting a bot or
-- thread reclaims the rows through the foreign keys rather than through a
-- role's DELETE. The API uploads an attachment for a thread and resolves the
-- file a download addresses; the worker reads a message's attachments to place
-- them in the computer and records the artifact one tool call produced. Both
-- need SELECT and INSERT on both tables and nothing else.
grant select, insert on "message_attachment" to porkbot_api;
grant select, insert on "message_attachment" to porkbot_worker;
grant select, insert on "run_artifact" to porkbot_api;
grant select, insert on "run_artifact" to porkbot_worker;
