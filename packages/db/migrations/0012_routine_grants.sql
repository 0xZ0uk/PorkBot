-- hand-edited: routine scheduling is a role privilege, which drizzle-kit does
-- not model (the same reason migrations/0004_database_roles.sql,
-- migrations/0006_run_leases.sql, migrations/0008_approval_grants.sql and
-- migrations/0009_watchdog_grants.sql are hand-written). Slice 8.4 makes the
-- worker the producer of routine-triggered runs, so the worker's first domain
-- INSERT arrives with the scheduler that needs it:
--
--   porkbot_worker  the scheduler: SELECT on `routine` for the due scan,
--                   UPDATE on its cursor columns only — `next_run_at` and
--                   `updated_at` — so a job cannot rewrite an instruction, a
--                   cron expression or the tombstone, INSERT on
--                   `routine_occurrence` for the ledger and UPDATE on its
--                   `run_id` link, and INSERT (plus SELECT for the RETURNING
--                   projections) on `task` and `run` for the fire itself. It
--                   still receives no INSERT on `bot`,
--                   `thread`, `message` or `space`: the only rows it creates
--                   are the run one scheduled slot produced, through the same
--                   run-creation command the API will use for messages.
--   porkbot_api     the operator's half: CRUD on `routine` (no DELETE — a
--                   delete is the `deleted_at` tombstone) and SELECT on the
--                   occurrence ledger for the outcome history. Slice 8.5's
--                   editor is the surface that uses it.
grant select on "routine" to porkbot_worker;--> statement-breakpoint
grant update (next_run_at, updated_at) on "routine" to porkbot_worker;--> statement-breakpoint
grant select, insert on "routine_occurrence" to porkbot_worker;--> statement-breakpoint
grant update (run_id, updated_at) on "routine_occurrence" to porkbot_worker;--> statement-breakpoint
grant select, insert on "task" to porkbot_worker;--> statement-breakpoint
grant insert on "run" to porkbot_worker;--> statement-breakpoint
grant select, insert, update on "routine" to porkbot_api;--> statement-breakpoint
grant select on "routine_occurrence" to porkbot_api;
