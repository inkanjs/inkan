// {{name}}: a plugin for inkan. It is an example to replace with your own; keep the shape.
//
//   import { myPlugin } from "{{name}}";
//   app.register(myPlugin({ header: "x-tenant" }));
//
// It asks every request of the scope it is registered in for a header, answers 400 when
// it is missing, puts it on the context as `ctx.tenant`, and writes the header into the
// OpenAPI document of every route there, so the docs say what the plugin asks for.
//
// Plain JavaScript with its types in index.d.ts: no build step, and what is in the
// repository is what npm installs.

import { plugin, problem } from "@vxnsin/inkan";

/**
 * @param {import("./index.d.ts").MyPluginOptions} [options]
 */
export function myPlugin(options = {}) {
  const header = (options.header ?? "x-tenant").toLowerCase();
  return plugin(
    (app) => {
      // the raw headers: a route's header schema may leave out what it does not list
      app.onRequest((ctx) => {
        if (!ctx.rawHeaders[header]) throw problem(400, "missing-header", `Send the ${header} header.`);
      });
      app.describe((operation) => {
        (operation.parameters ??= []).push({ name: header, in: "header", required: true, schema: { type: "string" } });
        operation.responses["400"] ??= { description: `Without the ${header} header` };
      });
      // returned, so the types of what it decorates reach the handlers
      return app.decorateRequest("tenant", (ctx) => String(ctx.rawHeaders[header]));
    },
    // shared: its hooks act on the routes of the scope it is registered in.
    // inkan: the versions it works with; keep it the same as peerDependencies.
    { name: "{{name}}", shared: true, inkan: "{{range}}" },
  );
}

export default myPlugin;
