// 一覧の質問の画面の回答欄が使う、herdr に依存しない部分。node のテストから読む。
// state.js に置かないのは、state.js を変えると my-agents の写し（thread-state.js）と my-agents の置き直しも要るため
// （my-agents は回答欄を使わない）

// 送る 1 行の末尾に付ける印。coordinator の prompt（「user に判断を仰ぐ」）が、この形でも user の答えとして受ける
export const ANSWER_MARK = "（一覧の回答欄から）";

// question.md の選択肢（coordinator の prompt の雛形の「### A: <案の名前>」）を [{ key: "A", name: "<案の名前>" }] で返す。
// 同じ記号が 2 回出たら最初のものを使う。<!-- --> の中は読まない
export function choicesOf(text) {
  if (typeof text !== "string") return [];
  const choices = [];
  for (const line of text.replace(/<!--[\s\S]*?(-->|$)/g, "").split("\n")) {
    const m = /^###\s+([A-Z])\s*[:：]\s*(.*?)\s*#*\s*$/.exec(line.trim());
    if (m && !choices.some((c) => c.key === m[1])) choices.push({ key: m[1], name: m[2] });
  }
  return choices;
}

// 回答欄の先頭を選んだ記号にする。先頭に別の記号（「B」「B。」「B: 」など）があれば置き換え、補足は残す
export function withChoice(value, key) {
  const rest = (value ?? "").replace(/^\s*[A-Z](?:\s*[。、.:：]|\s+|$)\s*/, "");
  return `${key}。${rest}`;
}

// 回答欄の送信の状態（{ id, kind, question, ... }）のうち、いまの thread に出してよいもの。無ければ null。
// 送れた状態（sent）は、送ったときの質問の文（question）がいまの question.md と同じあいだだけ出す。coordinator は次の問いを
// 同じパスの question.md に書き直す（thread の次の報告、1 つの報告の問いを 1 問ずつ出すとき）ので、id だけで見ると、
// まだ答えていない次の問いにも「回答を送信済み」が出る
export function answerStateFor(state, thread) {
  if (!state || !thread || state.id !== thread.id) return null;
  if (state.kind === "sent" && state.question !== thread.question) return null;
  return state;
}

// ⌘Enter で回答欄に入った改行の位置（UTF-16 の単位）。無ければ null。
// 複数行の入力欄（gpui-base の Textarea）は ⌘Enter でもキャレットの位置に改行を入れ、キャレットをその後ろに置いてから submit を呼ぶ。
// 文の途中で押すと、その改行が送る 1 行の「 / 」になり、入力欄にも残るので、submit を受けたらこの位置の 1 文字を消す。
// range は submit を受けたときの selected_range()。範囲を選んでいる（start と end が違う）ときは改行を入れた直後ではないので触らない
export function submitNewlineAt(value, range) {
  if (typeof value !== "string" || !range || range.start !== range.end) return null;
  const at = range.start - 1;
  return at >= 0 && value[at] === "\n" ? at : null;
}

// 回答欄の文を、coordinator に送る 1 行にする。改行はそのまま送ると Claude Code が貼り付けた文（<pasted_content>）として包むので、
// 行を「 / 」でつなぐ。空の行は落とす。中身が無ければ null
export function answerLine(id, value) {
  const body = (value ?? "").split("\n").map((line) => line.trim()).filter(Boolean).join(" / ");
  return body ? `${id} は ${body}${ANSWER_MARK}` : null;
}
