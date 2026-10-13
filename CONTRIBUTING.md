# Contributing to Longtable

Longtable is free software (see [`LICENSING.md`](LICENSING.md)) and
contributions are welcome — code, docs, lexicon proposals, importer
plugins, bug reports with reproduction steps.

## Developer Certificate of Origin

Contributions are accepted under the **Developer Certificate of
Origin 1.1** (DCO). There is no copyright assignment and no CLA: you
keep your copyright, and you certify the contribution is yours to
submit under the project's licenses.

To certify, add a sign-off line to every commit:

```
Signed-off-by: Your Name <you@example.org>
```

`git commit -s` adds it automatically. By signing off, you certify
the following:

```text
Developer Certificate of Origin
Developer Certificate of Origin
Version 1.1
Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.
Developer's Certificate of Origin 1.1
By making a contribution to this project, I certify that:
(a) The contribution was created in whole or in part by me and I
have the right to submit it under the open source license
indicated in the file; or
(b) The contribution is based upon previous work that, to the best
of my knowledge, is covered under an appropriate open source
license and I have the right under that license to submit that
work with modifications, whether created in whole or in part
by me, under the same open source license (unless I am
permitted to submit under a different license), as indicated
in the file; or
(c) The contribution was provided directly to me by some other
person who certified (a), (b) or (c) and I have not modified
it.
(d) I understand and agree that this project and the contribution
are public and that a record of the contribution (including all
personal information I submit with it, including my sign-off) is
maintained indefinitely and may be redistributed consistent with
this project or the open source license(s) involved.
```

## Practicalities

- Build and validate before you push: the CI pipeline (typecheck,
  unit tests, AppView tests, web build, Android debug build, e2e gate,
  storage-migration proof) must be green; a red run publishes nothing.
- Any change to an on-disk storage format ships with a migration and
  an upgrade test, or it doesn't ship.
- New importers go in `src/importers/plugins/` against the Importer
  API v1 contract in [`docs/importers.md`](docs/importers.md).
- Protocol changes start as lexicon/spec changes in
  [`lexicons/`](lexicons/) and [`docs/public-protocol.md`](docs/public-protocol.md);
  both are CC0, so the ecosystem can adopt them independently of this
  codebase.
