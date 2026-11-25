/** A third-party repository fetched at a pinned commit (never vendored). */
export interface Corpus {
  name: string;
  repo: string;
  commit: string;
  /** Directories to check out (sparse). */
  paths: string[];
  /** Licence of the corpus files, as stated by the repository. */
  license: string;
}

/** A set of labelled files inside a corpus. */
export interface Suite {
  name: string;
  corpus: string;
  /** Directory inside the corpus. */
  dir: string;
  /** biolint format id the files are checked as. */
  format: string;
  include: RegExp;
  exclude?: RegExp;
  /** What the corpus authors say about a file (path relative to `dir`); null = not a labelled test file. */
  label(rel: string): 'valid' | 'invalid' | null;
}

export type Verdict =
  | 'corpus-error'      // the file's label contradicts the specification, or the file has a second, unintended defect
  | 'corpus-outdated'   // the label follows an earlier revision of the specification
  | 'beyond-spec'       // the corpus enforces a convention of its own validator that the specification does not state
  | 'deliberate'        // biolint knowingly differs, for the reason given
  | 'not-implemented';  // a real requirement that biolint does not check yet

/** Explains one group of disagreements between biolint (strict profile) and a corpus label. */
export interface Adjudication {
  /** Matched against the corpus-relative path (`<corpus>/<dir>/<file>`). */
  path?: RegExp;
  /** Matched against the `##CauseOfFailure` text some corpora embed in their invalid files. */
  cause?: RegExp;
  /** `invalid` = the corpus rejects the file and biolint accepts it; `valid` = the reverse. */
  label: 'valid' | 'invalid';
  verdict: Verdict;
  why: string;
}

export interface FormatConformance {
  corpora: Corpus[];
  suites: Suite[];
  adjudications: Adjudication[];
  /** Caveats printed under the format's table. */
  notes?: string[];
}
