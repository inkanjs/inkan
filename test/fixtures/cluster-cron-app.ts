// The app cluster.test.ts starts to see where a job's schedule runs. The worker in slot 1
// is told to die once, so its replacement shows it takes the schedule over. With "own" as
// the argument the fixture makes the cluster itself, without inkan's workers (no INKAN_WORKER).
import cluster from "node:cluster";
import { inkan, memoryStore } from "../../src/index.ts";

const own = process.argv[2] === "own";

if (own && cluster.isPrimary) {
  cluster.fork();
  cluster.fork();
} else {
  if (cluster.isPrimary) {
    let crashed = false;
    cluster.on("message", (worker, m) => {
      if (m?.up !== "1" || crashed) return;
      crashed = true;
      worker.send({ crash: true });
    });
  } else {
    process.on("message", (m: any) => m?.crash && process.exit(3));
  }
  const store = { ...memoryStore(), shared: true };
  const app = inkan({ log: false, dev: false, workers: own ? undefined : 2 }).job("/tick", { store, every: "* * * * *" }, () => null);
  const server = await app.listen(0, "127.0.0.1");
  const address = server.address();
  const armed = app._jobs!.kinds.some((k) => k.schedule?.timer !== undefined);
  const port = typeof address === "object" && address ? address.port : 0;
  console.log(JSON.stringify({ msg: "up", port, slot: process.env.INKAN_WORKER, id: cluster.worker?.id, armed }));
  if (!own) process.send?.({ up: process.env.INKAN_WORKER });
}
