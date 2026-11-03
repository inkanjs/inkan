import { handlers } from "@inkanjs/next";
import { app } from "@/server/app.ts";

// Every request under /api goes to the inkan app: its routes, /api/docs and the
// inspector at /api/_inkan while `next dev` runs.
export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = handlers(app);
