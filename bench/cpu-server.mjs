// A bench server that also counts its own CPU time. Started by cpu.mjs over IPC:
// "mark" starts a measurement, "read" answers the CPU microseconds per request since.
import http from "node:http";

let served = 0;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === "request") served++;
  return emit.call(this, event, ...args);
};
let since = process.cpuUsage();
let at = 0;
process.on("message", (m) => {
  if (m === "mark") {
    since = process.cpuUsage();
    at = served;
    process.send({ ok: true });
  }
  if (m === "read") {
    const u = process.cpuUsage(since);
    process.send({ us: (u.user + u.system) / Math.max(1, served - at) });
  }
});
process.argv = [process.argv[0], "servers.mjs", process.argv[2], process.argv[3]];
await import("./servers.mjs");
