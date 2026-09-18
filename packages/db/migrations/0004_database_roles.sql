-- hand-edited: roles and grants are cluster identity and privilege, which
-- drizzle-kit does not model. This is a `drizzle-kit generate --custom`
-- migration, so the schema snapshots are unchanged and the SQL is written by a
-- reviewer's hand rather than diffed from src/schema. The reason the grants
-- live in a migration and the passwords do not: DDL is reviewed and committed,
-- a credential is supplied per environment (PORKBOT_API_DB_PASSWORD,
-- PORKBOT_WORKER_DB_PASSWORD) by `pnpm db:migrate`.
--
-- Two login roles, because the API and the worker are separate always-on
-- processes and neither may perform the other's operations (PRD decision 7):
--
--   porkbot_api     the operator's session and every domain write the HTTP
--                   surface performs: identity, tenancy, bots, threads,
--                   messages, tasks, runs, events, steering and effects.
--   porkbot_worker  the run executor: reads the domain rows it re-reads before
--                   acting, and owns the Graphile queue schema — jobs, locks
--                   and retries live there and nowhere else.
--
-- The division is checked, not assumed: pg_catalog answers it (the roles
-- integration suite asks `has_table_privilege` and then really performs the
-- operation as each role), so a grant that drifts fails a test rather than a
-- review. The worker's domain grants are SELECT only in this slice: run claims,
-- heartbeats and attempts land in 6.2 and add their own grant migration beside
-- the code that uses them.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'porkbot_api') then
    create role porkbot_api login;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'porkbot_worker') then
    create role porkbot_worker login;
  end if;
end
$$;--> statement-breakpoint

-- Both processes read and write inside the application schema.
grant usage on schema public to porkbot_api;--> statement-breakpoint
grant usage on schema public to porkbot_worker;--> statement-breakpoint

-- The API's tables. Identity and tenancy first (better-auth reads and writes
-- the session tables), then the domain the HTTP surface owns. `attempt` is a
-- read for the API — the run executor writes it — so it is granted separately.
grant select, insert, update, delete on
  "user",
  "session",
  "account",
  "verification",
  "deployment_settings",
  "space",
  "space_member",
  "bot_section",
  "bot",
  "thread",
  "message",
  "task",
  "run",
  "event",
  "steering_message",
  "external_effect"
to porkbot_api;--> statement-breakpoint
grant select on "attempt" to porkbot_api;--> statement-breakpoint

-- The worker's reads, matching the surface `SystemRepositories` exposes to a
-- job: the bot, thread and run rows it re-reads before acting. No INSERT,
-- UPDATE or DELETE — the API owns every domain write in this slice, and the
-- queue below is the worker's only write. Later slices extend this list in
-- their own migration beside the code that uses it.
grant select on
  "bot",
  "thread",
  "run"
to porkbot_worker;--> statement-breakpoint

-- Graphile Worker's queue owns its own schema. Creating it here, with the
-- worker role as its only user, keeps the queue's objects out of the API's
-- reach. The worker also holds `CREATE` on the database, which is broader than
-- least privilege: Graphile's boot runs `create schema if not exists` on every
-- start, and Postgres checks the database privilege even when the schema
-- already exists, so the grant is the price of Graphile's own schema lifecycle.
-- It is the worker's alone — the API role cannot create a schema — and a
-- deployment that will not extend it can install Graphile's schema out of band.
create schema if not exists "graphile_worker";--> statement-breakpoint
revoke all on schema "graphile_worker" from public;--> statement-breakpoint
grant usage, create on schema "graphile_worker" to porkbot_worker;--> statement-breakpoint
do $$
begin
  execute format('grant create on database %I to porkbot_worker', current_database());
end
$$;
