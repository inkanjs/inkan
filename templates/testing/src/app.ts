import { inkan, problem, t } from "@vxnsin/inkan";

// 1. This file builds the app and exports it. It does not listen: src/server.ts does.
//    Tests can import it without a port, and so can `inkan check`.
export const app = inkan({ title: "Todos", version: "1.0.0" });

const Todo = t.object({ id: t.int(), title: t.string(), done: t.boolean() }).named("Todo");

let todos: { id: number; title: string; done: boolean }[] = [];
let nextId = 1;

// 2. Puts the data back. `inkan check` and the tests call it before each example or test.
export function resetTodos() {
  nextId = 1;
  todos = [{ id: nextId++, title: "Water the plants", done: false }];
}
export const beforeEach = resetTodos;
resetTodos();

app.get(
  "/todos",
  {
    summary: "List todos",
    query: t.object({ done: t.boolean().optional() }),
    response: { 200: t.array(Todo) },
    examples: [
      { name: "all of them", expect: [{ title: "Water the plants" }] },
      { name: "only the done ones", query: { done: true }, expect: [] },
    ],
  },
  ({ query }) => todos.filter((x) => query.done === undefined || x.done === query.done),
);

app.post(
  "/todos",
  {
    summary: "Add a todo",
    body: t.object({ title: t.string().trim().min(1).max(200) }),
    response: { 201: Todo },
    examples: [
      { name: "a new one", body: { title: "Call grandma" }, expect: { id: 2, done: false } },
      { name: "an empty title", body: { title: "   " }, status: 400 },
    ],
  },
  ({ body }) => {
    const todo = { id: nextId++, title: body.title, done: false };
    todos.push(todo);
    return todo;
  },
);

app.patch(
  "/todos/:id/done",
  {
    summary: "Mark a todo done",
    params: t.object({ id: t.int() }),
    response: { 200: Todo, 404: t.problem() },
    examples: [
      { name: "done", params: { id: 1 }, expect: { done: true } },
      { name: "missing", params: { id: 9 }, status: 404 },
    ],
  },
  ({ params }) => {
    const todo = todos.find((x) => x.id === params.id);
    if (!todo) throw problem(404, "todo-not-found", `There is no todo ${params.id}`);
    todo.done = true;
    return todo;
  },
);
