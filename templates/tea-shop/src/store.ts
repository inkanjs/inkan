import type { NewTea, Tea } from "./schemas.ts";

// A store in memory. In a real app this is your database; the routes would not change.
let teas: Tea[] = [];
let nextId = 1;

export const store = {
  all: () => teas,
  find: (id: number) => teas.find((x) => x.id === id),
  byName: (name: string) => teas.find((x) => x.name.toLowerCase() === name.toLowerCase()),
  add(input: NewTea): Tea {
    const tea = { id: nextId++, ...input };
    teas.push(tea);
    return tea;
  },
  change(id: number, patch: Partial<NewTea>): Tea | undefined {
    const tea = store.find(id);
    if (tea) Object.assign(tea, patch);
    return tea;
  },
  remove(id: number): boolean {
    const before = teas.length;
    teas = teas.filter((x) => x.id !== id);
    return teas.length < before;
  },
  /** The same three teas every time. `inkan check` calls this before every example. */
  reset() {
    nextId = 1;
    teas = [];
    store.add({ name: "Sencha", kind: "green", grams: 100, price: 9.5, inStock: true });
    store.add({ name: "Earl Grey", kind: "black", grams: 100, price: 7, inStock: true });
    store.add({ name: "Tie Guan Yin", kind: "oolong", grams: 50, price: 12, inStock: false });
  },
};
