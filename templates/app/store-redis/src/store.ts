import { createClient } from "redis";
import { redisStore } from "@inkanjs/redis";

const client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
// without a listener, a dropped connection would end the process; node-redis reconnects by itself
client.on("error", (err: Error) => console.error(`redis: ${err.message}`));
await client.connect();

// Every key under "inkan:". Rate limits, sessions and jobs can share it: every process
// of the app sees the same state.
export const store = redisStore(client);

/** Closes the store's subscriber and the client. The app calls it on shutdown, the tests when they are done. */
export async function closeStore() {
  await store.close();
  await client.close();
}
