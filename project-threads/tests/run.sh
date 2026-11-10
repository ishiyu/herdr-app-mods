#!/usr/bin/env bash
# project-threads のテスト。bin/ のスクリプトは hc・claude・herdr-app を偽物（stubs/）に差し替えて、
# 渡した引数と書いたファイルを確かめる。一覧の状態の判定（state.js）は node のテストで確かめる。
#
# usage: tests/run.sh [名前の一部]   名前の一部を渡すと、bin/ のテストのうち名前に含むものだけを動かす
# shellcheck disable=SC1010  # done は report に渡す status で、シェルの done ではない
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(cd "$HERE/../bin" && pwd)"

# 1 件ごとに空の repo と偽物の状態を作る。テストは subshell で動かすので、失敗は exit 1 で返す
setup() {
  T="$(cd "$(mktemp -d)" && pwd -P)"
  trap 'rm -rf "$T"' EXIT
  export STUB_LOG="$T/log" STUB_STATE="$T/state"
  mkdir -p "$STUB_STATE"
  : > "$STUB_LOG"
  echo t900 > "$STUB_STATE/next-address"
  echo '{"spaces":[{"tabs":[{"terminals":[{"terminal":"t100","pane":"pOWN"}]}]}]}' > "$STUB_STATE/ls.json"
  REPO="$T/repo"
  git init -q "$REPO"
  PROJECT="$REPO/.local/hc-projects/demo"
  export PATH="$HERE/stubs:$PATH"
  # このテスト自体が hc の terminal の中で動いていても、その番号を拾わせない
  unset HC_TERMINAL_ID
}

ng() {
  echo "    NG: $*"
  exit 1
}
eq() { # <期待> <実際> <何の値か>
  [[ "$1" == "$2" ]] || ng "$3: 期待 [$1] 実際 [$2]"
}
logged() { # <記録の 1 行に含まれるはずの JSON の断片>
  grep -qF -- "$1" "$STUB_LOG" || ng "記録に無い: $1
$(cat "$STUB_LOG")"
}
not_logged() {
  ! grep -qF -- "$1" "$STUB_LOG" || ng "記録にある: $1
$(cat "$STUB_LOG")"
}
fails() { # <コマンド...>  失敗することを確かめ、stderr を $ERR に残す
  ERR="$("$@" 2>&1 >/dev/null)" && ng "成功してしまった: $*"
  return 0
}

open_project() {
  (cd "$REPO" && HC_TERMINAL_ID=t100 "$BIN/open" demo "$@")
}
# coordinator の claude が t100 の前面で動いている形にする
coordinator_alive() {
  jq -n --arg prompt "$PROJECT/coordinator-prompt.md" \
    '{address: "t100", state: "live", cwd: "/somewhere", foreground: {argv: ["claude", "--append-system-prompt-file", $prompt]}}' \
    > "$STUB_STATE/get-t100.json"
}
start_thread() {
  printf 'README を直す\n2 行目\n' > "$T/brief.md"
  HC_TERMINAL_ID=t100 "$BIN/start" "$PROJECT" "README の修正" "$T/brief.md" "$@"
}
# env VAR=値 <スクリプト> の形は使わない。スクリプトのパスに = があると（worktree のフォルダ名など）、env がパスまで代入と読む
report_as() { # <terminal> <report の引数...>
  HC_TERMINAL_ID="$1" "$BIN/report" "${@:2}"
}

# --- open

test_open_creates_project_and_starts_coordinator() {
  open_project 2>/dev/null
  eq "demo" "$(jq -r .name "$PROJECT/project.json")" "project.json の name"
  eq "t100" "$(jq -r .coordinator.terminal "$PROJECT/project.json")" "coordinator の terminal"
  eq "pLIST" "$(jq -r .listPane "$PROJECT/project.json")" "一覧の pane"
  grep -q '^# demo$' "$PROJECT/CLAUDE.md" || ng "CLAUDE.md に project の名前が無い"
  # @ の取り込みがあると、thread の claude が起動時に外部ファイルの許可の確認で止まる
  ! grep -q '^@' "$PROJECT/CLAUDE.md" || ng "CLAUDE.md がほかのファイルを @ で取り込んでいる"
  [[ -f "$PROJECT/memory/MEMORY.md" && -d "$PROJECT/threads" && -d "$PROJECT/drafts" ]] || ng "フォルダが足りない"
  grep -qF "$BIN/start $PROJECT" "$PROJECT/coordinator-prompt.md" || ng "prompt の {bin} と {project} が置き換わっていない"
  ! grep -q '{bin}\|{project}' "$PROJECT/coordinator-prompt.md" || ng "prompt に置き換え前の印が残っている"
  logged '"do","pane.split","--direction","right","--pane","pOWN","--mod","project-threads","--props","{\"project\":\"'"$PROJECT"'\"}"'
  logged '"do","pane.focus","--pane","pOWN"'
  not_logged '"pane.close"'
  eq "$PROJECT" "$(cat "$STUB_STATE/claude-cwd")" "claude の作業フォルダ"
  local args="$STUB_STATE/claude-args.json"
  eq "$PROJECT/coordinator-prompt.md" "$(jq -r '.[index("--append-system-prompt-file") + 1]' "$args")" "prompt のファイル"
  eq "project:demo" "$(jq -r '.[index("--name") + 1]' "$args")" "表示名"
  eq "auto" "$(jq -r '.[index("--permission-mode") + 1]' "$args")" "権限モード"
  eq "[\"Bash($BIN/start *)\",\"Bash($BIN/message *)\"]" "$(jq -r '.[index("--settings") + 1] | fromjson | .permissions.allow | tojson' "$args")" "許可リスト"
  eq "null" "$(jq -r 'index("--continue")' "$args")" "初回は --continue を付けない"
}

