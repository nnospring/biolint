# biolint

[English](README.md) | **简体中文**

**给生物信息学文件用的“编译器级”报错。**

流程报一句 `Could not parse the header` 就停了，或者悄悄丢了几条记录，多半是文件里某个很小、很具体的地方坏了。
biolint 把它找出来，告诉你第几行第几列、错在哪、规范哪一节这么规定、该怎么改。

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

支持 VCF、FASTA、FASTQ、GFF3、GTF、BED、SAM，可直接读 `.gz` 和 `.bgz`；能在命令行、CI、代码库里用，
也能[在浏览器里用](#在浏览器里用)，文件不会上传。诊断信息目前为英文。

## 快速开始

```bash
npx biolint variants.vcf.gz reads_R1.fastq.gz genes.gff3
```

也可以全局安装：`npm install --global biolint`。需要 Node.js 20 或更高版本，没有任何依赖。

```bash
biolint calls.vcf                      # 按文件名和内容自动识别格式
zcat calls.vcf.gz | biolint -t vcf -   # 从标准输入读
biolint --strict calls.vcf             # 严格按规范条文检查
biolint --explain VCF305               # 解释一条规则，附例子
biolint --fix sample_sheet.bed         # 自动修复能机械修复的问题
```

退出码：没有错误为 `0`，有错误为 `1`，用法或读写出错为 `2`。

## 它懂什么

<!-- status:start -->
| 格式 | 规则数 | 第三方语料：严格档与标注一致 | 留出的真实文件：盲测时被误报为错误 |
|---|---:|---:|---:|
| VCF | 67 | 1733 / 1967 (88.1%) | 1 / 49 |
| SAM | 63 | 199 / 204 (97.5%) | 0 / 2 |
| FASTQ | 14 | 98 / 98 (100.0%) | 0 / 58 |
| FASTA | 17 | 53 / 57 (93.0%) | 0 / 58 |
| GFF3 | 40 | 102 / 128 (79.7%) | 0 / 8 |
| GTF | 26 | 5 / 6 (83.3%) | 0 / 4 |
| BED | 38 | 602 / 636 (94.7%) | 1 / 29 |
| 通用文本与压缩容器 | 19 | | |

共 284 条规则。与语料的 304 处分歧全部逐条归类：语料自身有误 68，语料落后于规范 10，语料超出规范 129，有意不同 37，**尚未实现 60**。详见 [docs/CONFORMANCE.md](docs/CONFORMANCE.md)。真实文件的盲测结果（含两处误报及其修复）见 [docs/REALWORLD.md](docs/REALWORLD.md)。
<!-- status:end -->

“规则数”是每种格式的规则条数；每条规则在 [docs/rules](docs/RULES.md) 下都有一页，带问题示例和 biolint 的实际输出。

除了各格式自身的语法，biolint 还认得文件在现实里常遇到的事：

- **电子表格**：位置被改成 `1e+05`、基因名被改成日期（`1-Mar`）、小数点变逗号、UTF-8 BOM、UTF-16 导出。
- **编辑器和文档**：该用制表符的地方用了空格、Windows 换行、弯引号、不换行空格和零宽空格、中文输入法打出的全角标点。
- **命令行习惯**：用 `cat` 拼接的 VCF（出现两个表头）、该用 `bgzip` 却用了 `gzip`、下载到一半的文件、
  缺少结束块的 BGZF、被压缩了两次的数据。
- **工具惯例**：常用工具偏离规范的地方它知道，所以默认档不会用几千条“严格来说没错”的抱怨把真问题埋掉。

同一个错误每行都犯时，biolint 只列出前几处，其余计数。

## 两档检查

| | 什么算错误 |
|---|---|
| 默认 | 会让主流工具失败、或悄悄读成别的意思的问题 |
| `--strict` | 一切违反规范条文的地方，包括工具能容忍的 |

想知道“这个文件能不能用”用默认档；提交或发布数据前用 `--strict`。
单条规则可以用 `--ignore` 关掉，或用 `--select` 只看某几条。

## 用在 CI 里

```yaml
# .github/workflows/check-data.yml
- uses: actions/checkout@v4
- uses: nnospring/biolint@main
  with:
    files: data/*.vcf.gz annotation/*.gff3
```

问题会以批注形式显示在 Pull Request 上。其他系统可以用 `--format github`、`--format sarif`、
`--format json` 和单行的 `--format compact`。仓库里也带了 [pre-commit](https://pre-commit.com) 钩子配置。

## 当库用

```js
import { lintText, lintStream } from 'biolint';
import { lintFile } from 'biolint/node';

const result = await lintFile('calls.vcf.gz');            // Node.js：流式读取并解压
for (const d of result.diagnostics) {
  console.log(`${d.line}:${d.column} ${d.code} ${d.message}`);
}

lintText('>seq1\nACGT\n', { filename: 'a.fa' });           // 已经在内存里的内容
await lintStream(file.stream(), { filename: file.name }); // 浏览器：File、fetch 响应体或任意字节流
```

## 在浏览器里用

`web/` 是一个静态页面，在后台线程里运行同一套库：把文件拖进去，就在本机检查，什么都不上传。
对人类基因组数据来说这一点很要紧。

```bash
npm ci && npm run build:web && npm run serve    # http://localhost:4173
```

也可以把 `site/` 部署到任何静态托管；仓库里的工作流会把它发布到 GitHub Pages。

## 能信到什么程度

biolint 是新项目。下面是目前的全部证据，都能用本仓库复现：

- **规则示例。** 每条规则都带一个必须触发它的输入，这些示例就是测试。
- **第三方语料。** 严格档的结果会和其他项目标注了“合法/非法”的测试文件比对，语料按固定 commit 拉取，一致率见上表。
  不一致的每一处都在 [docs/CONFORMANCE.md](docs/CONFORMANCE.md) 里归了类：有的是语料落后于规范，
  有的是语料执行了它自家校验器的约定，也有的是 biolint 确实还没实现，这一类照实列出。
- **真实文件。** 主流工具产出的文件（取自 nf-core 测试数据集）在默认档下应当通过。其中一半在调规则时从未看过，
  上表报告的就是这留出的一半。

这些都不需要你相信作者的说法：每条规则注明规范出处，语料和真实文件按固定 commit 拉取，每一处分歧都公开说明，
README 里的数字由脚本从运行结果生成，而不是手填的。如果你发现它判错了某个文件，那是最有价值的问题报告。

它**不做**的事：见英文版 [README](README.md#how-much-to-trust-it) 的同名小节。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。新增规则或格式的约定在 [docs/ADDING_A_FORMAT.md](docs/ADDING_A_FORMAT.md)。

## 许可证

Copyright (C) 2026 biolint contributors.

biolint 是自由软件，按自由软件基金会发布的 GNU 通用公共许可证第 3 版（GPL-3.0）授权，不提供任何担保，全文见 [LICENSE](LICENSE)。

用 biolint 检查你的文件，不会给这些文件或你的流程附加任何条件；把它的代码并入另一个程序，则该程序须以兼容的条款发布。

测试语料和真实数据文件不在本仓库内，运行 `npm run corpora` 时从各自的项目按各自的许可证下载。
