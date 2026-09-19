-- hand-edited: role privileges are not modelled by drizzle-kit (the same
-- reason migrations/0004_database_roles.sql, migrations/0006_run_leases.sql,
-- migrations/0008_approval_grants.sql, migrations/0009_watchdog_grants.sql,
-- migrations/0012_routine_grants.sql, migrations/0015_notification_grants.sql
-- and migrations/0017_credentials_grants.sql are hand-written). Slice 9.5 adds
-- the MCP server registry and the per-bot grants:
--
--   porkbot_api     the operator's half: SELECT to list and by-id read, INSERT
--                   and UPDATE for install, discovery caching and status, and
--                   DELETE for uninstall and for replacing a server's tool list
--                   in one pass. A server removal cascades its tools and grants
--                   through the foreign keys.
--   porkbot_worker  the run half: SELECT only. A job reads the servers and tools
--                   a bot was granted and re-checks one grant, and can never
--                   install, rewrite or grant.
--
-- It also widens the encrypted credential grant by DELETE, because
-- uninstalling a server removes the credential row that held its tokens: the
-- value must not outlive the server that owned it.
grant select, insert, update, delete on "mcp_server" to porkbot_api;--> statement-breakpoint
grant select on "mcp_server" to porkbot_worker;--> statement-breakpoint
grant select, insert, update, delete on "mcp_server_tool" to porkbot_api;--> statement-breakpoint
grant select on "mcp_server_tool" to porkbot_worker;--> statement-breakpoint
grant select, insert, update, delete on "bot_mcp_server" to porkbot_api;--> statement-breakpoint
grant select on "bot_mcp_server" to porkbot_worker;--> statement-breakpoint
grant delete on "encrypted_credential" to porkbot_api;
