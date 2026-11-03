import { defineConfig } from "vite";
import inkan from "@inkanjs/vite";

// The API runs inside Vite's dev server, on the same port, reloaded on every save.
export default defineConfig({
  plugins: [inkan({ entry: "src/server/app.ts" })],
});
