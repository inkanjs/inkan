// 1. One import: the app, the schema builder `t`, and `problem` for errors.
import { inkan, problem, t } from "@vxnsin/inkan";

// 2. An app. The title and version show up on the docs page and in the OpenAPI document.
export const app = inkan({ title: "Hello", version: "0.1.0" });

// 3. A route is three things: the path, its contract, and the handler.
app.get(
  "/hello/:name",
  {
    summary: "Say hello",

    // 3a. What may come in. `:name` is 1 to 30 letters, `?shout` an optional boolean.
    //     Path and query arrive as strings; the schema turns "true" into true for you.
    params: t.object({ name: t.string().min(1).max(30).pattern(/^[a-z]+$/i) }),
    query: t.object({ shout: t.boolean().default(false) }),

    // 3b. What goes out, per status. A route that takes input also promises a 400
    //     for input that breaks the contract, without you writing it down.
    response: {
      200: t.object({ greeting: t.string() }),
      404: t.problem(),
    },

    // 3c. Examples. The docs page shows them with a send button,
    //     and `npm run check` runs every one of them as a test.
    examples: [
      { name: "a friend", params: { name: "Mio" }, expect: { greeting: "Hello, Mio!" } },
      { name: "shouting", params: { name: "Mio" }, query: { shout: true }, expect: { greeting: "HELLO, MIO!" } },
      { name: "nobody home", params: { name: "nobody" }, status: 404 },
      { name: "not a name", params: { name: "R2-D2" }, status: 400 },
    ],
  },

  // 4. The handler. `params.name` is a string and `query.shout` a boolean, typed and
  //    already checked. Return a value for the 200, throw a problem for anything else.
  ({ params, query }) => {
    if (params.name.toLowerCase() === "nobody") throw problem(404, "nobody-home", "There is nobody here to greet");
    const greeting = `Hello, ${params.name}!`;
    return { greeting: query.shout ? greeting.toUpperCase() : greeting };
  },
);

// 5. Listen on $PORT, or 3000. `inkan check` loads this file without opening a port.
app.listen();