test_open_again_continues_and_replaces_list_pane() {
  open_project 2>/dev/null
  : > "$STUB_LOG"
  touch "$STUB_STATE/close-ok"
  open_project 2>/dev/null
  logged '"do","pane.close","--pane","pLIST"'
  logged '"do","pane.split"'
  [[ "$(jq -r 'index("--continue")' "$STUB_STATE/claude-args.json")" != "null" ]] || ng "2 回目に --continue が無い"
}

test_open_again_when_old_list_pane_is_gone() {
  open_project 2>/dev/null
  open_project 2>/dev/null
  eq "pLIST" "$(jq -r .listPane "$PROJECT/project.json")" "閉じられなくても一覧を開き直す"
}

test_open_new_does_not_continue() {
  open_project 2>/dev/null
  open_project --new 2>/dev/null
  eq "null" "$(jq -r 'index("--continue")' "$STUB_STATE/claude-args.json")" "--new は --continue を付けない"
}

test_open_without_own_pane_skips_list() {
  echo '{"spaces":[]}' > "$STUB_STATE/ls.json"
  open_project 2>/dev/null
  not_logged '"pane.split"'
  eq "null" "$(jq -r '.listPane' "$PROJECT/project.json")" "一覧の pane は記録しない"
  [[ -f "$STUB_STATE/claude-args.json" ]] || ng "一覧が無くても coordinator は起動する"
}

test_open_fails_outside_hc() {
  fails bash -c "cd '$REPO' && '$BIN/open' demo"
  [[ "$ERR" == *HC_TERMINAL_ID* ]] || ng "理由が出ていない: $ERR"
  [[ ! -e "$PROJECT" ]] || ng "失敗したのに project を作った"
}

test_open_rejects_bad_name() {
  fails open_project "Bad_Name"
  fails open_project demo --fresh
}

# --- start

test_start_launches_thread() {
  open_project 2>/dev/null
  local out
  out="$(start_thread)" || ng "start が失敗"
  eq "THREAD_ID=t001
TERMINAL=t900
DIR=$PROJECT/threads/t001" "$out" "start の出力"
  local dir="$PROJECT/threads/t001"
  eq "$(cat "$T/brief.md")" "$(cat "$dir/brief.md")" "brief.md"
  eq '{"id":"t001","title":"README の修正","model":"opus","sessionId":"aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb","terminal":"t900"}' \
    "$(jq -c 'del(.startedAt)' "$dir/thread.json")" "thread.json"
  [[ "$(jq -r .startedAt "$dir/thread.json")" =~ ^20[0-9-]+T[0-9:]+Z$ ]] || ng "startedAt の形"
  grep -qF "$BIN/report " "$dir/system-prompt.md" || ng "thread の prompt の {bin} が置き換わっていない"
  logged '"run","--bg","--json","--outlive-parent","--cwd","'"$dir"'","--","claude"'
  local argv="$STUB_STATE/get-t900.json"
  eq "opus" "$(jq -r '.foreground.argv | .[index("--model") + 1]' "$argv")" "モデル"
  eq "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb" "$(jq -r '.foreground.argv | .[index("--session-id") + 1]' "$argv")" "会話の id"
  eq "$dir/system-prompt.md" "$(jq -r '.foreground.argv | .[index("--append-system-prompt-file") + 1]' "$argv")" "prompt のファイル"
  eq "demo/t001 README の修正" "$(jq -r '.foreground.argv | .[index("--name") + 1]' "$argv")" "表示名"
  eq "[\"Bash($BIN/report *)\"]" "$(jq -r '.foreground.argv | .[index("--settings") + 1] | fromjson | .permissions.allow | tojson' "$argv")" "許可リスト"
  eq "$(cat "$T/brief.md")" "$(jq -r '.foreground.argv | last' "$argv")" "最初のメッセージは brief"
}

