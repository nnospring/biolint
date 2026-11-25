#!/bin/sh
# Installs a packed tarball into an empty directory and exercises the installed command and library
# under whatever `node` is first on PATH. Usage: sh scripts/smoke.sh path/to/biolint-x.y.z.tgz
set -eu
TARBALL=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
echo "node $(node --version), tarball $(basename "$TARBALL")"
npm init -y >/dev/null
npm install --no-audit --no-fund "$TARBALL" >/dev/null
BIN=./node_modules/.bin/biolint

printf '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t100\t.\tA\tT\t.\t.\t.\n' > good.vcf
printf '##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n1\t1e+05\t.\tA\tT\t.\t.\t.\n' > bad.vcf
gzip -c bad.vcf > bad.vcf.gz
cat bad.vcf.gz bad.vcf.gz > twice.vcf.gz

expect() { # expect <status> <pattern> <command...>
  want=$1; pattern=$2; shift 2
  set +e; out=$("$@" 2>&1); got=$?; set -e
  if [ "$got" != "$want" ]; then echo "FAIL: '$*' exited $got, expected $want"; echo "$out"; exit 1; fi
  if ! printf '%s' "$out" | grep -q -- "$pattern"; then echo "FAIL: '$*' output lacks '$pattern'"; echo "$out"; exit 1; fi
  echo "ok   $*"
}
expect 0 'no problems' $BIN good.vcf
expect 1 'error\[VCF205\]' $BIN bad.vcf
expect 1 'bad.vcf.gz:3:3' $BIN -f compact bad.vcf.gz
expect 1 'VCF105' $BIN -f compact twice.vcf.gz
expect 2 'no such file' $BIN missing.vcf
expect 0 'VCF205' $BIN --explain VCF205
expect 0 '"schema": 1' sh -c "$BIN -f json good.vcf"
expect 0 'clean' node --input-type=module -e "
import { lintText, lintStream, allRules, VERSION } from 'biolint';
import { lintFile } from 'biolint/node';
import { createReadStream } from 'node:fs';
const a = lintText('>s\nACGT\n', { filename: 'a.fa' });
const b = await lintFile('bad.vcf.gz');
const c = await lintStream(createReadStream('twice.vcf.gz'), { filename: 'twice.vcf.gz' });
if (b.diagnostics[0].code !== 'VCF205' || c.lines !== 6 || allRules().length < 80 || !VERSION) throw new Error('library check failed: ' + JSON.stringify([b.diagnostics[0], c.lines]));
console.log(a.counts.error === 0 ? 'clean' : 'unexpected errors');
"
echo "smoke test passed"
