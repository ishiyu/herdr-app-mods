# stub が共有する関数。run.sh と、PATH から実行された stub が source する。
# shellcheck shell=bash
#
# テストは Microsoft Defender などの Endpoint Security の検査を受け、新しいプロセスの起動と、書いて閉じたファイルが
# 重い。stub は 1 件のテストで数十回呼ばれるので、記録と応答でプロセスを起動せず、記録のファイルも開き直さない。

# 引数を JSON の文字列の配列（jq -c と同じ形）にして REPLY に入れる。プロセスを起動しない。
# \ " 改行 タブ CR 以外の制御文字は jq と同じ書き方にするのが手間なので、そのときだけ jq に任せる
stub_json_array() {
  local out="" s
  for s in "$@"; do
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\r'/\\r}"
    if [[ "$s" =~ [[:cntrl:]] ]]; then
      REPLY="$(jq -cn '$ARGS.positional' --args -- "$@")"
      return
    fi
    out+="${out:+,}\"$s\""
  done
  REPLY="[$out]"
}

# 1 つの文字列を JSON の文字列にして REPLY に入れる
stub_json_string() {
  stub_json_array "$1"
  REPLY="${REPLY:1:${#REPLY}-2}"
}

# 呼ばれた引数を $STUB_LOG に 1 行で足す。setup が記録のファイルを fd 9 に開いておけば、それに書く
# （1 回ごとにファイルを開いて閉じると、閉じるたびに検査される）。fd 9 が無ければファイルを開いて足す
stub_log() {
  stub_json_array "$@"
  if [[ -n "${STUB_LOG_FD9:-}" ]]; then
    printf '%s\n' "$REPLY" >&9
  else
    printf '%s\n' "$REPLY" >> "$STUB_LOG"
  fi
}

# ファイルの中身を stdout に出す。cat を起動しない
stub_cat() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do printf '%s\n' "$line"; done < "$1"
}
