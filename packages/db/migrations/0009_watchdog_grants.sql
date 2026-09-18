-- hand-edited: worker lease recovery is a role privilege, which drizzle-kit
-- does not model (the same reason migrations/0004_database_roles.sql,
-- migrations/0006_run_leases.sql and migrations/0008_approval_grants.sql are
-- hand-written). Slice 6.3 makes a reclaim reconcile what the superseded owner
-- left behind: the attempt it recorded is closed as `abandoned` (UPDATE on
-- attempt), and every tool-call row still `pending` or `running` is settled as
-- failed so a resume replays a recorded outcome instead of re-running a
-- possible side effect (SELECT and UPDATE on external_effect, selected for the
-- status predicate and updated for the settlement). The worker still receives
-- no INSERT or DELETE on either table, and no domain write outside the fenced
-- run paths.
grant update on "attempt" to porkbot_worker;--> statement-breakpoint
grant select, update on "external_effect" to porkbot_worker;
