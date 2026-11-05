# herdr-app-mods

[Herdr](https://herdr.dev) の Mac アプリ向けの mod。1 フォルダが 1 mod。

| mod | 内容 |
|---|---|
| [right-sidebar](right-sidebar/) | フォーカス中の terminal がいる repo の、open issue、open PR（CI の集計・draft・レビュー状態）、現在ブランチの Actions run、`.local` 配下の Markdown（更新の新しい順に 20 件）を Issues / PRs / CI / .local のタブで並べるパネル（初期表示は Issues）。Issues / PRs / .local の一覧の上には検索バーがあり、Issues / PRs は入力した語で repo 全体（closed / merged も含む）を `gh` で検索した結果に一覧を置き換え、.local は `.local` 配下の全 Markdown をパスで絞り込む（空白区切りの語をすべて含むもの）。検索語は GitHub の検索クエリ（`is:closed` `label:` `author:` など）で書ける。初期表示は検索バーに Issues なら `is:open assignee:@me -has:parent-issue`、PRs なら `is:open author:@me` を入れた状態で、検索バーを空にすると open なもの全件を出す。Issues / PRs の mine ボタンを押すと検索バーをこの条件に置き換えて検索し直す。行をクリックすると詳細（issue: ラベル・担当者・サブイシューの一覧（完了数 / 総数つき。行をクリックするとそのサブイシューを開き、back で親 issue へ戻る）・Markdown で描いた本文、PR: レビュー・checks・本文、run: job と失敗した step、.local: Markdown で描いた本文）を開く。Issues / PRs の検索欄に `#1234` のように番号だけを入れて Enter を押すか（PR か issue かは自動で見分ける）、`herdr-app do right-sidebar.open-<番号>`（run は `run-<run id>`、一覧へ戻るのは `back`）を送ると、その詳細を開く。`tab-issue` / `tab-pr` / `tab-ci` / `tab-local` でタブを切り替える（`tab-issue` は Issues の検索欄を全選択してフォーカスし、Enter で元の terminal へ戻す）。手元のマシンの `.local` は変更を監視して即時に一覧を更新する。それ以外の一覧（issue・PR・run と別マシンの `.local`）は自動では取り直さず、↻ ボタンを押したときだけ取り直す（初めて表示する repo だけは開いた時点で取得する）。`gh` CLI を実行する |
| [my-agents](my-agents/) | 同梱の `agents` mod（サイドバーの Agents 欄）を `mod.clone` で複製したもの。Grouped by space の見出しに Spaces と同じアイコン（頭文字＋space の色）を付け、space 名を `muted` の明るさにする。herdr-app-config の `my-layout` から使う |

## 入れ方

フォルダを `~/.config/herdr-app/mods/` にコピーし、`herdr-app check ~/.config/herdr-app/mods/<name>` で確認する。pane として開くなら `herdr-app do pane.split '{"direction":"right","mod":"<name>"}'`。
