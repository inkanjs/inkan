import pg from "pg";
import { postgresStore } from "@inkanjs/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres" });

// One table, inkan_store, made on first use. Rate limits, sessions and jobs can share it:
// every process of the app sees the same state.
export const store = postgresStore(pool);

/** Stops the store's sweep and ends the pool. The app calls it on shutdown, the tests when they are done. */
export async function closeStore() {
  await store.close();
  await pool.end();
}
