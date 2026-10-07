import { inkan, problem, t } from "@vxnsin/inkan";

// 1. Everything here ends up in the OpenAPI document: title, version, description, servers.
export const app = inkan({
  title: "Bookmarks",
  version: "1.2.0",
  description: "Bookmarks with tags. The document at /openapi.json is written from these routes.",
  servers: [{ url: "http://localhost:3000", description: "your machine" }],
});

// 2. Named schemas become `components/schemas` and are referred to by `$ref`.
//    `.describe()` and `.example()` land in the document next to the field.
const Tag = t.string().pattern(/^[a-z0-9-]+$/).max(30).describe("Lowercase, digits and dashes").example("reading");
const Bookmark = t
  .object({
    id: t.int().example(1),
    url: t.string().format("uri").example("https://nodejs.org"),
    title: t.string().max(200),
    tags: t.array(Tag),
    added: t.date().describe("When it was saved"),
  })
  .named("Bookmark");
const NewBookmark = Bookmark.omit("id", "added").named("NewBookmark");

let bookmarks: { id: number; url: string; title: string; tags: string[]; added: Date }[] = [];
export function beforeEach() {
  bookmarks = [{ id: 1, url: "https://nodejs.org", title: "Node.js", tags: ["docs"], added: new Date("2026-01-02T03:04:05Z") }];
}
beforeEach();

app.get(
  "/bookmarks",
  {
    // 3. summary, description and tags shape the document and the docs page.
    summary: "List bookmarks",
    description: "Newest first. Filter by one tag, or several: `?tag=a&tag=b` means both.",
    tags: ["bookmarks"],
    // 4. An operationId of your own becomes the method name in a generated client.
    operationId: "listBookmarks",
    query: t.object({ tag: t.array(Tag).optional() }),
    response: { 200: t.array(Bookmark).describe("The bookmarks, newest first") },
    examples: [
      { name: "all", expect: [{ title: "Node.js" }] },
      { name: "by tag", query: { tag: ["docs"] }, expect: [{ id: 1 }] },
    ],
  },
  ({ query }) => bookmarks.filter((b) => (query.tag ?? []).every((tag) => b.tags.includes(tag))).toReversed(),
);

app.post(
  "/bookmarks",
  {
    summary: "Save a bookmark",
    tags: ["bookmarks"],
    operationId: "saveBookmark",
    body: NewBookmark,
    response: { 201: Bookmark, 409: t.problem().describe("That URL is saved already") },
    examples: [
      { name: "a new one", body: { url: "https://developer.mozilla.org", title: "MDN", tags: ["docs"] }, expect: { id: 2 } },
      { name: "saved already", body: { url: "https://nodejs.org", title: "again", tags: [] }, status: 409 },
      { name: "not a url", body: { url: "nodejs", title: "x", tags: [] }, status: 400 },
    ],
  },
  ({ body }) => {
    if (bookmarks.some((b) => b.url === body.url)) throw problem(409, "already-saved", `${body.url} is saved already`);
    const bookmark = { id: bookmarks.length + 1, added: new Date(), ...body };
    bookmarks.push(bookmark);
    return bookmark;
  },
);

app.listen();
