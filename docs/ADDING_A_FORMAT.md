# Adding or changing a format

This is the contract every format implementation follows. `src/formats/vcf/` is the reference implementation: read
`rules.ts` and `index.ts` there before writing anything.

## Files a format owns

| File | Purpose |
|---|---|
| `src/formats/<id>/rules.ts` | Rule catalogue: `defineRules('<id>', {...})`, with examples |
| `src/formats/<id>/index.ts` | The validator and the exported `FormatDef` |
| `test/<id>.test.ts` | Tests beyond the rule examples |
| `conformance/<id>.ts` | Third-party corpora, suites, and an explanation of every disagreement |

A format does not edit `src/core/`, other formats, `src/formats/index.ts`, `conformance/index.ts` or `scripts/`.
If the core lacks something, say so in the pull request rather than working around it in place.

## The interface

```ts
export const myformat: FormatDef = {
  id, name, description, extensions,          // extensions without .gz, lower case
  rules: Object.values(R),
  sniff(headLines) { return 0..1 },           // 1 = certainly this format, judging by the first lines
  segments?: true,                            // validator accepts very long lines in pieces (FASTA)
  blankLinesAreData?: true,                   // empty lines can be record content (FASTQ)
  bgzipExpected?: true,                       // usually indexed with bgzip + tabix/faidx
  create(ctx) { return new MyValidator(); },
};

interface Validator { line(line: Line, ctx: Context): void; end(ctx: Context): void }
```

`line()` is called once per line, in order. `line.bytes` is the content without its terminator and is only valid during
the call. `line.text` is the same content decoded one byte per character, so **string indices are byte offsets**; it is
computed lazily, so byte-oriented validators (FASTA, FASTQ) never pay for it. Line endings, byte-order marks, invalid
UTF-8, control characters, look-alike Unicode, trailing blank lines and a missing final newline are already reported by
the engine (`TXT` rules): do not report them again.

Report with `ctx.report(rule, column, endColumn, message, { hint, notes, fix, spec })`. `column` is a **0-based byte
index** into the line and `endColumn` is exclusive; pass `-1, -1` for "the whole line". The engine converts to 1-based
character columns, builds the excerpt, applies the per-rule display cap and counts occurrences. Use
`ctx.reportAt(rule, lineNumber, message, extra)` for something not tied to the current line (`0` = the whole file).
`ctx.enabled(rule)` lets you skip an expensive check that is switched off. `ctx.stat('records', n)` publishes summary
numbers; use the keys `records`, `sequences`, `reads`, `features` or `samples` where they fit, and `version` for a
display name such as `VCF 4.3`.

Memory must not grow with file size, except for sets that are inherently needed (IDs that must be unique). State that
exception in a comment and keep the per-entry cost small.

## Rules

Every rule has:

- a stable code (`<PREFIX><3 digits>`, never reused) and a camelCase key that becomes its kebab-case name;
- `title`: one line, sentence case, no trailing period;
- `level` for the default profile and optionally `strict` for the strict profile (`error`, `warning`, `info`, `off`);
- `explanation`: why it matters and what usually causes it, written for someone who has never read the specification;
- `spec`: document and section, when a specification states the requirement;
- at least one `bad` example, and a `good` example where the contrast teaches something.

Examples are tests: `test/examples.test.ts` checks that every bad example triggers its rule and no unrelated error, and
that every good example is completely clean. They are also the documentation: `docs/rules/` is generated from them.
Write examples with the `ex` template tag (`→` stands for a tab).

### Choosing levels

The **default** profile answers "will this file work?". An `error` is something that makes a mainstream tool fail, or
silently produce wrong results, or that no reasonable reading of the format allows. A `warning` is a violation that
tools tolerate, or a strong sign of a mistake. An `info` is worth knowing and not a defect.

The **strict** profile answers "does this file follow the specification to the letter?". Violations that tools accept
are `warning` or `off` by default and `error` in strict.

When a specification and widespread practice disagree, default follows practice and strict follows the specification.
Never make something an error because a test corpus expects it; make it an error because a specification or a tool
requires it, and cite which.

### Messages

- Say what is wrong with the actual value, quoted with backticks: ``POS `1e+05` is not a valid position``.
  Quote user content through `show()` from `core/util.ts`, which truncates and escapes it.
- Start lower case, no trailing period, no "Error:" prefix. The message must stand alone without the hint.
- `hint` says what to do, concretely, as an imperative: a corrected value, a command, or the likely cause.
  Recognise common real-world causes (spreadsheet artefacts, spaces for tabs, a tool's known quirk) and name them.
- `notes` carry context such as ``declared on line 12``.
- Point at the smallest span that is wrong, not the whole line.
- One problem, one diagnostic: after reporting a structural problem on a line, skip the checks that depend on it.

## Acceptance gates

A format ships as stable only when all four hold. Otherwise it ships marked experimental.

1. **Examples.** Every rule has a bad example; `npm test` passes.
2. **Third-party corpus.** `conformance/<id>.ts` names at least one corpus of files labelled valid/invalid by people
   other than us, pinned to a commit, with its licence. `npm run conformance` scores the strict profile against it and
   every disagreement is explained in `adjudications` with one of the verdicts in `conformance/types.ts`.
   Rules come from the specification, never from file names or labels in the corpus.
3. **Real files.** `node scripts/realworld.ts --format <id> --set dev` runs the default profile over files produced by
   mainstream tools. A file that those tools accept must produce no errors, or the error must be a genuine defect that
   you can explain. Tune only on the `dev` half. The `holdout` half is scored once, by the maintainer, for the report.
4. **Scale.** A file of several hundred megabytes is checked in bounded memory at a reasonable speed
   (tens of MB/s for tab-separated formats, 100+ MB/s for FASTA/FASTQ).
