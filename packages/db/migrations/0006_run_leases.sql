-- hand-edited: worker lease ownership is a role privilege, which drizzle-kit
-- does not model. The worker needs UPDATE on run for fenced claim, heartbeat,
-- reclaim and execution writes, plus INSERT on attempt to record each acquired
-- fence. SELECT on attempt is needed by the atomic insert's RETURNING CTE. It
-- receives no run INSERT/DELETE and no attempt UPDATE/DELETE.
grant update on "run" to porkbot_worker;--> statement-breakpoint
grant select, insert on "attempt" to porkbot_worker;
