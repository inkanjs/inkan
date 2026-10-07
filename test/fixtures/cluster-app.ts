// The app cluster.test.ts starts: two workers on one port, JSON logs to read.
import { inkan } from "../../src/index.ts";

const app = inkan({ log: "json", dev: false, workers: 2 })
  .get("/who", () => ({ pid: process.pid }))
  .get("/crash", () => process.exit(3))
  .onClose(() => console.log(JSON.stringify({ msg: "closed", pid: process.pid })));

await app.listen(0, "127.0.0.1");
