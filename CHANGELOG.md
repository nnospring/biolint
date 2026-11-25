# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/). Rule codes are part of the public interface:
a code is never reused for a different check.

## [0.1.0] - unreleased

First release.

### Added

- Command-line tool, JavaScript/TypeScript library and browser playground.
- Formats: VCF 4.1–4.5, FASTA, FASTQ, GFF3, GTF, BED and SAM, plus generic text checks
  (encoding, line endings, look-alike Unicode, byte-order marks, truncated or mis-compressed gzip/BGZF).
- Two profiles: default (what breaks mainstream tools) and `--strict` (the letter of each specification).
- Output as annotated source excerpts, one-line `compact`, JSON, SARIF 2.1.0 and GitHub Actions annotations.
- `--fix` for mechanical repairs; `--explain` for any rule.
- Conformance reports against third-party corpora, with every disagreement explained.
