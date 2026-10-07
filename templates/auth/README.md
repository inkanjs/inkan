# Auth

Notes behind a token. It shows where "who is asking" goes in an inkan app: in middleware,
on `ctx.state`, and in the contract, because a 401 and a 403 are answers like any other.

## Run it

```sh
npm install
npm run dev        # then open http://localhost:3000/docs
npm run check
```

On the docs page, put `Bearer demo-admin` into the token field at the top: every request from
the page sends it. It is kept for that tab only.

## Read it in this order

1. [src/auth.ts](src/auth.ts)
   1. the users, fake on purpose
   2. `authenticate`: finds the user or answers **401** (with `www-authenticate`)
   3. `requireRole(role)`: middleware made by a function, answers **403**
   4. `userOf(ctx)`: reads the user back, typed
2. [src/app.ts](src/app.ts)
   1. a route open to everybody
   2. a **group** that needs a token: `routes().use(authenticate)`
   3. the 401 in the contract, with examples that send no token or a wrong one
   4. **route-level** `use: [requireRole("admin")]` on top of the group's middleware

The order is: the group's middleware, then the route's, then the handler. Input is checked
before any of them, so a route never sees an id that is not a number.

## Change this first

Let readers write: add `POST /notes` that takes `{ text }` and stores it with `by` set to the
user's name. Examples: as a reader, as nobody, with an empty text.

## Try this: break it on purpose

1. **Forget the role.** Remove `use: [requireRole("admin")]`. `npm run check` fails "a reader may
   not": the contract still promises a 403 for readers, and now they get a 204.
2. **Trust the wrong thing.** Make `authenticate` take the user from a `?user=` query instead of a
   token. Then think about who can type a query string.
3. **Ask the inspector.** Open `/_inkan` and send a few requests from the docs page with a token.
   The `authorization` header shows as •••: the inspector never keeps secrets.

## Next

`npx @vxnsin/inkan examples testing`: examples as tests inside node:test, and in CI.
