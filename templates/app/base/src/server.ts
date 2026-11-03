import { app } from "./app.ts";

// The only file that opens a port: $PORT or 3000. Tests and `inkan check` import
// app.ts instead, without one.
app.listen();
