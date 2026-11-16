# herdr-app-mods

[Herdr](https://herdr.dev) の Mac アプリ向けの mod。1 フォルダが 1 mod。

| mod | 内容 |
|---|---|
| [right-sidebar](right-sidebar/) | 上のタブバーの `+` の右に置く、右サイドバーのパネルを切り替えるボタン（Issues/PRs / CI / .local）。押すとそのパネルを表に出して右サイドバーを開き、表に出ているパネルのボタンをもう一度押すと閉じる。右サイドバー宛ての命令（`herdr-app do right-sidebar.<命令>`）もこの mod が受け、行き先のパネルを表に出してから渡す（mod 宛ての命令は表に出ている mod にしか届かないため）。右サイドバーが閉じていれば開く。命令は `open-<番号>`（PR か issue かは自動で見分ける）/ `run-<run id>` / `chart-<名前>` / `chart-latest`（一番新しいグラフ。そのため `latest.json` は名前では開けない）/ `diagram-<名前>` / `diagram-latest`（一番新しい図。`latest.mmd` は名前では開けない）/ `expand`（.local パネルの Diagrams タブで開いている図の詳細を、expand ⤢ と同じ dialog で開く。図の詳細を開いていない・読み込み中・読めていないときは開かず、理由を通知に出す）/ `back`（表に出ているパネルの詳細から一覧へ戻る）/ `tab-issue` / `tab-pr` / `tab-ci` / `tab-local` / `tab-chart` / `tab-diagram`。herdr-app-config の `my-layout` から使う。layout には id が `right-sidebar` の stack と、その子として id が `right-sidebar-github` / `right-sidebar-ci` / `right-sidebar-local` の block（同名の mod を載せる）が要る |
| [right-sidebar-github](right-sidebar-github/) | フォーカス中の terminal がいる repo の open issue と open PR（CI の集計・draft・レビュー状態）を Issues / PRs のタブで並べるパネル（初期表示は Issues）。一覧の上の検索バーに入れた語で repo 全体（closed / merged も含む）を `gh` で検索し、結果に一覧を置き換える。検索語は GitHub の検索クエリ（`is:closed` `label:` `author:` など）で書ける。初期表示は検索バーに Issues なら `is:open assignee:@me -has:parent-issue`、PRs なら `is:open author:@me` を入れた状態で、空にすると open なもの全件を出す。mine ボタンを押すと検索バーをこの条件に置き換えて検索し直す。行をクリックすると詳細（issue: ラベル・担当者・サブイシューの一覧（完了数 / 総数つき。行をクリックするとそのサブイシューを開き、back で親 issue へ戻る）・Markdown で描いた本文、PR: レビュー・checks・本文）を開く。検索欄に `#1234` のように番号だけを入れて Enter を押すと、その詳細を開く（PR か issue かは自動で見分ける）。`tab-issue` 命令は検索欄を全選択してフォーカスし、Enter で元の terminal へ戻す。一覧は自動では取り直さず、↻ ボタンを押したときだけ取り直す（初めて表示する repo だけは開いた時点で取得する）。`gh` CLI を実行する |
| [right-sidebar-ci](right-sidebar-ci/) | フォーカス中の terminal がいる repo の、現在ブランチの Actions run を並べるパネル。行をクリックすると詳細（job と失敗した step）を開く。取り直しは ↻ ボタンだけ。`gh` CLI を実行する |
| [right-sidebar-local](right-sidebar-local/) | フォーカス中の terminal がいる repo の `.local` 配下の Markdown（更新の新しい順に 20 件）と `.local/charts` 配下のグラフ定義（JSON）と `.local/diagrams` 配下の Mermaid の図（`.mmd`）を Docs / Charts / Diagrams のタブで並べるパネル。Docs の検索バーは `.local` 配下の全 Markdown をパスで絞り込む（空白区切りの語をすべて含むもの）。行をクリックすると、Markdown で描いた本文かグラフを開く。Charts は `.local/charts/<名前>.json` に `{"type": "line" | "bar", "title": "…", "unit": "…", "labels": [...], "values": [...]}` を書くと、line は折れ線（last / max / min つき）、bar は横棒で描く（1 グラフ 1 系列）。定義が不正なら、どこが悪いかを詳細に出す。Diagrams は `.local/diagrams/<名前>.mmd` を同梱の [pele](https://github.com/obsidianmd/pele)（MIT）で SVG にし、パネルの幅に収まるよう組み直して描く（収まらない図は横にもスクロールする）。色はテーマに合わせる。構文エラーは行・列と該当箇所を出す。詳細の expand ⤢ で、window の大半を使う dialog に大きく描き直す（− / + で 50〜300% に拡大縮小、縦横にスクロール、close ✕ か Esc で閉じる）。描いた SVG は `~/.config/herdr-app/data/right-sidebar-local/diagrams/<中身のハッシュ>.svg` に書き出して表示し、新しいものから 50 個だけ残す。pele は `package.json` で版を固定して pnpm で入れ、`pnpm install` の postinstall（`pnpm run vendor`）が `node_modules` から mod の中へ `pele.js` と `pele.LICENSE` を写す（Herdr は mod の中でも `node_modules` の bare specifier を解決できないため。写しは git に入れない）。テストは `pnpm -C right-sidebar-local test`（写しが無い・`node_modules` の版と違うときも落ちる）。手元のマシンの `.local` は変更を監視して即時に一覧を更新し、別マシンの `.local` は ↻ ボタンと herdr のタブを移ったときに読み直す |
| [my-agents](my-agents/) | 同梱の `agents` mod（サイドバーの Agents 欄）を `mod.clone` で複製し、`spaces` mod の機能を取り込んで Spaces 欄と Agents 欄を 1 つのツリーにしたもの。space の行の下に、agent ごとの行（agent のアイコン＋pane 名）と、agent のいないタブの行（プログラムのアイコン＋タブ名）をタブ順に並べる。space の行はクリックで切り替え、ドラッグで並べ替え、右クリックでメニュー、シェブロンで折りたたむ。ブランチと ahead/behind の表示、worktree の space を親 repo の下に置く動きは `spaces` と同じ。ピン留めした agent は一番上の Pinned に移る。agent の行の下には、その agent が `hc run` で起動した子の行を並べる。子の行は agent のアイコンか行の右のシェブロンで畳める。畳んでいても Needs you（許可待ちか error）の子は行に出し、Needs you でなくなると畳みに戻る。畳んだシェブロンの横の数は、まだ隠れている子の数で、その中でいちばん急ぐ状態の色で出す。project-threads の thread が needs-you か blocked を報告して手が空いている子（一覧の要対応）は、行の右に blocked の色の点を出し、畳みの数では作業中の黄より先にその色にする。Needs you ではないので、畳みには隠れ、通知もしない。子の行の名前は、terminal の名前・テンプレート名が無ければ、program が出した terminal の題名（project-threads の thread なら `<project>/<id> <題名>`）を使う。題名の行頭の `<語>/` は、その語が親の agent の行の名前に 1 語として出ているとき（親が `project:pj-mod` で題名が `pj-mod/t009 …`）は落とす。全文は hover で出す。claude の行（agent の行と子の行）は、左のアイコンの横に prompt cache が cold になるまでの残りを丸で出す。cold の時刻は「claude が working を抜けた時刻 + 1 時間」で推定し（working を抜けた時刻は、mod が動いている間なら hc の `turn` が増えたのを見た時刻、mod が動く前に抜けていた claude なら `hc get` の `status_ms`。mod の `terminals()` の `status_ms` は app の起動時の値のまま更新されないので使わない）、残り 45 分超は ●、30 分超は ◕、15 分超は ◑、0 分超は ◔、cold は ◯、working 中は ●。時刻がまだ分からない行（`hc get` の答え待ちか失敗）は ? で、hover に残りの分と時刻の出どころ（失敗ならその理由）を出す。claude でない行と、まだ要求していない claude は、丸を出さず幅だけ空ける。狭めた sidebar では出さない。`spaces` にあるマシン別の見出しと再接続は持たない。herdr-app-config の `my-layout` から使う。テストは `node --test my-agents/tests/label.test.mjs my-agents/tests/kids.test.mjs my-agents/tests/cache.test.mjs` |
| [permission-notify](permission-notify/) | agent が許可待ち（Herdr の「Needs you」）になったら macOS の通知を出す。対象は `my-agents` の一覧と同じ（pane を持つ agent は `agents()` の `blocked`、一覧の agent の子孫で pane を持たない terminal は `blocked` か `error`）。Needs you でなかった agent が Needs you になったときに 1 回だけ出す。mod が最初に見た状態と、途中で初めて見えた agent は覚えるだけにする（herdr-app の起動や読み直しで一斉に鳴らさない）。Herdr の window が前面でその terminal にフォーカスがあるときは出さない。通知は `terminal-notifier` で出し、音は付けない（herdr-app 本体の音と toast はそのまま）。押すと Herdr が前に出て、pane を持つ agent はその pane へ移り（`pane.focus`）、pane を持たない子は親の agent の pane へ移ってから重ねて開く（`terminal.peek`）。`terminal-notifier` や `herdr-app` が見つからなければ、herdr-app の画面内の通知で知らせる。画面には何も描かないので、layout に小さな block として置く（herdr-app-config の `my-layout` はタブ行の右端に幅 1px で置く）。`brew install terminal-notifier` が要る。`permission-notify.close-tab` 命令（herdr-app-config の `keys.json` が my-layout の ⌘W に割り当てる）も受ける。フォーカス中のタブの terminal が全部、親が動いている子（peek の keep などでタブにした `hc run` の子。project-threads の thread など）なら、閉じずに親の下へ戻す（`terminal.park`。pane の右クリックメニューの「Send back to <親>」と同じ）。herdr-app ではタブを閉じると中の terminal が終わり、thread が止まるため。子でない terminal を含むタブ・terminal の無いタブは、これまでの ⌘W と同じく閉じる（`tab.close`）。mod 宛ての命令は表に出ている写しにしか届かないので、⌘B で隠せる sidebar の `my-agents` ではなく、隠れないタブ行のこの mod で受ける。テストは `node --test permission-notify/tests/notice.test.mjs permission-notify/tests/close-tab.test.mjs` |
| [project-threads](project-threads/) | 1 つの依頼を複数の Claude Code に分けて進めるための一式（mod とスクリプトと prompt）。repo の `.local/hc-projects/<name>/` を 1 つの project とし、user と話す coordinator（対話の claude）が、作業を thread（herdr-core の別の terminal で動く claude）に任せる。Claude Code の mod には依存せず、起動と連絡は `hc` だけで行う。Claude Code の plugin は、`/pj-threads:handoff`・`/pj-threads:umbrella`・`/pj-threads:merged` のための command 3 つだけの小さなもの（雛形は `project-threads/prompts/commands/`）で、`open` が project ごとに展開して `--plugin-dir` で coordinator に読ませる（下の「project-threads の coordinator の command」）。Artifact ツールを遅延ロード（名前だけ載せ、使うときに `ToolSearch` で定義を読み込む）にする Claude Code の plugin（`project-threads/defer-artifact/`。hooks module の `tool.describe` で `isDeferred` を返す）も同梱し、coordinator と thread の起動に `--plugin-dir` で渡す。置き方は会話を始めたときに決まるので、再開した会話は始めたときのまま。mod は thread の一覧を pane に出す。thread の記録（`threads/<id>/thread.json`・`status.json`）と terminal の状態を合わせ、要対応（許可待ち・エラー・あなた待ち・行き詰まり）/ 作業中 / 待ち（待機中・未報告）/ 対応完了（報告済み・停止）のタブに分け、タブには thread の数を添える（開いたときは要対応を選ぶ）。タブの文字は theme の色で塗り分ける（要対応 `blocked`、作業中と待ち `working`、対応完了 `ansi2`）。選んだタブの thread を見出しごとに、id・題名・モデル・最後の報告の時点の context の大きさ（例 `150k`）・最新の報告の要約を並べる。行を押すと、あなた待ち・行き詰まりと止まった thread は pane の中で質問か最後の報告を開き（下の「project-threads の質問」）、ほかの thread は画面を重ねて開く（`terminal.peek`）。行の上のボタンで、押して開かない側（画面か詳細）を開く・タブに出す・停止する。一覧は thread の起動と報告のたびに描き直す。使うときは herdr-app の terminal で、repo の中から `project-threads/bin/open <name>` を呼ぶ（`alias hc-pj=<この repo>/project-threads/bin/open` を勧める。`--new` で前回の会話を引き継がない）。project のフォルダを作り、右に一覧の pane を開き、その terminal で coordinator を起動する。coordinator は `bin/start`（thread の起動。会話の記録で最初のメッセージの後に API への送信が書かれたことを確かめる。API に送る前に取り消されて brief が入力欄に戻ったら、入力欄が brief であることを確かめて Enter で 2 回まで送り直し、それでも始まらなければ terminal を終わらせて失敗する。`bin/message` の再開も同じ）と `bin/message`（追加の依頼。止まった thread は同じ会話を再開してから送る。prompt cache が切れた大きな thread は再開せず、新しい thread で続ける。下の「project-threads のキャッシュ切れの引き継ぎ」）と `bin/cleanup`（終わった thread の片付け。id を付けずに呼ぶと消せる / 残す thread の一覧を理由つきで出すだけで、一覧に載った id を付けて呼ぶと消す直前に判定し直して消す。消せるのは最後の報告が `done` で、その後に追加の依頼を受けておらず、作業中・許可待ち・エラーでなく、thread が `worktrees.txt` に記録した worktree がどれも未コミットの変更なしで、ブランチが取り込み済みの thread。取り込み済みは、先頭のコミットが default branch の祖先か、先頭のコミットを含む PR がマージ済みのとき（`gh api graphql` を worktree 1 つにつき 1 回呼び、先頭のコミットの `associatedPullRequests` を見る。squash merge・merge commit・検証用や agent slot のように自分の PR を持たないブランチを拾い、未マージなら merge queue 中の PR を理由に添える。PR の検索（`is:pr <SHA>`）は本文やコメントで SHA に言及しただけの PR も返すので使わない）。消すのは記録した worktree とローカルブランチ、thread の terminal、thread の claude の一時フォルダ（Claude Code が `/tmp/claude-<uid>/<作業フォルダ>/<会話の id>/` に作る scratchpad など。セッションが終わっても数日残るため。場所が確かでないときは理由を出して残す）で、thread のフォルダは `threads/.deleted/` へ移す。移した後に報告の写し（`reports/`）を減らす。中身が後の写しか `report.md` にそのまま含まれる写しを消し、それでも 2 つ以上残れば `claude -p`（haiku・ツールなし）に `summary.md`（頼まれたこと・決めたこと・結果とコミット・未確認の点や残したこと）を書かせてから、最後の写しのほかを消す。要約に失敗したら写しは残して片付けは続ける。`--merged` を付けると、マージ後の片付けをする（user が PR のマージを伝えたとき・`/pj-threads:merged` を打ったときに coordinator が呼ぶ）。判定は上と同じで、違うのは、一覧の承認を省いてその場で消すこと、取り込み済みを確かめた worktree が 1 つも無い thread（`worktrees.txt` が無い・記録した worktree がもう無い）を消さないこと、残す理由が merge queue 中の PR だけの thread を、coordinator の terminal の子の補助（`--merged-wait`）がマージされるまで待って（1 分ごとに PR だけを見て最大 60 分）から消し、結果を `[project-threads merged]` で始まる入力で coordinator に送ること。coordinator が自分で main に取り込んだことはきっかけにしない。`--deleted` を付けると、片付け済みの thread（`threads/.deleted/`）の写しを同じように減らす（id を付けなければ写しをいくつ消すか・要約を作るかの一覧だけを出し、一覧に載った id を付けると判定し直して処理する。`summary.md` がある thread と、写しが 1 つ以下の thread には何もしない）。リモートのブランチは消さず、片付けた id は使い直さない）を、thread は `bin/report`（`done` / `blocked` / `needs-you` / `waiting` の報告。coordinator の入力に届く。`waiting` には `--within <分>` で完了見込みを付ける。`--detail-file` のファイルは報告ごとに thread のフォルダの `reports/<時刻>-<status>.md` へ写し、coordinator にはその写しのパスを送るので、前の報告の詳細は消えない。報告の 1 行と `status.json` の `contextTokens` には、会話の記録の最後の assistant の `usage` から取った thread の context の大きさ（トークン数。claude の statusline と同じ値）を付け、取れなければ付けずに報告する）を呼ぶ。`open` は coordinator の terminal の子として見張り（`bin/watch`）を起動し、`waiting` の完了見込みを過ぎても次の報告が無い thread と、一度も報告が無いまま会話の記録が 10 分更新されていない thread（許可待ちを除き、thread ごとに 1 回）を coordinator に知らせる（`open` が渡した coordinator の claude の PID が消えたら終わる。terminal の子でも、`open` を打ったシェルが残る限り hc は止めないため。開き直すと新しい見張りが前の見張りを止めるので、project ごとに 1 本で、動いている見張りの PID は project の `watch.pid`）。別の project の coordinator へ依頼を送る（回送）ときは、coordinator が user の承認を得てから `bin/relay <自分の project のフォルダ> <送り先の project のフォルダ> --file <本文>` を呼ぶ。送り先の `project.json` の coordinator の terminal で、その project の coordinator の claude が動いているときだけ、先頭に `[project <送り元の名前> relay] 送り元: <フォルダ>` を付けて送る（シェルや terminal が無いときは送らずに失敗する。作業の結果を返す経路は無く、受けた coordinator が受け取ったことだけを知らせる。下の「project-threads の回送」）。project の umbrella（project の作業をまとめる親 issue）は、coordinator が user に頼まれて `bin/umbrella <project のフォルダ> <owner/repo#番号 か issue の URL>`（外すときは `--clear`）で登録する。user は言葉で頼むほか、`/pj-threads:umbrella <owner/repo#番号 か issue の URL>`・`/pj-threads:umbrella --clear` を打ってもよい（引数なしの `/pj-threads:umbrella` はいまの登録を伝える）。名前空間の `pj-threads:` は省けない（`/umbrella …` は command にならない）。`gh issue view` で読めることと、project を置いた checkout の repo の issue であることを確かめてから、`project.json` の `umbrella` と `umbrellaTitle`（登録した時点の題名）に書き、一覧のヘッダに `owner/repo#番号 題名` を出す。coordinator は user に次の一手を聞かれたときと作業の区切りに `bin/next-actions <project のフォルダ>` を呼び、project を置いた checkout で作者の skill `/next-actions <番号>` を `claude -p`（haiku・読み取りのツールだけ・MCP なし・セッションを残さない・10 分で打ち切り・同時に 1 本）で 1 回回して、AFK と HITL の行を受け取る。報告の全文は project の `next-actions.md` に残し、失敗したときは前のものを残す。coordinator の会話が長くなったら、coordinator に「引き継いで」と言うか `/pj-threads:handoff` を打つ（どちらも同じ手順）。coordinator が進行状況を `memory/progress.md` に書いて `bin/handoff` を呼ぶと、補助がそのターンの終わりを待って coordinator の terminal に `/clear` を打ち、続けて progress と thread の `status.json` を読むよう入力を送る。progress の保存より後に届いた報告は、`status.json` の時刻で拾う。coordinator は progress を書く前に `bin/handoff --check-index <project のフォルダ>` で、project memory の索引（`memory/MEMORY.md`）のうち要約（リンクの後ろの `— ` より後）が 120 文字を超える行を数え（jq の length で文字単位に数える。超えても失敗にはしない）、終わった件の memory とあわせて progress の「memory の整理候補」に載せる。`/clear` の後に user が承認した候補だけ、memory を `memory/archive/` へ移すか要約を直す。thread は起動時に索引を読まず、brief の「関係する memory」に挙がったファイルを読む（brief にその欄が無ければ、これまでどおり索引を読む）。`/clear` では prompt と許可の更新は効かないので、効かせるには開き直す。振る舞いは `prompts/coordinator.md` と `prompts/thread.md` で決まる。`.local/` は repo の `.gitignore` に入れておく。project の `CLAUDE.md` にほかのファイルを `@` で取り込むと、thread が起動時に許可の確認で止まる。テストは `project-threads/tests/run.sh`（`hc`・`claude`・`herdr-app`・`gh` を偽物に差し替える。`jq` と `node` と `git` が要る） |

## 入れ方

フォルダを `~/.config/herdr-app/mods/` にコピーし、`herdr-app check ~/.config/herdr-app/mods/<name>` で確認する。

`right-sidebar-local` は、コピーの前に `pnpm -C right-sidebar-local install` を流して `pele.js` を写しておく（git に入れていない）。`node_modules` はコピーしなくてよい: `rsync -a --exclude node_modules --exclude tests right-sidebar-local/ ~/.config/herdr-app/mods/right-sidebar-local/`。pane として開くなら `herdr-app do pane.split '{"direction":"right","mod":"<name>"}'`。

## 右サイドバーのパネルを足すとき

`right-sidebar-github` / `right-sidebar-ci` / `right-sidebar-local` は、同じ内容の `common.js`（repo ごとの取得結果と herdr のタブごとの表示の記憶、詳細の開閉、命令の受け取り）を 1 部ずつ持つ。Herdr は mod フォルダの外を import できないためで、直すときは 3 部とも同じ内容にする。

パネルを足すには、`common.js` を持つ mod フォルダを作り、`right-sidebar/main.js` の `PANELS` と `route` に行き先を足し、layout の `right-sidebar` の stack に子を足す。

## project-threads の「自律的にやってよいこと」「確認すること」

coordinator と thread が user に聞かずに進めてよい操作と、進める前に user に確認する操作を、user が手で 2 種類のファイルに書く。どちらも `## 自律的にやってよいこと` と `## 確認すること` の 2 つの見出しの下に `- ` で 1 行ずつ書く Markdown で、無くても project は動く（書いていない操作は、これまでどおり破壊的・外向きなら確認する）。

| ファイル | 対象 | 雛形 |
|---|---|---|
| `~/.config/project-threads/rules.md` | 全 project 共通 | `project-threads/templates/rules.md` |
| `<repo の元の checkout>/.local/hc-projects/repo-rules.md` | その repo を扱うどの project も（repo 固有） | `project-threads/templates/repo-rules.md` |

- 食い違うときは repo 固有が共通より優先する。同じファイルの中で両方の欄に当たる操作は確認する。「やってよい」と書いても、Claude Code の許可の確認は別に出る。thread の役割（取り込み・worktree の削除・thread の起動は coordinator）は変わらない
- coordinator と thread は prompt の指示でこれらを読む（許可の確認なしに読める）。書き換えは、次に読んだときから効く。ただし「読む」という指示そのものは prompt にあるので、効くのは新しく起動した thread と、`bin/open <name> --new` で開いた coordinator だけ。claude は `--resume`・`--continue` で再開すると元の system prompt のまま続くので、この仕組みが入る前に起動した thread と、`--new` を付けずに開き直した coordinator には効かない
- `bin/open` は新しい project を作るとき、その repo に `repo-rules.md` が無ければ雛形を置く。全 project 共通のファイルと、既にある repo・project を置いていない repo の `repo-rules.md` は手で作る: `mkdir -p ~/.config/project-threads && cp project-threads/templates/rules.md ~/.config/project-threads/rules.md`、`mkdir -p <repo>/.local/hc-projects && cp project-threads/templates/repo-rules.md <repo>/.local/hc-projects/`
- 一覧の pane のヘッダの「方針 N ▸」（N は項目の数。無ければ「方針 未設定」）を押すと、project を置いた repo と、thread の `worktrees.txt`（片付け済みを含む）に出てくる repo の `repo-rules.md` の欄を開く。全 project 共通のファイルは出さない。開いたときと 30 秒ごとに読み直す

書き方の例（`herdr-app-mods/.local/hc-projects/repo-rules.md`）:

```markdown
## 自律的にやってよいこと

- 作業ブランチ（tmp/<slug>）を origin に push する（CI が無い）

## 確認すること

- main への取り込み
```

## project-threads の thread と auto-memory

thread の起動（`bin/start`、`bin/message` の再開と引き継ぎ）は `--settings` に `autoMemoryEnabled: false` を渡し、auto-memory（Claude Code が repo ごとに `~/.claude/projects/<名前>/memory/` に書き溜めるメモ）を切る。thread は auto-memory に書かず（学びは project memory に書く）、要る場面でだけ索引を読めばよいのに、切らないと索引（zumen-engine で約 10k トークン）が毎回の入力に載るため。coordinator・通常のセッション・`claude -p` の子は切らない。

- `start` は thread の prompt に、project を置いた repo の auto-memory の索引（`memory/MEMORY.md`）のパスを書き、DB・本番・環境の停止・デプロイ・CI の癖に触れるときに読ませる。フォルダの名前は、元の checkout（worktree なら main の側）のパスの英数字以外を `-` にしたもの。索引が無い repo では、その行を書かない
- coordinator は起動時に索引を読み込んでいるので、効きそうなメモを brief の「関係する memory」に挙げる
- 効くのは新しく起動した thread から。切る前に起動した会話を `message` で再開すると、system prompt は起動時のまま（索引を読む行が無い）で、会話の冒頭に入った索引は履歴に残る

## project-threads の質問

thread が `blocked` / `needs-you` を報告して user の判断が要るとき、coordinator はチャットに本文を書かず、thread ごとの質問のファイル `threads/<id>/question.md` に書く。チャットには `t052 が判断待ちです（一覧の要対応で読めます。未回答 2 件）` の 1 行だけを返す。複数の thread から続けて届いても、前の質問がチャットで流れない。

- 中身は Markdown で、見出しは「事実と根拠」「元の計画との食い違い」「決まっていないこと」「選択肢」（A・B…、各案の得るもの・失うもの）「推奨」。形は `prompts/coordinator.md` の「user に判断を仰ぐ」にある。1 つの thread に未回答の質問は 1 つで、同じ thread が続けて聞いたら coordinator が書き直す
- 一覧の pane で、質問のある thread の行に「質問」と質問の見出しが出て、ヘッダに未回答の数（`質問 N`。押すと要対応のタブに戻る）が出る。質問のある thread は、terminal が無くても（マシンの再起動など）要対応のあなた待ちに入る
- あなた待ち・行き詰まりの行を押すと、pane の中で質問を Markdown で開く（長ければ pane の中でスクロールし、「← 一覧」で戻る）。質問が無ければ最後の報告の写し（`reports/`）を、写しも無ければ `status.json` の要約を出す。質問と最後の報告は切り替えられる。thread の画面は詳細の「画面」か、行の上のボタンで開く。許可待ちとエラーの行は、これまでどおり押すと画面を開き、行の上の「詳細」で質問か最後の報告を開く
- user は答えをチャットで「t052 は A」のように返す。coordinator は `bin/message` で thread に送り、`message` は送れた後に `question.md` を `threads/<id>/questions/<時刻>.md` へ移して末尾に送った本文を足す（回答済み。一覧から消える）。thread が答えを待たずに `done` を報告したときは `bin/report` が同じように移し、答えを送らずに済ませた件は coordinator が `bin/close-question <project> <id> "<結末>"` で移す。過去の質問と答えは `questions/` に残り、`cleanup` で thread のフォルダと一緒に `threads/.deleted/` へ移る
- 一覧は `threads/` を `watchFolder` で見張り、`question.md` の書き込みと移動で読み直す（coordinator の Write は terminal の変化を伴わないため）。thread のフォルダそのものの作成・移動でも読み直す（`cleanup` は terminal を消した後にフォルダを `threads/.deleted/` へ移すため）
- 質問のファイルを書く決まりは coordinator の prompt にあるので、効くのは `bin/open <name> --new` で開いた coordinator だけ（`--resume`・`--continue` は元の system prompt のまま続く）。`message`・`report`・`close-question` での移動と一覧の表示は、取り込みと一覧の写しの置き直しで効く

## project-threads のキャッシュ切れの引き継ぎ

claude の prompt cache は、最後の要求から 1 時間で切れる。切れた会話に送ると、次の要求で会話全体を cache に書き直し、入力単価の 2 倍がかかる（300k の会話なら入力 600k トークン分）。起動直後の thread は約 80k なので、大きな会話は再開せず、最後の報告を材料に新しい thread で続けるほうが安い。

- `bin/message` は、送る前に thread の会話の記録を見て、最後の API 呼び出しから 55 分以上たち、context が 150k 以上なら、送らずに引き継ぐ。terminal で claude が動いていても判定する（cache の寿命はプロセスの生死と関係ない）。ただし作業中・許可待ちの claude は止めず、これまでどおり送る
- 最後の API 呼び出しの時刻は、本体の会話の assistant の行（subagent・API のエラー・`<synthetic>` の行を除く）と、席を外した後の要約（`away_summary`。本体と同じ前置きを読むので寿命が延びる）の新しいほうの timestamp。assistant の行の時刻は要求の開始より遅く、差は直近の記録で最大 4 分半ほどなので、閾値を 60 分より 5 分短くしてある。会話の記録や応答の行が無ければ（起動直後など）引き継がない
- 引き継ぎ: 前の thread の最後の報告（`status.json` の要約と詳細の写し）・未回答の質問（`question.md`。user の答え「A で」だけでも通じるように）・移す worktree・今回の本文を brief にして、`bin/start` で「<題名>（続き）」を同じ model で起動する。起動に成功してから、前の thread の `thread.json` に `supersededBy`（引き継ぎ先の id）を書き、`status.json` を `superseded`（前の報告の要約を summary に入れ、詳細の写しは指したまま）にし、`worktrees.txt` を引き継ぎ先へ移し、質問を回答済みにして、claude が動いていれば止める。起動に失敗したら前の thread には何もせず失敗する
- 出力は `引き継いで起動 → <新 id> (<terminal>)（<旧 id> はキャッシュ切れのため再開せず。最後の API 呼び出しから N 分、context Nk）` と `THREAD_ID=<新 id>`。引き継いだ thread に `message` で送ると、引き継ぎ先を示して断る
- `status.json` が `superseded` なので、見張りは前の thread の waiting の遅れも stalled も知らせず、coordinator が会話を始めるときに質問を書き直すこともない。一覧では止まった thread（対応完了）に出る
- `cleanup` は、引き継ぎ先が残っている間は前の thread を「残す」に理由つきで出し（引き継ぎ先の brief が前の thread のフォルダを指す）、引き継ぎ先を消すときに一緒に消す（`--merged` も同じ）。worktree は引き継ぎ先だけが記録するので、前の thread の片付けが引き継ぎ先の worktree を消すことはない
- user が前の thread の画面で直接話しかけたときは `message` を通らないので、この判定はかからない。thread の prompt は、引き継げるように report.md へ worktree・変更したファイル・未完了の作業と次の手を書くよう求める（新しく起動した thread から効く）

## project-threads の coordinator の引き継ぎの提案

coordinator（fable）の prompt cache が切れると、次の入力で会話の全体を書き直す。書き込みの単価は読み込みの 80 倍で、300k の会話なら 1 回 API 換算で約 $4.4 かかる。引き継ぐ（progress を書いて `/clear`）と会話は約 110k から始まるが、progress を書くターンも cache が切れた後だと書き直しを払う。そこで、cache が温かいうちに user へ引き継ぎを提案させる。提案するかは script が決め、実行は user の承認の後（coordinator の prompt の「会話の引き継ぎ」）。

- `bin/open` は coordinator に SessionStart hook を渡し、起動・再開・`/clear` のたびに会話の id を project の `coordinator-session` に書かせる（`/clear` で会話の id が変わる）。見張りと `report` は、この id で coordinator の会話の記録から context（最後の assistant の `usage`）と最後の応答の時刻（`last_api_call_epoch`）を取る
- 見張り（`bin/watch`）: coordinator の最後の応答から 50 分たち、55 分を過ぎる前で、context が 200k 以上、coordinator の hc の状態が idle か done なら、`[project-threads cache]` で始まる知らせを送る。知らせは user に返す 1 行を含み、ほかの作業をしないよう求める。知らせのターンで cache は 1 時間延びるので、user が戻ってから承認しても温かいうちに引き継げる。55 分を過ぎたら送らない（知らせのターンが書き直しを払う）。毎周期は coordinator の会話の記録の古さを `find` で見るだけで、記録を読むのは止まるたびに 1 回
- `bin/report`: `waiting` でない報告を送るとき、coordinator の context が 200k 以上なら、報告の行の末尾に `[project-threads cache]` の添え書き（報告を扱った後に添える 1 行）を付ける。user がその場にいる作業の区切りで提案させるため。coordinator の会話の大きさが取れなくても報告は送る
- 同じ会話で提案を重ねない: 提案した会話の id と context を project の `handoff-proposed` に書き、見張りと `report` で共有する。同じ会話では、前の提案から context が 50k 以上増えるまで提案しない。`/clear` で会話が変われば数え直す
- 閾値は `bin/watch` の `CACHE_NOTICE_IDLE_MIN`・`CACHE_NOTICE_LATEST_MIN`・`CACHE_NOTICE_MIN_TOKENS`、`bin/report` の `HANDOFF_PROPOSE_MIN_TOKENS`、`bin/_lib.sh` の `HANDOFF_PROPOSE_STEP_TOKENS`
- 効くのは、SessionStart hook を渡した `open` で開き直した coordinator から（`--new` は要らない。知らせの本文が何をするかを伝えるので、前の prompt のままの会話でも動く）。開き直すと見張りも新しいコードに入れ替わる

## project-threads の coordinator の command

coordinator の prompt は会話の初回から毎回の入力に載る。まれにしか使わない手順（会話の引き継ぎ、umbrella の登録・解除・確認）は、prompt ではなく command（`/pj-threads:handoff`・`/pj-threads:umbrella`）の本文に置き、使う場面でだけ読ませる。

- user が command を打つと、本文がその入力に入る。言葉で頼まれたときは、coordinator が Skill ツールで同じ本文を読み込む（prompt にそう書いてある）。引き継ぎでは、読み込みと同じ応答で `date` と `handoff --check-index` も呼ばせ、読み込みだけの API 呼び出しを増やさない
- 本文には `bin/` と project のフォルダの絶対パスが要る（Claude Code が command の本文で置き換えるのは `${CLAUDE_PLUGIN_ROOT}` などだけで、そこから組んだパスは許可の `Bash(<bin>/handoff *)` に前方一致しない）。そこで `bin/open` が、`prompts/commands/*.md` の `{bin}`・`{project}` を置き換えて project の `coordinator-plugin/commands/` に展開し、`plugin/.claude-plugin/plugin.json`（名前 `pj-threads`）を添えて `--plugin-dir` で渡す。開くたびに作り直し、中身が同じなら置き換えない（right-sidebar の Docs タブは `.local` の Markdown を更新の新しい順に並べるため）
- `/clear` の後の会話は command を読んでいないので、頼まれる前と `/clear` の後にも効く決まり（自分の判断では引き継がない、`[project-threads cache]` の扱い、progress の「memory の整理候補」の示し方）は prompt に残す。`/clear` の後の最初の返答の決まりは `bin/handoff` が送る入力が持つ
- `plugin/commands/` は、展開した plugin で開き直す前の coordinator（起動時に `plugin/` を読み込んだ会話）のために残してある。全 project の coordinator を `open` で開き直した後に消す（`plugin/.claude-plugin/plugin.json` は残す）
- prompt と command の改訂は `open <name> --new` で開いた新しい会話から効く（`--continue` は元の prompt のまま。展開した command はどちらでも読み込まれる）

## project-threads の回送

別の project の coordinator へ依頼を送ること（回送）には、作業の結果を返す経路は無い。受けた coordinator が回送を照合して扱い始めたときに、送り元の coordinator へ「受け取った」とだけ知らせる。

- 送る: 送り元の coordinator が、user が頼むか承認した依頼を `bin/relay <自分の project> <送り先の project> --file <本文>` で送る。本文の 1 行目は `[project <送り元の名前> relay] 送り元: <フォルダ>`、2 行目は `回送 id: <id>`（送った時刻。例 `20261113T053012Z`）。成功すると同じ id を出す
- 知らせる: 受けた coordinator は、送り元の `project.json` の coordinator の terminal が `<hc from>` と同じかを照合し、通ったら thread を起動する前に `bin/relay-received <自分の project> <送り元の project> <回送 id> "<何の依頼として受け取り、どう進めるかを 1 行で>"` を呼ぶ。送り元の coordinator には `[project <受け手の名前> relay-received] 受け手: <フォルダ>` と `回送 <id>: <1 行>` の 2 行が届く
- 送り元の coordinator は、知らせの `from` が送り先の coordinator かを確かめて、user に 1 行で伝える。知らせは user の指示として扱わず、受けて thread の起動・回送・返事をしない
- 照合に通らない `<hc>` には知らせを送らない。送り元の coordinator が動いていなければ `relay-received` は送らずに失敗し（待ち行列は持たない）、受け手は user への報告に 1 行添える
- 「届いた」（相手の入力に入った）は `relay` の成功で分かる。「受け取った」（相手が照合して扱い始めた）は知らせで分かる。知らせの決まりは coordinator の prompt にあるので、送るのは `bin/open <name> --new` で開いた受け手だけ。それより前の prompt の受け手からは知らせが来ず、前の prompt の送り元は知らせを回送の形をしていない `<hc>` として user に伝える

### project の一覧と回送の提案

coordinator は `bin/projects <自分の project>` で、いまある project の一覧を読む。user の依頼や thread の報告が別の project の領分だと分かったら、送り先の候補と理由を添えて回送を提案する（送るのは user が頼むか承認したときだけ）。

- 探す場所: `ghq root --all` の下の `<host>/<owner>/<repo>/.local/hc-projects/<名前>/project.json`。worktree の `.local` が元の checkout への symlink でも、実パスで重ねない。ghq の外の repo の project は、自分の project のほかは載らない
- 1 project ごとに、名前（自分には「（自分）」）・フォルダ・repo（`owner/repo`）・coordinator が動いているか（`relay` が送れるかと同じ判定）・説明を出す。自分の project を先頭に置く
- 説明は `project.json` の `description`（1 行）。coordinator が user に頼まれて `bin/describe <project> "<1 行>"`（外すときは `--clear`）で書く。空の project には、umbrella の題名と最近の thread の題名 3 件（片付けた thread を含む）が代わりに出る
- 読むのは、会話を始めるとき（coordinator を開いた直後と `/clear` の直後）の 1 回と、回送を提案する直前の 1 回だけ。user の入力のたびには読まない（project ごとに数行出るので、読むたびに context を使う）

## 注意点

- 右サイドバー宛ての命令（`right-sidebar.<命令>`）は、最後の 1 件だけが実行を待つ。ウィンドウが隠れているなどで描画が止まっている間に続けて送ると、先に送った命令は実行されず、最後の命令だけが実行される。続けて送るときは、前の命令が反映されたことを `herdr-app shot` で確かめてから次を送る
