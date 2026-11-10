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

# thread の claude を hc の terminal で起動し、terminal の番号を stdout に返す。
# 起動後に状態を報告してこなければ、信頼確認などのダイアログで止まっている（最初のメッセージが届いていない）ので、
# terminal を終わらせて失敗する。hc はこの止まり方を blocked として知らせない
launch_thread() { # <thread のフォルダ> <bin のフォルダ> <model> <表示名> <最初のメッセージ> <claude の追加引数...>
  local dir="$1" bin="$2" model="$3" display="$4" message="$5"
  shift 5
  local settings address status screen
  settings="$(jq -nc --arg report "Bash($bin/report *)" '{permissions: {allow: [$report]}}')"
  # 呼び出し側が if や $(...) の中で呼ぶと set -e が効かないので、失敗は 1 つずつ return で返す。
  # --outlive-parent: hc の子は既定で親と一緒に終わる。coordinator を閉じても thread を残す
  address="$(hc run --bg --json --outlive-parent --cwd "$dir" -- \
    claude --model "$model" --effort high --permission-mode auto --name "$display" \
    --append-system-prompt-file "$dir/system-prompt.md" --settings "$settings" "$@" "$message" \
    | jq -er '.address')" || return 1
  for _ in $(seq 1 30); do
    status="$(hc get "$address" --json | jq -r '.status.state // empty')" || return 1
    if [[ -n "$status" ]]; then
      printf '%s\n' "$address"
      return 0
    fi
    sleep 1
  done
  screen="$(hc read "$address" --lines 0)"
  hc kill "$address" >/dev/null
  echo "thread の claude が起動後 30 秒たっても状態を報告しないので終わらせました（信頼確認などのダイアログで止まっていた可能性があります）。最後の画面:" >&2
  printf '%s\n' "$screen" >&2
  return 1
}
