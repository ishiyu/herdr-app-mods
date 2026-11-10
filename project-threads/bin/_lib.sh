# open / start / message / report が source する共通の関数。単体では実行しない。
# shellcheck shell=bash

# {bin} と {project} を置き換えて prompt を書き出す。claude に渡すコマンドを絶対パスで示すため
render_prompt() { # <元のファイル> <書き出し先> <bin のフォルダ> <project のフォルダ>
  local text
  text="$(cat "$1")"
  text="${text//\{bin\}/$3}"
  text="${text//\{project\}/$4}"
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

# 会話の記録の、先頭から <バイト数> より後ろに、メッセージ（type が user の行）が書かれたか。
# --resume では既存の記録に追記され、メッセージより前にほかの行も書かれるので、大きさの増加では判定しない
message_recorded_after() { # <会話の id> <バイト数>
  local file
  file="$(transcript_of "$1")" || return 1
  tail -c "+$(($2 + 1))" "$file" | jq -Rne '[inputs | fromjson? | select(type == "object" and .type == "user")] | length > 0' >/dev/null
}

# thread の claude を hc の terminal で起動し、terminal の番号を stdout に返す。
# 最初のメッセージが届いたかは、hc の状態の通知か、会話の記録に入ったかで判定する。claude は起動時の問い合わせに
# terminal の返事が間に合わないと、その会話のあいだ通知を出さない（#8）ので、通知だけで判定すると動いている thread を捨てる。
# どちらも無ければ信頼確認などのダイアログで止まっているので、terminal を終わらせて失敗する。hc はこの止まり方を blocked として知らせない
launch_thread() { # <thread のフォルダ> <bin のフォルダ> <model> <表示名> <最初のメッセージ> <会話の id> <claude の追加引数...>
  local dir="$1" bin="$2" model="$3" display="$4" message="$5" session="$6"
  shift 6
  local settings address status screen transcript offset=0 recorded_at="" i
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
    claude --model "$model" --effort high --permission-mode auto --name "$display" \
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
