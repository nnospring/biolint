// Third-party test corpora are not vendored. This script fetches them at pinned commits into .corpora/
// so that conformance numbers are reproducible. Usage: node scripts/corpora.ts [name ...]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { corpora as CORPORA_LIST } from '../conformance/index.ts';
import type { Corpus } from '../conformance/types.ts';

export const CORPORA: Corpus[] = CORPORA_LIST;

export const ROOT = join(import.meta.dirname, '..', '.corpora');

export function fetchCorpus(c: Corpus): void {
  const dir = join(ROOT, c.name);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git('init', '-q');
    git('remote', 'add', 'origin', c.repo);
    git('config', 'core.sparseCheckout', 'true');
    git('sparse-checkout', 'set', '--no-cone', ...c.paths.map((p) => `/${p}/`));
  }
  // The sparse path list may have grown since the last run.
  git('sparse-checkout', 'set', '--no-cone', ...c.paths.map((p) => `/${p}/`));
  if (safe(() => git('rev-parse', 'HEAD')) === c.commit) { git('checkout', '-q', c.commit); return; }
  git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', c.commit);
  git('checkout', '-q', 'FETCH_HEAD');
}

function safe(f: () => string): string | null { try { return f(); } catch { return null; } }

if (import.meta.main) {
  const want = process.argv.slice(2);
  for (const c of CORPORA) {
    if (want.length && !want.includes(c.name)) continue;
    process.stdout.write(`${c.name} @ ${c.commit.slice(0, 10)} ... `);
    fetchCorpus(c);
    process.stdout.write('ok\n');
  }
}
