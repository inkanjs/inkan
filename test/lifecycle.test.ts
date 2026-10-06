import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan } from "../src/index.ts";

test("lifecycle hooks: onListen and onClose, with fake resource", async () => {
  const events: string[] = [];
  const fakeResource = {
    connect: async () => {
      await new Promise((r) => setTimeout(r, 10));
      events.push("connect");
    },
    close: async () => {
      await new Promise((r) => setTimeout(r, 10));
      events.push("close");
    }
  };

  const app = inkan({ log: false, gracefulShutdown: true });
  app.onListen(async () => {
    await fakeResource.connect();
    events.push("onListen");
  });
  app.onClose(async () => {
    await fakeResource.close();
    events.push("onClose");
  });

  const server = await app.listen(0);
  assert.deepEqual(events, ["connect", "onListen"]);

  const originalExit = process.exit;
  let exitCode: number | undefined;
  (process as any).exit = (code?: number) => {
    exitCode = code;
  };

  process.emit("SIGTERM" as any);

  // Wait for the shutdown to complete (the server.close callback)
  await new Promise((resolve) => setTimeout(resolve, 50));

  (process as any).exit = originalExit;

  assert.deepEqual(events, ["connect", "onListen", "close", "onClose"]);
  assert.equal(exitCode, 0);
});
