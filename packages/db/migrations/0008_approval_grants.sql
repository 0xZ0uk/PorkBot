-- hand-edited: table and column privileges are role policy, which drizzle-kit
-- does not model. The approval gate is split by actor, and the split is column
-- level because both processes UPDATE the same row:
--
--   porkbot_worker  the run's half: INSERT to open a gate, SELECT to read it
--                   back and to reopen it after a restart, and UPDATE on the
--                   timeout's columns only. It cannot write decided_by_user_id,
--                   so a job cannot vote in the operator's name.
--   porkbot_api     the operator's half: SELECT the timeline and UPDATE the
--                   vote's columns only. It cannot write expires_at, so the
--                   HTTP surface cannot move a deadline the run is waiting on.
--
-- The resolution check in 0007_cooing_lethal_legion.sql is the second half of
-- the same argument: an approved or denied row always carries the deciding
-- user, and a timed-out row never does.
grant select, insert on "approval" to porkbot_worker;--> statement-breakpoint
grant update (status, decided_at, updated_at) on "approval" to porkbot_worker;--> statement-breakpoint
grant select on "approval" to porkbot_api;--> statement-breakpoint
grant update (status, decided_by_user_id, decided_at, reason, updated_at) on "approval" to porkbot_api;
