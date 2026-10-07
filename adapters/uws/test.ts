// The same requests every way of serving inkan has to answer alike, on uWebSockets.js.
import { conformance } from "../../test/adapters/conformance.ts";
import { serve } from "./index.js";

conformance("uWebSockets.js (@inkanjs/uws)", async (app) => {
  const server = await serve(app, { port: 0, host: "127.0.0.1" });
  return { url: `http://127.0.0.1:${server.port}`, close: () => server.close() };
});
