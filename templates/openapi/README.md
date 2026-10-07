# OpenAPI

Bookmarks, with an OpenAPI 3.1 document that is written from the routes, never by hand.
It shows what ends up in the document, how to get a typed client out of it, and how to
notice when a change would break that client.

## Run it

```sh
npm install
npm run dev        # the document is at http://localhost:3000/openapi.json
npm run openapi    # writes openapi.json to disk
npm run client     # generates client/api.d.ts from it (with openapi-typescript)
```

`npm run client` uses [openapi-typescript](https://openapi-ts.dev), an outside tool, through
`npx`. Any OpenAPI 3.1 generator works the same way: the document is the hand-over.

## Read it in this order

Open [src/app.ts](src/app.ts):

1. **app options**: title, version, description, servers
2. **named schemas** with `.describe()` and `.example()`: `components/schemas` and `$ref`
3. **summary, description, tags** on each route
4. **operationId**: the method name a generated client gets (otherwise inkan makes one up,
   like `getBookmarks`)

Then open `openapi.json` next to it and find each of them.

## Keep it in sync

Commit `openapi.json`. In CI, write it again and fail when it changed but the commit did not
include it:

```yaml
- run: npm run openapi
- run: git diff --exit-code openapi.json
```

Now every pull request that changes the API also shows the change to the document, line by
line, where reviewers can see what a client will notice.

A diff shows *that* something changed. `inkan diff` says whether it **breaks** a client:

```sh
npx inkan diff openapi.json src/app.ts
```

It compares the saved document with the app as it is now, lists every change as breaking or
safe, and exits with `1` only for the breaking ones. A new optional field passes, a field that
is required now does not.

## Change this first

Add `DELETE /bookmarks/:id` with an `operationId` of `removeBookmark`. Run `npm run openapi` and
`npm run client`, and look at what appeared in `client/api.d.ts`.

## Try this: break it on purpose

1. **A breaking change.** Make `tags` in `NewBookmark` need at least one entry
   (`t.array(Tag).min(1)`). Before you write the document again, run `npx inkan diff openapi.json src/app.ts`:
   it says "body.tags needs minItems 1 now", breaking. `minItems: 1` is exactly what an old
   client would trip over. `npm run check` notices first: "saved already" sends no tags, and
   now gets a 400 instead of the 409 it promises.
2. **A quiet rename.** Rename `title` to `name`. The examples fail first, then the document shows it.

## Next

`npx @vxnsin/inkan examples deploy`: a container, JSON logs and a clean shutdown.
