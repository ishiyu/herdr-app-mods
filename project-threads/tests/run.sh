#!/usr/bin/env bash
# project-threads のテスト。bin/ のスクリプトは hc・claude・herdr-app・gh を偽物（stubs/）に差し替えて、
# 渡した引数と書いたファイルを確かめる。cleanup の git は本物を一時フォルダの repo に対して動かす。一覧の状態の判定（state.js）は node のテストで確かめる。
#
# usage: tests/run.sh [名前の一部]   名前の一部を渡すと、bin/ のテストのうち名前に含むものだけを動かす
# shellcheck disable=SC1010  # done は report に渡す status で、シェルの done ではない
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$(cd "$HERE/../bin" && pwd)"

# 偽物の hc・gh・herdr-app・uuidgen・sleep は関数として export し、bin/ のスクリプトに PATH より先に使わせる。
# テストは Microsoft Defender などの検査を受け、新しいプロセスの起動が重い。偽物は全件で数千回呼ばれるので、
# スクリプトとして起動すると、そのたびに env・bash と記録用の jq が起動する。claude は open が exec するのでスクリプトのまま
# shellcheck source=stubs/_lib.sh
source "$HERE/stubs/_lib.sh"
for stub in hc gh herdr-app uuidgen sleep; do
  # shellcheck source=/dev/null
  source "$HERE/stubs/$stub"
done
export -f stub_json_array stub_json_string stub_log stub_cat hc gh herdr-app uuidgen sleep

# 1 件ごとに空の repo と偽物の状態を作る。テストは subshell で動かすので、失敗は exit 1 で返す
setup() {
  T="$(cd "$(mktemp -d)" && pwd -P)"
  trap 'rm -rf "$T"' EXIT
  export STUB_LOG="$T/log" STUB_STATE="$T/state"
  mkdir -p "$STUB_STATE"
  : > "$STUB_LOG"
  # 偽物は記録をこの fd に足す。呼ばれるたびにファイルを開いて閉じると、閉じるたびに検査される
  exec 9>>"$STUB_LOG"
  export STUB_LOG_FD9=1
  echo t900 > "$STUB_STATE/next-address"
  echo '{"spaces":[{"tabs":[{"terminals":[{"terminal":"t100","pane":"pOWN"}]}]}]}' > "$STUB_STATE/ls.json"
  REPO="$T/repo"
  # テンプレート（hooks の見本など十数個のファイル）は使わないので写さない。open は repo の最上位を知るだけ
  git init -q --template= "$REPO"
  PROJECT="$REPO/.local/hc-projects/demo"
  export PATH="$HERE/stubs:$PATH"
  # このテスト自体が hc の terminal の中で動いていても、その番号を拾わせない
  unset HC_TERMINAL_ID
  # 会話の記録は手元の claude のものを読ませない
  export CLAUDE_CONFIG_DIR="$T/claude-config"
  # cleanup が消す Claude の一時フォルダ（scratchpad など）は、本物の /tmp/claude-<uid> ではなくここで探させる
  export CLAUDE_CODE_TMPDIR="$T/tmp"
}

ng() {
  echo "    NG: $*"
  exit 1
}
eq() { # <期待> <実際> <何の値か>
  [[ "$1" == "$2" ]] || ng "$3: 期待 [$1] 実際 [$2]"
}
# 記録に断片があるか。grep を起動せずに読む。断片は改行を含まないので、1 行の中にあるかと同じ
log_has() { # <断片>
  local text=""
  IFS= read -rd '' text < "$STUB_LOG" || true
  [[ "$text" == *"$1"* ]]
}
logged() { # <記録の 1 行に含まれるはずの JSON の断片>
  log_has "$1" || ng "記録に無い: $1
$(cat "$STUB_LOG")"
}
not_logged() {
  ! log_has "$1" || ng "記録にある: $1
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
  ! grep -q '{bin}\|{project}\|{rules}' "$PROJECT/coordinator-prompt.md" || ng "prompt に置き換え前の印が残っている"
  grep -qF "$HOME/.config/project-threads/rules.md" "$PROJECT/coordinator-prompt.md" || ng "prompt に全 project 共通の決まりのファイルが無い"
  cmp -s "$BIN/../templates/repo-rules.md" "$REPO/.local/hc-projects/repo-rules.md" || ng "repo 固有の決まりの雛形を置いていない"
  grep -qF "$BIN/umbrella $PROJECT" "$PROJECT/coordinator-prompt.md" || ng "prompt に umbrella の登録が無い"
  grep -qF "$BIN/next-actions $PROJECT" "$PROJECT/coordinator-prompt.md" || ng "prompt に next-actions が無い"
  logged '"do","pane.split","--direction","right","--pane","pOWN","--mod","project-threads","--props","{\"project\":\"'"$PROJECT"'\"}"'
  logged '"do","pane.focus","--pane","pOWN"'
  not_logged '"pane.close"'
  eq "$PROJECT" "$(cat "$STUB_STATE/claude-cwd")" "claude の作業フォルダ"
  local args="$STUB_STATE/claude-args.json"
  eq "$PROJECT/coordinator-prompt.md" "$(jq -r '.[index("--append-system-prompt-file") + 1]' "$args")" "prompt のファイル"
  eq "project:demo" "$(jq -r '.[index("--name") + 1]' "$args")" "表示名"
  eq "auto" "$(jq -r '.[index("--permission-mode") + 1]' "$args")" "権限モード"
  eq "[\"Bash($BIN/start *)\",\"Bash($BIN/message *)\",\"Bash($BIN/relay *)\",\"Bash($BIN/cleanup *)\",\"Bash($BIN/handoff *)\",\"Bash($BIN/umbrella *)\",\"Bash($BIN/next-actions *)\"]" "$(jq -r '.[index("--settings") + 1] | fromjson | .permissions.allow | tojson' "$args")" "許可リスト"
  eq "null" "$(jq -r 'index("--continue")' "$args")" "初回は --continue を付けない"
  eq "$(cd "$BIN/.." && pwd)/plugin" "$(jq -r '.[index("--plugin-dir") + 1]' "$args")" "/pj-threads:handoff の plugin"
}

# repo 固有の決まりは同じ repo のほかの project と共有するので、新しい project を作っても書き換えない
test_open_keeps_existing_repo_rules() {
  mkdir -p "$REPO/.local/hc-projects"
  echo "user が書いた" > "$REPO/.local/hc-projects/repo-rules.md"
  open_project 2>/dev/null
  eq "user が書いた" "$(cat "$REPO/.local/hc-projects/repo-rules.md")" "既にある repo-rules.md"
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
  eq '{"id":"t001","title":"README の修正","model":"opus","effort":"xhigh","sessionId":"aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb","terminal":"t900"}' \
    "$(jq -c 'del(.startedAt)' "$dir/thread.json")" "thread.json"
  [[ "$(jq -r .startedAt "$dir/thread.json")" =~ ^20[0-9-]+T[0-9:]+Z$ ]] || ng "startedAt の形"
  grep -qF "$BIN/report " "$dir/system-prompt.md" || ng "thread の prompt の {bin} が置き換わっていない"
  grep -qF "$HOME/.config/project-threads/rules.md" "$dir/system-prompt.md" || ng "thread の prompt の {rules} が置き換わっていない"
  logged '"run","--bg","--json","--outlive-parent","--cwd","'"$dir"'","--","claude"'
  local argv="$STUB_STATE/get-t900.json"
  eq "opus" "$(jq -r '.foreground.argv | .[index("--model") + 1]' "$argv")" "モデル"
  eq "xhigh" "$(jq -r '.foreground.argv | .[index("--effort") + 1]' "$argv")" "opus の effort"
  eq "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb" "$(jq -r '.foreground.argv | .[index("--session-id") + 1]' "$argv")" "会話の id"
  eq "$dir/system-prompt.md" "$(jq -r '.foreground.argv | .[index("--append-system-prompt-file") + 1]' "$argv")" "prompt のファイル"
  eq "demo/t001 README の修正" "$(jq -r '.foreground.argv | .[index("--name") + 1]' "$argv")" "表示名"
  eq "[\"Bash($BIN/report *)\"]" "$(jq -r '.foreground.argv | .[index("--settings") + 1] | fromjson | .permissions.allow | tojson' "$argv")" "許可リスト"
  eq "$(cat "$T/brief.md")" "$(jq -r '.foreground.argv | last' "$argv")" "最初のメッセージは brief"
}

# user が thread の画面に直接入力しても（bin/message を通らなくても）、前の報告のラベルが残らない
test_start_clears_report_label_on_each_prompt() {
  open_project 2>/dev/null
  start_thread >/dev/null
  local hooks
  hooks="$(jq -r '.foreground.argv | .[index("--settings") + 1] | fromjson | .hooks.UserPromptSubmit' "$STUB_STATE/get-t900.json")"
  eq "1" "$(jq -r 'length' <<<"$hooks")" "UserPromptSubmit の hook の数"
  : > "$STUB_LOG"
  # claude が hook を動かすときと同じく、thread の terminal の環境でシェルに渡す
  local out
  out="$(HC_TERMINAL_ID=t900 bash -c "$(jq -r '.[0].hooks[0].command' <<<"$hooks")")" || ng "hook のコマンドが失敗"
  logged '["hc","label","t900","report=","report.at="]'
  # stdout は claude への入力に足されるので、何も出さない
  eq "" "$out" "hook の stdout"
}

test_start_numbers_threads_in_order() {
  open_project 2>/dev/null
  start_thread >/dev/null
  echo t901 > "$STUB_STATE/next-address"
  eq "THREAD_ID=t002" "$(start_thread --model sonnet | head -n 1)" "2 本目の id"
  eq "sonnet" "$(jq -r .model "$PROJECT/threads/t002/thread.json")" "--model sonnet"
}

test_start_sonnet_uses_high_effort() {
  open_project 2>/dev/null
  start_thread --model sonnet >/dev/null || ng "start が失敗"
  local argv="$STUB_STATE/get-t900.json"
  eq "sonnet" "$(jq -r '.foreground.argv | .[index("--model") + 1]' "$argv")" "モデル"
  eq "high" "$(jq -r '.foreground.argv | .[index("--effort") + 1]' "$argv")" "sonnet の effort"
  eq "high" "$(jq -r .effort "$PROJECT/threads/t001/thread.json")" "thread.json の effort"
}

test_start_fails_when_claude_never_reports() {
  open_project 2>/dev/null
  touch "$STUB_STATE/run-dialog"
  fails start_thread
  [[ "$ERR" == *"TRUST DIALOG SCREEN"* ]] || ng "最後の画面が出ていない: $ERR"
  logged '"kill","t900"'
  [[ ! -e "$PROJECT/threads/t001" ]] || ng "起動できなかった thread のフォルダが残っている"
}

test_start_keeps_thread_that_does_not_notify() {
  open_project 2>/dev/null
  touch "$STUB_STATE/run-silent"
  local out
  out="$(start_thread 2>"$T/err")" || ng "start が失敗: $(cat "$T/err")"
  eq "THREAD_ID=t001" "$(head -n 1 <<<"$out")" "start の出力"
  grep -q "hc に状態を通知していません" "$T/err" || ng "通知しないことの警告が無い: $(cat "$T/err")"
  not_logged '"kill"'
  [[ -f "$PROJECT/threads/t001/thread.json" ]] || ng "thread.json が無い"
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
  : > "$STUB_LOG"
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
  eq "xhigh" "$(jq -r '.foreground.argv | .[index("--effort") + 1]' "$argv")" "再開でも effort を渡す"
}

# claude は --resume で effort を引き継がないので、再開のたびに model の組の effort で起こし、thread.json に残す。
# 組を変える前に起動した thread（thread.json に effort が無い）も同じ
test_message_resumes_with_effort_of_model() {
  open_project 2>/dev/null
  start_thread --model sonnet >/dev/null
  local updated
  updated="$(jq 'del(.effort)' "$PROJECT/threads/t001/thread.json")"
  printf '%s\n' "$updated" > "$PROJECT/threads/t001/thread.json"
  rm "$STUB_STATE/get-t900.json"
  echo t901 > "$STUB_STATE/next-address"
  "$BIN/message" "$PROJECT" t001 "続きをお願い" >/dev/null || ng "message が失敗"
  local argv="$STUB_STATE/get-t901.json"
  eq "sonnet" "$(jq -r '.foreground.argv | .[index("--model") + 1]' "$argv")" "モデル"
  eq "high" "$(jq -r '.foreground.argv | .[index("--effort") + 1]' "$argv")" "sonnet の effort"
  eq "high" "$(jq -r .effort "$PROJECT/threads/t001/thread.json")" "thread.json の effort"
}

