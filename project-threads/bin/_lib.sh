# open / start / message / report が source する共通の関数。単体では実行しない。
# shellcheck shell=bash

# 全 project 共通の決まり（user が手で書く。無くてもよい）のフォルダ。coordinator-rules.md は coordinator だけが従い、
# thread-rules.md は thread が従う（start が thread の prompt に写す）。repo 固有は <repo の元の checkout>/.local/hc-projects/ の
# repo-coordinator-rules.md と repo-thread-rules.md。XDG_CONFIG_HOME を見るのは、テストに手元のファイルを読ませないため
RULES_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/project-threads"

# {bin} と {project} と {rules_dir} と {auto_memory} を置き換えて prompt を書き出す。claude に渡すコマンドとファイルを絶対パスで示すため。
# {auto_memory} は project を置いた repo の auto-memory の索引（auto_memory_index_of）。索引が無い repo では、{auto_memory} を
# 含む行ごと書かない（読む物が無いのに読ませない）。
# thread の prompt は <repo> に、thread 用の決まりを写す repo の元の checkout を渡す。{rules_repos} をその並びに、
# {thread_rules} の行を thread_rules_section に置き換える。写す物が無ければ {thread_rules} の行ごと書かない
render_prompt() { # <元のファイル> <書き出し先> <bin のフォルダ> <project のフォルダ> [<repo>...]
  local text index line kept="" src="$1" dst="$2" bin="$3" project="$4" repos section sep="\`・\`"
  shift 4
  text="$(cat "$src")"
  text="${text//\{bin\}/$bin}"
  text="${text//\{project\}/$project}"
  text="${text//\{rules_dir\}/$RULES_DIR}"
  if [[ "$text" == *"{rules_repos}"* ]]; then
    # 元のファイルでは 1 つの `{rules_repos}` と書くので、repo ごとに ` で囲んで ・ でつなぐ
    printf -v repos "%s$sep" "$@"
    repos="${repos%"$sep"}"
    text="${text//\{rules_repos\}/$repos}"
  fi
  if [[ "$text" == *"{thread_rules}"* ]]; then
    section="$(thread_rules_section "$@")"
    kept=""
    while IFS= read -r line; do
      if [[ "$line" != *"{thread_rules}"* ]]; then
        kept+="$line"$'\n'
      elif [[ -n "$section" ]]; then
        kept+="$section"$'\n'
      fi
    done <<<"$text"
    text="${kept%$'\n'}"
  fi
  if [[ "$text" == *"{auto_memory}"* ]]; then
    if index="$(auto_memory_index_of "$project")"; then
      text="${text//\{auto_memory\}/$index}"
    else
      kept=""
      while IFS= read -r line; do
        [[ "$line" == *"{auto_memory}"* ]] || kept+="$line"$'\n'
      done <<<"$text"
      text="${kept%$'\n'}"
    fi
  fi
  printf '%s\n' "$text" > "$dst"
}

# project memory の索引（memory/MEMORY.md）の 1 行の要約の上限の文字数。handoff と memory が数える
# shellcheck disable=SC2034  # source する handoff と memory が使う
SUMMARY_MAX_CHARS=120
# 索引の行（`- [題名](<名前>.md) — <要約>`）を読む jq の定義。entry は索引の行でなければ何も返さない。summary_of は rest から
# 先頭の — と前後の空白を除いた要約で、題名とリンクは数えない。数えるのは jq の length（Unicode の文字単位）。bash 3.2 の ${#var} は
# C locale で、macOS の awk の length は常にバイト数になる
# shellcheck disable=SC2034  # source する handoff と memory が使う
MEMORY_INDEX_JQ='
  def entry: capture("^(?<prefix>\\s*- \\[.*?\\]\\((?<link>[^)]*)\\))(?<rest>.*)$");
  def summary_of: sub("^\\s*(—\\s*)?"; "") | sub("\\s+$"; "");'

# memory の整理の候補のファイルの名前（project のフォルダの中）。handoff が起動した thread が書き、memory が読む。
# .local の *.md なので、一覧の pane の Docs タブにも出る
# shellcheck disable=SC2034  # source する handoff と memory が使う
MEMORY_CANDIDATES_FILE=memory-cleanup.md
# 前の memory の整理を終えた時点の索引の行数を書くファイルの名前（project のフォルダの中。数字 1 つの 1 行）。handoff が整理の
# thread を起動するときと、memory apply が候補を行ったときに書き、handoff が前の整理から増えた行数を数えるのに読む
# shellcheck disable=SC2034  # source する handoff と memory が使う
MEMORY_TIDIED_FILE=memory-tidied

# 索引の行の数を stdout に出す
memory_index_entries() { # <索引のファイル>
  jq -Rn "$MEMORY_INDEX_JQ"'[inputs | entry] | length' "$1"
}

