# biolint

**English** | [简体中文](README.zh-CN.md)

**Compiler-grade diagnostics for bioinformatics files.**

When a pipeline stops with `Could not parse the header`, or silently drops records, the file is usually broken in a
small, specific way. biolint finds it and tells you the line, the column, what is wrong, which part of the specification
says so, and what to change.

<!-- demo:start -->
```text
$ biolint examples/broken.vcf

error[VCF010]: Type=Int is not a valid INFO type
 --> examples/broken.vcf:3:29
  |
3 | ##INFO=<ID=DP,Number=1,Type=Int,Description="Depth">
  |                             ^^^
  = help: did you mean `Type=Integer`?
  = spec: VCF 4.3 §1.4.2

warning[VCF204]: contig `1` is not declared in any `##contig` line
 --> examples/broken.vcf:7:1
  |
7 | 1→1e+05→rs123→A→T,G→50→PASS→DP=10;AF=0.5→GT→0/1→1/3
  | ^
  = help: the header declares `chr1`: header and records use different naming (`chr` prefix); rename with `bcftools annotate --rename-chrs`
  = spec: VCF 4.3 §1.4.7

error[VCF205]: POS `1e+05` is not a valid position
 --> examples/broken.vcf:7:3
  |
7 | 1→1e+05→rs123→A→T,G→50→PASS→DP=10;AF=0.5→GT→0/1→1/3
  |   ^^^^^
  = help: scientific notation is usually a spreadsheet artefact; write the integer, e.g. `100000`
  = spec: VCF 4.3 §1.6.1

warning[VCF305]: `AF` has 1 value but its declaration requires one per ALT allele (2)
 --> examples/broken.vcf:7:38
  |
7 | 1→1e+05→rs123→A→T,G→50→PASS→DP=10;AF=0.5→GT→0/1→1/3
  |                                      ^^^
  = help: per-allele values must be updated whenever alleles are split, merged or removed (`bcftools norm` does this for declared tags)
  = note: declared as Number=A,Type=Float on line 4
  = spec: VCF 4.3 §1.4.2

error[VCF405]: genotype refers to allele 3, but the record has 2 ALT alleles
 --> examples/broken.vcf:7:51
  |
7 | 1→1e+05→rs123→A→T,G→50→PASS→DP=10;AF=0.5→GT→0/1→1/3
  |                                                   ^
  = help: allele indices run from 0 (REF) to 2
  = spec: VCF 4.3 §1.6.2

error[VCF210]: REF `-` is not a sequence of bases
 --> examples/broken.vcf:8:9
  |
8 | 1→200→.→-→T→NA→PASS→DP=7→GT→0/1→0/0
  |         ^
  = help: REF cannot be empty or missing: for an insertion, give the reference base before it and start ALT with the same base (e.g. REF=`A`, ALT=`ATG`)
  = spec: VCF 4.3 §1.6.1