test_start_numbers_threads_in_order() {
  open_project 2>/dev/null
  start_thread >/dev/null
  echo t901 > "$STUB_STATE/next-address"
  eq "THREAD_ID=t002" "$(start_thread --model sonnet | head -n 1)" "2 本目の id"
  eq "sonnet" "$(jq -r .model "$PROJECT/threads/t002/thread.json")" "--model sonnet"
}

test_start_fails_when_claude_never_reports() {
  open_project 2>/dev/null
  touch "$STUB_STATE/run-dialog"
  fails start_thread
  [[ "$ERR" == *"TRUST DIALOG SCREEN"* ]] || ng "最後の画面が出ていない: $ERR"
  logged '"kill","t900"'
  [[ ! -e "$PROJECT/threads/t001" ]] || ng "起動できなかった thread のフォルダが残っている"
}

test_start_fails_when_hc_run_fails() {
  open_project 2>/dev/null
  touch "$STUB_STATE/run-fails"
  fails start_thread
  not_logged '"get"'
  [[ ! -e "$PROJECT/threads/t001" ]] || ng "起動できなかった thread のフォルダが残っている"
}

test_start_rejects_bad_input() {
  open_project 2>/dev/null
  : > "$T/empty.md"
  fails "$BIN/start" "$PROJECT" "題名" "$T/empty.md"
  fails "$BIN/start" "$PROJECT" "題名" "$T/missing.md"
  fails start_thread --model haiku
  fails "$BIN/start" "$T" "題名" "$T/empty.md"
  not_logged '"run"'
  [[ -z "$(ls "$PROJECT/threads")" ]] || ng "失敗したのに thread のフォルダを作った"
}

# --- message

test_message_sends_to_running_thread() {
  open_project 2>/dev/null
  start_thread >/dev/null
  : > "$STUB_LOG"
  "$BIN/message" "$PROJECT" t001 "案 1 で進めて" >/dev/null || ng "message が失敗"
  logged '["hc","send","t900","案 1 で進めて"]'
  logged '["hc","label","t900","report=","report.at="]'
  not_logged '"run"'
}

test_message_reads_text_from_file() {
  open_project 2>/dev/null
  start_thread >/dev/null
  printf '1 行目\n2 行目\n' > "$T/text.md"
  "$BIN/message" "$PROJECT" t001 --file "$T/text.md" >/dev/null || ng "message が失敗"
  logged '["hc","send","t900","1 行目\n2 行目"]'
}

test_message_resumes_stopped_thread() {
  open_project 2>/dev/null
  start_thread >/dev/null
  rm "$STUB_STATE/get-t900.json"
  echo t901 > "$STUB_STATE/next-address"
  : > "$STUB_LOG"
  "$BIN/message" "$PROJECT" t001 "続きをお願い" >/dev/null || ng "message が失敗"
  not_logged '"send"'
  eq "t901" "$(jq -r .terminal "$PROJECT/threads/t001/thread.json")" "thread.json の terminal"
  eq "README の修正" "$(jq -r .title "$PROJECT/threads/t001/thread.json")" "ほかの欄は残る"
  local argv="$STUB_STATE/get-t901.json"
  eq "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb" "$(jq -r '.foreground.argv | .[index("--resume") + 1]' "$argv")" "同じ会話を再開"
  eq "null" "$(jq -r '.foreground.argv | index("--session-id")' "$argv")" "再開では --session-id を付けない"
  eq "続きをお願い" "$(jq -r '.foreground.argv | last' "$argv")" "本文が最初のメッセージ"
  eq "$PROJECT/threads/t001" "$(jq -r .cwd "$argv")" "thread のフォルダで起動"
}

test_message_does_not_type_into_shell() {
  open_project 2>/dev/null
  start_thread >/dev/null
  # claude が終わって、同じ terminal にシェルが残った形
  jq '.foreground.argv = ["/bin/zsh", "-l"]' "$STUB_STATE/get-t900.json" > "$STUB_STATE/shell.json"
  cp "$STUB_STATE/shell.json" "$STUB_STATE/get-t900.json"
  echo t901 > "$STUB_STATE/next-address"
  : > "$STUB_LOG"
  "$BIN/message" "$PROJECT" t001 "rm -rf something" >/dev/null || ng "message が失敗"
  not_logged '"send"'
  eq "t901" "$(jq -r .terminal "$PROJECT/threads/t001/thread.json")" "新しい terminal で再開"
}

