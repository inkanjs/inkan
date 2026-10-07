// An inkan app on uWebSockets.js instead of node:http. Everything goes through
// app.exchange(), the one door inkan has for any server: the contracts, hooks, problems
// and streams are the app's, this file only moves bytes between the socket and the app.
//
//   import { serve } from "@inkanjs/uws";
//   const server = await serve(app, { port: 3000 });
//   await server.close();

import { STATUS_CODES } from "node:http";
import { createRequire } from "node:module";

// uWebSockets.js 20.71 ships an ESM wrapper that imports a file it does not have; its CommonJS entry works
const uWS = createRequire(import.meta.url)("uWebSockets.js");

const text = (ab) => Buffer.from(ab).toString();

/**
 * Serves `app` on uWebSockets.js. Resolves once it listens, after the app's plugins and its
 * onListen hooks; `close()` stops taking requests and runs the onClose hooks.
 */
export async function serve(app, { port = Number(process.env.PORT ?? 3000), host = "0.0.0.0" } = {}) {
  await app.ready();
  const limit = app.options.bodyLimit;

  const server = uWS.App().any("/*", (res, req) => {
    // the request is only readable now, before the first await
    const method = req.getCaseSensitiveMethod().toUpperCase();
    const query = req.getQuery();
    const url = req.getUrl() + (query ? `?${query}` : "");
    const headers = {};
    req.forEach((name, value) => (headers[name] = name in headers ? `${headers[name]}, ${value}` : value));
    const remote = text(res.getRemoteAddressAsText());

    let gone = false;
    let answer;
    res.onAborted(() => {
      gone = true;
      answer?.abort?.abort(); // the client went away: tell the source, so it stops producing
    });

    const hasBody = method !== "GET" && method !== "HEAD" && (headers["content-length"] !== undefined || headers["transfer-encoding"] !== undefined);
    if (!hasBody) return void exchange(undefined);
    if (Number(headers["content-length"] ?? 0) > limit) return tooLarge();
    const chunks = [];
    let size = 0;
    res.onData((ab, last) => {
      if (size > limit) return; // already answered 413; the rest is let go
      size += ab.byteLength;
      if (size > limit) return tooLarge();
      chunks.push(Buffer.from(new Uint8Array(ab))); // a copy: uWS takes the memory back after this call
      if (last) exchange(Buffer.concat(chunks));
    });

    function tooLarge() {
      if (gone) return;
      gone = true;
      const body = JSON.stringify({ type: "body-too-large", title: STATUS_CODES[413], status: 413, detail: `Request bodies may be at most ${limit} bytes`, instance: url });
      res.cork(() => res.writeStatus("413 Payload Too Large").writeHeader("content-type", "application/problem+json").end(body, true));
    }

    async function exchange(body) {
      try {
        answer = await app.exchange({ method, url, headers, body, remote });
      } catch (err) {
        console.error(err);
        answer = { status: 500, headers: { "content-type": "application/problem+json" }, body: JSON.stringify({ type: "internal", title: STATUS_CODES[500], status: 500 }) };
      }
      if (gone) return void answer.abort?.abort();
      if (answer.stream) return void stream(answer);
      res.cork(() => {
        head(answer);
        const length = answer.headers["content-length"];
        // a HEAD keeps the length of the GET it stands for, without the body
        if (answer.body === undefined && length !== undefined && method === "HEAD") res.endWithoutBody(Number(length));
        else res.end(answer.body ?? "");
      });
      answer.done?.();
    }

    function head(a) {
      res.writeStatus(`${a.status} ${STATUS_CODES[a.status] ?? ""}`);
      // uWS writes the length itself, and the connection is its business
      for (const [k, v] of Object.entries(a.headers)) if (k !== "content-length" && k !== "connection") res.writeHeader(k, v);
    }

    async function stream(a) {
      res.cork(() => head(a));
      try {
        for await (const chunk of a.stream) {
          if (gone) break;
          let ok;
          res.cork(() => (ok = res.write(chunk)));
          if (!ok) await new Promise((resolve) => res.onWritable(() => (resolve(), true)));
        }
      } catch (err) {
        console.error(err);
      }
      if (!gone) res.cork(() => res.end());
      a.done?.();
    }
  });

  const token = await new Promise((resolve, reject) =>
    server.listen(host, port, (t) => (t ? resolve(t) : reject(new Error(`uWebSockets.js could not listen on ${host}:${port}`)))),
  );
  await app.started();
  return {
    /** The port it listens on, also when it was asked for 0. */
    port: uWS.us_socket_local_port(token),
    /** Stops taking requests, then runs the app's onClose hooks. */
    async close() {
      uWS.us_listen_socket_close(token);
      await app.stopped();
    },
  };
}
