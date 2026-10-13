# Writing an importer — Importer API v1

An importer turns source material — a file from another recipe app,
pasted text, a web page — into recipes in Longtable's shape. Importers
are the main extension point for third-party developers: small,
self-contained modules that the app loads and offers in its Import
panel. You do not need to touch the app itself.

## The contract

An importer is an object implementing this interface
(`src/importers/contract.ts` is the normative source):

```ts
export const IMPORTER_API_VERSION = 1

export type ImporterInputKind = 'file' | 'text' | 'url'

export interface ImporterInput {
  kind: ImporterInputKind
  text?: string      // file contents or pasted text ('file' | 'text')
  fileName?: string  // original file name ('file' only)
  mimeType?: string  // file MIME type, when known ('file' only)
  url?: string       // the page to fetch ('url' only)
}

export interface ImportedRecipe {
  title: string
  ingredients: string[]
  steps: string[]
  prepMinutes?: number   // minutes
  cookMinutes?: number   // minutes
  photos?: string[]      // data URLs or http(s) URLs
}

export interface RecipeImporter {
  apiVersion: 1                    // must equal IMPORTER_API_VERSION
  id: string                       // stable, kebab-case, unique
  name: string                     // shown in the Import panel
  description?: string             // one line, shown under the name
  accepts: ImporterInputKind[]     // at least one
  fileExtensions?: string[]        // e.g. ['.json'] — file-picker filter
  import: (input: ImporterInput) =>
    Promise<ImportedRecipe[]> | ImportedRecipe[]
}
```

Rules of the road:

- **Input in, data out.** An importer never touches the store, the UI,
  or other app state. For `url` importers, fetching the supplied URL is
  the importer's own job (and the only network it should do).
- **One or many.** Return an array — a single recipe or a whole
  collection file both work.
- **Fail with a sentence.** On any problem, `throw new Error('…')` with
  a plain-language message a cook can act on ("This doesn't look like a
  Mealie recipe — it has no recipeIngredient list"). The app shows the
  message verbatim and imports **nothing** from that run.
- **Don't pre-validate defensively — but do shape faithfully.** After
  your importer returns, the app validates every recipe (below). Map
  your format's fields to the canonical names; don't stuff data into
  fields it doesn't belong in.
- **API v1 stores no description/yield/tags.** The local recipe shape
  doesn't have them yet. If your source has an essential note, fold it
  into a step; don't silently invent fields — extra fields are ignored.

## Validation (the app's side)

Every returned recipe passes `validateImportedRecipe` before anything
is saved. One invalid recipe fails the whole run — imports are atomic.

- `title`: required, non-empty after trimming, ≤ 500 characters.
- `ingredients` / `steps`: must be arrays of strings; entries are
  trimmed, empties dropped, ≤ 500 entries of ≤ 2000 characters.
- `prepMinutes` / `cookMinutes`: optional; a finite number ≥ 0
  (numeric strings are coerced; values are rounded).
- `photos`: optional array of strings; only `data:image/…` and
  `http(s)://` entries are kept — anything else is dropped, not stored.

Your importer's own shape is also checked when it registers: wrong
`apiVersion`, a non-kebab-case `id`, an empty `accepts`, or a missing
`import` function means the importer is refused (built-ins) or reported
as a plugin issue (drop-ins).

## Installing an importer

**Drop-in plugins (the normal path):** put the module file in
`src/importers/plugins/` and rebuild. The app discovers every
`*.{ts,tsx,js,mjs}` module there, loads it lazily when the Import panel
opens, shape-checks it, and lists it next to the built-ins. The module's
**default export** (or a named export called `importer`) must be the
importer object. Plugins must be self-contained — no imports of app
code. A plugin that fails to load is named in the Import panel with the
reason, and everything else keeps working.

**Built-ins** live directly in `src/importers/` and register in
`registry.ts`; that's the path for importers shipped with the app.

## Worked example

A complete importer for a simple Markdown recipe format — one `# Title`,
an `## Ingredients` list, an `## Steps` numbered list — lives in
[`examples/importers/markdown/`](../examples/importers/markdown/),
together with its author's standalone self-test. It was written from
this document alone (the Phase 5 clean-room proof) and installs
verbatim as a drop-in plugin; that directory's README records the
process and the author's friction notes on this document.

Two clarifications that process surfaced:

- **Who rejects a missing required field?** Both of you can. If your
  format can tell *why* a recipe is unusable, throw your own specific
  message from `import` — it's the one the user sees. The app validates
  whatever you return, regardless; think of your errors as diagnostics
  and the validator as the safety net.
- **Returning zero recipes is an error.** An `import` that resolves
  with an empty list is treated as "found no recipes in that source"
  and imports nothing. If your format legitimately yields nothing,
  throw a message saying so instead.
- **Which input do you get?** The Import panel builds exactly one
  `ImporterInput` per run, of a kind from your `accepts`: URL if you
  declared `url` and the user entered one, else the chosen file, else
  pasted text. If your `accepts` lists kinds you can't actually handle,
  the contract still requires the listed ones to work — declare only
  what you support.

## Reference importers (in `src/importers/`)

| Importer | id | Input | Notes |
|---|---|---|---|
| Web page | `web-page` | URL | JSON-LD (`schema.org/Recipe`) + OpenGraph parsing of a fetched page. |
| JSON file | `longtable-json` | file / text | One recipe object, an array, or `{"recipes": […]}`. Accepts the canonical field names plus the public-record aliases (`name`, `instructions`, `prepTimeMinutes`, `cookTimeMinutes`), so a saved `kitchen.longtable.recipe` record imports as-is. |
| Mealie export | `mealie-json` | file / text | A `recipe.json` from a Mealie backup (unzip first). ISO-8601 durations (`PT1H30M`) become minutes; `HowToSection` groups are flattened in order. Mealie's `image` field is a file *name* inside the backup, not data, so photos are not imported. |

## Testing your importer

- Unit-test it like the reference ones (`src/test/importers.test.ts`):
  feed fixtures, assert the mapped output; feed garbage, assert a plain
  failure message.
- The contract validator is importable from
  `src/importers/contract.ts` if you want to check your output shape in
  your own tests.
- On device: the e2e gate (`e2e/test.mjs`) exercises the JSON importer
  through the real Import panel UI; `e2e/proof-importer.mjs` proves a
  drop-in plugin (the Markdown importer above) end to end.
