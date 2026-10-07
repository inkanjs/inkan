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
    const params: Record<string, string> = {};
    if (!routes) {
      let segments = splitPath(path);
      if (encoded) {
        try {
          segments = segments.map(decodeURIComponent);
        } catch {
          return NONE;
        }
      }
      const names: string[] = [];
      const values: string[] = [];
      routes = this.walk(this.root, segments, 0, names, values);
      if (!routes) return NONE;
      for (let i = 0; i < names.length; i++) params[names[i]] = values[i];
    }
    const route = routes.get(method) ?? (method === "HEAD" ? routes.get("GET") : undefined);
    if (route) return { kind: "found", route, params };
    const allow = [...routes.keys()];
    if (allow.includes("GET")) allow.push("HEAD");
    return { kind: "method", allow };
  }

  // Depth first; the names and values of the parameters on the winning path are left in the arrays.
  private walk(n: Node<R>, segs: string[], i: number, names: string[], values: string[]): Map<string, R> | undefined {
    if (i === segs.length) {
      if (n.routes.size) return n.routes;
      if (n.wildcard) {
        names.push(n.wildcard.name);
        values.push("");
        return n.wildcard.routes;
      }
      return undefined;
    }
    const s = n.statics.get(segs[i]);
    if (s) {
      const hit = this.walk(s, segs, i + 1, names, values);
      if (hit) return hit;
    }
    if (n.param) {
      names.push(n.param.name);
      values.push(segs[i]);
      const hit = this.walk(n.param.node, segs, i + 1, names, values);
      if (hit) return hit;
      names.pop();
      values.pop();
    }
    if (n.wildcard) {
      names.push(n.wildcard.name);
      values.push(segs.slice(i).join("/"));
      return n.wildcard.routes;
    }
    return undefined;
  }
}
