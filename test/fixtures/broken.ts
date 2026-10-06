import { inkan, t } from "../../src/index.ts";

export const app = inkan({ title: "Broken", version: "0.0.0", log: false, gracefulShutdown: false }).get(
  "/teas/:id",
  {
    params: t.object({ id: t.int() }),
    response: { 200: t.object({ id: t.int() }), 404: t.problem() },
    examples: [{ name: "missing", params: { id: 99 }, status: 404 }],
  },
  ({ params }) => ({ id: params.id }),
);
