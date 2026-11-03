import { auth, hashPassword } from "@inkanjs/auth";
import { store } from "./store.ts";

type User = { id: string; email: string; passwordHash: string; roles: string[] };

{{production}}

// Signs the session cookies: 32 bytes or more, the same in every process. Only outside
// production is there a stand-in.
const secret = process.env.AUTH_SECRET ?? (production ? "" : "dev-only-secret-set-AUTH_SECRET-in-production");
if (secret.length < 32) throw new Error("Set AUTH_SECRET to a secret of 32 characters or more (openssl rand -base64 32).");

// The account `inkan check` and the tests log in with. It exists outside production only.
export const demoAccount = { login: "demo@example.com", password: "demo-password" };

// Your users table goes here: `find` by what they type to log in, `byId` for the session.
const users = new Map<string, User>();
if (!production) {
  users.set("1", { id: "1", email: demoAccount.login, passwordHash: await hashPassword(demoAccount.password), roles: ["user"] });
}

// POST /auth/login, POST /auth/logout and GET /auth/me, a session cookie kept in the same
// store as the rest of the app, CSRF checks and brute-force lockouts.
export const login = auth({
  secret,
  users: {
    find: (email) => [...users.values()].find((u) => u.email === email),
    byId: (id) => users.get(String(id)),
  },
  store,
  example: production ? undefined : demoAccount,
});
