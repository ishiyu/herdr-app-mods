# herdr-app-mods

[Herdr](https://herdr.dev) の Mac アプリ向けの mod。1 フォルダが 1 mod。

| mod | 内容 |
|---|---|
| [gh-status](gh-status/) | フォーカス中の terminal がいる repo の open PR（CI の集計・draft・レビュー状態）と、現在ブランチの Actions run を並べるパネル。行をクリックするとブラウザで開く。`gh` CLI を実行する |

## 入れ方

フォルダを `~/.config/herdr-app/mods/` にコピーし、`herdr-app check ~/.config/herdr-app/mods/<name>` で確認する。pane として開くなら `herdr-app do pane.split '{"direction":"right","mod":"<name>"}'`。