test_message_resumes_thread_that_does_not_notify() {
  open_project 2>/dev/null
  start_thread >/dev/null
  rm "$STUB_STATE/get-t900.json"
  echo t901 > "$STUB_STATE/next-address"
  touch "$STUB_STATE/run-silent"
  "$BIN/message" "$PROJECT" t001 "続きをお願い" >/dev/null 2>"$T/err" || ng "message が失敗: $(cat "$T/err")"
  grep -q "hc に状態を通知していません" "$T/err" || ng "通知しないことの警告が無い: $(cat "$T/err")"
  eq "t901" "$(jq -r .terminal "$PROJECT/threads/t001/thread.json")" "thread.json の terminal"
}

test_message_fails_when_resumed_thread_stops_at_dialog() {
  open_project 2>/dev/null
  touch "$STUB_STATE/run-silent"
  start_thread >/dev/null 2>&1
  # 前の会話の記録にあるメッセージを、再開で届いたものと数えない
  rm "$STUB_STATE/run-silent" "$STUB_STATE/get-t900.json"
  touch "$STUB_STATE/run-dialog"
  echo t901 > "$STUB_STATE/next-address"
  : > "$STUB_LOG"
  fails "$BIN/message" "$PROJECT" t001 "続きをお願い"
  [[ "$ERR" == *"TRUST DIALOG SCREEN"* ]] || ng "最後の画面が出ていない: $ERR"
  logged '"kill","t901"'
  eq "t900" "$(jq -r .terminal "$PROJECT/threads/t001/thread.json")" "失敗したら thread.json を書き換えない"
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
  local at detail
  at="$(jq -r .at "$dir/status.json")"
  [[ "$at" =~ ^20[0-9-]+T[0-9:]+Z$ ]] || ng "at の形: $at"
  # 写しの名前は報告の時刻と status
  detail="$dir/reports/${at//[-:]/}-done.md"
  eq '{"status":"done","summary":"README を直した","detail":"'"$detail"'"}' "$(jq -c 'del(.at)' "$dir/status.json")" "status.json"
  eq "# 詳細" "$(cat "$detail")" "詳細の写し"
  [[ ! -e "$dir/report.md" ]] || ng "渡していない report.md を作った"
  logged '["hc","label","t900","report=done","report.at='"$at"'"]'
  logged '["hc","send","t100","[thread t001 done] README を直した (詳細: '"$detail"')"]'
  [[ ! -e "$dir/status.json.tmp" ]] || ng "書きかけのファイルが残っている"
}

test_report_without_detail() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001"
  # 前の報告の詳細が残っていても、この報告の詳細としては指さない
  echo "# 前の報告" > "$dir/report.md"
  report_as t900 needs-you "案を選んでほしい" >/dev/null || ng "report が失敗"
  logged '["hc","send","t100","[thread t001 needs-you] 案を選んでほしい"]'
  eq "null" "$(jq -r .detail "$dir/status.json")" "status.json に詳細が無い"
  [[ ! -e "$dir/reports" ]] || ng "detail を渡していないのに写しがある"
}

# hc send は入力欄の今の中身の後ろに貼り付けて Enter を押すので、user の書きかけと報告が 1 つの入力で送られていた。
# 送る前に claude の Ctrl+S で書きかけを退避する（送信の後に claude が入力欄へ戻す）
test_report_stashes_draft_before_sending() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  : > "$STUB_LOG"
  report_as t900 done "直した" >/dev/null || ng "report が失敗"
  logged '["hc","keys","t100","ctrl+s"]'
  [[ "$(line_of '["hc","keys","t100","ctrl+s"]')" -lt "$(line_of '["hc","send","t100"')" ]] || ng "送った後に退避した"
}

# 退避が既にあると、Ctrl+S は空の入力欄に退避を取り出して報告に混ぜるか、前の退避を書きかけで上書きして失う
test_send_keeps_existing_stash() {
  open_project 2>/dev/null
  start_thread >/dev/null
  printf '❯ \n                                                  › stashed\n' > "$STUB_STATE/read-screen"
  : > "$STUB_LOG"
  "$BIN/message" "$PROJECT" t001 "案 1 で進めて" >/dev/null || ng "message が失敗"
  not_logged '"keys"'
  logged '["hc","send","t900","案 1 で進めて"]'
}

# 許可の確認などで止まっている間は、ダイアログにキーを送らない（hc send が断る）
test_send_does_not_press_keys_while_blocked() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local got
  got="$(jq '.status = {app: "claude-code", state: "blocked"}' "$STUB_STATE/get-t100.json")"
  printf '%s\n' "$got" > "$STUB_STATE/get-t100.json"
  : > "$STUB_LOG"
  report_as t900 done "直した" >/dev/null || ng "report が失敗"
  not_logged '"keys"'
}

test_report_accepts_report_md_written_in_place() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001"
  echo "# 自分で書いた" > "$dir/report.md"
  (cd "$dir" && report_as t900 waiting "CI を待つ" --detail-file report.md --within 20 >/dev/null) || ng "report が失敗"
  eq "# 自分で書いた" "$(cat "$dir/report.md")" "report.md はそのまま"
  local clock
  clock="$(jq -r '.expectedAt | fromdateiso8601 | strflocaltime("%H:%M")' "$dir/status.json")"
  local detail
  detail="$(jq -r .detail "$dir/status.json")"
  eq "# 自分で書いた" "$(cat "$detail")" "写しは渡した report.md の内容"
  logged '[thread t001 waiting] CI を待つ (完了見込み: '"$clock"'、詳細: '"$detail"')'
}

# coordinator に最後に送った報告の、詳細のパス
last_detail() {
  local line
  line="$(jq -r 'select(.[0] == "hc" and .[1] == "send" and .[2] == "t100") | .[3]' "$STUB_LOG" | tail -n 1)"
  [[ "$line" == *"詳細: "* ]] || ng "報告に詳細のパスが無い: $line"
  line="${line##*詳細: }"
  printf '%s\n' "${line%)}"
}

# pc-slow の t001 は、report.md に節を積み上げたあと、途中経過を別のファイルで報告して 1〜20 節を失った
test_report_keeps_earlier_reports() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001" first second third first_status second_status third_status
  echo "# 1 節" > "$dir/report.md"
  (cd "$dir" && report_as t900 done "1 節を終えた" --detail-file report.md >/dev/null) || ng "1 回目の report が失敗"
  first="$(last_detail)"
  first_status="$(jq -r .detail "$dir/status.json")"
  "$BIN/message" "$PROJECT" t001 "続きをお願い" >/dev/null || ng "message が失敗"
  echo "# 途中経過" > "$dir/waiting.md"
  (cd "$dir" && report_as t900 waiting "CI を待つ" --within 20 --detail-file waiting.md >/dev/null) || ng "2 回目の report が失敗"
  second="$(last_detail)"
  second_status="$(jq -r .detail "$dir/status.json")"
  printf '# 1 節\n# 2 節\n' > "$dir/report.md"
  (cd "$dir" && report_as t900 done "2 節を終えた" --detail-file report.md >/dev/null) || ng "3 回目の report が失敗"
  third="$(last_detail)"
  third_status="$(jq -r .detail "$dir/status.json")"
  eq "# 1 節" "$(cat "$first")" "1 回目の詳細"
  eq "# 途中経過" "$(cat "$second")" "2 回目の詳細"
  eq "$(printf '# 1 節\n# 2 節')" "$(cat "$third")" "3 回目の詳細"
  eq "$(printf '# 1 節\n# 2 節')" "$(cat "$dir/report.md")" "report.md は thread が書いたまま"
  eq "$first" "$first_status" "1 回目の status.json の詳細"
  eq "$second" "$second_status" "2 回目の status.json の詳細"
  eq "$third" "$third_status" "3 回目の status.json の詳細"
}

test_report_keeps_reports_in_same_second() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001" first second
  echo "# 1 回目" > "$T/one.md"
  echo "# 2 回目" > "$T/two.md"
  report_as t900 done "1 回目" --detail-file "$T/one.md" >/dev/null || ng "1 回目の report が失敗"
  first="$(last_detail)"
  # 2 回目が秒をまたいでも名前がぶつかるよう、この先 3 秒の名前を先に埋めておく
  local now s name
  now="$(date +%s)"
  for s in 0 1 2; do
    name="$dir/reports/$(date -u -r $((now + s)) +%Y%m%dT%H%M%SZ)-done.md"
    [[ -e "$name" ]] || echo "# 埋めた" > "$name"
  done
  report_as t900 done "2 回目" --detail-file "$T/two.md" >/dev/null || ng "2 回目の report が失敗"
  second="$(last_detail)"
  [[ "$second" == *-done-[0-9].md ]] || ng "名前がぶつかったときの写しの名前: $second"
  eq "# 1 回目" "$(cat "$first")" "1 回目の詳細"
  eq "# 2 回目" "$(cat "$second")" "2 回目の詳細"
}

test_report_waiting_records_expected_time() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001" before after expected
  before="$(date +%s)"
  report_as t900 waiting "deploy を待つ" --within 30 >/dev/null || ng "report が失敗"
  after="$(date +%s)"
  expected="$(jq -r '.expectedAt | fromdateiso8601' "$dir/status.json")"
  [[ "$expected" -ge $((before + 1800)) && "$expected" -le $((after + 1800)) ]] || ng "expectedAt が 30 分後でない: $(cat "$dir/status.json")"
  logged '[thread t001 waiting] deploy を待つ (完了見込み: '
}

test_report_rejects_bad_within() {
  open_project 2>/dev/null
  start_thread >/dev/null
  : > "$STUB_LOG"
  # waiting には必須、ほかの status には付けられない
  fails report_as t900 waiting "CI を待つ"
  [[ "$ERR" == *"--within"* ]] || ng "理由が出ていない: $ERR"
  fails report_as t900 waiting "CI を待つ" --within 0
  fails report_as t900 waiting "CI を待つ" --within 1.5
  fails report_as t900 waiting "CI を待つ" --within
  fails report_as t900 done "終わった" --within 10
  [[ ! -e "$PROJECT/threads/t001/status.json" ]] || ng "失敗したのに status.json を書いた"
  not_logged '"label"'
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

# thread の会話の記録に、assistant の行を書き足す。値は usage の入力側の 3 項目（和が context の大きさ）
assistant_line() { # <input> <cache_creation> <cache_read> [<isSidechain>]
  local session
  session="$(jq -r .sessionId "$PROJECT/threads/t001/thread.json")"
  mkdir -p "$CLAUDE_CONFIG_DIR/projects/stub"
  printf '{"type":"assistant","isSidechain":%s,"message":{"model":"claude-opus-5-5","usage":{"input_tokens":%s,"cache_creation_input_tokens":%s,"cache_read_input_tokens":%s,"output_tokens":300}}}\n' \
    "${4:-false}" "$1" "$2" "$3" >> "$CLAUDE_CONFIG_DIR/projects/stub/$session.jsonl"
}

test_report_records_context_tokens() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001" session
  session="$(jq -r .sessionId "$dir/thread.json")"
  assistant_line 2 1000 50000
  # assistant の行の後ろに、ほかの種類の行や subagent の行が続いても、本体の会話の最後の assistant の行を使う
  assistant_line 2 35031 114809
  printf '{"type":"user","message":{"role":"user","content":"%s"}}\n' "$(printf 'x%.0s' {1..3000})" \
    >> "$CLAUDE_CONFIG_DIR/projects/stub/$session.jsonl"
  assistant_line 5 500000 0 true
  echo "# 詳細" > "$T/detail.md"
  : > "$STUB_LOG"
  report_as t900 done "README を直した" --detail-file "$T/detail.md" >/dev/null 2>"$T/err" || ng "report が失敗"
  eq "149842" "$(jq -r .contextTokens "$dir/status.json")" "status.json の contextTokens"
  logged '["hc","send","t100","[thread t001 done] README を直した (context 150k、詳細: '"$(jq -r .detail "$dir/status.json")"')"]'
  eq "" "$(cat "$T/err")" "stderr"
}

