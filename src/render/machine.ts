import type { LintResult, RuleMeta, Severity } from '../core/types.ts';
import { HOMEPAGE, VERSION } from '../version.ts';

/** Stable JSON document for scripts. `schema` changes only with a breaking change. */
export function renderJson(results: readonly LintResult[]): string {
  return JSON.stringify({ schema: 1, tool: { name: 'biolint', version: VERSION }, results }, null, 2);
}

const SARIF_LEVEL: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'note' };

/** SARIF 2.1.0, for GitHub code scanning and other viewers. Columns are Unicode code points. */
export function renderSarif(results: readonly LintResult[], rules: readonly RuleMeta[]): string {
  const used = new Set(results.flatMap((r) => r.diagnostics.map((d) => d.code)));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'biolint',
          version: VERSION,
          ...(HOMEPAGE ? { informationUri: HOMEPAGE } : {}),
          rules: rules.filter((r) => used.has(r.code)).map((r) => ({
            id: r.code,
            name: r.name,
            shortDescription: { text: r.title },
            fullDescription: { text: r.explanation },
            ...(HOMEPAGE ? { helpUri: `${HOMEPAGE}/blob/main/docs/rules/${r.code}.md` } : {}),
            defaultConfiguration: { level: r.level === 'off' ? 'none' : SARIF_LEVEL[r.level] },
          })),
        },
      },
      columnKind: 'unicodeCodePoints',
      results: results.flatMap((r) => r.diagnostics.map((d) => ({
        ruleId: d.code,
        level: SARIF_LEVEL[d.severity],
        message: { text: d.hint ? `${d.message}. Help: ${d.hint}` : d.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: r.filename.split('\\').join('/') },
            ...(d.line > 0 ? { region: { startLine: d.line, ...(d.column > 0 ? { startColumn: d.column, endColumn: Math.max(d.endColumn, d.column) } : {}) } } : {}),
          },
        }],
      }))),
    }],
  };
  return JSON.stringify(sarif, null, 2);
}

const escData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s: string) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** GitHub Actions workflow commands: problems show up as annotations on the pull request. */
export function renderGithub(results: readonly LintResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    for (const d of r.diagnostics) {
      const kind = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'notice';
      const props = [`file=${escProp(r.filename)}`];
      if (d.line > 0) props.push(`line=${d.line}`);
      if (d.line > 0 && d.column > 0) props.push(`col=${d.column}`, `endColumn=${Math.max(d.endColumn, d.column)}`);
      props.push(`title=${escProp(`${d.code} ${d.name}`)}`);
      lines.push(`::${kind} ${props.join(',')}::${escData(d.hint ? `${d.message}. Help: ${d.hint}` : d.message)}`);
    }
  }
  return lines.join('\n');
}
