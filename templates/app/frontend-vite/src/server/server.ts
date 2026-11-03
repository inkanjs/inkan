import { serveStatic } from "@vxnsin/inkan";
import { app } from "./app.ts";

// In production one process serves both: the API under /api, and the frontend that
// `npm run build` wrote to dist/. Under `npm run dev` Vite does this instead.
app.register(serveStatic({ dir: "dist", spa: true, exclude: ["/api"] }));
app.listen();
