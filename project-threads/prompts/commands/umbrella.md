---
description: project の umbrella（作業をまとめる親 issue）を登録する・外す・いまの登録を見る（project-threads の coordinator 用）
argument-hint: "[owner/repo#番号 | issue の URL | --clear]"
---

user が project の umbrella（project の作業をまとめる親 issue）の登録・解除・確認を頼みました。引数は次の 1 行です（空なら引数なし）。

```
$ARGUMENTS
```

次のとおりに進めてください。この command を Skill ツールで呼び直す必要はありません。

- 引数あり（`--clear` を含む）: 引数を解釈し直さず、全体を単一引用符で囲んで 1 つの引数として、次の 1 コマンドに渡す。登録できるのは project を置いた repo の issue だけで、違えば断られる
  ```
  {bin}/umbrella {project} '<引数>'
  ```
  成功したら出力の 1 行（登録した `owner/repo#番号` と題名、または外したこと）を伝え、失敗したら出力の理由を 1 行で伝える。登録の直後には `next-actions` を回さない（回す場面は system prompt の「umbrella と次の一手」）
- 引数なし: `umbrella` を呼ばずに `{project}/project.json` の `umbrella` と `umbrellaTitle` を読んで伝える。未登録ならそう伝え、「`/pj-threads:umbrella <owner/repo#番号 か issue の URL>` で登録、`/pj-threads:umbrella --clear` で外す」と 1 行で示す（`pj-threads:` を省いた `/umbrella …` は command にならない）
