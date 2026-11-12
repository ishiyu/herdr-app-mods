# open / start / message / report が source する共通の関数。単体では実行しない。
# shellcheck shell=bash

# {bin} と {project} と {rules} を置き換えて prompt を書き出す。claude に渡すコマンドとファイルを絶対パスで示すため。
# {rules} は全 project 共通の決まりのファイル（user が手で書く。無くてもよい）
render_prompt() { # <元のファイル> <書き出し先> <bin のフォルダ> <project のフォルダ>
  local text
  text="$(cat "$1")"
  text="${text//\{bin\}/$3}"
  text="${text//\{project\}/$4}"
  text="${text//\{rules\}/$HOME/.config/project-threads/rules.md}"
  printf '%s\n' "$text" > "$2"
}

# terminal の前面で、この prompt ファイルを渡された claude が動いているか。
# hc send は相手がシェルだと本文をコマンドとして実行させてしまうので、送る前に必ず確かめる。
# terminal が無い（再起動で消えた）のは普通に起きる状態なので、hc get の失敗も「動いていない」に数える
is_claude_with() { # <terminal> <prompt ファイル>
  local got
  got="$(hc get "$1" --json 2>/dev/null)" || return 1
  jq -e --arg prompt "$2" '
    .state == "live"
    and ((.foreground.argv[0] // "") | split("/") | last) == "claude"
    and ((.foreground.argv // []) | index($prompt) != null)
  ' <<<"$got" >/dev/null
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

# 送る前に Ctrl+S で書きかけを退避するかを決める。押すなら 0、押さないなら 1、hc が失敗したら 2 を返す。
# 入力欄が DRAFT_WAIT_SEC 秒変わらなければ、人が書きかけを置いたまま離れたとみて押す。人の最後の打鍵の時刻は hc から
# 取れないので、入力欄の変化で代える。空になれば（人が送ったか消した）押さない
draft_to_stash() { # <terminal>
  local terminal="$1" got screen last="" still=0 waited=0
  got="$(hc get "$terminal" --json)" || return 2
  [[ "$(jq -r '.status.state // empty' <<<"$got")" != "blocked" ]] || return 1
  while :; do
    screen="$(hc read "$terminal" --lines 0)" || return 2
    [[ "$screen" != *"› stashed"* ]] || return 1
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
#   - 退避が既にある（画面に「› stashed」）: 入力欄が空だと退避を取り出して本文に混ぜ、書きかけがあると前の退避を上書きして
#     失う。書きかけと混ざりうるが、hc send の待ちに任せる
#   - blocked（許可の確認など）: hc send が断るので送らずに失敗する。ダイアログにキーを送らない
#   - 入力欄が画面に見えない、または DRAFT_GIVE_UP_SEC 秒たっても変わり続ける: hc send の待ちに任せる
# 押した後に hc send が失敗しても、書きかけは退避に残り、user の次の送信の後に入力欄へ戻る（画面には「› stashed」と出る）
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

# トークン数を claude の statusline と同じ丸めで書く（150k、94.4k、901）。state.js の contextLabel と揃える
format_tokens() { # <トークン数>
  jq -nr --argjson t "$1" 'if $t >= 100000 then "\($t / 1000 | round)k" elif $t >= 1000 then "\($t / 100 | round / 10)k" else "\($t)" end'
}

# 会話の記録の、先頭から <バイト数> より後ろに、メッセージ（type が user の行）が書かれたか。
# --resume では既存の記録に追記され、メッセージより前にほかの行も書かれるので、大きさの増加では判定しない
message_recorded_after() { # <会話の id> <バイト数>
  local file
  file="$(transcript_of "$1")" || return 1
  tail -c "+$(($2 + 1))" "$file" | jq -Rne '[inputs | fromjson? | select(type == "object" and .type == "user")] | length > 0' >/dev/null
}

# thread の claude に渡す effort（reasoning effort）。model ごとに決めた組で、start も message の再開も同じ値を使う。
# claude は --resume で effort を引き継がない（渡さないと既定に戻る）ので、再開のたびに渡す
thread_effort() { # <model>
  case "$1" in
    opus) echo xhigh ;;
    sonnet) echo high ;;
    *)
      echo "thread の effort を決められない model です: $1" >&2
      return 1
      ;;
  esac
}

# thread の claude を hc の terminal で起動し、terminal の番号を stdout に返す。
# 最初のメッセージが届いたかは、hc の状態の通知か、会話の記録に入ったかで判定する。claude は起動時の問い合わせに
# terminal の返事が間に合わないと、その会話のあいだ通知を出さない（#8）ので、通知だけで判定すると動いている thread を捨てる。
# どちらも無ければ信頼確認などのダイアログで止まっているので、terminal を終わらせて失敗する。hc はこの止まり方を blocked として知らせない
launch_thread() { # <thread のフォルダ> <bin のフォルダ> <model> <表示名> <最初のメッセージ> <会話の id> <claude の追加引数...>
  local dir="$1" bin="$2" model="$3" display="$4" message="$5" session="$6"
  shift 6
  local settings address status screen transcript offset=0 recorded_at="" i effort
  effort="$(thread_effort "$model")" || return 1
  # 入力を受けた時点で前の報告は済んだことになるので、terminal の報告のラベルを消す。消さないと、user が thread の
  # 画面に直接答えて、thread が報告せずにターンを終えたとき、一覧が前の報告の見出しと要約を出したままになる。
  # hook の stdout は claude への入力に足されるので捨てる
  settings="$(jq -nc --arg report "Bash($bin/report *)" \
    --arg clear 'hc label "$HC_TERMINAL_ID" report= report.at= >/dev/null' \
    '{permissions: {allow: [$report]}, hooks: {UserPromptSubmit: [{hooks: [{type: "command", command: $clear}]}]}}')"
  # --resume では記録に追記されるので、起動前の大きさより後ろだけを見る
  if transcript="$(transcript_of "$session")"; then
    offset="$(wc -c < "$transcript" | tr -d ' ')"
  fi
  # 呼び出し側が if や $(...) の中で呼ぶと set -e が効かないので、失敗は 1 つずつ return で返す。
  # --outlive-parent: hc の子は既定で親と一緒に終わる。coordinator を閉じても thread を残す
  address="$(hc run --bg --json --outlive-parent --cwd "$dir" -- \
    claude --model "$model" --effort "$effort" --permission-mode auto --name "$display" \
    --append-system-prompt-file "$dir/system-prompt.md" --settings "$settings" "$@" "$message" \
    | jq -er '.address')" || return 1
  # 待ちは hc がテンプレートの起動で準備を待つ 60 秒に合わせる
  for i in $(seq 1 60); do
    status="$(hc get "$address" --json | jq -r '.status.state // empty')" || return 1
    if [[ -n "$status" ]]; then
      printf '%s\n' "$address"
      return 0
    fi
    if [[ -z "$recorded_at" ]] && message_recorded_after "$session" "$offset"; then
      recorded_at="$i"
    fi
    # 通知は記録とほぼ同時に来るので、少し待っても来なければ、この会話では来ないとみなす
    if [[ -n "$recorded_at" && $((i - recorded_at)) -ge 5 ]]; then
      break
    fi
    sleep 1
  done
  if [[ -n "$recorded_at" ]]; then
    echo "thread の claude は最初のメッセージを受け取って動いていますが、hc に状態を通知していません（この会話のあいだ通知しません）。許可の確認で止まっても hc は知らせず、sidebar の「Needs you」・macOS の通知にも出ず、一覧では最初の報告まで「未報告」と出ます。" >&2
    printf '%s\n' "$address"
    return 0
  fi
  screen="$(hc read "$address" --lines 0)"
  hc kill "$address" >/dev/null
  echo "thread の claude が起動後 60 秒たっても、状態の通知も無く、最初のメッセージも会話の記録に入っていないので終わらせました（信頼確認などのダイアログで止まっていた可能性があります）。最後の画面:" >&2
  printf '%s\n' "$screen" >&2
  return 1
}
