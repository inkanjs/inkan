# Tea shop

A whole small API: list, get, add, change and remove teas. It shows how an inkan app is laid
out once it is more than one file, and how examples that change data stay reliable as tests.

## Run it

```sh
npm install
npm run dev        # then open http://localhost:3000/docs
npm run check      # every example as a test, with --strict
```

## Read it in this order

1. [src/schemas.ts](src/schemas.ts): **named schemas**, and new shapes built from old ones
   (`omit`, `partial`). The TypeScript types come from the same place.
2. [src/store.ts](src/store.ts): a store in memory with a `reset()`. Your database goes here.
3. [src/teas.ts](src/teas.ts): **a group of routes**. Look for
   - one `problem()` helper, so every "not found" looks the same
   - query strings that become booleans and numbers, with a default
   - `reply(201, tea, { location })` for a header, typed to the contract
   - `t.empty()` for a 204
4. [src/app.ts](src/app.ts): the app puts it together: middleware, `mount("/teas", teas)`
   and the exported `beforeEach`.

## Why beforeEach matters

"a new oolong" adds a tea, "removes it" deletes one. Without a reset, the order of the
examples would decide whether "found" still finds anything. `inkan check` calls the
exported `beforeEach` before every example, so each one starts from the same shelf.

## Change this first

Add `GET /teas/:id/brew` that answers `{ seconds, celsius }` by kind: green 120 s at 75 °C,
black 240 s at 95 °C. Give it an example for each kind and one for a missing tea.

## Try this: break it on purpose

1. **Forget the reset.** Remove `export` from `beforeEach`. `npm run check` still passes, but only
   because of the order the examples happen to run in. Now move the `teas.delete(...)` block to the
   top of teas.ts: "everything" finds two teas instead of three. Put `export` back and it passes
   in any order.
2. **Leak a field.** In `store.add`, also keep `supplier: "secret"` on the tea. The answer
   still matches the contract, and `supplier` never leaves the server: anything the contract
   does not list is dropped.
3. **Take a promise back.** Remove `409: t.problem()` from the POST contract. The handler
   still throws a 409, so `npm run check` reports a status that is not in the contract.

## Next

`npx @vxnsin/inkan examples auth`: middleware that knows who is asking.
