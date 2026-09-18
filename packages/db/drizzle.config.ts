import { defineConfig } from "drizzle-kit";

/**
 * The one entry point drizzle-kit reads. `pnpm db:generate` diffs the schema
 * against the snapshots in `migrations/meta` and writes the SQL for a reviewer
 * to read; `pnpm db:migrate` applies the journal to a real database. The output
 * is committed, never edited by hand without the `-- hand-edited:` marker the
 * migration suite requires, and split so a destructive change is its own file.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
