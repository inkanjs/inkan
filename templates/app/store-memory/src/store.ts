import { memoryStore } from "@vxnsin/inkan";

// Kept in this process: gone on a restart and not shared with other processes, which is
// fine to start with. Redis, Postgres, MongoDB and MySQL take the same place later: one
// file, the rest of the app stays as it is.
export const store = memoryStore();

/** Lets go of the connection, where there is one. The app calls it on shutdown, the tests when they are done. */
export async function closeStore() {}
