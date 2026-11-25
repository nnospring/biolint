# Contributing

Thanks for helping. The most useful contributions are, in order: a file that biolint judges wrongly (open a
"False positive or false negative" issue with the smallest input that shows it), a rule for something that bit you in
real work, and a new format.

## Setup

Development needs Node.js 24 or later, because tests and scripts run the TypeScript sources directly.
(The published package runs on Node.js 20 and later.)

```bash
npm ci
npm test                 # every rule's examples, plus unit and CLI tests
npm run typecheck
npm run docs             # regenerate docs/RULES.md and docs/rules/ after changing a rule
npm run corpora          # fetch third-party test corpora and real files into .corpora/ (about 250 MB)
npm run conformance      # score against the corpora; fails on any unexplained disagreement
npm run realworld        # run over real files produced by mainstream tools
npm run build:web && npm run serve   # playground at http://localhost:4173
```

There are no runtime dependencies and there should not be any: the library has to run unchanged in a browser.

## How rules are decided

- A rule exists because a specification states the requirement or because a mainstream tool fails without it.
  Say which in the rule's `spec` and `explanation`. "A test file expects it" is not a reason.
- **Default profile**: an error is something that breaks tools or cannot be interpreted. Violations that tools accept are
  warnings. **Strict profile** (`--strict`): the letter of the specification.
- Every rule carries its own examples. They are the tests and the documentation at once.
- A change that makes real, tool-accepted files fail needs a very good reason. `npm run realworld` is there to catch it.

The full contract for formats and rules, including message style, is in
[docs/ADDING_A_FORMAT.md](docs/ADDING_A_FORMAT.md).

## Conformance bookkeeping

`npm run conformance` compares the strict profile with labels in third-party corpora. Disagreements are expected: corpora
lag behind specifications, and validators add conventions of their own. Each disagreement must be explained in
`conformance/<format>.ts` with one of five verdicts (`corpus-error`, `corpus-outdated`, `beyond-spec`, `deliberate`,
`not-implemented`). The run fails if any is left unexplained, and CI checks that the committed report matches a fresh run.
Be honest with `not-implemented`: it is the to-do list.

## What a change needs

A change is accepted on evidence: a specification citation, a failing example that now passes, corpus and real-file
results. Please say in the pull request what you verified and how. Contributions are licensed under GPL-3.0, like the
rest of the project.

## Releasing (maintainers)

1. Update `version` in `package.json` and `VERSION` in `src/version.ts` (a test checks they agree), and `CHANGELOG.md`.
2. `npm test && npm run conformance && npm run docs`.
3. Tag `vX.Y.Z` and push the tag; the release workflow publishes to npm.
