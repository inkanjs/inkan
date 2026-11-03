# {{name}}

An API built with [inkan](https://github.com/inkanjs/inkan): one contract per route gives
validation, types, the OpenAPI document, the docs page and the tests.

{{stack}}

## Run it

```sh
{{commands}}
```

## What is where

{{layout}}

## Change this first

Add `DELETE {{prefix}}/notes/:id`. Give it an example for "deleted" (204) and one for
"missing" (404); `npm run check` fails until both statuses are shown.

## Next

- `npm run check` and `npm test` run in CI on every push: .github/workflows/ci.yml.
- `npx inkan openapi {{src}}/app.ts -o openapi.json` writes the document. Commit it, and
  `npx inkan diff openapi.json {{src}}/app.ts` tells you later whether a change breaks a client.
- The docs: https://inkan-dev.vercel.app/docs
