import mysql from "mysql2/promise";
import { mysqlStore } from "@inkanjs/mysql";

const pool = mysql.createPool(process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/app");

// Two tables, inkan_store and inkan_events, made on first use. Rate limits, sessions and
// jobs can share them: every process of the app sees the same state.
export const store = mysqlStore(pool);

/** Stops the store's sweep and ends the pool. The app calls it on shutdown, the tests when they are done. */
export async function closeStore() {
  await store.close();
  await pool.end();
}
