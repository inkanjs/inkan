# create-inkan

```sh
npm create inkan@latest
npm create inkan@latest my-api -- --store postgres --auth --frontend next
```

A new [inkan](https://github.com/inkanjs/inkan) app: routes with contracts and examples, a
store (memory, Postgres, Redis, MongoDB or MySQL), logins from `@inkanjs/auth` if you want
them, a Next.js or Vite frontend if you want one, tests and a CI workflow. Every project
passes `inkan check` and its own tests as it comes.

It asks what it needs. Options skip the questions:

| option | |
| --- | --- |
| `--store memory\|postgres\|redis\|mongo\|mysql` | where the data lives (memory) |
| `--auth`, `--no-auth` | logins and sessions (no) |
| `--frontend none\|next\|vite` | a frontend with the API under `/api` (none) |
| `--pm npm\|pnpm\|yarn\|bun` | who installs (the one that ran this) |
| `--no-install` | write the files only |
| `--yes` | the defaults for everything the options leave open |
| `--force` | write into a folder that is not empty |

This package is `inkan create app` of `@inkanjs/inkan` at the same version; with inkan
installed, `npx inkan create app` does the same.
