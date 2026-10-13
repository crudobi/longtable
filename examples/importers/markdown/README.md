# The clean-room Markdown importer

`markdown-recipe.mjs` in this directory was written by a developer (an
independent agent) who was given **only** the published documentation —
`docs/` and `lexicons/` — and had never seen the Longtable source code.
It implements a simple Markdown recipe format:

```markdown
# Recipe Title

Prep: 15 min
Cook: 30 min

## Ingredients
- 200 g flour
- 2 eggs

## Steps
1. Mix everything.
2. Bake for 30 minutes.
```

It is the worked example for [docs/importers.md](../../../docs/importers.md)
and the subject of the Phase 5 clean-room proof:

- `selftest.mjs` — the author's own standalone checks (parsing variants +
  plain-language error cases), runnable with plain `node selftest.mjs`
  (it imports `./markdown-recipe.mjs` — copy the two files together).
- The same module ships as a drop-in plugin at
  `src/importers/plugins/markdown-recipe.mjs` (byte-identical), and
  `e2e/proof-importer.mjs` proves it end-to-end in the real app on an
  emulator: listed in the Import panel, paste Markdown, recipe lands in
  the cookbook complete.

Friction the author reported against the docs (all since addressed in
`docs/importers.md`): the worked-example stub's elided signature read
as pseudocode rather than legal syntax; the docs didn't say whether
"required" fields are the importer's or the validator's job to reject;
they didn't mention that an importer returning zero recipes is itself
an error; and `accepts`-driven input selection among equally valid
kinds wasn't spelled out.
