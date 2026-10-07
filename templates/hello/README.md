# Hello

The smallest inkan app there is: one route, its contract, four examples. Five minutes,
and you have seen the whole idea.

## Run it

```sh
npm install
npm run dev        # then open http://localhost:3000/docs
npm run check      # every example, run as a test
```

`npm run dev` restarts on every save. Node 22.18 or newer runs the `.ts` file as it is.

## Read it in this order

Open [src/app.ts](src/app.ts). The numbers in the comments are the reading order:

1. **the import**: everything comes from `@vxnsin/inkan`
2. **the app**: title and version land on the docs page
3. **the route**: path, contract, handler
   - **3a** what may come in, and how strings become booleans
   - **3b** what goes out, per status
   - **3c** the examples: shown on `/docs`, run by `npm run check`
4. **the handler**: typed input, a return for the 200, a `problem()` for the 404
5. **listen**: `$PORT` or 3000

Then click around on `/docs`: every example has **send**, **edit** and **curl**. Open
`/_inkan` in a second tab and watch the requests arrive.

## Change this first

Add a `?lang=de` query that answers `Hallo, Mio!`. Give it an example. Run `npm run check`.
The new example is a test now, and the docs page shows it.

## Try this: break it on purpose

1. **Answer the wrong shape.** In the handler, return `{ greeting: 42 }` (TypeScript will
   complain, that is the first catch). Run `npm run check`: the answer breaks the contract.
   With `npm run dev`, the server answers a 500 that says where, instead of sending it.
2. **Let the docs drift.** Change the "a friend" example to expect `"Hi, Mio!"`. `npm run check`
   shows exactly what came back instead.
3. **Promise more than you test.** Delete the "nobody home" example and run
   `npm run check -- --strict`. The 404 is still in the contract, but nothing tests it,
   and `--strict` says so.
4. **Send rubbish.** `curl "localhost:3000/hello/R2-D2?shout=maybe"` answers one 400 that
   lists both problems, not just the first.

## Next

`npx @vxnsin/inkan examples tea-shop`: a whole API with named schemas, groups and a store.
