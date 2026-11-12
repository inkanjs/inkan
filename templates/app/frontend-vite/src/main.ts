import { client } from "@inkanjs/inkan/client";
import type { app } from "./server/app.ts";

// The typed client: every path, parameter and answer is checked against the API by the
// compiler. Same origin, so no CORS: under `npm run dev` Vite hands /api to the app.
const api = client<typeof app>(location.origin);

const health = await api.get("/api/health");
document.querySelector("#health")!.textContent = health.ok ? (health.data.ok ? "all good" : "not good") : health.problem.title;
