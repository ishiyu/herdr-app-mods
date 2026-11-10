#!/usr/bin/env bash
# project-threads のテスト。bin/ のスクリプトは hc・claude・herdr-app・gh を偽物（stubs/）に差し替えて、
# 渡した引数と書いたファイルを確かめる。cleanup の git は本物を一時フォルダの repo に対して動かす。一覧の状態の判定（state.js）は node のテストで確かめる。
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
  eq "[\"Bash($BIN/start *)\",\"Bash($BIN/message *)\",\"Bash($BIN/relay *)\"]" "$(jq -r '.[index("--settings") + 1] | fromjson | .permissions.allow | tojson' "$args")" "許可リスト"
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

# --- cleanup

# 仕事の repo（main に 1 コミット）に、thread が作った形の worktree（ブランチ tmp/<slug>）を作ってパスを返す
git_q() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"; }
make_worktree() { # <slug>
  if [[ ! -d "$T/work" ]]; then
    git init -q -b main "$T/work"
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