test_report_context_tokens_format() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  assistant_line 2 3061 91309
  report_as t900 waiting "CI を待つ" --within 20 >/dev/null || ng "report が失敗"
  local clock
  clock="$(jq -r '.expectedAt | fromdateiso8601 | strflocaltime("%H:%M")' "$PROJECT/threads/t001/status.json")"
  logged '[thread t001 waiting] CI を待つ (context 94.4k、完了見込み: '"$clock"')'
  assistant_line 1 400 500
  report_as t900 done "終わった" >/dev/null || ng "report が失敗"
  logged '[thread t001 done] 終わった (context 901)'
}

# 会話の記録が無い・読めないときは、context の大きさを付けずに報告を通す（報告が coordinator に届かなくなるほうが困る）
test_report_without_context_tokens() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  local dir="$PROJECT/threads/t001" session
  session="$(jq -r .sessionId "$dir/thread.json")"
  report_as t900 done "記録が無い" >/dev/null 2>"$T/err" || ng "記録が無いと report が失敗"
  eq "null" "$(jq -r .contextTokens "$dir/status.json")" "記録が無いときの contextTokens"
  logged '["hc","send","t100","[thread t001 done] 記録が無い"]'
  [[ "$(cat "$T/err")" == *"context の大きさを取れませんでした"* ]] || ng "取れなかったことが出ていない: $(cat "$T/err")"
  # 形式が変わって usage が無い
  mkdir -p "$CLAUDE_CONFIG_DIR/projects/stub"
  echo '{"type":"assistant","message":{"model":"claude-opus-5-5"}}' > "$CLAUDE_CONFIG_DIR/projects/stub/$session.jsonl"
  report_as t900 done "usage が無い" >/dev/null 2>/dev/null || ng "usage が無いと report が失敗"
  eq "null" "$(jq -r .contextTokens "$dir/status.json")" "usage が無いときの contextTokens"
  logged '["hc","send","t100","[thread t001 done] usage が無い"]'
}

# --- cleanup