# 決まりのファイルの中身を、thread の prompt に写す形で書き出す。説明のコメント（<!-- … -->）と 1 段目の見出し（ファイルの題名）を
# 除き、本文のある欄だけを、見出しを 2 段下げて書く（prompt の中の節の下に置くため）。欄の前後の空行は詰める。
# ファイルが無い・本文のある欄が無ければ何も書かない
rules_sections_of() { # <ファイル>
  local line text in_comment="" heading="" body="" blanks="" out=""
  [[ -f "$1" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    text=""
    while :; do
      if [[ -n "$in_comment" ]]; then
        if [[ "$line" != *"-->"* ]]; then
          line=""
          break
        fi
        line="${line#*-->}"
        in_comment=""
      fi
      if [[ "$line" != *"<!--"* ]]; then
        text+="$line"
        break
      fi
      text+="${line%%<!--*}"
      line="${line#*<!--}"
      in_comment=1
    done
    if [[ "$text" == "# "* ]]; then
      continue
    elif [[ "$text" == "## "* ]]; then
      if [[ -n "$body" ]]; then out+="${heading}${body}"$'\n\n'; fi
      heading="##${text}"$'\n\n'
      body=""
      blanks=""
    elif [[ "$text" != *[![:space:]]* ]]; then
      if [[ -n "$body" ]]; then blanks+=$'\n'; fi
    else
      if [[ "$text" == "###"* ]]; then text="##${text}"; fi
      if [[ -n "$body" ]]; then body+=$'\n'"$blanks"; fi
      body+="$text"
      blanks=""
    fi
  done < "$1"
  if [[ -n "$body" ]]; then out+="${heading}${body}"$'\n\n'; fi
  printf '%s' "${out%$'\n\n'}"
}

# thread の prompt の末尾に置く「決まり」の節。全 project 共通の thread 用の決まりと、<repo> ごとの repo 固有の thread 用の決まり。
# 写す物が 1 つも無ければ何も書かない
thread_rules_section() { # [<repo の元の checkout>...]
  local repo body out=""
  body="$(rules_sections_of "$RULES_DIR/thread-rules.md")"
  if [[ -n "$body" ]]; then out+=$'\n### 全 project 共通\n\n'"$body"$'\n'; fi
  for repo in "$@"; do
    body="$(rules_sections_of "$repo/.local/hc-projects/repo-thread-rules.md")"
    if [[ -n "$body" ]]; then out+=$'\n### repo 固有: '"${repo}"$'\n\n'"$body"$'\n'; fi
  done
  if [[ -n "$out" ]]; then printf '\n## 決まり\n%s' "${out%$'\n'}"; fi
}

# <フォルダ> を含む git の repo の元の checkout（worktree なら main の側）のパスを返す。git の repo でなければ失敗する
repo_checkout_of() { # <フォルダ>
  local common
  common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  printf '%s\n' "${common%/*}"
}

# <フォルダ> を置いた repo の auto-memory（Claude Code が repo ごとに書き溜めるメモ）の索引のパスを返す。無ければ失敗する。
# thread は起動で auto-memory を切る（launch_thread）ので、索引は prompt にパスを書いて、要る場面で読ませる。
# Claude Code は索引の置き場を、元の checkout（worktree なら main の側）のパスの英数字以外を - にした名前のフォルダに作る
auto_memory_index_of() { # <フォルダ>
  local root index
  root="$(repo_checkout_of "$1")" || return 1
  index="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/${root//[^0-9A-Za-z]/-}/memory/MEMORY.md"
  [[ -f "$index" ]] || return 1
  printf '%s\n' "$index"
}

# terminal の前面で、この prompt ファイルを渡された claude が動いているか。
# hc send は相手がシェルだと本文をコマンドとして実行させてしまうので、送る前に必ず確かめる。
# terminal が無い（再起動で消えた）のは普通に起きる状態なので、hc get の失敗も「動いていない」に数える
# 終了コードは、動いている 0・動いていない 1（terminal がもう無い not_found を含む）・hc から読めなかった 2。
# 2 を「動いていない」と同じに扱うと、message が動いている claude の横に同じ会話をもう 1 本起こす（external-data の t083）
is_claude_with() { # <terminal> <prompt ファイル>
  local got
  got="$(hc get "$1" --json 2>/dev/null)" || { if (($? == 3)); then return 1; fi; return 2; }
  jq -e --arg prompt "$2" "$CLAUDE_WITH_JQ" <<<"$got" >/dev/null
}
# hc get の JSON が、前面で $prompt を渡された claude が動いている terminal か。is_claude_with と concurrent_threads_section が使う
# shellcheck disable=SC2016  # $prompt は jq の変数
CLAUDE_WITH_JQ='
  .state == "live"
  and ((.foreground.argv[0] // "") | split("/") | last) == "claude"
  and ((.foreground.argv // []) | index($prompt) != null)'

# 起動の時点で同じ project で動いている thread を、brief の末尾に添える節として書き出す。並行する thread が同じファイルを
# 触って取り込みで衝突するのと、テストの全件を重ねて流すのを、起動した thread が前もって判断できるようにする。
# 動いているとみなすのは、引き継いでおらず（supersededBy なし）、terminal の前面で thread の claude が動いていて（is_claude_with と
# 同じ判定）、done を報告した後に止まっていない（報告のラベルが done でない。一覧が「報告済み」に入れ、cleanup が「done の後に
# 追加の依頼」を見るのと同じラベル）thread。needs-you・waiting で止まっている thread は、続きで同じ worktree を触るので含める。
# hc から状態を読めなかった thread は、動いていないと決めつけずにそう添える。<除く id> は自分と引き継ぎ元。無ければ何も書かない
concurrent_threads_section() { # <project のフォルダ> [<除く id>...]
  local project="$1" dir id meta terminal title got rc line paths lines=""
  shift
  for dir in "$project"/threads/t*; do
    id="${dir##*/}"
    [[ -f "$dir/thread.json" && " $* " != *" $id "* ]] || continue
    # タブは read で続けて並ぶと 1 つにまとまるので、空になりうる欄（terminal）は jq の側で除く
    meta="$(jq -r 'if .supersededBy or (.terminal // "") == "" then empty else [.terminal, .title // ""] | @tsv end' "$dir/thread.json")"
    IFS=$'\t' read -r terminal title <<<"$meta"
    [[ -n "$terminal" ]] || continue
    rc=0
    got="$(hc get "$terminal" --json 2>/dev/null)" || rc=$?
    if [[ $rc -eq 3 ]]; then continue; fi
    paths=""
    if [[ -f "$dir/worktrees.txt" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ -n "$line" ]]; then paths+="${paths:+、}$line"; fi
      done < "$dir/worktrees.txt"
    fi
    line="- ${id}「${title}」: ${paths:-worktree の記録なし}"
    if [[ $rc -ne 0 ]]; then
      lines+="${line}（hc から状態を読めず、動いているかは分からない）"$'\n'
    elif jq -e --arg prompt "$dir/system-prompt.md" "($CLAUDE_WITH_JQ) and .labels.report != \"done\"" <<<"$got" >/dev/null; then
      lines+="$line"$'\n'
    fi
  done
  [[ -n "$lines" ]] || return 0
  printf '\n## 起動の時点で同じ project で動いている thread\n\n%s\n' "$lines"
  printf '%s\n' "これらと同じファイルを触るなら report.md に書き、後から取り込まれる側として main へ載せ直す前提で進める。テストの全件など重い処理は、これらの thread と重ねて流さない。"
}

# いまある project のフォルダ（実パス）を PROJECT_DIRS に、ghq の root を GHQ_ROOTS に入れる。projects（一覧）と
# thread-count（起動本数）が同じ探し方をする。project は open が <repo>/.local/hc-projects/<名前> に作る。repo はすべて
# ghq の下にある前提で、ghq の root から探す（ghq の外の repo の project は、自分の project のほかは載らない）。
# 自分の project を先頭に置く。worktree の .local は元の checkout への symlink のことがあるので、実パスで重ねない
find_projects() { # <自分の project のフォルダ（実パス）>
  local root config dir seen=" $1 "
  GHQ_ROOTS=()
  PROJECT_DIRS=("$1")
  while IFS= read -r root; do
    [[ -z "$root" ]] || GHQ_ROOTS+=("$root")
  done < <(ghq root --all)
  for root in "${GHQ_ROOTS[@]+"${GHQ_ROOTS[@]}"}"; do
    # <root>/<host>/<owner>/<repo>/.local/hc-projects/<名前>/project.json
    for config in "$root"/*/*/*/.local/hc-projects/*/project.json; do
      [[ -f "$config" ]] || continue
      dir="$(cd "${config%/project.json}" && pwd -P)"
      [[ "$seen" != *" $dir "* ]] || continue
      seen+="$dir "
      PROJECT_DIRS+=("$dir")
    done
  done
}

# hc の draft_wait の既定値（秒）。hc send は、人の書きかけがあると、人がそれを送るか消すまで、最後の打鍵からこの秒数まで待つ。
# user が ~/.config/herdr-core/config.toml の draft_wait を延ばしたら、ここも合わせる。短いままだと、退避した後も hc send が
# 待ち続け、その間に人が新しく打って送ると、claude が戻した書きかけに本文がつながる
DRAFT_WAIT_SEC=60
# 入力欄を見直す間隔（秒）
DRAFT_POLL_SEC=2
# 入力欄が変わり続けるときに待つ上限（秒）。画面を読み違えて入力欄が変わり続けて見えても、本文が届かないままにしない。
# 超えたら退避せずに hc send に任せる（人が打っている間は hc send も待つ）
DRAFT_GIVE_UP_SEC=600

# 画面から claude の入力欄を REPLY に入れる。入力欄は、画面の最後の「❯」で始まる行から、その下の罫線（「─」で始まる行）の
# 手前まで。会話の中の user の入力も「❯」で始まるが、入力欄は画面のいちばん下にある。見つからなければ失敗する
input_box_of() { # <画面>
  local line box="" state=none
  while IFS= read -r line; do
    if [[ "$line" == "❯"* ]]; then
      box="$line"
      state=open
    elif [[ "$state" == open ]]; then
      if [[ "$line" == "─"* ]]; then
        state=closed
      else
        box+=$'\n'"$line"
      fi
    fi
  done <<<"$1"
  [[ "$state" == closed ]] || return 1
  REPLY="$box"
}

# 入力欄に書きかけが無いか。claude は「❯」の後ろに NBSP を置く。
# 入力がキューにある間は、空の入力欄に「Press up to edit queued messages」などのヒントが出る（v2.1.322 で 4 通り、
# どれも「Press up to 」で始まる）。書きかけと見なすと、応答中に続けて届く報告がそのたびに DRAFT_WAIT_SEC 秒遅れる
input_box_is_empty() { # <入力欄>
  local text="${1#❯}"
  text="${text//$'\xc2\xa0'/}"
  [[ -z "${text//[[:space:]]/}" || "$text" == "Press up to "* ]]
}

# 入力欄に退避（claude の Ctrl+S）があるか。claude は入力欄の上の罫線のすぐ上の行の右端に、2.1.325 までは「› stashed」、
# 2.1.326 からは「draft stashed」と出す。会話の中の同じ文字列を拾わないよう、その行だけを見る。
# 2.1.326 からは、退避がある間も空の入力欄に次の入力の候補が出るので、入力欄の中身からは退避の有無が分からない
input_box_stashed() { # <画面>
  local line above="" previous="" marker=""
  while IFS= read -r line; do
    if [[ "$line" == "❯"* && "$previous" == "─"* ]]; then marker="$above"; fi
    above="$previous"
    previous="$line"
  done <<<"$1"
  marker="${marker%"${marker##*[![:space:]]}"}"
  [[ "$marker" == *"draft stashed" || "$marker" == *"› stashed" ]]
}

# 送る前に Ctrl+S で書きかけを退避するかを決める。押すなら 0、押さないなら 1、hc が失敗したら 2 を返す。
# 入力欄が DRAFT_WAIT_SEC 秒変わらなければ、人が書きかけを置いたまま離れたとみて押す。人の最後の打鍵の時刻は hc から
# 取れないので、入力欄の変化で代える。空になれば（人が送ったか消した）押さない
draft_to_stash() { # <terminal>
  local terminal="$1" got screen last="" still=0 waited=0
  got="$(hc get "$terminal" --json)" || return 2
  [[ "$(jq -r '.status.state // empty' <<<"$got")" != "blocked" ]] || return 1
  while :; do
    screen="$(hc read "$terminal" --lines 0)" || return 2
    ! input_box_stashed "$screen" || return 1
    input_box_of "$screen" || return 1
    ! input_box_is_empty "$REPLY" || return 1
    if [[ "$REPLY" == "$last" ]]; then
      still=$((still + DRAFT_POLL_SEC))
    else
      last="$REPLY"
      still=0
    fi
    ((still < DRAFT_WAIT_SEC)) || break
    ((waited < DRAFT_GIVE_UP_SEC)) || return 1
    sleep "$DRAFT_POLL_SEC"
    waited=$((waited + DRAFT_POLL_SEC))
  done
  # 待っている間に許可の確認などが出ていたら押さない
  got="$(hc get "$terminal" --json)" || return 2
  [[ "$(jq -r '.status.state // empty' <<<"$got")" != "blocked" ]]
}

# claude の terminal に本文を送る。相手の入力欄に user の書きかけがあっても、書きかけと混ぜずに本文だけを送り、
# user が打っている途中の入力欄には触らない。相手が claude であることは呼び出し側が is_claude_with で確かめておく。
# hc send は、人の書きかけがあると、人がそれを送るか消すまで（最後の打鍵から DRAFT_WAIT_SEC 秒まで）待ち、その後は入力欄の
# 今の中身の後ろに貼り付けて Enter を押す（入力欄が空かは見ない）。だから書きかけを置いたまま人が離れると、書きかけと本文が
# 1 つの入力として送られる（応答中でも 1 つのキューの入力になる）。
# claude の Ctrl+S（chat:stash）は入力欄の中身を退避して空にし、次の送信の後に入力欄へ戻すので、この場合は送る前に押す。
# hc keys は人が 3 秒ほど打たなければ押し、書きかけを待たないので、押す時機は draft_to_stash が決める。3 秒で押すと、
# 考えながら打っている途中で入力欄が消え、hc send は人が送るまで待ったうえで、claude が戻した書きかけに本文をつなげる。
# 押さないとき:
#   - 退避が既にある（input_box_stashed）: 入力欄が空だと退避を取り出して本文に混ぜ、書きかけがあると前の退避を上書きして
#     失う。書きかけと混ざりうるが、hc send の待ちに任せる
#   - blocked（許可の確認など）: hc send が断るので送らずに失敗する。ダイアログにキーを送らない
#   - 入力欄が画面に見えない、または DRAFT_GIVE_UP_SEC 秒たっても変わり続ける: hc send の待ちに任せる
# 押した後に hc send が失敗しても、書きかけは退避に残り、user の次の送信の後に入力欄へ戻る（画面には退避の印が出る）
send_keeping_draft() { # [hc send のオプション...] <terminal> <本文>
  local terminal="${*: -2:1}" decision=0
  draft_to_stash "$terminal" || decision=$?
  case "$decision" in
    0) hc keys "$terminal" ctrl+s >/dev/null || return 1 ;;
    2) return 1 ;;
  esac
  hc send "$@"
}

# 会話の記録ファイルのパスを返す。無ければ失敗する。
# 場所は作業フォルダから作る名前の規則に依存させず、会話の id で探す
transcript_of() { # <会話の id>
  local file
  for file in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl; do
    if [[ -f "$file" ]]; then
      printf '%s\n' "$file"
      return 0
    fi
  done
  return 1
}

# 会話の記録で、本体の会話の最後のターンが終わっているか。claude はターンの終わりに system の turn_duration の行を書き、
# 次の入力（人の入力・バックグラウンドの作業の終わりの知らせ）は user の行になる。記録が無い・行が無ければ失敗する。
# claude は、そのターンで run_in_background で起動したコマンドやバックグラウンドの subagent が動いている間、ターンを終えても
# hc に working と出す（status.msg は「N shells still running」。前のターンで起動したものだけが動いていれば done と出る）。
# working がターンの途中かこの状態かは、これで見分ける
turn_ended() { # <会話の id>
  local file
  file="$(transcript_of "$1")" || return 1
  [[ "$(grep -E '"type":"(user|assistant)"|"subtype":"turn_duration"' "$file" | tail -n 50 | jq -Rnr '
    [inputs | fromjson? | select(type == "object" and (.isSidechain | not))] | last | .subtype // empty')" == turn_duration ]]
}

# 会話の context の大きさ（トークン数）。本体の会話の最後の assistant の行の usage の入力側の和で、
# claude の statusline の total_input_tokens・/context と同じ値になる。上限（context の窓）は記録に無いので返さない。
# 記録には 1 行が数 MB の行（api-request-blob・user）があるので、末尾の固定バイト数では読まず、assistant の行だけを拾う。
# 和が 0 の行は context の大きさを表さないので数えない。取れなければ失敗する
context_tokens_of() { # <会話の id>
  local file
  file="$(transcript_of "$1")" || return 1
  grep -F '"type":"assistant"' "$file" | tail -n 50 | jq -Rnre '
    [inputs | fromjson? | select(type == "object" and .type == "assistant" and (.isSidechain | not))
      | try (.message.usage | .input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens) catch null
      | numbers | select(. > 0)]
    | last | numbers'
}

# 会話の prompt cache を最後に使った時刻（epoch 秒）。cache の寿命は要求のたびに延びるので、本体の会話の最後の要求の時刻を、
# assistant の行（応答）と system の away_summary の行（席を外して約 3 分後に作られる要約。本体と同じ前置きを読むので寿命が延びる）の
# 新しいほうの timestamp で取る。subagent（isSidechain）の要求は本体の cache を延ばさず、エラーの行（isApiErrorMessage）と
# 合成の行（model が <synthetic>。中断・利用枠の上限など）は API の応答でないので数えない。
# assistant の行の timestamp は応答を書いた時刻で、cache の寿命の起点（要求の開始）より遅い。差は直近の記録で p99.9 が 151 秒・
# 最大 275 秒（t052）なので、呼び出し側は数分の余裕を持たせる。api-request の行は断られた要求（429 など）にも書かれるので使わない。
# 記録には 1 行が数 MB の行があるので、見る種類の行だけを grep で拾ってから jq で読む。取れなければ失敗する
last_api_call_epoch() { # <会話の id>
  local file
  file="$(transcript_of "$1")" || return 1
  grep -E '"type":"assistant"|"subtype":"away_summary"' "$file" | tail -n 50 | jq -Rnre '
    [inputs | fromjson? | select(type == "object" and (.isSidechain | not) and (.timestamp | type) == "string")
      | select((.type == "assistant" and (.isApiErrorMessage | not) and .message.model != "<synthetic>")
          or (.type == "system" and .subtype == "away_summary"))
      | .timestamp | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch empty]
    | max | numbers | floor'
}

# トークン数を claude の statusline と同じ丸めで書く（150k、94.4k、901）。state.js の contextLabel と揃える
format_tokens() { # <トークン数>
  jq -nr --argjson t "$1" 'if $t >= 100000 then "\($t / 1000 | round)k" elif $t >= 1000 then "\($t / 100 | round / 10)k" else "\($t)" end'
}

# coordinator の会話の id を REPLY に入れる。/clear で会話の id が変わるので、open が coordinator に渡す SessionStart hook が
# 起動・再開・/clear のたびに project の coordinator-session に書く。無ければ失敗する
coordinator_session_of() { # <project のフォルダ>
  REPLY=""
  [[ -f "$1/coordinator-session" ]] || return 1
  read -r REPLY < "$1/coordinator-session" || true
  [[ -n "$REPLY" ]]
}

# coordinator に引き継ぎを提案させる知らせ（bin/watch）と報告への添え書き（bin/report）が共有する決まり。
# 同じ会話では、前の提案から context がこれだけ増えるまで次の提案を出さない。断られた提案を、作業が進むまで繰り返さないため
HANDOFF_PROPOSE_STEP_TOKENS=50000
# 引き継いだ直後の coordinator の context。再開のターン（progress と status.json を読む）の後の実測の中央値は 108k（t053）
HANDOFF_FRESH_TOKENS=110000

# coordinator の context が <閾値> 以上で、同じ会話でまだ提案していないか、前の提案から HANDOFF_PROPOSE_STEP_TOKENS 以上
# 増えたかを確かめる。印（project の handoff-proposed。「会話の id context」の 1 行）は bin/watch と bin/report で共有する
handoff_proposal_due() { # <project のフォルダ> <会話の id> <context> <閾値>
  local session="" tokens=0
  (($3 >= $4)) || return 1
  if [[ -f "$1/handoff-proposed" ]]; then read -r session tokens < "$1/handoff-proposed" || true; fi
  [[ "$session" != "$2" ]] || (($3 >= tokens + HANDOFF_PROPOSE_STEP_TOKENS))
}

mark_handoff_proposed() { # <project のフォルダ> <会話の id> <context>
  printf '%s %s\n' "$2" "$3" > "$1/handoff-proposed"
}

# coordinator が user に返す、引き継ぎの提案の 1 行
handoff_proposal_line() { # <context>
  printf '「context が %s です。席を外すなら先に引き継ぐと、prompt cache が切れた後に書き直す会話が約 %s に減ります（引き継ぐなら「引き継いで」）」' \
    "$(format_tokens "$1")" "$(format_tokens "$HANDOFF_FRESH_TOKENS")"
}

# 見張り（bin/watch）が coordinator の prompt cache を切れる前に延ばす時間帯の設定（user が手で書く。無くてもよい）。
# 「<曜日の範囲> <時刻の範囲>」の 1 行で、曜日は 1（月）〜7（日）、時刻は終わりを含まない（例 1-5 09:00-21:00）。
# off の 1 行で延ばさない。# から後ろは読まない。無ければ KEEPALIVE_DEFAULT_HOURS（user が決めた営業時間。祝日は考えない）。
# XDG_CONFIG_HOME を見るのは、テストに手元のファイルを読ませないため（手元では ~/.config と同じ）
KEEPALIVE_HOURS_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/project-threads/coordinator-keepalive.txt"
KEEPALIVE_DEFAULT_HOURS="1-5 09:00-21:00"

# 延ばす時間帯を REPLY に入れる。off なら空。書式が違えば失敗する
keepalive_hours() {
  local line days times rest found=""
  REPLY="$KEEPALIVE_DEFAULT_HOURS"
  [[ -f "$KEEPALIVE_HOURS_FILE" ]] || return 0
  REPLY=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    read -r days times rest <<<"${line%%#*}" || true
    [[ -n "$days" ]] || continue
    [[ -z "$found" && -z "$rest" ]] || return 1
    found=1
    if [[ "$days" == off && -z "$times" ]]; then continue; fi
    [[ "$days" =~ ^[1-7]-[1-7]$ && "$times" =~ ^[0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]$ ]] || return 1
    REPLY="$days $times"
  done < "$KEEPALIVE_HOURS_FILE"
  [[ -n "$found" ]]
}

# <時間帯>（keepalive_hours の形）が <曜日>（date +%u）の <時刻>（date +%H%M）を含むか
hours_cover() { # <時間帯> <曜日> <時刻>
  local days="${1%% *}" times="${1#* }" from to
  from="${times%-*}"
  to="${times#*-}"
  ((${days%-*} <= $2 && $2 <= ${days#*-} && 10#${from/:/} <= 10#$3 && 10#$3 < 10#${to/:/}))
}

# 会話の記録の、先頭から <バイト数> より後ろで、最初のメッセージのターンがどこまで進んだかを REPLY に入れる。
#   none      メッセージ（type が user の行）がまだ無い。記録のファイルが無いときも
#   received  メッセージはあるが、その後に API への送信（api-request・api-request-shape）も応答（assistant）も無い
#   started   メッセージの後に API への送信か応答がある
# claude は API に送る前に取り消されたメッセージを会話から外して入力欄に戻すが、記録の user の行は残す（t044）ので、
# user の行だけではターンが始まったと言えない。
# --resume では既存の記録に追記され、メッセージより前にほかの行も書かれるので、大きさの増加では判定しない。
# 記録には 1 行が数 MB の行（api-request-blob）があるので、見る種類の行だけを grep で拾ってから jq で読む
turn_progress_after() { # <会話の id> <バイト数>
  local file
  REPLY=none
  file="$(transcript_of "$1")" || return 0
  REPLY="$(tail -c "+$(($2 + 1))" "$file" | { grep -E '"type":"(user|assistant|api-request|api-request-shape)"' || true; } | jq -Rnr '
    reduce (inputs | fromjson? | select(type == "object") | .type) as $t ("none";
      if . == "none" and $t == "user" then "received"
      elif . == "received" and ($t == "api-request" or $t == "api-request-shape" or $t == "assistant") then "started"
      else . end)')"
}

# 空白（改行・NBSP を含む）を除いた文字列を REPLY に入れる。bash 3.2 の ${s//[[:space:]]/} は数 KB の本文で数秒かかる
# （9KB の brief で 7 秒）ので、read の単語分割で除く
without_spaces() { # <文字列>
  local IFS=$' \t\n\r' words=()
  read -rd '' -a words <<<"${1//$'\xc2\xa0'/ }" || true
  REPLY=""
  if [[ ${#words[@]} -gt 0 ]]; then printf -v REPLY '%s' "${words[@]}"; fi
}

# 画面の入力欄に <本文> が入っているか。API に送る前に取り消されたメッセージは入力欄に戻る（t044）ので、送り直す前に確かめる。
# 長い本文は入力欄に末尾の数十行だけが見え、行は画面の幅で折り返されて、続きの行は字下げされる。
# だから空白を除いて、入力欄の中身が本文の末尾と一致するかで見る
input_box_holds() { # <画面> <本文>
  local box
  input_box_of "$1" || return 1
  without_spaces "${REPLY#❯}"
  box="$REPLY"
  without_spaces "$2"
  [[ -n "$box" && "$REPLY" == *"$box" ]]
}

# thread の claude に渡す effort（reasoning effort）。model ごとに決めた組で、start も message の再開も同じ値を使う。
# claude は --resume で effort を引き継がない（渡さないと既定に戻る）ので、再開のたびに渡す
thread_effort() { # <model>
  case "$1" in
    opus) echo high ;;
    sonnet) echo high ;;
    *)
      echo "thread の effort を決められない model です: $1" >&2
      return 1
      ;;
  esac
}

# coordinator（open）と thread（launch_thread）の claude から外す組み込みのツール。coordinator と thread では一度も
# 使われていないのに、定義が API 呼び出しのたびの入力に載る。外す前に始めた会話も、再開（--resume・--continue）すると外れる。
# --disallowedTools は可変長の引数で、後ろの位置引数まで飲み込む（thread の最初のメッセージが deny のルールとして
# 読まれ、thread が入力待ちで止まる）ので、渡すときは直後に別のオプションを置く
UNUSED_TOOLS="Workflow,ScheduleWakeup,ReportFindings,ListAgents,ShareOnboardingGuide"

# thread の skill の一覧で説明を残す skill を 1 行に 1 つ書いたファイル（user が手で書く）。載せていない skill は説明を外して
# 名前だけにする。一覧の説明は thread の毎回の入力に載るので、新しく足した skill が何もしなくても入力を増やさないようにする。
# 名前だけの skill も、名前を指定すれば Skill ツールで呼べる。XDG_CONFIG_HOME を見るのは、テストに手元のファイルを読ませないため
# （手元では ~/.config と同じ）
THREAD_SKILLS="${XDG_CONFIG_HOME:-$HOME/.config}/project-threads/thread-skills.txt"
# thread の会話の記録の skill の一覧に出た名前（launch_thread が足す）。Claude Code の組み込みの skill はファイルから列挙
# できないので、記録から覚える。覚える前（Claude Code の更新で増えた組み込みの skill を初めて見る thread）は説明つきで載る。
# coordinator（open）も読む（組み込みの skill は coordinator と thread で同じ）
THREAD_SKILL_NAMES_SEEN="${XDG_STATE_HOME:-$HOME/.local/state}/project-threads/thread-skill-names.txt"

# thread の起動の settings に、THREAD_SKILLS の skill のほかを名前だけにする skillOverrides を足して返す。
# THREAD_SKILLS が無ければ雛形から作る。出力は coordinator が読む
with_thread_skills() { # <settings の JSON> <thread のフォルダ> <雛形のフォルダ>
  if [[ ! -e "$THREAD_SKILLS" ]]; then
    if ! { mkdir -p "${THREAD_SKILLS%/*}" && cp "$3/thread-skills.txt" "$THREAD_SKILLS"; }; then
      echo "thread の skill の一覧で説明を残す skill のファイル（${THREAD_SKILLS}）を雛形から作れないので、thread を起動していません。このことを user に 1 行で伝えてください。" >&2
      return 1
    fi
    echo "thread の skill の一覧で説明を残す skill のファイルが無かったので、雛形から ${THREAD_SKILLS} を作りました（載せていない skill は名前だけになります）。このことを user に 1 行で伝えてください。" >&2
  fi
  with_kept_skills "$1" "$THREAD_SKILLS" "$2" "thread の skill の一覧" "thread を起動していません。このことを user に 1 行で伝えてください。"
}

# <settings の JSON> に、<作業フォルダ> で起動する claude から見える skill のうち <説明を残す skill のファイル> に無いものを
# 名前だけ（name-only）にする skillOverrides を足して返す。skillOverrides には全部をまとめて指定する書き方が無く、キーは
# skill の名前の完全一致だけなので、名前を集める。集めるのは user の skill・claude.ai から同期した skill（anthropic-skills:<名前>）・
# 作業フォルダから git の最上位までの .claude/skills（claude が起動時に読む範囲）・THREAD_SKILL_NAMES_SEEN。claude が使う名前は
# front matter の name ではなくフォルダ名。plugin の skill には skillOverrides が効かない。
# user 設定の skillOverrides に書かれた skill は渡さない。--settings の値が skill ごとに勝つので、user が隠した skill
# （user-invocable-only・off）を一覧に出してしまう。project の設定は作業フォルダの .claude のものだけが読まれ、thread と
# coordinator の作業フォルダには無い。名前が 1 つも無ければ、どの skill も名前だけになる。
# 読めないファイルがあれば、<何の一覧> を組み立てられないことと <止めたことと対応> を出して失敗する
with_kept_skills() { # <settings の JSON> <説明を残す skill のファイル> <作業フォルダ> <何の一覧> <止めたことと対応>
  local config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" d="$3" f skill_names=() user_settings=/dev/null seen=/dev/null
  for f in "$config"/skills/*/SKILL.md; do
    if [[ -f "$f" ]]; then f="${f%/SKILL.md}" && skill_names+=("${f##*/}"); fi
  done
  for f in "$config"/skills/synced/*/*/SKILL.md; do
    if [[ -f "$f" ]]; then f="${f%/SKILL.md}" && skill_names+=("anthropic-skills:${f##*/}"); fi
  done
  while :; do
    for f in "$d"/.claude/skills/*/SKILL.md; do
      if [[ -f "$f" ]]; then f="${f%/SKILL.md}" && skill_names+=("${f##*/}"); fi
    done
    if [[ -e "$d/.git" || -z "$d" ]]; then break; fi
    d="${d%/*}"
  done
  if [[ -f "$config/settings.json" ]]; then user_settings="$config/settings.json"; fi
  if [[ -f "$THREAD_SKILL_NAMES_SEEN" ]]; then seen="$THREAD_SKILL_NAMES_SEEN"; fi
  jq -nc --argjson settings "$1" --rawfile keep "$2" --rawfile seen "$seen" --slurpfile user "$user_settings" '
    def names: split("\n") | map(sub("#.*"; "") | gsub("^\\s+|\\s+$"; "") | select(. != ""));
    ([($keep | names[]), ($user[0].skillOverrides // {} | keys[])] | map({key: ., value: true}) | from_entries) as $skip
    | [$ARGS.positional[], ($seen | names[])] | unique | map(select($skip[.] | not) | {key: ., value: "name-only"}) | from_entries
    | if . == {} then $settings else $settings + {skillOverrides: .} end
  ' --args ${skill_names[@]+"${skill_names[@]}"} || {
    echo "${4}を組み立てられない（${2}・${user_settings}・${seen} のどれかを読めない）ので、${5}" >&2
    return 1
  }
}

# 会話の記録の、先頭から <バイト数> より後ろの skill の一覧に出た名前のうち、THREAD_SKILL_NAMES_SEEN に無いものを足す
remember_thread_skill_names() { # <会話の id> <バイト数>
  local file seen=/dev/null
  file="$(transcript_of "$1")" || return 1
  if [[ -f "$THREAD_SKILL_NAMES_SEEN" ]]; then seen="$THREAD_SKILL_NAMES_SEEN"; fi
  mkdir -p "${THREAD_SKILL_NAMES_SEEN%/*}" || return 1
  # 手で置いたファイルの最後の行に改行が無ければ、続けて書かないよう先に改行を足す
  tail -c "+$(($2 + 1))" "$file" | { grep -F '"skill_listing"' || true; } | jq -Rnr --rawfile seen "$seen" '
    ($seen | split("\n") | map({key: ., value: true}) | from_entries) as $known
    | [inputs | fromjson? | select(type == "object" and .type == "attachment" and .attachment.type == "skill_listing")
        | .attachment.names[]?] | unique | map(select($known[.] | not))
    | if . == [] then empty
      else (if $seen != "" and ($seen | endswith("\n") | not) then "" else empty end), .[] end
  ' >> "$THREAD_SKILL_NAMES_SEEN"
}

# 最初のメッセージが会話の記録に入ってから、API への送信が記録に入らないまま、取り消しを疑うまでの秒数。
# 平常時は 1 秒以内に入る（t044）
TURN_START_WAIT_SEC=5
# API に送る前に取り消されて入力欄に戻った最初のメッセージを、Enter で送り直す回数の上限
TURN_RESEND_MAX=2
# thread の claude の terminal に付ける、会話の id のラベルの名前。hc run が失敗を返したときに、それでも作られた terminal を探す
SESSION_LABEL=thread.session
# hc run が失敗を返した後に、作られた terminal を探す回数（1 秒おき）
UNCONFIRMED_LAUNCH_TRIES=5

# その会話の claude が前面で動いている terminal の番号を 1 行ずつ出す。会話の id のラベルで探す。ラベルは claude が終わって
# シェルが残った terminal（hc keep）にも残るので、前面の argv も見る
terminals_of_session() { # <会話の id>
  local listed address got
  listed="$(hc ls --json --label "$SESSION_LABEL=$1")" || return 1
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    # not_found（3）は探した後に消えた
    got="$(hc get "$address" --json 2>/dev/null)" || { if (($? == 3)); then continue; fi; return 1; }
    jq -r --arg session "$1" '
      select(.state == "live"
        and ((.foreground.argv[0] // "") | split("/") | last) == "claude"
        and ((.foreground.argv // []) | index($session) != null))
      | .address' <<<"$got"
  done < <(jq -r '.terminals[].address' <<<"$listed")
}

# hc run が失敗を返しても、terminal は作られていることがある（hc は「registry persistence timed out; the operation may
# already have completed」を返す）。残すと、呼び出し側（start）が thread を起動できなかったものとして扱うので、記録に無い
# claude が thread のフォルダで動き続ける（mail-notify の t164 の terminal t216）。会話の id のラベルで探して止める
stop_unconfirmed_launch() { # <会話の id> <hc run の出力>
  local session="$1" run_out="$2" found="" try address stopped=() unstopped=()
  for ((try = 1; try <= UNCONFIRMED_LAUNCH_TRIES; try++)); do
    if found="$(terminals_of_session "$session")" && [[ -n "$found" ]]; then break; fi
    sleep 1
  done
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    if hc kill "$address" >/dev/null; then stopped+=("$address"); else unstopped+=("$address"); fi
  done <<<"$found"
  echo "hc が thread の claude の起動に失敗したと返しました（${run_out:-出力なし}）。" >&2
  if [[ ${#unstopped[@]} -gt 0 ]]; then
    echo "それでも作られた terminal（${unstopped[*]}）を止められませんでした。thread を起動できていません。止めてよいかを user に聞き、よければ hc kill で止めてから起動し直してください。" >&2
  elif [[ ${#stopped[@]} -gt 0 ]]; then
    echo "それでも作られていた terminal（${stopped[*]}）を止めました。thread を起動できていないので、同じコマンドで起動し直してください。" >&2
  elif ! terminals_of_session "$session" >/dev/null; then
    echo "作られた terminal が残っていないかを hc から確かめられませんでした。thread を起動できていません。hc ls --label ${SESSION_LABEL}=${session} で残っていないかを確かめ、残っていれば止めてよいかを user に聞いてから起動し直してください。" >&2
  else
    echo "terminal は作られていませんでした。thread を起動できていないので、同じコマンドで起動し直してください。" >&2
  fi
}

# thread の claude を hc の terminal で起動し、terminal の番号を stdout に返す。
# 成功は、会話の記録で、最初のメッセージの後に API への送信か応答が書かれたこと（ターンが始まったこと）で判定する。
# hc の状態の通知やメッセージの記録だけでは判定しない。claude は API に送る前にターンが取り消されると、メッセージを会話から
# 外して入力欄に戻し、何もせずに待つ。t044 の 2 件は起動直後の取り消しで、通知もメッセージの記録も取り消しの前に済んでいた。
# 取り消しを見つけたら、入力欄に本文が戻っていることを確かめて Enter で送り直す（TURN_RESEND_MAX 回まで。user が手で
# 戻したのと同じ操作で、会話の id も terminal も変わらない）。入力欄が本文でなければ押さない（人の書きかけを送らない）。
# API への送信が記録に入った後、応答が返る前に取り消されたときも入力欄に戻るが、記録に印が残らないのでここでは拾えない
# （t048 の試験で再現）。見張り（bin/watch）の stalled の知らせが拾う。
# 起動から 60 秒たってもターンが始まらなければ（信頼確認などのダイアログで止まった・送り直しても取り消される）、
# terminal を終わらせて失敗する。hc はダイアログでの止まり方を blocked として知らせない。
# hc の状態の通知は、ターンが始まった後の警告にだけ使う。claude は起動時の問い合わせに terminal の返事が間に合わないと、
# その会話のあいだ通知を出さない（#8）
launch_thread() { # <thread のフォルダ> <bin のフォルダ> <model> <Chrome: true|false> <表示名> <最初のメッセージ> <会話の id> <claude の追加引数...>
  local dir="$1" bin="$2" model="$3" chrome="$4" display="$5" message="$6" session="$7"
  shift 7
  local settings address status notified="" screen transcript offset=0 progress=none received_at="" check_at=0 resent=0 reason="" i effort
  local running="" run_out=""
  local connectors_off chrome_flag=--no-chrome
  effort="$(thread_effort "$model")" || return 1
  # Claude in Chrome は、ブラウザを使う thread（start・message の --chrome）のほかは切る。切らないと、使わない thread でも
  # system prompt の節・MCP の指示・遅延ツールの名前 20 件が毎回の入力に載る。user の既定（claudeInChromeDefaultEnabled）に
  # 左右されないよう、どちらの場合も明示して渡す。再開では、起動のときに切った会話にも --chrome で戻せる
  if [[ "$chrome" == true ]]; then chrome_flag=--chrome; fi
  # project の threadConnectors（bin/connectors が書く）が false なら、claude.ai の connector（Datadog・Slack・Claude Docs など）を
  # 切る。使わない project でも、遅延ツールの名前の一覧（Datadog だけで約 500 件）と MCP の指示が、thread と subagent の毎回の
  # 入力に載る。欄が無ければ切らない（欄ができる前に作った project。bin/open が新しく作る project は false から始まる）。
  # thread のフォルダは start が <project>/threads/<id> に作る
  connectors_off="$(jq '.threadConnectors == false' "${dir%/threads/*}/project.json")" || return 1
  # 入力を受けた時点で前の報告は済んだことになるので、terminal の報告のラベルを消す。消さないと、user が thread の
  # 画面に直接答えて、thread が報告せずにターンを終えたとき、一覧が前の報告の見出しと要約を出したままになる。
  # hook の stdout は claude への入力に足されるので捨てる。
  # auto-memory は切る。thread は auto-memory に書かず（学びは project memory に書く）、索引は要る場面でだけ読めばよいのに、
  # 切らないと索引（zumen-engine で約 10k トークン）が毎回の入力に載る。読む場面は prompt に書く（render_prompt の {auto_memory}）
  settings="$(jq -nc --arg report "Bash($bin/report *)" \
    --arg clear 'hc label "$HC_TERMINAL_ID" report= report.at= >/dev/null' --argjson connectorsOff "$connectors_off" \
    '{permissions: {allow: [$report]}, hooks: {UserPromptSubmit: [{hooks: [{type: "command", command: $clear}]}]}, autoMemoryEnabled: false}
      + if $connectorsOff then {disableClaudeAiConnectors: true} else {} end')"
  # --resume では記録に追記されるので、起動前の大きさより後ろだけを見る
  if transcript="$(transcript_of "$session")"; then
    offset="$(wc -c < "$transcript" | tr -d ' ')"
  fi
  # 説明を残すと決めた skill のほかは、説明を一覧から外す（coordinator は open が別の一覧で外す）
  settings="$(with_thread_skills "$settings" "$dir" "${bin%/*}/templates")" || return 1
  # 再開では、同じ会話を 2 つの claude で動かさない。記録に無い terminal で動いている（message が動いている claude を見落とした）
  # なら、起動せずに知らせる。terminal には起動のときに会話の id のラベルを付けてある（付ける前に起動した terminal は見つからない）。
  # start は会話の id を新しく作るので確かめない
  if [[ "${1:-}" == --resume ]] && ! running="$(terminals_of_session "$session")"; then
    echo "同じ会話の claude が動いていないかを hc から確かめられなかったので、thread の claude を起動していません。少し待って同じコマンドを繰り返してください。" >&2
    return 1
  fi
  if [[ -n "$running" ]]; then
    echo "この thread の会話（${session}）の claude が、thread.json に記録の無い terminal（$(printf '%s' "$running" | tr '\n' ' ')）で動いているので、もう 1 本は起動していません。user に伝えて判断を仰いでください。" >&2
    return 1
  fi
  # 呼び出し側が if や $(...) の中で呼ぶと set -e が効かないので、失敗は 1 つずつ return で返す。
  # --outlive-parent: hc の子は既定で親と一緒に終わる。coordinator を閉じても thread を残す。
  # defer-artifact は Artifact を遅延ロードにする Claude Code の plugin。coordinator 用の command がある plugin/ は渡さない
  if ! run_out="$(hc run --bg --json --outlive-parent --cwd "$dir" --label "$SESSION_LABEL=$session" -- \
    claude --model "$model" --effort "$effort" "$chrome_flag" --permission-mode auto --disallowedTools "$UNUSED_TOOLS" --name "$display" \
    --append-system-prompt-file "$dir/system-prompt.md" --settings "$settings" --plugin-dir "${bin%/*}/defer-artifact" \
    "$@" "$message")" || ! address="$(jq -er '.address' <<<"$run_out")"; then
    stop_unconfirmed_launch "$session" "$run_out"
    return 1
  fi
  # 待ちは hc がテンプレートの起動で準備を待つ 60 秒に合わせる
  for i in $(seq 1 60); do
    if ! status="$(hc get "$address" --json | jq -r '.status.state // empty')" || ! turn_progress_after "$session" "$offset"; then
      reason="thread の claude（terminal ${address}）の状態か会話の記録を読めなかったので終わらせました。"
      break
    fi
    if [[ -n "$status" ]]; then notified=1; fi
    progress="$REPLY"
    if [[ "$progress" != none && -z "$received_at" ]]; then received_at="$i"; fi
    if [[ "$progress" == started ]]; then
      # 通知はメッセージの記録とほぼ同時に来るので、記録から少し待っても来なければ、この会話では来ないとみなす
      if [[ -n "$notified" ]] || ((i - received_at >= 5)); then break; fi
    elif [[ "$progress" == received ]] && ((i - received_at >= TURN_START_WAIT_SEC && i >= check_at)) &&
      screen="$(hc read "$address" --lines 0)" && input_box_holds "$screen" "$message"; then
      if ((resent >= TURN_RESEND_MAX)); then
        reason="thread の claude の最初のターンが、Enter で ${TURN_RESEND_MAX} 回送り直しても API に送られる前に取り消され、本文が入力欄に戻ったので終わらせました。"
        break
      fi
      if ! hc keys "$address" enter >/dev/null; then
        reason="thread の claude の最初のターンが API に送られる前に取り消され、入力欄に戻った本文を送り直せなかったので終わらせました。"
        break
      fi
      resent=$((resent + 1))
      echo "thread の claude の最初のターンが API に送られる前に取り消され、本文が入力欄に戻っていたので、Enter で送り直しました（${resent} 回目）。" >&2
      check_at=$((i + TURN_START_WAIT_SEC))
    fi
    sleep 1
  done
  # 失敗・警告の出力には coordinator の取るべき対応を書く。coordinator の prompt は「出力に書かれた対応に従う」とだけ持つ
  if [[ -z "$reason" && "$progress" == started ]]; then
    if ((resent > 0)); then
      echo "送り直した後にターンが始まったので、対応は要りません。" >&2
    fi
    if [[ -z "$notified" ]]; then
      echo "thread の claude は最初のメッセージを受け取って動いていますが、hc に状態を通知していません（この会話のあいだ通知しません）。許可の確認で止まっても hc は知らせず、sidebar の「Needs you」・macOS の通知にも出ず、一覧では最初の報告まで「未報告」と出ます。このことを user に 1 行で伝えてください（thread は動いているので、ほかの対応は要りません）。" >&2
    fi
    # skill の一覧はメッセージの後、API への送信の前に記録に書かれるので、ターンが始まった時点で読める
    if ! remember_thread_skill_names "$session" "$offset"; then
      echo "thread は動いていますが、会話の記録の skill の名前を ${THREAD_SKILL_NAMES_SEEN} に足せませんでした（足せないままだと、Claude Code の組み込みの skill が次の thread でも説明つきで載ります）。このことを user に 1 行で伝えてください（thread への対応は要りません）。" >&2
    fi
    printf '%s\n' "$address"
    return 0
  fi
  if [[ -z "$reason" && "$progress" == received ]]; then
    reason="thread の claude は最初のメッセージを受け取りましたが、起動後 60 秒たってもターンが始まらない（API への送信が会話の記録に入らない）ので終わらせました。"
  elif [[ -z "$reason" ]]; then
    reason="thread の claude が起動後 60 秒たっても、最初のメッセージが会話の記録に入っていないので終わらせました（信頼確認などのダイアログで止まっていた可能性があります）。"
  fi
  screen="$(hc read "$address" --lines 0)"
  hc kill "$address" >/dev/null
  echo "$reason 最後の画面:" >&2
  printf '%s\n' "$screen" >&2
  echo "thread の claude を起動できていません。上の理由と画面を user に見せて判断を仰いでください。同じコマンドを繰り返さないでください。" >&2
  return 1
}
