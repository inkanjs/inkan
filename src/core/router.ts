// A segment tree. Static segments win over `:params`, params win over `*rest`,
// so `/users/me` and `/users/:id` can live side by side in any order.
//
// Paths without parameters are also kept in a map by their exact path, so the
// most common request (`/health`, `/teas`) is one lookup, not a walk.

type Node<R> = {
  statics: Map<string, Node<R>>;
  param?: { name: string; node: Node<R> };
  wildcard?: { name: string; routes: Map<string, R> };
  routes: Map<string, R>;
};

const node = <R>(): Node<R> => ({ statics: new Map(), routes: new Map() });

export type Match<R> =
  | { kind: "found"; route: R; params: Record<string, string> }
  | { kind: "method"; allow: string[] }
  | { kind: "none" };

export function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

const NONE = { kind: "none" } as const;
/** The params of a path without any; shared by every such match, so it must not change. */
export const NO_PARAMS: Record<string, string> = Object.freeze({}) as Record<string, string>;

export class Router<R> {
  private root: Node<R> = node();
  /** Routes of paths without parameters, by their normalized path; shares its maps with the tree. */
  private exact = new Map<string, Map<string, R>>();

  add(method: string, path: string, route: R) {
    let n = this.root;
    const segments = splitPath(path);
    for (const [i, seg] of segments.entries()) {
      if (seg.startsWith("*")) {
        if (i !== segments.length - 1) throw new Error(`A wildcard has to be the last segment: ${path}`);
        n.wildcard ??= { name: seg.slice(1) || "rest", routes: new Map() };
        this.put(n.wildcard.routes, method, path, route);
        return;
      }
      if (seg.startsWith(":")) {
        const name = seg.slice(1);
        if (n.param && n.param.name !== name) {
          throw new Error(`${path} names a parameter :${name} where another route already has :${n.param.name}`);
        }
        n.param ??= { name, node: node() };
        n = n.param.node;
      } else {
        let next = n.statics.get(seg);
        if (!next) n.statics.set(seg, (next = node()));
        n = next;
      }
    }
    this.put(n.routes, method, path, route);
    // the tree would end on this very node for this path, so the shortcut answers the same
    if (!segments.some((s) => s.startsWith(":"))) this.exact.set("/" + segments.join("/"), n.routes);
  }

  private put(routes: Map<string, R>, method: string, path: string, route: R) {
    if (routes.has(method)) throw new Error(`${method} ${path} is defined twice`);
    routes.set(method, route);
  }

  match(method: string, path: string): Match<R> {
    const encoded = path.includes("%");
    let routes = encoded ? undefined : this.exact.get(path);
    let params = NO_PARAMS;
    if (!routes) {
      const names: string[] = [];
      const values: string[] = [];
      try {
        routes = this.walk(this.root, path, 0, encoded, names, values);
      } catch {
        return NONE; // a broken %-escape
      }
      if (!routes) return NONE;
      if (names.length) {
        params = {};
        for (let i = 0; i < names.length; i++) params[names[i]] = values[i];
      }
    }
    const route = routes.get(method) ?? (method === "HEAD" ? routes.get("GET") : undefined);
    if (route) return { kind: "found", route, params };
    const allow = [...routes.keys()];
    if (allow.includes("GET")) allow.push("HEAD");
    return { kind: "method", allow };
  }

  // Depth first, straight over the path: one segment at a time, no array of them. Empty
  // segments (`//`, a trailing `/`) are skipped. The names and values of the parameters on
  // the winning path are left in the arrays.
  private walk(n: Node<R>, path: string, at: number, decode: boolean, names: string[], values: string[]): Map<string, R> | undefined {
    let i = at;
    while (path.charCodeAt(i) === 47) i++; // "/"
    if (i >= path.length) {
      if (n.routes.size) return n.routes;
      if (n.wildcard) {
        names.push(n.wildcard.name);
        values.push("");
        return n.wildcard.routes;
      }
      return undefined;
    }
    let end = path.indexOf("/", i);
    if (end < 0) end = path.length;
    const seg = decode ? decodeURIComponent(path.slice(i, end)) : path.slice(i, end);
    const s = n.statics.get(seg);
    if (s) {
      const hit = this.walk(s, path, end, decode, names, values);
      if (hit) return hit;
    }
    if (n.param) {
      names.push(n.param.name);
      values.push(seg);
      const hit = this.walk(n.param.node, path, end, decode, names, values);
      if (hit) return hit;
      names.pop();
      values.pop();
    }
    if (n.wildcard) {
      const rest = splitPath(path.slice(i));
      names.push(n.wildcard.name);
      values.push((decode ? rest.map(decodeURIComponent) : rest).join("/"));
      return n.wildcard.routes;
    }
    return undefined;
  }
}
