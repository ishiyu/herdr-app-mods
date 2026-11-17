# project memory の整理の候補を洗い出す

## 目的

project memory の索引（`{project}/memory/MEMORY.md`）から、外す memory と、要約を直す行を洗い出し、候補のファイルに書く。coordinator は候補の中身を読まずに件数だけを user に示し、user が承認した番号だけをコマンドで行う。この thread は候補を書くだけで、memory のファイルと索引は変えない。

この thread は、coordinator の会話の引き継ぎのときに `handoff` が起動した（索引が前の整理から大きくなったか、要約が 120 文字を超える行があった）。

## 洗い出すもの

- 外す候補: 終わった件にしか効かない memory（merge 済みの Slice の `*-elaborated`・`*-slices-issued`、解決済みの調査の記録、close した issue の段取りなど）。件が終わっていても、後の作業に効く決定・前提・落とし穴は外さない。迷うものと progress は候補にしない
  - 判断の材料: 索引の要約、memory の本文、`{project}/memory/progress.md`（前の coordinator の進行状況）、issue・PR の状態（`gh issue view`・`gh pr view` で読むだけ）
- 要約を直す候補: `{bin}/memory {project} long` が出す、要約が 120 文字を超える行。memory の本文を読み、何についての決定・事実・手順かが分かる要約を 120 文字以内で書く。結論の細部・日時・thread の id・進行の状態は入れない。外す候補にした memory は、要約を直す候補にしない

## 成果物

`{project}/memory-cleanup.md` を次の形で書く。番号は 1 から通しで振る。番号の行の下に、字下げした行で補足を書いてよい（コマンドは読まない）。`<名前>` は索引の行のリンクから `.md` を除いたもの。候補の無い見出しは書かない。

```
# memory の整理候補

## 外す

1. `<名前>` — <外す理由を 1 行>

## 要約を直す

2. `<名前>` — <新しい要約>
   - いま: <いまの要約>
```

書いたら `{bin}/memory {project} check` を実行し、通らない件を直して通るまで繰り返す。候補が 1 件も無ければファイルを書かない。

## 完了条件と報告

- 候補があれば、`check` が通った後に `done` で報告する。要約には `check` の出力（「memory の整理候補は …」で始まる 1 行）をそのまま書く
- 候補が無ければ、`done` で「memory の整理候補はありません」と報告する
- report.md には、外すか迷って候補にしなかった memory と、その理由を書く（無ければ「なし」）

## 触ってはいけないもの

- `{project}/memory/` のファイルと索引（候補のファイルのほかは書かない）
- issue・PR への書き込み

## 関係する memory

なし（索引と memory の本文そのものがこの作業の対象）
