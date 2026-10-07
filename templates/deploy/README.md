# Deploy

The same kind of app as the others, ready to leave your machine: a container, JSON logs,
request ids, a health route, and a shutdown that does not cut anybody off.

## Run it

```sh
npm install
npm run dev                                  # as always
NODE_ENV=production npm start                # how it runs in production: JSON lines
docker build -t {{name}} .
docker run --rm -p 8080:3000 {{name}}        # then: curl localhost:8080/healthz
docker run --rm -p 9000:9000 -e PORT=9000 {{name}}
```

## Read it in this order

1. [src/app.ts](src/app.ts)
   1. what changes in production by itself (logs, inspector, answer checks)
   2. a pretend database
   3. `onListen`: connect before the first request
   4. `onClose`: disconnect after the last one
   5. `/healthz` for the container
   6. request ids: `ctx.id`, from a proxy's `x-request-id` or fresh
   7. no port in the code: `$PORT` decides
2. [Dockerfile](Dockerfile): no build step, cached dependencies, not root, a health check,
   and node as PID 1 so it gets the signal
3. [warden.project.toml](warden.project.toml): the same app on your machine, on a port that
   stays its own

## What happens on `docker stop`

Docker sends SIGTERM and waits ten seconds. inkan stops taking new connections, lets the open
requests finish, runs `onClose`, and exits. If something hangs, it gives up after ten seconds
too, so it never gets killed halfway through closing.

## Logs

In production every request is one JSON line, ready for Loki, CloudWatch, Datadog or anything
that reads JSON:

```json
{"time":"2026-10-07T09:15:02.311Z","id":"edge-123","method":"GET","path":"/whoami","route":"/whoami","status":200,"ms":0.4,"notes":[]}
```

Hand them to your own logger instead with `inkan({ logger: (entry) => pino.info(entry) })`.

## Change this first

Make `/healthz` answer 503 while `db.open` is false, and add it to the contract with an example.
A load balancer then stops sending traffic to an instance whose database is gone.

## Try this: break it on purpose

1. **Fail on start.** Make `db.connect()` throw. `npm start` exits with the error instead of
   serving a broken app, and Docker restarts it.
2. **Point the health check at nothing.** Change `/healthz` in the Dockerfile to `/health`, build and
   run it. After a minute `docker ps` shows the container as unhealthy, though the app is fine:
   the health check is part of the contract between you and the platform.
