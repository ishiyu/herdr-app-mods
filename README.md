# herdr-app-mods

[Herdr](https://herdr.dev) の Mac アプリ向けの mod。1 フォルダが 1 mod。

| mod | 内容 |
|---|---|
| [right-sidebar](right-sidebar/) | フォーカス中の terminal がいる repo の、自分が担当で親 issue を持たない open issue、open PR（CI の集計・draft・レビュー状態）、現在ブランチの Actions run、`.local` 配下の Markdown（更新の新しい順に 20 件）を Issues / PRs / CI / .local のタブで並べるパネル（初期表示は Issues）。行をクリックすると詳細（issue: ラベル・担当者・Markdown で描いた本文、PR: レビュー・checks・本文、run: job と失敗した step、.local: Markdown で描いた本文）を開く。ヘッダの入力欄に番号を入れるか、`herdr-app do right-sidebar.open-<番号>`（run は `run-<run id>`、一覧へ戻るのは `back`）を送ると、その詳細を開く。`tab-issue` / `tab-pr` / `tab-ci` / `tab-local` でタブを切り替える（`tab-issue` は番号入力へもフォーカスする）。手元のマシンの `.local` は変更を監視して即時に一覧を更新し、別マシンの space は 60 秒ごとに取り直す。`gh` CLI を実行する |
| [my-agents](my-agents/) | 同梱の `agents` mod（サイドバーの Agents 欄）を `mod.clone` で複製したもの。Grouped by space の見出しに Spaces と同じアイコン（頭文字＋space の色）を付け、space 名を `muted` の明るさにする。herdr-app-config の `my-layout` から使う |

## 入れ方

フォルダを `~/.config/herdr-app/mods/` にコピーし、`herdr-app check ~/.config/herdr-app/mods/<name>` で確認する。pane として開くなら `herdr-app do pane.split '{"direction":"right","mod":"<name>"}'`。