# 仕事の repo（main に 1 コミット）に、thread が作った形の worktree（ブランチ tmp/<slug>）を作ってパスを返す
git_q() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"; }
make_worktree() { # <slug>
  if [[ ! -d "$T/work" ]]; then
    git init -q --template= -b main "$T/work"
    git_q -C "$T/work" commit -q --allow-empty -m init
  fi
  git -C "$T/work" worktree add -q "$T/work=tmp-$1" -b "tmp/$1" main
  echo "$T/work=tmp-$1"
}
commit_in() { # <path>
  git_q -C "$1" commit -q --allow-empty -m "作業"
}
# thread を起動して done を報告させ、claude が入力待ちに戻った形にする。worktree を渡せば worktrees.txt に記録する
done_thread() { # <terminal> [<worktree>...]
  echo "$1" > "$STUB_STATE/next-address"
  local id
  id="$(start_thread | head -n 1)"
  id="${id#THREAD_ID=}"
  report_as "$1" done "終わった" >/dev/null
  set_status "$1" idle
  if [[ $# -gt 1 ]]; then printf '%s\n' "${@:2}" > "$PROJECT/threads/$id/worktrees.txt"; fi
}
set_status() { # <terminal> <hc の status.state>
  jq --arg state "$2" '.status.state = $state' "$STUB_STATE/get-$1.json" > "$STUB_STATE/status.json"
  mv "$STUB_STATE/status.json" "$STUB_STATE/get-$1.json"
}
cleanup() {
  "$BIN/cleanup" "$PROJECT" "$@"
}

test_cleanup_lists_without_deleting() {
  open_project 2>/dev/null
  local wt
  wt="$(make_worktree a)"
  commit_in "$wt"
  git -C "$T/work" merge -q --ff-only tmp/a
  done_thread t900 "$wt"
  echo t901 > "$STUB_STATE/next-address"
  start_thread >/dev/null
  report_as t901 needs-you "案を選んでほしい" >/dev/null
  : > "$STUB_LOG"
  local out
  out="$(cleanup)" || ng "一覧が失敗"
  [[ "$out" == *"消せる thread（1 件）:
- t001「README の修正」: worktree $wt とブランチ tmp/a を消す（main に取り込み済み） / terminal t900 を終わらせる
残す thread（1 件）:
- t002「README の修正」: 最後の報告が needs-you"* ]] || ng "一覧: $out"
  [[ "$out" == *"まだ何も消していません"* ]] || ng "消していないことが出ていない: $out"
  [[ -d "$wt" ]] || ng "一覧だけで worktree を消した"
  git -C "$T/work" rev-parse -q --verify refs/heads/tmp/a >/dev/null || ng "一覧だけでブランチを消した"
  [[ -d "$PROJECT/threads/t001" ]] || ng "一覧だけで thread を片付けた"
  not_logged '"kill"'
  eq "t001" "$(cat "$PROJECT/cleanup-listed")" "一覧の「消せる」の記録"
  # 祖先で取り込みが分かったので gh には聞かない
  not_logged '"gh"'
}

test_cleanup_deletes_listed_threads() {
  open_project 2>/dev/null
  local wt
  wt="$(make_worktree a)"
  commit_in "$wt"
  git -C "$T/work" merge -q --ff-only tmp/a
  done_thread t900 "$wt"
  echo "# 詳細" > "$PROJECT/threads/t001/report.md"
  cleanup >/dev/null
  : > "$STUB_LOG"
  local out
  out="$(cleanup t001)" || ng "片付けが失敗: $out"
  eq "- t001「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/t001 に残っています）" "$out" "結果"
  [[ ! -e "$wt" ]] || ng "worktree が残っている"
  ! git -C "$T/work" rev-parse -q --verify refs/heads/tmp/a >/dev/null || ng "ブランチが残っている"
  [[ ! -e "$PROJECT/threads/t001" ]] || ng "thread のフォルダが残っている"
  eq "# 詳細" "$(cat "$PROJECT/threads/.deleted/t001/report.md")" "report.md は .deleted に残る"
  logged '["hc","kill","t900"]'
  logged '["hc","rm","t900"]'
  [[ ! -e "$PROJECT/cleanup-listed" ]] || ng "一覧の記録は 1 回で使い切る"
  # 片付けた id は使い直さない
  echo t901 > "$STUB_STATE/next-address"
  eq "THREAD_ID=t002" "$(start_thread | head -n 1)" "次の thread の id"
}

test_cleanup_refuses_ids_not_listed() {
  open_project 2>/dev/null
  done_thread t900
  echo t901 > "$STUB_STATE/next-address"
  start_thread >/dev/null
  : > "$STUB_LOG"
  fails cleanup t001
  [[ "$ERR" == *"一覧"* ]] || ng "理由が出ていない: $ERR"
  cleanup >/dev/null
  fails cleanup t001 t002
  [[ "$ERR" == *"t002"* ]] || ng "一覧に無い id が出ていない: $ERR"
  fails cleanup ../t001
  [[ -d "$PROJECT/threads/t001" && -d "$PROJECT/threads/t002" ]] || ng "拒否したのに片付けた"
  not_logged '"kill"'
}

test_cleanup_keeps_unmerged_and_dirty_worktrees() {
  open_project 2>/dev/null
  local unmerged dirty
  unmerged="$(make_worktree a)"
  commit_in "$unmerged"
  dirty="$(make_worktree b)"
  touch "$dirty/memo.txt"
  done_thread t900 "$unmerged"
  done_thread t901 "$dirty"
  local out
  out="$(cleanup)"
  [[ "$out" == *"- t001「README の修正」: ブランチ tmp/a が未マージ"* ]] || ng "未マージ: $out"
  [[ "$out" == *"- t002「README の修正」: $dirty に未コミットの変更がある"* ]] || ng "未コミット: $out"
  [[ "$out" == *"消せる thread（0 件）"* ]] || ng "消せるものは無い: $out"
  logged '["gh","pr","list","--head","tmp/a","--state","merged","--json","number,headRefOid"]'
  [[ ! -e "$PROJECT/cleanup-listed" ]] || ng "消せるものが無いのに一覧を記録した"
}

test_cleanup_accepts_squash_merged_pr() {
  open_project 2>/dev/null
  local wt sha
  wt="$(make_worktree a)"
  commit_in "$wt"
  sha="$(git -C "$wt" rev-parse HEAD)"
  done_thread t900 "$wt"
  echo '[{"number":11,"headRefOid":"0000000"},{"number":12,"headRefOid":"'"$sha"'"}]' > "$STUB_STATE/gh-prs.json"
  [[ "$(cleanup)" == *"とブランチ tmp/a を消す（PR #12 がマージ済み）"* ]] || ng "PR のマージで取り込み済みとみなしていない"
  # マージの後にコミットを足したブランチは先頭が合わない
  commit_in "$wt"
  [[ "$(cleanup)" == *"ブランチ tmp/a が未マージ"* ]] || ng "先頭の合わない PR をマージ済みとみなした"
  touch "$STUB_STATE/gh-fails"
  [[ "$(cleanup)" == *"ブランチ tmp/a のマージを gh で確かめられない"* ]] || ng "gh の失敗を理由に出していない"
}

test_cleanup_keeps_busy_or_rerequested_threads() {
  open_project 2>/dev/null
  done_thread t900
  set_status t900 working
  [[ "$(cleanup)" == *"- t001「README の修正」: 作業中"* ]] || ng "作業中を残していない"
  set_status t900 blocked
  [[ "$(cleanup)" == *"- t001「README の修正」: 許可待ち"* ]] || ng "許可待ちを残していない"
  set_status t900 error
  [[ "$(cleanup)" == *"- t001「README の修正」: エラー"* ]] || ng "エラーを残していない"
  set_status t900 idle
  "$BIN/message" "$PROJECT" t001 "もう 1 つ直して" >/dev/null
  [[ "$(cleanup)" == *"- t001「README の修正」: done の報告の後に追加の依頼を受けている"* ]] || ng "追加の依頼を受けた thread を残していない"
  touch "$STUB_STATE/get-error"
  [[ "$(cleanup)" == *"- t001「README の修正」: terminal t900 の状態を確かめられない"* ]] || ng "hc get の失敗で残していない"
}

test_cleanup_rejudges_before_deleting() {
  open_project 2>/dev/null
  local wt
  wt="$(make_worktree a)"
  done_thread t900 "$wt"
  cleanup >/dev/null
  # 一覧の後にコミットが増えた
  commit_in "$wt"
  local out
  out="$(cleanup t001)" && ng "残したのに成功で返した"
  eq "- t001「README の修正」: 残した: ブランチ tmp/a が未マージ" "$out" "結果"
  [[ -d "$wt" && -d "$PROJECT/threads/t001" ]] || ng "判定し直さずに消した"
}

test_cleanup_refuses_main_checkout_and_inner_folder() {
  open_project 2>/dev/null
  local wt
  wt="$(make_worktree a)"
  mkdir "$wt/sub"
  done_thread t900 "$T/work"
  done_thread t901 "$wt/sub"
  done_thread t902 "relative/path"
  local out
  out="$(cleanup)"
  [[ "$out" == *"- t001「README の修正」: $T/work は元の checkout（$T/work）で、git worktree add で作った worktree ではない"* ]] || ng "元の checkout: $out"
  [[ "$out" == *"- t002「README の修正」: $wt/sub は worktree の最上位（${wt}）ではない"* ]] || ng "worktree の中のフォルダ: $out"
  [[ "$out" == *"- t003「README の修正」: worktrees.txt の relative/path が絶対パスでない"* ]] || ng "相対パス: $out"
}

test_cleanup_stopped_thread_without_worktrees() {
  open_project 2>/dev/null
  done_thread t900
  # マシンの再起動で terminal が消えた
  rm "$STUB_STATE/get-t900.json"
  done_thread t901 "$T/gone"
  local out
  out="$(cleanup)"
  [[ "$out" == *"- t001「README の修正」: worktree の記録なし（thread だけ片付ける）
- t002「README の修正」: worktree $T/gone はもう無い（ブランチは確かめていない） / terminal t901 を終わらせる"* ]] || ng "一覧: $out"
  : > "$STUB_LOG"
  cleanup t001 >/dev/null || ng "片付けが失敗"
  not_logged '"kill"'
  not_logged '"rm"'
  [[ -d "$PROJECT/threads/.deleted/t001" ]] || ng "thread を片付けていない"
}

test_cleanup_without_threads() {
  open_project 2>/dev/null
  eq "消せる thread（0 件）:
- なし
残す thread（0 件）:
- なし" "$(cleanup)" "thread が無いときの一覧"
  fails "$BIN/cleanup" "$T"
}

# Claude Code が会話ごとに作る一時フォルダ（scratchpad と、裏で動かしたコマンドの出力の tasks）を、本物と同じ形で
# $CLAUDE_CODE_TMPDIR/claude-<uid>/<作業フォルダの絶対パスの英数字以外を - にした名前>/<会話の id>/ に作り、そのパスを返す
SID=aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb # 偽の uuidgen の id を start が小文字にしたもの
make_scratch() { # <作業フォルダ> <会話の id>
  local dir="$CLAUDE_CODE_TMPDIR/claude-$UID/${1//[^a-zA-Z0-9]/-}/$2"
  mkdir -p "$dir/scratchpad/repo" "$dir/tasks"
  touch "$dir/scratchpad/repo/a.js" "$dir/tasks/b1.output"
  echo "$dir"
}
files_under() { # <フォルダ>
  find "$1" | sort
}

test_cleanup_deletes_thread_scratchpad() {
  open_project 2>/dev/null
  done_thread t900
  echo t901 > "$STUB_STATE/next-address"
  start_thread >/dev/null
  local own launch other coordinator out
  own="$(make_scratch "$PROJECT/threads/t001" "$SID")"
  # claude は起動のたびに、別の id の空のフォルダも作る。thread.json の id のものだけを消す
  launch="$(make_scratch "$PROJECT/threads/t001" 0f0f0f0f-0000-4000-8000-000000000001)"
  # 偽の uuidgen はどの会話にも同じ id を返すので、id だけで探すと、別の thread と coordinator のフォルダにも当たる
  other="$(make_scratch "$PROJECT/threads/t002" "$SID")"
  coordinator="$(make_scratch "$PROJECT" "$SID")"
  out="$(cleanup)"
  [[ "$out" == *"- t001「README の修正」: worktree の記録なし（thread だけ片付ける） / Claude の一時フォルダ ${own}（scratchpad など）を消す / terminal t900 を終わらせる"* ]] || ng "一覧: $out"
  [[ -f "$own/scratchpad/repo/a.js" ]] || ng "一覧だけで消した"
  out="$(cleanup t001)" || ng "片付けが失敗: $out"
  eq "- t001「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/t001 に残っています） / Claude の一時フォルダ $own を消した" "$out" "結果"
  [[ ! -e "$own" ]] || ng "thread の一時フォルダが残っている"
  [[ -d "$launch/scratchpad" ]] || ng "同じ thread の別の id のフォルダまで消した"
  [[ -f "$other/scratchpad/repo/a.js" ]] || ng "別の thread の一時フォルダを消した"
  [[ -f "$coordinator/scratchpad/repo/a.js" ]] || ng "coordinator の一時フォルダを消した"
}

test_cleanup_deletes_scratchpad_after_claude_ends() {
  open_project 2>/dev/null
  done_thread t900
  local own out
  own="$(make_scratch "$PROJECT/threads/t001" "$SID")"
  cleanup >/dev/null
  # claude を終わらせられなければ、動いている claude の一時フォルダは消さない
  touch "$STUB_STATE/kill-fails"
  out="$(cleanup t001)" && ng "残したのに成功で返した"
  [[ "$out" == *"残した: terminal t900 を終わらせられない"* ]] || ng "結果: $out"
  [[ -f "$own/scratchpad/repo/a.js" ]] || ng "claude を終わらせる前に消した"
  # terminal が消えて claude が動いていない thread は、そのまま消す
  rm "$STUB_STATE/kill-fails" "$STUB_STATE/get-t900.json"
  cleanup >/dev/null
  out="$(cleanup t001)" || ng "片付けが失敗: $out"
  [[ "$out" == *" / Claude の一時フォルダ $own を消した" ]] || ng "結果: $out"
  [[ ! -e "$own" ]] || ng "一時フォルダが残っている"
}

test_cleanup_keeps_scratchpad_without_valid_session_id() {
  open_project 2>/dev/null
  local terminal id pair before out
  for terminal in t900 t901 t902 t903 t904; do done_thread "$terminal"; done
  # t001: 会話の id が無い t002: 空 t003: パスをさかのぼる t004: glob t005: UUID の形でない
  jq 'del(.sessionId)' "$PROJECT/threads/t001/thread.json" > "$T/thread.json"
  mv "$T/thread.json" "$PROJECT/threads/t001/thread.json"
  for pair in "t002:" "t003:../.." "t004:*" "t005:aaaaaaaa"; do
    jq --arg sid "${pair#*:}" '.sessionId = $sid' "$PROJECT/threads/${pair%%:*}/thread.json" > "$T/thread.json"
    mv "$T/thread.json" "$PROJECT/threads/${pair%%:*}/thread.json"
  done
  for id in t001 t002 t003 t004 t005; do make_scratch "$PROJECT/threads/$id" "$SID" >/dev/null; done
  make_scratch "$PROJECT/threads/t004" "*" >/dev/null
  make_scratch "$PROJECT/threads/t005" aaaaaaaa >/dev/null
  before="$(files_under "$CLAUDE_CODE_TMPDIR")"
  out="$(cleanup)"
  [[ "$out" == *"- t001「README の修正」: worktree の記録なし（thread だけ片付ける） / Claude の一時フォルダは消さない（thread.json の会話の id（なし）が UUID の形でない） / terminal t900 を終わらせる"* ]] || ng "一覧: $out"
  [[ "$out" == *"- t003「README の修正」: worktree の記録なし（thread だけ片付ける） / Claude の一時フォルダは消さない（thread.json の会話の id（../..）が UUID の形でない）"* ]] || ng "一覧: $out"
  out="$(cleanup t001 t002 t003 t004 t005)" || ng "片付けが失敗: $out"
  [[ "$out" == *"- t002「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/t002 に残っています） / Claude の一時フォルダは消していない: thread.json の会話の id（なし）が UUID の形でない"* ]] || ng "結果: $out"
  [[ "$out" == *"- t004「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/t004 に残っています） / Claude の一時フォルダは消していない: thread.json の会話の id（*）が UUID の形でない"* ]] || ng "結果: $out"
  eq "$before" "$(files_under "$CLAUDE_CODE_TMPDIR")" "一時フォルダの中身"
  for id in t001 t002 t003 t004 t005; do
    [[ -d "$PROJECT/threads/.deleted/$id" ]] || ng "$id を片付けていない"
  done
}

test_cleanup_keeps_scratchpad_outside_expected_place() {
  open_project 2>/dev/null
  local own elsewhere out
  done_thread t900
  done_thread t901
  # t001: 一時フォルダがシンボリックリンクで、ほかの場所を指している
  own="$(make_scratch "$PROJECT/threads/t001" "$SID")"
  elsewhere="$T/elsewhere"
  mv "$own" "$elsewhere"
  ln -s "$elsewhere" "$own"
  cleanup >/dev/null
  out="$(cleanup t001)" || ng "片付けが失敗: $out"
  [[ "$out" == *" / Claude の一時フォルダは消していない: $own がシンボリックリンク" ]] || ng "結果: $out"
  [[ -L "$own" && -f "$elsewhere/scratchpad/repo/a.js" ]] || ng "リンクかリンクの先を消した"
  # t002: CLAUDE_CODE_TMPDIR が相対パスで、場所がそのときの作業フォルダで変わる
  own="$(make_scratch "$PROJECT/threads/t002" "$SID")"
  cleanup >/dev/null
  out="$(CLAUDE_CODE_TMPDIR=tmp cleanup t002)" || ng "片付けが失敗: $out"
  [[ "$out" == *" / Claude の一時フォルダは消していない: CLAUDE_CODE_TMPDIR（tmp）が絶対パスでない" ]] || ng "結果: $out"
  [[ -f "$own/scratchpad/repo/a.js" ]] || ng "相対パスのときに消した"
}

# Claude Code は、名前が 200 文字を超えると先頭 200 文字と - とハッシュにする。英数字以外の文字は UTF-16 の単位で - にする。
# どちらも実物で確かめていないので、名前を作らずに消さない
test_cleanup_keeps_scratchpad_of_unsure_folder_name() {
  local name dir before out
  for REPO in "$T/$(printf '%0150d' 0)/repo" "$T/作業/repo"; do
    PROJECT="$REPO/.local/hc-projects/demo"
    git init -q --template= "$REPO"
    open_project 2>/dev/null
    done_thread t900
    name="$PROJECT/threads/t001"
    name="${name//[^a-zA-Z0-9]/-}"
    # 名前は 255 バイトまでなので、200 文字を超える名前はハッシュの付いた形だけを作る
    dir="$CLAUDE_CODE_TMPDIR/claude-$UID/${name:0:200}-1x2y3z/$SID"
    mkdir -p "$dir/scratchpad"
    if [[ ${#name} -le 200 ]]; then mkdir -p "$CLAUDE_CODE_TMPDIR/claude-$UID/$name/$SID/scratchpad"; fi
    before="$(files_under "$CLAUDE_CODE_TMPDIR")"
    cleanup >/dev/null
    out="$(cleanup t001)" || ng "片付けが失敗: $out"
    [[ "$out" == *" / Claude の一時フォルダは消していない: thread のフォルダのパスが 200 文字を超えるか ASCII 以外の文字を含み、名前を確かめられない" ]] || ng "結果: $out"
    eq "$before" "$(files_under "$CLAUDE_CODE_TMPDIR")" "一時フォルダの中身（${REPO}）"
  done
}

# thread のフォルダに、bin/report が残す形の報告の写しを置く
put_report() { # <thread の id> <写しの名前> <中身>
  mkdir -p "$PROJECT/threads/$1/reports"
  printf '%s\n' "$3" > "$PROJECT/threads/$1/reports/$2"
}
reports_of() { # <片付けた thread の id>
  local file names=""
  for file in "$PROJECT/threads/.deleted/$1/reports/"*; do names+="${file##*/} "; done
  echo "${names% }"
}
SUMMARY_OUTPUT='{"type":"result","is_error":false,"total_cost_usd":0.01234,"result":"## 頼まれたこと\nREADME を直す\n\n## 決めたこと\n案 A にした（途中の報告: 20260101T000100Z-needs-you.md）"}'
STAGE1=$'# 第 1 段: 調べ\n\n- 案 A と案 B がある。案 A を勧める'
STAGE2=$'# 第 2 段: 実装\n\n- 案 A で作った'

test_cleanup_drops_reports_contained_in_later_ones() {
  open_project 2>/dev/null
  done_thread t900
  done_thread t901
  # t001: 追記していく thread。途中の写しは後の写しの先頭にそのまま含まれ、最後の写しは report.md と同じ
  put_report t001 20260101T000000Z-waiting.md "$STAGE1"
  put_report t001 20260101T000100Z-needs-you.md "$STAGE1"$'\n- 全件のテストを待つ'
  put_report t001 20260101T000200Z-done.md "$STAGE1"$'\n- 全件のテストを待つ\n- 全件が通った'
  cp "$PROJECT/threads/t001/reports/20260101T000200Z-done.md" "$PROJECT/threads/t001/report.md"
  # bin/report の付けた名前でないファイルは数えない
  put_report t001 memo.md "$STAGE1"
  # t002: 同じ秒の 2 つ目の写し（-2）は後の写し。名前の順では前に来るが、前の写しを含むので前の写しを消す
  put_report t002 20260101T000000Z-done.md "$STAGE2"
  put_report t002 20260101T000000Z-done-2.md "$STAGE2"$'\n- 直した'
  local out
  out="$(cleanup)"
  [[ "$out" == *"- t001「README の修正」: worktree の記録なし（thread だけ片付ける） / 報告の写し 3 つのうち、後の写しか report.md に中身が含まれる 2 つを消す / terminal t900 を終わらせる"* ]] || ng "一覧: $out"
  [[ "$out" == *"- t002「README の修正」: worktree の記録なし（thread だけ片付ける） / 報告の写し 2 つのうち、後の写しか report.md に中身が含まれる 1 つを消す / terminal t901 を終わらせる"* ]] || ng "一覧: $out"
  [[ -f "$PROJECT/threads/t001/reports/20260101T000000Z-waiting.md" ]] || ng "一覧だけで写しを消した"
  out="$(cleanup t001 t002)" || ng "片付けが失敗: $out"
  eq "- t001「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/t001 に残っています） / 報告の写しのうち、後の写しか report.md に中身が含まれる 2 つを消した
- t002「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/t002 に残っています） / 報告の写しのうち、後の写しか report.md に中身が含まれる 1 つを消した" "$out" "結果"
  eq "20260101T000200Z-done.md memo.md" "$(reports_of t001)" "t001 に残した写し"
  eq "20260101T000000Z-done-2.md" "$(reports_of t002)" "t002 に残した写し"
  [[ -f "$PROJECT/threads/.deleted/t001/report.md" ]] || ng "report.md を消した"
  [[ ! -e "$PROJECT/threads/.deleted/t001/summary.md" ]] || ng "残る写しが 1 つなのに要約を作った"
  [[ ! -e "$STUB_STATE/claude-print-args.json" ]] || ng "claude -p を動かした"
}

test_cleanup_leaves_single_report_without_summary() {
  open_project 2>/dev/null
  done_thread t900
  done_thread t901
  # t001: 写しが 1 つだけ。thread が報告の後に report.md を書き足していても、写しは消さない
  put_report t001 20260101T000000Z-done.md "$STAGE2"
  printf '%s\n' "$STAGE2"$'\n- 報告の後に足した' > "$PROJECT/threads/t001/report.md"
  # t002: 写しが無い（--detail-file を付けずに報告した）
  local out
  out="$(cleanup)"
  [[ "$out" != *"報告の写し"* ]] || ng "何もしないのに写しのことを出した: $out"
  out="$(cleanup t001 t002)" || ng "片付けが失敗: $out"
  eq "- t001「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/t001 に残っています）
- t002「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/t002 に残っています）" "$out" "結果"
  eq "20260101T000000Z-done.md" "$(reports_of t001)" "残した写し"
  [[ ! -e "$PROJECT/threads/.deleted/t002/reports" ]] || ng "写しの無い thread に reports を作った"
  [[ ! -e "$STUB_STATE/claude-print-args.json" ]] || ng "claude -p を動かした"
}

test_cleanup_summarizes_rewritten_reports() {
  open_project 2>/dev/null
  done_thread t900
  done_thread t901
  local id status_before args="$STUB_STATE/claude-print-args.json" stdin
  # 書き直す thread: 第 1 段の報告を 2 回（同じ中身）出し、第 2 段で report.md を書き直した
  for id in t001 t002; do
    put_report "$id" 20260101T000000Z-waiting.md "$STAGE1"
    put_report "$id" 20260101T000100Z-needs-you.md "$STAGE1"
    put_report "$id" 20260101T000200Z-done.md "$STAGE2"
    printf '%s\n' "$STAGE2" > "$PROJECT/threads/$id/report.md"
  done
  status_before="$(cat "$PROJECT/threads/t001/status.json")"
  printf '%s\n' "$SUMMARY_OUTPUT" > "$STUB_STATE/claude-print.json"
  local out
  out="$(cleanup)"
  [[ "$out" == *"- t001「README の修正」: worktree の記録なし（thread だけ片付ける） / 報告の写し 3 つのうち、後の写しか report.md に中身が含まれる 1 つを消し、残る 2 つから haiku で summary.md を作って、最後の 1 つのほかを消す（要約に失敗したら残す） / terminal t900 を終わらせる"* ]] || ng "一覧: $out"
  [[ ! -e "$args" ]] || ng "一覧だけで要約を作った"
  out="$(cleanup t001 t002)" || ng "片付けが失敗: $out"
  for id in t001 t002; do
    [[ "$out" == *"- ${id}「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/$id に残っています） / 報告の写しのうち、後の写しか report.md に中身が含まれる 1 つを消した / summary.md を作り（"*" 秒、\$0.012）、途中の報告の写し 1 つを消した"* ]] || ng "結果: $out"
    eq "20260101T000200Z-done.md" "$(reports_of "$id")" "$id に残した写し"
    eq "# ${id}「README の修正」の要約" "$(head -n 1 "$PROJECT/threads/.deleted/$id/summary.md")" "要約の見出し"
    grep -qF "brief.md と報告の写し 2 つ（20260101T000100Z-needs-you.md、20260101T000200Z-done.md）から作った" "$PROJECT/threads/.deleted/$id/summary.md" || ng "要約に元の写しが書かれていない"
    grep -qF '案 A にした（途中の報告: 20260101T000100Z-needs-you.md）' "$PROJECT/threads/.deleted/$id/summary.md" || ng "要約に haiku の出力が無い"
    [[ ! -e "$PROJECT/threads/.deleted/$id/summary.md.tmp" ]] || ng "書きかけが残っている"
  done
  [[ "$(head -n 1 <<<"$out")" == "- t001"* ]] || ng "t001 の行が先に無い: $out"
  # status.json の detail は最後の写しを指したまま。最後の写しは消さない
  eq "$status_before" "$(cat "$PROJECT/threads/.deleted/t001/status.json")" "status.json"
  eq "$PROJECT/threads/.deleted/t002" "$(cat "$STUB_STATE/claude-print-cwd")" "claude -p の作業フォルダ"
  eq "haiku" "$(jq -r '.[index("--model") + 1]' "$args")" "モデル"
  eq "json" "$(jq -r '.[index("--output-format") + 1]' "$args")" "出力の形"
  eq "" "$(jq -r '.[index("--tools") + 1]' "$args")" "ツールを持たせない"
  eq "" "$(jq -r '.[index("--setting-sources") + 1]' "$args")" "user の設定を読まない"
  eq "true" "$(jq '(index("--no-session-persistence") != null) and (index("--strict-mcp-config") != null) and (index("--disable-slash-commands") != null)' "$args")" "セッションを残さず MCP とスキルを読まない"
  eq "true" "$(jq '.[index("--system-prompt") + 1] | contains("## 決めたこと") and contains("## 未確認の点や残したこと")' "$args")" "要約の指示"
  [[ "$(jq -r '.[index("--max-budget-usd") + 1]' "$args")" =~ ^[0-9.]+$ ]] || ng "費用の上限が無い"
  stdin="$(cat "$STUB_STATE/claude-print-stdin")"
  [[ "$stdin" == *'<file name="brief.md">'$'\n''README を直す'* ]] || ng "brief.md を渡していない: $stdin"
  [[ "$stdin" == *'<file name="reports/20260101T000100Z-needs-you.md">'$'\n'"$STAGE1"$'\n''</file>'*'<file name="reports/20260101T000200Z-done.md">'$'\n'"$STAGE2"* ]] || ng "写しを古い順に渡していない: $stdin"
  [[ "$stdin" != *"20260101T000000Z-waiting.md"* ]] || ng "消した写しを渡した: $stdin"
}

test_cleanup_keeps_reports_when_summary_fails() {
  open_project 2>/dev/null
  local id terminal case out
  for terminal in t900 t901 t902 t903; do done_thread "$terminal"; done
  for id in t001 t002 t003 t004; do
    put_report "$id" 20260101T000100Z-needs-you.md "$STAGE1"
    put_report "$id" 20260101T000200Z-done.md "$STAGE2"
  done
  out="$(cleanup)"
  [[ "$out" == *"- t001「README の修正」: worktree の記録なし（thread だけ片付ける） / 報告の写し 2 つから haiku で summary.md を作って、最後の 1 つのほかを消す（要約に失敗したら残す） / terminal t900 を終わらせる"* ]] || ng "一覧: $out"
  # t001: エラー t002: 空の出力 t003: 打ち切り（perl の alarm は 142） t004: JSON でない
  for case in \
    't001|1|{"is_error":true,"subtype":"error_max_budget_usd","result":"上限に達した"}|claude -p が error_max_budget_usd: 上限に達した' \
    't002|0|{"is_error":false,"result":"  "}|claude -p の出力が空' \
    't003|142||120 秒で打ち切った' \
    't004|1|not json|claude -p が exit 1: not json'; do
    IFS='|' read -r id code output reason <<<"$case"
    printf '%s\n' "$output" > "$STUB_STATE/claude-print.json"
    echo "$code" > "$STUB_STATE/claude-print-exit"
    cleanup >/dev/null
    out="$(cleanup "$id")" || ng "要約の失敗で片付けが失敗した（${id}）: $out"
    eq "- ${id}「README の修正」: 片付けた（report.md などは $PROJECT/threads/.deleted/$id に残っています） / 要約を作れなかった（${reason}）ので、報告の写しは残した" "$out" "結果（${id}）"
    eq "20260101T000100Z-needs-you.md 20260101T000200Z-done.md" "$(reports_of "$id")" "残した写し（${id}）"
    [[ ! -e "$PROJECT/threads/.deleted/$id/summary.md" && ! -e "$PROJECT/threads/.deleted/$id/summary.md.tmp" ]] || ng "要約のファイルが残っている（${id}）"
  done
}

# 片付け済みの thread（写しを減らす処理ができる前に .deleted へ移したもの）を作る
deleted_thread() { # <thread の id>
  local dir="$PROJECT/threads/.deleted/$1"
  mkdir -p "$dir"
  jq -n --arg id "$1" '{id: $id, title: "README の修正"}' > "$dir/thread.json"
  echo "README を直す" > "$dir/brief.md"
}
deleted_report() { # <thread の id> <写しの名前> <中身>
  mkdir -p "$PROJECT/threads/.deleted/$1/reports"
  printf '%s\n' "$3" > "$PROJECT/threads/.deleted/$1/reports/$2"
}
# t001: 書き直す（重なり 1 つを消して要約） t002: 追記する（重なりを消すだけ） t003: reports/ の無い古い形
# t004: 写しが 1 つ t005: summary.md がある
deleted_threads() {
  local id
  for id in t001 t002 t003 t004 t005; do deleted_thread "$id"; done
  deleted_report t001 20260101T000000Z-waiting.md "$STAGE1"
  deleted_report t001 20260101T000100Z-needs-you.md "$STAGE1"
  deleted_report t001 20260101T000200Z-done.md "$STAGE2"
  printf '%s\n' "$STAGE2" > "$PROJECT/threads/.deleted/t001/report.md"
  deleted_report t002 20260101T000000Z-waiting.md "$STAGE1"
  deleted_report t002 20260101T000100Z-done.md "$STAGE1"$'\n- 直した'
  echo "# 詳細" > "$PROJECT/threads/.deleted/t003/report.md"
  deleted_report t004 20260101T000000Z-done.md "$STAGE2"
  deleted_report t005 20260101T000100Z-needs-you.md "$STAGE1"
  deleted_report t005 20260101T000200Z-done.md "$STAGE2"
  echo "# 要約" > "$PROJECT/threads/.deleted/t005/summary.md"
}

test_cleanup_deleted_lists_without_changing() {
  open_project 2>/dev/null
  deleted_threads
  # まだ片付けていない thread（片付けた id は使い直さないので t006）は対象にしない
  done_thread t900
  put_report t006 20260101T000100Z-needs-you.md "$STAGE1"
  put_report t006 20260101T000200Z-done.md "$STAGE2"
  local before out
  before="$(files_under "$PROJECT/threads")"
  : > "$STUB_LOG"
  out="$(cleanup --deleted)" || ng "一覧が失敗: $out"
  eq "写しを減らせる片付け済みの thread（2 件）:
- t001「README の修正」: 報告の写し 3 つのうち、後の写しか report.md に中身が含まれる 1 つを消し、残る 2 つから haiku で summary.md を作って、最後の 1 つのほかを消す（要約に失敗したら残す）
- t002「README の修正」: 報告の写し 2 つのうち、後の写しか report.md に中身が含まれる 1 つを消す
何もしない片付け済みの thread（3 件）: 写しが無い 1 件、写しが 1 つ 1 件、summary.md がある 1 件

まだ何も変えていません。この一覧を user に見せて承認を得てから、id を付けて呼び直してください（除外を頼まれた id は付けない）。" "$out" "一覧"
  eq "$before" "$(files_under "$PROJECT/threads")" "一覧だけで変えたファイル"
  eq "t001
t002" "$(cat "$PROJECT/cleanup-deleted-listed")" "一覧に載せた id の記録"
  [[ ! -e "$STUB_STATE/claude-print-args.json" ]] || ng "一覧だけで claude -p を動かした"
  not_logged '"hc"'
  # 片付けの一覧の記録とは別に持つ
  [[ ! -e "$PROJECT/cleanup-listed" ]] || ng "片付けの一覧の記録を作った"
}

test_cleanup_deleted_processes_listed_ids() {
  open_project 2>/dev/null
  deleted_threads
  printf '%s\n' "$SUMMARY_OUTPUT" > "$STUB_STATE/claude-print.json"
  cleanup --deleted >/dev/null
  : > "$STUB_LOG"
  local out before
  out="$(cleanup --deleted t001 t002)" || ng "処理が失敗: $out"
  [[ "$out" == "- t001「README の修正」: 報告の写しのうち、後の写しか report.md に中身が含まれる 1 つを消した / summary.md を作り（"*" 秒、\$0.012）、途中の報告の写し 1 つを消した
- t002「README の修正」: 報告の写しのうち、後の写しか report.md に中身が含まれる 1 つを消した" ]] || ng "結果: $out"
  eq "20260101T000200Z-done.md" "$(reports_of t001)" "t001 に残した写し"
  eq "20260101T000100Z-done.md" "$(reports_of t002)" "t002 に残した写し"
  grep -qF '案 A にした（途中の報告: 20260101T000100Z-needs-you.md）' "$PROJECT/threads/.deleted/t001/summary.md" || ng "要約に haiku の出力が無い"
  [[ ! -e "$PROJECT/threads/.deleted/t002/summary.md" ]] || ng "残る写しが 1 つなのに要約を作った"
  eq "$PROJECT/threads/.deleted/t001" "$(cat "$STUB_STATE/claude-print-cwd")" "claude -p の作業フォルダ"
  [[ "$(cat "$STUB_STATE/claude-print-stdin")" == *'<file name="brief.md">'$'\n''README を直す'* ]] || ng "brief.md を渡していない"
  eq "# 要約" "$(cat "$PROJECT/threads/.deleted/t005/summary.md")" "id を付けなかった thread の summary.md"
  eq "20260101T000100Z-needs-you.md 20260101T000200Z-done.md" "$(reports_of t005)" "id を付けなかった thread の写し"
  # terminal・worktree・一時フォルダには触らない
  not_logged '"hc"'
  not_logged '"gh"'
  [[ ! -e "$PROJECT/cleanup-deleted-listed" ]] || ng "一覧の記録は 1 回で使い切る"
  # 2 回目は何もしない
  rm "$STUB_STATE/claude-print-args.json"
  before="$(files_under "$PROJECT/threads")"
  out="$(cleanup --deleted)" || ng "2 回目の一覧が失敗: $out"
  eq "写しを減らせる片付け済みの thread（0 件）:
- なし
何もしない片付け済みの thread（5 件）: 写しが無い 1 件、写しが 1 つ 2 件、summary.md がある 2 件" "$out" "2 回目の一覧"
  [[ ! -e "$PROJECT/cleanup-deleted-listed" ]] || ng "減らせる thread が無いのに一覧を記録した"
  fails cleanup --deleted t001
  eq "$before" "$(files_under "$PROJECT/threads")" "2 回目に変えたファイル"
  [[ ! -e "$STUB_STATE/claude-print-args.json" ]] || ng "2 回目に claude -p を動かした"
}

test_cleanup_deleted_refuses_ids_not_listed() {
  open_project 2>/dev/null
  deleted_threads
  done_thread t900
  : > "$STUB_LOG"
  fails cleanup --deleted t001
  [[ "$ERR" == *"一覧"* ]] || ng "理由が出ていない: $ERR"
  # 片付けの一覧に載った id（片付けた id は使い直さないので、新しい thread は t006）は、--deleted では使えない
  cleanup >/dev/null
  eq "t006" "$(cat "$PROJECT/cleanup-listed")" "片付けの一覧"
  fails cleanup --deleted t006
  cleanup --deleted >/dev/null
  # 何もしない thread は一覧に載らない
  fails cleanup --deleted t001 t004
  [[ "$ERR" == *"t004"* ]] || ng "一覧に無い id が出ていない: $ERR"
  fails cleanup --deleted ../t001
  # --deleted の一覧に載った id は、片付けでは使えない
  fails cleanup t001
  eq "20260101T000000Z-waiting.md 20260101T000100Z-needs-you.md 20260101T000200Z-done.md" "$(reports_of t001)" "拒否したのに写しを消した"
  [[ -d "$PROJECT/threads/t006" ]] || ng "拒否したのに片付けた"
  [[ ! -e "$STUB_STATE/claude-print-args.json" ]] || ng "拒否したのに claude -p を動かした"
  not_logged '"kill"'
}

test_cleanup_deleted_rejudges_before_processing() {
  open_project 2>/dev/null
  deleted_threads
  cleanup --deleted >/dev/null
  # 一覧の後に、別の呼び出しが要約を作った
  echo "# 要約" > "$PROJECT/threads/.deleted/t001/summary.md"
  local out
  out="$(cleanup --deleted t001)" || ng "処理が失敗: $out"
  eq "- t001「README の修正」: 何もしなかった（summary.md がある）" "$out" "結果"
  eq "20260101T000000Z-waiting.md 20260101T000100Z-needs-you.md 20260101T000200Z-done.md" "$(reports_of t001)" "写し"
  [[ ! -e "$STUB_STATE/claude-print-args.json" ]] || ng "claude -p を動かした"
}

test_cleanup_deleted_keeps_reports_when_summary_fails() {
  open_project 2>/dev/null
  deleted_threads
  printf '%s\n' '{"is_error":true,"subtype":"error_max_budget_usd","result":"上限に達した"}' > "$STUB_STATE/claude-print.json"
  echo 1 > "$STUB_STATE/claude-print-exit"
  cleanup --deleted >/dev/null
  local out
  out="$(cleanup --deleted t001)" || ng "要約の失敗で処理が失敗した: $out"
  eq "- t001「README の修正」: 報告の写しのうち、後の写しか report.md に中身が含まれる 1 つを消した / 要約を作れなかった（claude -p が error_max_budget_usd: 上限に達した）ので、報告の写しは残した" "$out" "結果"
  eq "20260101T000100Z-needs-you.md 20260101T000200Z-done.md" "$(reports_of t001)" "残した写し"
  [[ ! -e "$PROJECT/threads/.deleted/t001/summary.md" && ! -e "$PROJECT/threads/.deleted/t001/summary.md.tmp" ]] || ng "要約のファイルが残っている"
  # 要約に失敗した thread は、次の一覧にまた載る
  out="$(cleanup --deleted)"
  [[ "$out" == *"- t001「README の修正」: 報告の写し 2 つから haiku で summary.md を作って、最後の 1 つのほかを消す（要約に失敗したら残す）"* ]] || ng "一覧: $out"
}

test_cleanup_deleted_summarizes_without_drops() {
  open_project 2>/dev/null
  deleted_thread t001
  deleted_report t001 20260101T000100Z-needs-you.md "$STAGE1"
  deleted_report t001 20260101T000200Z-done.md "$STAGE2"
  printf '%s\n' "$SUMMARY_OUTPUT" > "$STUB_STATE/claude-print.json"
  cleanup --deleted >/dev/null
  local out
  out="$(cleanup --deleted t001)" || ng "処理が失敗: $out"
  [[ "$out" == "- t001「README の修正」: summary.md を作り（"*" 秒、\$0.012）、途中の報告の写し 1 つを消した" ]] || ng "結果: $out"
  eq "20260101T000200Z-done.md" "$(reports_of t001)" "残した写し"
}

test_cleanup_deleted_reports_missing_thread() {
  open_project 2>/dev/null
  deleted_threads
  cleanup --deleted >/dev/null
  # 一覧の後に、user が .deleted から消した
  rm -rf "$PROJECT/threads/.deleted/t002"
  local out
  out="$(cleanup --deleted t002)" && ng "見つからないのに成功で返した"
  eq "- t002: 片付け済みの thread に見つからない" "$out" "結果"
}

# --- relay

# 送り先の project（別の repo の peer）を作る。coordinator は t200 に記録する
peer_project() {
  PEER="$T/other/.local/hc-projects/peer"
  mkdir -p "$PEER"
  echo '{"name":"peer","coordinator":{"terminal":"t200"}}' > "$PEER/project.json"
}
# peer の coordinator の claude が t200 の前面で動いている形にする
peer_alive() {
  jq -n --arg prompt "$PEER/coordinator-prompt.md" \
    '{address: "t200", state: "live", cwd: "/somewhere", foreground: {argv: ["claude", "--append-system-prompt-file", $prompt]}}' \
    > "$STUB_STATE/get-t200.json"
}
relay_as() { # <terminal> <relay の引数...>
  HC_TERMINAL_ID="$1" "$BIN/relay" "${@:2}"
}

test_relay_sends_marked_text_to_peer_coordinator() {
  open_project 2>/dev/null
  peer_project
  peer_alive
  : > "$STUB_LOG"
  local out
  out="$(relay_as t100 "$PROJECT" "$PEER" "一覧を直してほしい")" || ng "relay が失敗"
  logged '["hc","send","t200","[project demo relay] 送り元: '"$PROJECT"'\n一覧を直してほしい"]'
  [[ "$out" == *peer*t200* ]] || ng "送った先が出ていない: $out"
}

test_relay_reads_text_from_file() {
  open_project 2>/dev/null
  peer_project
  peer_alive
  printf '目的: 1 行目\n前提: 2 行目\n' > "$T/relay.md"
  relay_as t100 "$PROJECT" "$PEER" --file "$T/relay.md" >/dev/null || ng "relay が失敗"
  logged '["hc","send","t200","[project demo relay] 送り元: '"$PROJECT"'\n目的: 1 行目\n前提: 2 行目"]'
}

test_relay_does_not_type_into_shell() {
  open_project 2>/dev/null
  peer_project
  # peer の coordinator が終わって、terminal にシェルが残った形
  echo '{"address":"t200","state":"live","foreground":{"argv":["/bin/zsh","-l"]}}' > "$STUB_STATE/get-t200.json"
  fails relay_as t100 "$PROJECT" "$PEER" "rm -rf something"
  [[ "$ERR" == *"動いていない"* ]] || ng "理由が出ていない: $ERR"
  not_logged '"send"'
}

# 前面が claude でも、peer の coordinator ではない（thread などの別の claude）なら送らない
test_relay_does_not_send_to_other_claude() {
  open_project 2>/dev/null
  peer_project
  echo '{"address":"t200","state":"live","foreground":{"argv":["claude","--append-system-prompt-file","/x/threads/t001/system-prompt.md"]}}' \
    > "$STUB_STATE/get-t200.json"
  fails relay_as t100 "$PROJECT" "$PEER" "本文"
  not_logged '"send"'
}

test_relay_fails_when_peer_terminal_is_gone() {
  open_project 2>/dev/null
  peer_project
  fails relay_as t100 "$PROJECT" "$PEER" "本文"
  [[ "$ERR" == *t200* ]] || ng "terminal が出ていない: $ERR"
  not_logged '"send"'
}

test_relay_fails_when_peer_has_no_coordinator() {
  open_project 2>/dev/null
  peer_project
  echo '{"name":"peer","coordinator":{}}' > "$PEER/project.json"
  : > "$STUB_LOG"
  fails relay_as t100 "$PROJECT" "$PEER" "本文"
  not_logged '"get"'
  not_logged '"send"'
}

test_relay_fails_when_peer_project_is_missing() {
  open_project 2>/dev/null
  fails relay_as t100 "$PROJECT" "$T/nowhere" "本文"
  [[ "$ERR" == *"送り先の project がありません"* ]] || ng "理由が出ていない: $ERR"
  not_logged '"send"'
}

test_relay_fails_when_send_fails() {
  open_project 2>/dev/null
  peer_project
  peer_alive
  touch "$STUB_STATE/send-fails"
  fails relay_as t100 "$PROJECT" "$PEER" "本文"
}

test_relay_rejects_bad_input() {
  open_project 2>/dev/null
  peer_project
  peer_alive
  : > "$STUB_LOG"
  fails relay_as t100 "$PROJECT" "$PEER" ""
  fails relay_as t100 "$PROJECT" "$PEER"
  fails relay_as t100 "$T" "$PEER" "送り元が project ではない"
  fails relay_as t100 "$PROJECT" "$PROJECT" "自分宛て"
  # 送り元の coordinator ではない terminal（thread など）から呼んだ
  fails relay_as t900 "$PROJECT" "$PEER" "本文"
  [[ "$ERR" == *"coordinator ではありません"* ]] || ng "理由が出ていない: $ERR"
  fails "$BIN/relay" "$PROJECT" "$PEER" "本文"
  [[ "$ERR" == *HC_TERMINAL_ID* ]] || ng "理由が出ていない: $ERR"
  not_logged '"send"'
}

# --- watch

# thread t001 の最後の報告を、見込みが <時刻> の waiting にする
waiting_report() { # <expectedAt>
  jq -n --arg expectedAt "$1" '{status: "waiting", summary: "CI を待つ", at: "2026-11-10T03:00:00Z", expectedAt: $expectedAt}' \
    > "$PROJECT/threads/t001/status.json"
}
watch_once() {
  "$BIN/watch" "$PROJECT" --once
}

test_open_starts_watch_as_child() {
  open_project 2>/dev/null
  # 親と一緒に終わるよう、--outlive-parent を付けない
  logged '["hc","run","--bg","--json","--no-notify","--cwd","'"$PROJECT"'","--","'"$BIN"'/watch","'"$PROJECT"'"]'
}

test_watch_sets_its_title() {
  open_project 2>/dev/null
  # 名前も題名も無い子は、一覧（my-agents）で program 名の「bash」として出て、何の子か分からない
  watch_once > "$T/out" || ng "watch が失敗"
  eq $'\e]0;'"$(basename "$PROJECT")"$'/見張り 報告の遅れを知らせる\a' "$(cat "$T/out")" "題名を出す OSC"
}

test_watch_tells_coordinator_once_when_overdue() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  waiting_report "2000-01-01T00:00:00Z"
  : > "$STUB_LOG"
  watch_once || ng "watch が失敗"
  logged '"send","t100","[thread t001 overdue] 完了見込みの時刻（'
  logged '最後の報告: waiting — CI を待つ（'
  logged 'thread の terminal: t900 live・working。'
  eq "expected 2026-11-10T03:00:00Z 2000-01-01T00:00:00Z" "$(cat "$PROJECT/threads/t001/overdue-notified")" "知らせ済みの印"
  : > "$STUB_LOG"
  watch_once || ng "watch が失敗"
  not_logged '"send"'
}

test_watch_tells_again_for_new_waiting_report() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  waiting_report "2000-01-01T00:00:00Z"
  watch_once >/dev/null
  waiting_report "2000-01-01T01:00:00Z"
  : > "$STUB_LOG"
  watch_once || ng "watch が失敗"
  logged '"send","t100","[thread t001 overdue]'
}

test_watch_ignores_reports_not_overdue() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  waiting_report "2999-01-01T00:00:00Z"
  jq -n '{status: "waiting", summary: "古い形", at: "2026-11-10T03:00:00Z"}' > "$T/old.json"
  mkdir -p "$PROJECT/threads/t002"
  cp "$PROJECT/threads/t001/thread.json" "$PROJECT/threads/t002/thread.json"
  cp "$T/old.json" "$PROJECT/threads/t002/status.json"
  : > "$STUB_LOG"
  watch_once || ng "watch が失敗"
  not_logged '"send"'
  [[ ! -e "$PROJECT/threads/t001/overdue-notified" ]] || ng "知らせていないのに印を書いた"
}

test_watch_skips_unreadable_status() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  # 読めない status.json があっても、ほかの thread は知らせる
  mkdir -p "$PROJECT/threads/t000"
  echo '{"status":' > "$PROJECT/threads/t000/status.json"
  waiting_report "2000-01-01T00:00:00Z"
  : > "$STUB_LOG"
  watch_once 2>"$T/err" || ng "watch が失敗"
  grep -q "t000/status.json を読めません" "$T/err" || ng "読めないことが出ていない: $(cat "$T/err")"
  logged '"send","t100","[thread t001 overdue]'
}

test_watch_waits_for_coordinator() {
  open_project 2>/dev/null
  start_thread >/dev/null
  waiting_report "2000-01-01T00:00:00Z"
  # coordinator が動いていない間は送らず、印も書かない。動き出したら送る
  : > "$STUB_LOG"
  watch_once || ng "watch が失敗"
  not_logged '"send"'
  [[ ! -e "$PROJECT/threads/t001/overdue-notified" ]] || ng "送っていないのに印を書いた"
  coordinator_alive
  watch_once || ng "watch が失敗"
  logged '"send","t100","[thread t001 overdue]'
}

test_watch_retries_when_send_fails() {
  open_project 2>/dev/null
  start_thread >/dev/null
  coordinator_alive
  waiting_report "2000-01-01T00:00:00Z"
  rm "$STUB_STATE/get-t900.json"
  touch "$STUB_STATE/send-fails"
  watch_once 2>/dev/null || ng "送れなくても watch は止まらない"
  [[ ! -e "$PROJECT/threads/t001/overdue-notified" ]] || ng "送れていないのに印を書いた"
  rm "$STUB_STATE/send-fails"
  : > "$STUB_LOG"
  watch_once || ng "watch が失敗"
  logged 'thread の terminal: t900 見つからない。'
  [[ -f "$PROJECT/threads/t001/overdue-notified" ]] || ng "送れたのに印が無い"
}

# --- handoff

write_progress() {
  printf -- '---\nname: progress\n---\n\n## 動いている thread\nなし\n' > "$PROJECT/memory/progress.md"
}
handoff_as() { # <terminal> <handoff の引数...>
  HC_TERMINAL_ID="$1" "$BIN/handoff" "${@:2}"
}
# 補助を、補助自身の terminal（t0h）の中で動かす形にする
after_turn() {
  handoff_as t0h --after-turn "$PROJECT" t100
}
line_of() { # <記録の 1 行に含まれる断片>  最初に現れる行の番号
  grep -nF -- "$1" "$STUB_LOG" | head -n 1 | cut -d: -f1
}

test_handoff_starts_helper_after_progress() {
  open_project 2>/dev/null
  coordinator_alive
  write_progress
  : > "$STUB_LOG"
  handoff_as t100 "$PROJECT" >/dev/null || ng "handoff が失敗"
  # 親（coordinator の terminal）と一緒に終わるよう --outlive-parent を付けない。終了の知らせを coordinator の入力に入れない
  logged '["hc","run","--bg","--rm","--no-notify","--json","--cwd","'"$PROJECT"'","--","'"$BIN"'/handoff","--after-turn","'"$PROJECT"'","t100"]'
  not_logged '"send"'
}

test_handoff_refuses_without_fresh_progress() {
  open_project 2>/dev/null
  coordinator_alive
  : > "$STUB_LOG"
  fails handoff_as t100 "$PROJECT"
  [[ "$ERR" == *"progress.md がありません"* ]] || ng "progress が無いことが出ていない: $ERR"
  write_progress
  touch -t 202001010000 "$PROJECT/memory/progress.md"
  fails handoff_as t100 "$PROJECT"
  [[ "$ERR" == *"分より前に書かれたまま"* ]] || ng "progress が古いことが出ていない: $ERR"
  not_logged '"run"'
}

test_handoff_refuses_other_terminal() {
  open_project 2>/dev/null
  coordinator_alive
  write_progress
  : > "$STUB_LOG"
  fails handoff_as t900 "$PROJECT"
  [[ "$ERR" == *"coordinator ではありません"* ]] || ng "coordinator でないことが出ていない: $ERR"
  fails "$BIN/handoff" "$PROJECT"
  fails handoff_as t100 "$T/nowhere"
  not_logged '"run"'
}

test_handoff_helper_clears_after_turn() {
  open_project 2>/dev/null
  coordinator_alive
  printf 'working\ndone\n' > "$STUB_STATE/wait-states"
  : > "$STUB_LOG"
  after_turn || ng "補助が失敗"
  logged '["hc","send","--wait","--timeout","60","t100","/clear"]'
  logged '"send","t100","[project-threads handoff] 会話を /clear しました。'
  # HC_TERMINAL_ID が残っていると本文が <hc> で囲まれ、/clear が slash command にならない
  not_logged '["send-from","t0h"]'
  [[ "$(line_of '"/clear"')" -lt "$(line_of '[project-threads handoff]')" ]] || ng "/clear より先に最初の入力を送った"
  # 書きかけがあると /clear がその後ろに付いて slash command にならないので、どちらの送信の前にも退避する
  [[ "$(grep -c '\["hc","keys","t100","ctrl+s"\]' "$STUB_LOG")" -eq 2 ]] || ng "送るたびに退避していない
$(cat "$STUB_LOG")"
  # ターンが終わる（done）まで待ってから打つ
  [[ "$(grep -c '"wait","t100"' "$STUB_LOG")" -eq 2 ]] || ng "ターンの終わりを待っていない
$(cat "$STUB_LOG")"
}

test_handoff_helper_waits_while_blocked() {
  open_project 2>/dev/null
  coordinator_alive
  printf 'blocked\nidle\n' > "$STUB_STATE/wait-states"
  : > "$STUB_LOG"
  after_turn || ng "補助が失敗"
  [[ "$(grep -c '"wait","t100"' "$STUB_LOG")" -eq 2 ]] || ng "許可待ちの間に打った"
  logged '"t100","/clear"]'
}

test_handoff_helper_does_not_type_into_shell() {
  open_project 2>/dev/null
  # user が coordinator を終わらせ、terminal にシェルが残った形
  jq -n '{address: "t100", state: "live", status: {state: "idle"}, foreground: {argv: ["zsh"]}}' > "$STUB_STATE/get-t100.json"
  : > "$STUB_LOG"
  after_turn || ng "補助が失敗"
  not_logged '"send"'
}

test_handoff_helper_tells_when_clear_fails() {
  open_project 2>/dev/null
  coordinator_alive
  printf 'done\n' > "$STUB_STATE/wait-states"
  touch "$STUB_STATE/send-fails"
  : > "$STUB_LOG"
  fails after_turn
  logged '"t100","/clear"]'
  logged '[project-threads handoff] /clear を打てませんでした（hc send が失敗）'
  not_logged '会話を /clear しました'
}

# plugin の command は名前空間つきでしか通らないので、user は /pj-threads:handoff・/pj-threads:umbrella をそのまま打つ
test_plugin_commands_are_named_pj_threads() {
  local plugin="$BIN/../plugin"
  eq "pj-threads" "$(jq -r .name "$plugin/.claude-plugin/plugin.json")" "plugin の名前"
  eq "handoff.md umbrella.md" "$(ls "$plugin/commands" | tr '\n' ' ' | xargs)" "command のファイル"
  ! grep -rqE 'pj-(handoff|umb)' "$plugin" "$BIN" "$BIN/../prompts" "$BIN/../../README.md" || ng "古い command の名前が残っている"
  grep -qF '/pj-threads:handoff' "$BIN/../prompts/coordinator.md" || ng "prompt に /pj-threads:handoff が無い"
}

test_handoff_plugin_command_points_to_prompt() {
  local command="$BIN/../plugin/commands/handoff.md"
  [[ -f "$BIN/../plugin/.claude-plugin/plugin.json" && -f "$command" ]] || ng "plugin のファイルが無い"
  # 付けると、モデルが Skill ツールで呼び直したときに「手順を代わりに実行するな」と返され、手順を拒む
  ! grep -q 'disable-model-invocation' "$command" || ng "disable-model-invocation が付いている"
  grep -q '「会話の引き継ぎ」' "$command" || ng "command が prompt の手順を指していない"
  grep -q '^## 会話の引き継ぎ$' "$BIN/../prompts/coordinator.md" || ng "prompt に「会話の引き継ぎ」の節が無い"
}

test_umbrella_plugin_command_points_to_prompt() {
  local command="$BIN/../plugin/commands/umbrella.md"
  [[ -f "$command" ]] || ng "umbrella の command が無い"
  ! grep -q 'disable-model-invocation' "$command" || ng "disable-model-invocation が付いている"
  # 引数（owner/repo#番号・URL・--clear・空）を coordinator に渡す
  grep -qF '$ARGUMENTS' "$command" || ng "command が引数を渡していない"
  grep -q '「umbrella と次の一手」' "$command" || ng "command が prompt の手順を指していない"
  grep -q '^## umbrella と次の一手$' "$BIN/../prompts/coordinator.md" || ng "prompt に「umbrella と次の一手」の節が無い"
  grep -qF '/pj-threads:umbrella' "$BIN/../prompts/coordinator.md" || ng "prompt に /pj-threads:umbrella の扱いが無い"
}

# --- umbrella

# open を通さずに project のフォルダを作る（open は coordinator の起動まで動くので重い）
make_project() { # [project.json に足す jq の式]
  mkdir -p "$PROJECT/threads"
  jq -n "{name: \"demo\", coordinator: {terminal: \"t100\"}} ${1:+| $1}" > "$PROJECT/project.json"
  echo "ishiyu/demo" > "$STUB_STATE/gh-repo"
}

test_umbrella_registers_issue_of_project_repo() {
  make_project
  echo "通知を届ける" > "$STUB_STATE/gh-issue-title"
  local out
  out="$("$BIN/umbrella" "$PROJECT" ishiyu/demo#5)" || ng "登録に失敗した"
  eq "ishiyu/demo#5" "$(jq -r .umbrella "$PROJECT/project.json")" "umbrella"
  eq "通知を届ける" "$(jq -r .umbrellaTitle "$PROJECT/project.json")" "umbrellaTitle"
  eq "t100" "$(jq -r .coordinator.terminal "$PROJECT/project.json")" "ほかのフィールドが残る"
  logged '["gh","issue","view","5","-R","ishiyu/demo","--json","title","-q",".title"]'
  # issue の repo と比べるのは、project を置いた checkout の repo
  eq "$REPO" "$(cat "$STUB_STATE/gh-repo-cwd")" "gh repo view の作業フォルダ"
  [[ "$out" == *"ishiyu/demo#5「通知を届ける」"* ]] || ng "出力に umbrella が無い: $out"
}

test_umbrella_accepts_issue_url() {
  make_project
  echo "Ishiyu/Demo" > "$STUB_STATE/gh-repo"
  echo "題名" > "$STUB_STATE/gh-issue-title"
  "$BIN/umbrella" "$PROJECT" https://github.com/ishiyu/demo/issues/7/ >/dev/null || ng "URL で登録できない"
  eq "ishiyu/demo#7" "$(jq -r .umbrella "$PROJECT/project.json")" "umbrella"
}

test_umbrella_refuses_issue_of_other_repo() {
  make_project
  echo "題名" > "$STUB_STATE/gh-issue-title"
  fails "$BIN/umbrella" "$PROJECT" ishiyu/other#5
  [[ "$ERR" == *"ishiyu/other"*"ishiyu/demo"* ]] || ng "理由に 2 つの repo が無い: $ERR"
  eq "null" "$(jq -r .umbrella "$PROJECT/project.json")" "umbrella を書かない"
}

test_umbrella_refuses_unreadable_issue() {
  make_project
  fails "$BIN/umbrella" "$PROJECT" ishiyu/demo#999
  [[ "$ERR" == *"ishiyu/demo#999 の issue を読めません"* ]] || ng "理由が違う: $ERR"
  eq "null" "$(jq -r .umbrella "$PROJECT/project.json")" "umbrella を書かない"
}

test_umbrella_rejects_bad_input() {
  make_project
  fails "$BIN/umbrella" "$PROJECT" 5
  [[ "$ERR" == *"owner/repo#123"* ]] || ng "形の案内が無い: $ERR"
  fails "$BIN/umbrella" "$PROJECT" https://github.com/ishiyu/demo/pull/5
  fails "$BIN/umbrella" "$PROJECT"
  fails "$BIN/umbrella" "$T/nowhere" ishiyu/demo#5
  fails "$BIN/umbrella" "$PROJECT" ishiyu/demo#5 extra
  not_logged '"gh"'
}

test_umbrella_clear_removes_umbrella_and_result() {
  make_project '.umbrella = "ishiyu/demo#5" | .umbrellaTitle = "題名"'
  echo "前の結果" > "$PROJECT/next-actions.md"
  "$BIN/umbrella" "$PROJECT" --clear >/dev/null || ng "外せない"
  eq '{"name":"demo","coordinator":{"terminal":"t100"}}' "$(jq -c . "$PROJECT/project.json")" "project.json"
  [[ ! -e "$PROJECT/next-actions.md" ]] || ng "前の umbrella の結果が残っている"
  not_logged '"gh"'
}

test_umbrella_change_drops_previous_result() {
  make_project '.umbrella = "ishiyu/demo#5" | .umbrellaTitle = "前の題名"'
  echo "題名" > "$STUB_STATE/gh-issue-title"
  echo "前の結果" > "$PROJECT/next-actions.md"
  "$BIN/umbrella" "$PROJECT" ishiyu/demo#5 >/dev/null || ng "登録し直せない"
  [[ -e "$PROJECT/next-actions.md" ]] || ng "同じ umbrella の登録し直しで結果を消した"
  eq "題名" "$(jq -r .umbrellaTitle "$PROJECT/project.json")" "題名を取り直す"
  "$BIN/umbrella" "$PROJECT" ishiyu/demo#6 >/dev/null || ng "替えられない"
  [[ ! -e "$PROJECT/next-actions.md" ]] || ng "前の umbrella の結果が残っている"
}

# --- next-actions

NEXT_ACTIONS_OUTPUT='{"type":"result","is_error":false,"total_cost_usd":0.01536,"structured_output":{"actions":[
  {"mode":"AFK","action":"実装","issue":7,"humanTask":"","title":"Slice: 通知を送る","reason":"着手できる","command":"/implement-slice 7"},
  {"mode":"HITL","action":"人がやる","issue":8,"humanTask":"H1","title":"本番で確かめる","reason":"リリース後","command":""}
],"report":"## 投げれば回る（AFK）\n- 実装 #7 Slice: 通知を送る"}}'

test_next_actions_runs_in_project_repo_and_writes_report() {
  make_project '.umbrella = "ishiyu/demo#5" | .umbrellaTitle = "題名"'
  printf '%s\n' "$NEXT_ACTIONS_OUTPUT" > "$STUB_STATE/claude-print.json"
  local out args="$STUB_STATE/claude-print-args.json"
  out="$("$BIN/next-actions" "$PROJECT")" || ng "失敗した"
  eq "$REPO" "$(cat "$STUB_STATE/claude-print-cwd")" "claude -p の作業フォルダ"
  eq "/next-actions 5" "$(jq -r '.[1]' "$args")" "プロンプト"
  eq "haiku" "$(jq -r '.[index("--model") + 1]' "$args")" "モデル"
  eq "dontAsk" "$(jq -r '.[index("--permission-mode") + 1]' "$args")" "権限モード"
  eq "json" "$(jq -r '.[index("--output-format") + 1]' "$args")" "出力の形"
  eq '["actions","report"]' "$(jq -c '.[index("--json-schema") + 1] | fromjson | .required' "$args")" "出力の schema"
  eq "true" "$(jq '(index("--no-session-persistence") != null) and (index("--strict-mcp-config") != null)' "$args")" "セッションを残さず MCP を読まない"
  eq '["Bash","Read","Grep","Glob","Skill"]' "$(jq -c '.[index("--tools") + 1:index("--allowedTools")]' "$args")" "使えるツール"
  eq "true" "$(jq --arg scan "Bash($HOME/.claude/skills/next-actions/scripts/scan-subissues.sh:*)" \
    '.[index("--allowedTools") + 1:] | index($scan) != null and index("Bash(gh issue view:*)") != null' "$args")" "許すコマンド"
  eq "true" "$(jq '.[index("--append-system-prompt") + 1] | contains("ishiyu/demo#5")' "$args")" "追加の指示に umbrella"
  [[ "$out" == *"- 実装 #7 Slice: 通知を送る — 着手できる → /implement-slice 7"* ]] || ng "AFK の行が無い: $out"
  [[ "$out" == *"- 人がやる #8 H1 本番で確かめる — リリース後"* ]] || ng "HITL の行が無い: $out"
  [[ "$out" == *"全文: $PROJECT/next-actions.md"* ]] || ng "全文の場所が無い: $out"
  eq "# /next-actions ishiyu/demo#5" "$(head -n 1 "$PROJECT/next-actions.md")" "全文の見出し"
  grep -qF '$0.015' "$PROJECT/next-actions.md" || ng "全文に費用が無い"
  grep -qF -- '- 実装 #7 Slice: 通知を送る' "$PROJECT/next-actions.md" || ng "全文に報告が無い"
  [[ ! -e "$PROJECT/next-actions.lock" ]] || ng "実行中の印が残っている"
}

test_next_actions_without_actions() {
  make_project '.umbrella = "ishiyu/demo#5"'
  echo '{"is_error":false,"structured_output":{"actions":[],"report":"なし"}}' > "$STUB_STATE/claude-print.json"
  local out
  out="$("$BIN/next-actions" "$PROJECT")" || ng "失敗した"
  [[ "$out" == *"AFK（投げれば回る）: なし"*"HITL（人が座る）: なし"* ]] || ng "行が無いことを返していない: $out"
}

test_next_actions_fails_without_umbrella() {
  make_project
  fails "$BIN/next-actions" "$PROJECT"
  [[ "$ERR" == *"umbrella が登録されていません"* ]] || ng "理由が違う: $ERR"
  [[ ! -e "$STUB_STATE/claude-print-args.json" ]] || ng "claude -p を動かした"
}

test_next_actions_keeps_previous_report_on_failure() {
  make_project '.umbrella = "ishiyu/demo#5"'
  echo "前の結果" > "$PROJECT/next-actions.md"
  echo '{"is_error":true,"subtype":"error_max_turns","result":"上限に達した"}' > "$STUB_STATE/claude-print.json"
  echo 1 > "$STUB_STATE/claude-print-exit"
  fails "$BIN/next-actions" "$PROJECT"
  [[ "$ERR" == *"error_max_turns"*"上限に達した"* ]] || ng "失敗の理由が無い: $ERR"
  eq "前の結果" "$(cat "$PROJECT/next-actions.md")" "前の全文を残す"
  [[ ! -e "$PROJECT/next-actions.lock" ]] || ng "実行中の印が残っている"
}

test_next_actions_rejects_unexpected_output() {
  make_project '.umbrella = "ishiyu/demo#5"'
  echo '{"is_error":false,"structured_output":{"actions":[{"mode":"SOON","issue":7}],"report":"x"}}' > "$STUB_STATE/claude-print.json"
  fails "$BIN/next-actions" "$PROJECT"
  [[ "$ERR" == *"決めた形"* ]] || ng "理由が違う: $ERR"
  echo 'not json' > "$STUB_STATE/claude-print.json"
  fails "$BIN/next-actions" "$PROJECT"
  [[ "$ERR" == *"not json"* ]] || ng "出力を添えていない: $ERR"
  [[ ! -e "$PROJECT/next-actions.md" ]] || ng "全文を書いた"
}

test_next_actions_refuses_while_running() {
  make_project '.umbrella = "ishiyu/demo#5"'
  mkdir "$PROJECT/next-actions.lock"
  fails "$BIN/next-actions" "$PROJECT"
  [[ "$ERR" == *"実行中"* ]] || ng "理由が違う: $ERR"
  [[ ! -e "$STUB_STATE/claude-print-args.json" ]] || ng "claude -p を動かした"
  [[ -d "$PROJECT/next-actions.lock" ]] || ng "ほかの実行の印を消した"
}

test_next_actions_ignores_stale_lock() {
  make_project '.umbrella = "ishiyu/demo#5"'
  printf '%s\n' "$NEXT_ACTIONS_OUTPUT" > "$STUB_STATE/claude-print.json"
  # 打ち切りの時間を過ぎて残った印は、途中で止まった実行の残り
  mkdir "$PROJECT/next-actions.lock"
  touch -t 202601010000 "$PROJECT/next-actions.lock"
  "$BIN/next-actions" "$PROJECT" >/dev/null || ng "古い印で止まった"
}

test_next_actions_rejects_bad_input() {
  make_project '.umbrella = "ishiyu/demo#5"'
  fails "$BIN/next-actions"
  fails "$BIN/next-actions" "$T/nowhere"
  fails "$BIN/next-actions" "$PROJECT" extra
  make_project '.umbrella = "#5"'
  fails "$BIN/next-actions" "$PROJECT"
  [[ "$ERR" == *"読めません"* ]] || ng "理由が違う: $ERR"
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
