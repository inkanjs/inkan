import { direct } from "@inkanjs/next";
import { app } from "@/server/app.ts";

// A Server Component asks the API in the same process: no port, no network, and the
// answer typed from the contract.
export const dynamic = "force-dynamic";

export default async function Home() {
  const api = direct(app);
  const health = await api.get("/api/health");
  return (
    <main>
      <h1>{"{{name}}"}</h1>
      <p>The API says: {health.ok ? (health.data.ok ? "all good" : "not good") : health.problem.title}</p>
      <p>
        <a href="/api/docs">API docs</a> · <a href="/api/openapi.json">OpenAPI</a>
      </p>
    </main>
  );
}
