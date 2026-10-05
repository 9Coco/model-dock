# Contributing

Use Node.js 24.13 or newer and npm. Install the committed dependency tree with
`npm ci`; optional local mirrors must not be hard-coded into the public lockfile.
Read [AGENTS.md](AGENTS.md) and the [security policy](SECURITY.md) before changes.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:production
```

The Windows/Linux CI matrix performs these checks from a fresh checkout.
Changes to layout, icons or dialogs also need the isolated Electron smoke checks
described in README. They use synthetic accounts and temporary profiles; a test
must not inspect real authorization files or mutate installed client settings.
Record native OS behavior and real-provider inference separately from unit or
fixture results. A model directory or a quota response does not prove inference.

## Changes and pull requests

Keep changes focused. Include the trigger, resulting behavior, checks and any
remaining verification boundary. Use meaningful mock-upstream regressions for
authorization, routing, cancellation and configuration preservation. Mark an
incompatible schema or adapter change explicitly and explain migration behavior.

Submit original contributions under ModelDock's MIT license. You must have the
right to contribute them; clearly identify any third-party portions and keep
their separate license and attribution instead of relabeling them as MIT.

Use descriptive commits such as `fix(auth): keep polling a pending device grant`
or `docs(license): record third-party artwork provenance`. New repairs belong in
new commits; do not force-push or rewrite published history without an explicit
maintainer decision and a coordinated recovery plan.

## Adapters, imports and third-party material

Record the upstream product/version, fixed source revision or official protocol
reference, fixture format and tested capabilities for an adapter or importer.
Read external files as metadata only, preserve their bytes, and reject unknown
layouts instead of guessing usage, model permissions or account identity.

For copied or adapted code/assets, record source, license, local hash and changes
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the applicable manifest.
Retain required copyright and permission notices. Do not present a branch-head
comparison as an exact match to an older source revision, and do not apply
ModelDock's MIT license over third-party Apache/CC-BY/MIT material.

Keep real tokens, account caches, client databases, screenshots containing
private data and local runtime profiles out of commits. Synthetic fixture values
must be unmistakably synthetic. Report sensitive issues through SECURITY.md.
