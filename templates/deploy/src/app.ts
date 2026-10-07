import { inkan, t } from "@vxnsin/inkan";

// 1. In production (NODE_ENV=production) inkan logs one JSON line per request, keeps the
//    inspector off, and does not check answers against the contract on every request.
//    Development keeps the short coloured line. Nothing here has to say so.
export const app = inkan({ title: "Deploy me", version: "1.0.0" });

// 2. Something to open and close. A database pool, a queue, a cache: here it is pretend.
const db = {
  open: false,
  async connect() {
    db.open = true;
  },
  async end() {
    db.open = false;
  },
};

// 3. onListen runs before listen() is done, so no request arrives before the database is there.
//    If it throws, listen() fails and the container restarts instead of serving errors.
app.onListen(() => db.connect());

// 4. onClose runs on SIGTERM (what `docker stop` and Kubernetes send) after the last open
//    request has finished, within ten seconds. Close what you opened.
app.onClose(() => db.end());

// 5. A health route for the container and the load balancer. Keep it cheap.
app.get(
  "/healthz",
  {
    summary: "Is it up?",
    response: { 200: t.object({ ok: t.boolean(), db: t.boolean() }) },
    examples: [{ name: "up", expect: { ok: true } }],
  },
  () => ({ ok: true, db: db.open }),
);

// 6. Every request has an id: ctx.id. It comes from x-request-id when a proxy sends one,
//    goes back out as a header, and sits in every log line and every error answer.
app.get(
  "/whoami",
  {
    summary: "The request id of this request",
    response: { 200: t.object({ requestId: t.string() }) },
    examples: [{ name: "with an id from the proxy", headers: { "x-request-id": "edge-123" }, expect: { requestId: "edge-123" } }],
  },
  ({ id }) => ({ requestId: id }),
);

// 7. The port comes from $PORT, the host from $HOST. A container, a PaaS and warden
//    all set PORT, so nothing here names a port.
app.listen();
