# Testing

A todo list with tests. It shows the two kinds of test an inkan app has, and how to run
both in CI.

## Run it

```sh
npm install
npm test           # node:test: the examples, plus the edge cases
npm run check      # the examples alone, the way inkan check prints them
npm run dev        # the server, from src/server.ts
```

## Read it in this order

1. [src/app.ts](src/app.ts) builds the app and **exports** it, but does not listen.
   [src/server.ts](src/server.ts) is the only file that opens a port. Tests import the app
   without starting anything.
2. [test/contract.test.ts](test/contract.test.ts): **one test for all examples**.
   `app.check({ beforeEach: resetTodos, strict: true })`, and on failure the same report
   `inkan check` prints.
3. [test/edges.test.ts](test/edges.test.ts): what examples are not for. Sequences ("ids keep
   counting up"), states after several requests, exact error lists. `app.inject()` sends
   requests straight into the app, without a socket.
4. [.github/workflows/check.yml](.github/workflows/check.yml): both, on every push.

**Rule of thumb:** if a person reading the docs should see it, make it an example. If only a
test needs it, use `inject`.

## Change this first

Add `DELETE /todos/:id`. Give it examples for "removes it" and "missing", then add an edge test
that deletes a todo and checks that the list got shorter.

## Try this: break it on purpose

1. **Drift.** Make `POST /todos` answer `{ ...todo, done: "no" }`. The contract test fails on the
   schema. The edge tests fail too, though none of them looks at `done`: in development inkan
   refuses to send an answer that breaks its contract, and the POST answers 500 instead.
2. **Promise without proof.** Remove the "missing" example of `PATCH /todos/:id/done`. `npm test`
   fails: `strict` notices that the 404 is promised but never shown.
3. **Order.** Remove `beforeEach(resetTodos)` from the edge tests and add a test above "ids keep
   counting up" that posts a todo. The ids are now 3 and 4: without the reset, every test depends
   on the ones before it.

## Next

`npx @vxnsin/inkan examples openapi`: the document, a generated client, and keeping them in sync.
