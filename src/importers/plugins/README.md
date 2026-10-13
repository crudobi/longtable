# Importer plugins

Drop a module in this directory and the app offers it in the Import panel
on the next build — no other code changes needed.

An importer plugin is a self-contained ES module whose **default export**
(or a named export called `importer`) is an importer object implementing
the Longtable Importer API v1 — see `docs/importers.md` for the full
contract and a worked example. The module must not import the app's code;
it receives source text/URLs and returns recipe data.

Plugins are loaded lazily and shape-checked. A plugin that fails to load
is reported in the Import panel and skipped — it cannot break the app.

File name becomes part of diagnostics only; the importer's own `id`
field is its identity.
