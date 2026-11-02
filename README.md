# herdr-app-mods

[Herdr](https://herdr.dev) の Mac アプリ向けの mod。1 フォルダが 1 mod。

| mod | 内容 |
|---|---|
| [gh-status](gh-status/) | フォーカス中の terminal がいる repo の open PR（CI の集計・draft・レビュー状態）と、現在ブランチの Actions run を PR / CI のタブで並べるパネル。行をクリックすると詳細（PR: レビュー・checks・本文、run: job と失敗した step）を開く。ヘッダの入力欄に番号を入れると、その PR / issue の詳細を開く。`gh` CLI を実行する |

## 入れ方

フォルダを `~/.config/herdr-app/mods/` にコピーし、`herdr-app check ~/.config/herdr-app/mods/<name>` で確認する。pane として開くなら `herdr-app do pane.split '{"direction":"right","mod":"<name>"}'`。
