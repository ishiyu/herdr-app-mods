# herdr-app-mods

[Herdr](https://herdr.dev) の Mac アプリ向けの mod。1 フォルダが 1 mod。

| mod | 内容 |
|---|---|
| [right-sidebar](right-sidebar/) | 上のタブバーの `+` の右に置く、右サイドバーのパネルを切り替えるボタン（Issues/PRs / CI / .local）。押すとそのパネルを表に出して右サイドバーを開き、表に出ているパネルのボタンをもう一度押すと閉じる。右サイドバー宛ての命令（`herdr-app do right-sidebar.<命令>`）もこの mod が受け、行き先のパネルを表に出してから渡す（mod 宛ての命令は表に出ている mod にしか届かないため）。右サイドバーが閉じていれば開く。命令は `open-<番号>`（PR か issue かは自動で見分ける）/ `run-<run id>` / `chart-<名前>` / `chart-latest`（一番新しいグラフ。そのため `latest.json` は名前では開けない）/ `back`（表に出ているパネルの詳細から一覧へ戻る）/ `tab-issue` / `tab-pr` / `tab-ci` / `tab-local` / `tab-chart`。herdr-app-config の `my-layout` から使う。layout には id が `right-sidebar` の stack と、その子として id が `right-sidebar-github` / `right-sidebar-ci` / `right-sidebar-local` の block（同名の mod を載せる）が要る |
| [right-sidebar-github](right-sidebar-github/) | フォーカス中の terminal がいる repo の open issue と open PR（CI の集計・draft・レビュー状態）を Issues / PRs のタブで並べるパネル（初期表示は Issues）。一覧の上の検索バーに入れた語で repo 全体（closed / merged も含む）を `gh` で検索し、結果に一覧を置き換える。検索語は GitHub の検索クエリ（`is:closed` `label:` `author:` など）で書ける。初期表示は検索バーに Issues なら `is:open assignee:@me -has:parent-issue`、PRs なら `is:open author:@me` を入れた状態で、空にすると open なもの全件を出す。mine ボタンを押すと検索バーをこの条件に置き換えて検索し直す。行をクリックすると詳細（issue: ラベル・担当者・サブイシューの一覧（完了数 / 総数つき。行をクリックするとそのサブイシューを開き、back で親 issue へ戻る）・Markdown で描いた本文、PR: レビュー・checks・本文）を開く。検索欄に `#1234` のように番号だけを入れて Enter を押すと、その詳細を開く（PR か issue かは自動で見分ける）。`tab-issue` 命令は検索欄を全選択してフォーカスし、Enter で元の terminal へ戻す。一覧は自動では取り直さず、↻ ボタンを押したときだけ取り直す（初めて表示する repo だけは開いた時点で取得する）。`gh` CLI を実行する |
| [right-sidebar-ci](right-sidebar-ci/) | フォーカス中の terminal がいる repo の、現在ブランチの Actions run を並べるパネル。行をクリックすると詳細（job と失敗した step）を開く。取り直しは ↻ ボタンだけ。`gh` CLI を実行する |
| [right-sidebar-local](right-sidebar-local/) | フォーカス中の terminal がいる repo の `.local` 配下の Markdown（更新の新しい順に 20 件）と `.local/charts` 配下のグラフ定義（JSON）を Docs / Charts のタブで並べるパネル。Docs の検索バーは `.local` 配下の全 Markdown をパスで絞り込む（空白区切りの語をすべて含むもの）。行をクリックすると、Markdown で描いた本文かグラフを開く。Charts は `.local/charts/<名前>.json` に `{"type": "line" | "bar", "title": "…", "unit": "…", "labels": [...], "values": [...]}` を書くと、line は折れ線（last / max / min つき）、bar は横棒で描く（1 グラフ 1 系列）。定義が不正なら、どこが悪いかを詳細に出す。手元のマシンの `.local` は変更を監視して即時に一覧を更新し、別マシンの `.local` は ↻ ボタンと herdr のタブを移ったときに読み直す |
| [my-agents](my-agents/) | 同梱の `agents` mod（サイドバーの Agents 欄）を `mod.clone` で複製し、`spaces` mod の機能を取り込んで Spaces 欄と Agents 欄を 1 つのツリーにしたもの。space の行の下に、agent ごとの行（agent のアイコン＋pane 名）と、agent のいないタブの行（プログラムのアイコン＋タブ名）をタブ順に並べる。space の行はクリックで切り替え、ドラッグで並べ替え、右クリックでメニュー、シェブロンで折りたたむ。ブランチと ahead/behind の表示、worktree の space を親 repo の下に置く動きは `spaces` と同じ。ピン留めした agent は一番上の Pinned に移る。`spaces` にあるマシン別の見出しと再接続は持たない。herdr-app-config の `my-layout` から使う |

## 入れ方

フォルダを `~/.config/herdr-app/mods/` にコピーし、`herdr-app check ~/.config/herdr-app/mods/<name>` で確認する。pane として開くなら `herdr-app do pane.split '{"direction":"right","mod":"<name>"}'`。

## 右サイドバーのパネルを足すとき

`right-sidebar-github` / `right-sidebar-ci` / `right-sidebar-local` は、同じ内容の `common.js`（repo ごとの取得結果と herdr のタブごとの表示の記憶、詳細の開閉、命令の受け取り）を 1 部ずつ持つ。Herdr は mod フォルダの外を import できないためで、直すときは 3 部とも同じ内容にする。

パネルを足すには、`common.js` を持つ mod フォルダを作り、`right-sidebar/main.js` の `PANELS` と `route` に行き先を足し、layout の `right-sidebar` の stack に子を足す。

## 注意点

- 右サイドバー宛ての命令（`right-sidebar.<命令>`）は、最後の 1 件だけが実行を待つ。ウィンドウが隠れているなどで描画が止まっている間に続けて送ると、先に送った命令は実行されず、最後の命令だけが実行される。続けて送るときは、前の命令が反映されたことを `herdr-app shot` で確かめてから次を送る
