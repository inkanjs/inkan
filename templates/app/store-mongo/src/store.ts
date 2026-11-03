import { MongoClient } from "mongodb";
import { mongoStore } from "@inkanjs/mongo";

const client = await new MongoClient(process.env.MONGO_URL ?? "mongodb://localhost:27017/app").connect();

// One collection, inkan_store, with a TTL index made on first use. Rate limits, sessions
// and jobs can share it: every process of the app sees the same state.
export const store = mongoStore(client.db());

/** Stops the store's polling and closes the client. The app calls it on shutdown, the tests when they are done. */
export async function closeStore() {
  await store.close();
  await client.close();
}