✖ examples/broken.vcf (VCF 4.2, 2 records, 2 samples): 4 errors, 2 warnings
```
<!-- demo:end -->

It checks VCF, FASTA, FASTQ, GFF3, GTF, BED and SAM, reads `.gz` and `.bgz` directly, and runs on the command line,
in CI, as a library, and [in the browser](#in-the-browser) without uploading anything.

## Quick start

```bash
npx biolint variants.vcf.gz reads_R1.fastq.gz genes.gff3
```

Or install it: `npm install --global biolint`. It needs Node.js 20 or later and has no dependencies.

```bash
biolint calls.vcf                      # format detected from the name and the content
zcat calls.vcf.gz | biolint -t vcf -   # standard input
biolint --strict calls.vcf             # follow the specification to the letter
biolint --explain VCF305               # what a rule means, with an example
biolint --fix sample_sheet.bed         # repair what can be repaired mechanically
```

Exit status is `0` when there are no errors, `1` when there are, `2` for usage or I/O problems.

## What it knows about

<!-- status:start -->
| Format | Rules | Third-party corpus: strict profile agrees with the label | Held-out real files: wrongly flagged as errors on the blind run |
|---|---:|---:|---:|
| VCF | 67 | 1733 / 1967 (88.1%) | 1 / 49 |
| SAM | 63 | 199 / 204 (97.5%) | 0 / 2 |
| FASTQ | 14 | 98 / 98 (100.0%) | 0 / 58 |
| FASTA | 17 | 53 / 57 (93.0%) | 0 / 58 |
| GFF3 | 40 | 102 / 128 (79.7%) | 0 / 8 |
| GTF | 26 | 5 / 6 (83.3%) | 0 / 4 |
| BED | 38 | 602 / 636 (94.7%) | 1 / 29 |
| Any text format, gzip/BGZF | 19 | | |

284 rules in total. All 304 disagreements with the corpora are classified: corpus error 68, corpus outdated 10, beyond the specification 129, deliberate 37, **not implemented yet 60**. See [docs/CONFORMANCE.md](docs/CONFORMANCE.md). The blind run on real files, including the two false positives it exposed and their fixes, is in [docs/REALWORLD.md](docs/REALWORLD.md).
<!-- status:end -->

The first column of numbers is how many rules each format has; every rule has a page under [docs/rules](docs/RULES.md)
with an example of the problem and of biolint's output.

Beyond each format's own grammar, biolint recognises the things that actually happen to files:

- **Spreadsheets**: positions turned into `1e+05`, gene symbols turned into dates (`1-Mar`), decimal commas, a UTF-8
  byte-order mark, UTF-16 exports.
- **Editors and documents**: spaces where tabs belong, Windows line endings, curly quotes, no-break and zero-width
  spaces, full-width punctuation from CJK input methods.
- **Shell habits**: VCFs joined with `cat` (two headers), files compressed with `gzip` where an indexer needs `bgzip`,
  truncated downloads, a BGZF file without its end-of-file block, data compressed twice.
- **Tool conventions**: the places where widely used tools deviate from a specification are known, so default mode does
  not bury a real problem under thousands of technically-correct complaints.

When one mistake repeats on every line, biolint prints the first few and counts the rest.

## Two profiles

| | Reports as an error |
|---|---|
| default | what makes mainstream tools fail, or silently read something else |
| `--strict` | every violation of the specification, including those that tools tolerate |

Use the default to answer "will this file work?" and `--strict` before depositing or publishing data.
Individual rules can be turned off with `--ignore` or isolated with `--select`.

## In CI

```yaml
# .github/workflows/check-data.yml
- uses: actions/checkout@v4
- uses: nnospring/biolint@main
  with:
    files: data/*.vcf.gz annotation/*.gff3
```

Problems appear as annotations on the pull request. For other systems, `--format github`, `--format sarif`
(GitHub code scanning and other SARIF viewers), `--format json` and one-line `--format compact` are available.
A [pre-commit](https://pre-commit.com) hook is included (`.pre-commit-hooks.yaml`).

## As a library

```js
import { lintText, lintStream } from 'biolint';
import { lintFile } from 'biolint/node';

const result = await lintFile('calls.vcf.gz');            // Node.js: streams and decompresses
for (const d of result.diagnostics) {
  console.log(`${d.line}:${d.column} ${d.code} ${d.message}`);
}

lintText('>seq1\nACGT\n', { filename: 'a.fa' });           // anything already in memory
await lintStream(file.stream(), { filename: file.name }); // browsers: a File, a fetch body, any byte stream
```

`result.counts` has totals, `result.byRule` has per-rule counts including occurrences that were not listed, and each
diagnostic carries `code`, `severity`, `message`, `line`, `column`, `endColumn`, `hint`, `spec`, an excerpt of the line,
and a `fix` when one exists. Types are included.

## In the browser

`web/` is a single static page that runs the same library in a worker: drop a file and it is checked locally.
Nothing is uploaded, which matters for human genomic data. Build and open it with

```bash
npm ci && npm run build:web && npm run serve    # http://localhost:4173
```

or deploy `site/` anywhere static; the included workflow publishes it to GitHub Pages.

## How much to trust it

biolint is new. This is the evidence so far, all of it reproducible from this repository:

- **Rule examples.** Every rule ships with an input that must trigger it, and these run as tests.
- **Third-party corpora.** In strict mode biolint is compared with test files that other projects label valid or
  invalid, fetched at pinned commits. Agreement is in the table above. Where it disagrees, each case is classified
  in [docs/CONFORMANCE.md](docs/CONFORMANCE.md): sometimes the corpus is behind the specification, sometimes it enforces
  its own validator's conventions, and sometimes biolint simply does not implement the check yet. The last group is
  listed there as such.
- **Real files.** Files produced by mainstream tools (from the nf-core test datasets) should pass in default mode.
  Half of them were never looked at while rules were being tuned and were then scored once. That blind run flagged
  7 of 208 files: 5 were really defective (3 by accident, 2 on purpose, as test fixtures) and 2 were false positives,
  which are fixed and written up in [docs/REALWORLD.md](docs/REALWORLD.md).

None of this asks you to take the project's word for anything: specifications are cited rule by rule, corpora and real
files are fetched at pinned commits, every disagreement is accounted for in the open, and the numbers in this README are
generated from those runs rather than typed in. A file that biolint judges wrongly is the most valuable bug report there
is: [open an issue](.github/ISSUE_TEMPLATE/false-positive.yml).

What it does **not** do:

- **Binary formats.** BAM, CRAM, BCF, bigWig and the like are recognised and named, not checked. Convert to text
  first (`samtools view -h`, `bcftools view`).
- **Anything that needs a second file.** REF bases are not compared with a reference FASTA, coordinates are not checked
  against chromosome sizes, and identifiers are not looked up anywhere. The one exception is `--paired` for FASTQ mates.
- **The newest VCF semantics.** The structural-variant, local-allele and base-modification rules introduced in VCF 4.4
  and 4.5 are not implemented; they are the "not implemented yet" count above.
- **Deep biology.** GFF3 feature types are not validated against the Sequence Ontology, CDS phases are not recomputed,
  SAM mate fields and MD/NM tags are not cross-checked.
- **Certainty about BED columns.** A BED file cannot say which of its columns are standard, so biolint infers it from the
  first data line and tells you what it assumed (`-o bed.type=bed6+4` overrides it).

Also worth knowing: diagnostics are in English only; it has been run on macOS and, for the built package, on Node.js
20, 22 and 24, but not on Windows; evidence for GTF is thinner than for the other formats because no independent
labelled GTF corpus was found; and SAM's real-file evidence comes largely from tool test suites rather than from the
shared collection (details in [docs/REALWORLD.md](docs/REALWORLD.md)). On a recent laptop it checks roughly
100 MB/s of VCF and 250–400 MB/s of FASTA, FASTQ, GTF and SAM, in memory that does not grow with file size, except for
the identifier tables that GFF3 and duplicate-ID checks need.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The contract for adding a rule or a format is in
[docs/ADDING_A_FORMAT.md](docs/ADDING_A_FORMAT.md).

## Licence

Copyright (C) 2026 biolint contributors.

biolint is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License,
version 3, as published by the Free Software Foundation. It is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; see [LICENSE](LICENSE) for the full text.

Running biolint on your files places no conditions on those files or on your pipeline. Building its code into another
program does: that program must then be distributed under compatible terms.

Test corpora and real data files are not part of this repository; they are downloaded from their own projects under
their own licences when you run `npm run corpora`.
