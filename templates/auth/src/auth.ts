import { problem, type Middleware } from "@vxnsin/inkan";

export type User = { name: string; role: "reader" | "admin" };

// 1. Who is who. Fake on purpose: in a real app this is a session store or a JWT check,
//    and the rest of this file stays the same.
const TOKENS: Record<string, User> = {
  "demo-reader": { name: "Rin", role: "reader" },
  "demo-admin": { name: "Mio", role: "admin" },
};

// 2. Middleware that finds out who is asking. It runs before the handler, puts the user
//    on ctx.state, and stops the request with a 401 when there is nobody.
export const authenticate: Middleware = async (ctx, next) => {
  const header: string = ctx.headers.authorization ?? "";
  const user = header.startsWith("Bearer ") ? TOKENS[header.slice(7)] : undefined;
  if (!user) {
    const p = problem(401, "unauthorized", "Send a token as `Authorization: Bearer <token>`");
    p.headers["www-authenticate"] = "Bearer"; // what a 401 should say, so clients know what to send
    throw p;
  }
  ctx.state.user = user;
  await next();
};

// 3. Middleware made by a function: a 403 for anybody without the role.
//    401 means "who are you?", 403 means "I know who you are, and no".
export const requireRole =
  (role: User["role"]): Middleware =>
  async (ctx, next) => {
    if (userOf(ctx).role !== role) throw problem(403, "forbidden", `Only the ${role} role may do this`);
    await next();
  };

// 4. A typed way to read the user back in a handler.
export const userOf = (ctx: { state: Record<string, unknown> }) => ctx.state.user as User;
