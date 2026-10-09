# {{name}}

A plugin for [inkan](https://github.com/inkanjs/inkan). It asks every request for a
header, answers 400 without it, and puts it on the context as `ctx.tenant`; the OpenAPI
document says so for every route. (An example to replace with what your plugin does.)

```sh
npm install @vxnsin/inkan {{name}}
```

Works with inkan `{{range}}`. On any other version `register()` throws and says which
one it needs.

## Usage

```ts
import { inkan } from "@vxnsin/inkan";
import { myPlugin } from "{{name}}";

const app = inkan()
  .register(myPlugin({ header: "x-tenant" }))
  .get("/me", (ctx) => ({ tenant: ctx.tenant })); // typed: string
```

```
GET /me  x-tenant: acme   → 200 { "tenant": "acme" }
GET /me                   → 400
```

## Options

| option | default | |
| --- | --- | --- |
| `header` | `"x-tenant"` | the header to read |

## Develop

```sh
npm install
npm test            # node:test, every case through app.inject
npm run typecheck   # test.ts against index.d.ts
```

The plugin is plain JavaScript in `index.js` with its types in `index.d.ts`: no build
step, and what is in the repository is what npm installs. When it needs another inkan
version, change `inkan` in `index.js` and `peerDependencies` together.

## Listed on Hanko

[Hanko](https://inkan-dev.vercel.app/hanko) lists every package on npm with the keyword
`inkan-plugin`, this one included once it is published. For a better line, tags or a docs
link, open a PR to [inkanjs/inkan.dev](https://github.com/inkanjs/inkan.dev) that adds it
under "community" in `data/hanko.ts`.

## License

MIT