test_message_rejects_bad_input() {
  open_project 2>/dev/null
  start_thread >/dev/null
  : > "$STUB_LOG"
  fails "$BIN/message" "$PROJECT" t009 "本文"
  fails "$BIN/message" "$PROJECT" ../t001 "本文"
  fails "$BIN/message" "$PROJECT" t001 ""
  fails "$BIN/message" "$PROJECT" t001
  not_logged '"send"'
  not_logged '"run"'
}

# --- report

test_report_records_and_tells_coordinator() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001"
  echo "# 詳細" > "$T/detail.md"
  : > "$STUB_LOG"
  report_as t900 done "README を直した" --detail-file "$T/detail.md" >/dev/null || ng "report が失敗"
  eq '{"status":"done","summary":"README を直した"}' "$(jq -c 'del(.at)' "$dir/status.json")" "status.json"
  local at
  at="$(jq -r .at "$dir/status.json")"
  [[ "$at" =~ ^20[0-9-]+T[0-9:]+Z$ ]] || ng "at の形: $at"
  eq "# 詳細" "$(cat "$dir/report.md")" "report.md"
  logged '["hc","label","t900","report=done","report.at='"$at"'"]'
  logged '["hc","send","t100","[thread t001 done] README を直した (詳細: '"$dir"'/report.md)"]'
  [[ ! -e "$dir/status.json.tmp" ]] || ng "書きかけのファイルが残っている"
}

test_report_without_detail() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  report_as t900 needs-you "案を選んでほしい" >/dev/null || ng "report が失敗"
  logged '["hc","send","t100","[thread t001 needs-you] 案を選んでほしい"]'
  [[ ! -e "$PROJECT/threads/t001/report.md" ]] || ng "detail を渡していないのに report.md がある"
}

test_report_accepts_report_md_written_in_place() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001"
  echo "# 自分で書いた" > "$dir/report.md"
  (cd "$dir" && report_as t900 waiting "CI を待つ" --detail-file report.md >/dev/null) || ng "report が失敗"
  eq "# 自分で書いた" "$(cat "$dir/report.md")" "report.md はそのまま"
  logged '[thread t001 waiting] CI を待つ (詳細: '"$dir"'/report.md)'
}

test_report_keeps_record_when_coordinator_is_not_claude() {
  open_project 2>/dev/null
  start_thread >/dev/null
  # coordinator の claude が終わって、terminal にシェルが残った形
  echo '{"address":"t100","state":"live","foreground":{"argv":["/bin/zsh","-l"]}}' > "$STUB_STATE/get-t100.json"
  local out
  out="$(report_as t900 blocked "権限が無い")" || ng "記録だけでも成功で返す"
  [[ "$out" == *"送っていません"* ]] || ng "送らなかったことが出ていない: $out"
  not_logged '"send"'
  eq "blocked" "$(jq -r .status "$PROJECT/threads/t001/status.json")" "status.json"
  logged '"label","t900","report=blocked"'
}

test_report_keeps_record_when_coordinator_terminal_is_gone() {
  open_project 2>/dev/null
  start_thread >/dev/null
  report_as t900 done "終わった" >/dev/null || ng "記録だけでも成功で返す"
  not_logged '"send"'
  eq "done" "$(jq -r .status "$PROJECT/threads/t001/status.json")" "status.json"
}

test_report_fails_when_send_fails() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  touch "$STUB_STATE/send-fails"
  fails report_as t900 done "終わった"
  eq "done" "$(jq -r .status "$PROJECT/threads/t001/status.json")" "送れなくても記録は残る"
}

test_report_rejects_bad_input() {
  open_project 2>/dev/null
  start_thread >/dev/null
  : > "$STUB_LOG"
  fails report_as t900 finished "終わった"
  fails report_as t900 done ""
  fails report_as t900 done "終わった" --detail-file "$T/missing.md"
  fails "$BIN/report" done "終わった"
  [[ "$ERR" == *HC_TERMINAL_ID* ]] || ng "理由が出ていない: $ERR"
  # thread ではない terminal（coordinator）から呼んだ
  echo '{"address":"t100","state":"live","cwd":"'"$PROJECT"'"}' > "$STUB_STATE/get-t100.json"
  fails report_as t100 done "終わった"
  [[ ! -e "$PROJECT/threads/t001/status.json" ]] || ng "失敗したのに status.json を書いた"
  not_logged '"label"'
  not_logged '"send"'
}

# --- 実行

FAILED=0
COUNT=0
for name in $(declare -F | awk '{print $3}' | grep '^test_' | grep -- "${1:-}"); do
  COUNT=$((COUNT + 1))
  if (setup && "$name"); then
    echo "ok  $name"
  else
    echo "NG  $name"
    FAILED=$((FAILED + 1))
  fi
done
echo "bin: $COUNT 件中 $FAILED 件失敗"

node --test "$HERE/state.test.mjs" || FAILED=$((FAILED + 1))

[[ "$FAILED" -eq 0 ]]
