# @inkanjs/uws

Runs an [inkan](https://github.com/inkanjs/inkan) app on
[uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) instead of `node:http`.
The app does not change: contracts, hooks, plugins, problems, streams and the inspector
all work as they do with `app.listen()`. This package only moves bytes between the socket
and `app.exchange()`, the one door inkan has for any server.

## Install

uWebSockets.js is not on npm; it comes from its GitHub releases. npm 12 refuses packages
from git unless you say so, which is why it is a peer you install yourself, on purpose:

```sh
npm install @inkanjs/uws
npm install --allow-git=all "uWebSockets.js@github:uNetworking/uWebSockets.js#v20.71.0"
```

## Use

```ts
import { inkan } from "@vxnsin/inkan";
import { serve } from "@inkanjs/uws";

const app = inkan().get("/hello", () => ({ hello: "world" }));
const server = await serve(app, { port: 3000 });
// later: await server.close();   stops taking requests, then runs onClose
```

## What is the same, what is not

The same set of requests runs against `app.listen()`, `app.fetch()` and this adapter in
CI: routes, bodies and the body limit, problems, HEAD, query and headers, endless event
streams that stop when the client leaves, onListen and onClose. `workers` (the cluster
mode) is for `app.listen()`; run one process per core yourself if you need it here.

Measure before you switch: the bench in the inkan repository has an `inkan-uws` entry
next to `inkan` on node:http.
