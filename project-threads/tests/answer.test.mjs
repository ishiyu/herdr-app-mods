import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_MARK, choicesOf, withChoice, answerLine, answerStateFor, submitNewlineAt, isSendingFor, answerDraftFor } from "../answer.js";

const QUESTION = `# 色を選んでください

## 選択肢

### A: 赤
- 得るもの: 目立つ

### B：青 ###
- 得るもの: 落ち着く

### C 黄（区切りが無いので選択肢にしない）

## 推奨
A
`;

test("choicesOf: 「### A: <案の名前>」から記号と名前を取る（全角のコロンも読む）", () => {
  assert.deepEqual(choicesOf(QUESTION), [{ key: "A", name: "赤" }, { key: "B", name: "青" }]);
});

test("choicesOf: 同じ記号は最初のものだけ、<!-- --> の中は読まない、選択肢の無い質問は空", () => {
  assert.deepEqual(choicesOf("### A: 一\n<!--\n### B: 例\n-->\n### A: 二\n"), [{ key: "A", name: "一" }]);
  assert.deepEqual(choicesOf("# 値を教えてください\n\n## 答えてほしいこと\n"), []);
  assert.deepEqual(choicesOf(null), []);
});

test("withChoice: 先頭に記号を入れ、前に選んだ記号は置き換えて補足を残す", () => {
  assert.equal(withChoice("", "A"), "A。");
  assert.equal(withChoice("急ぎで", "A"), "A。急ぎで");
  assert.equal(withChoice("A。急ぎで", "B"), "B。急ぎで");
  assert.equal(withChoice("A: 急ぎで", "B"), "B。急ぎで");
  assert.equal(withChoice("A", "B"), "B。");
  // 記号で始まる英単語は記号とみなさない
  assert.equal(withChoice("API を先に", "A"), "A。API を先に");
});

test("answerLine: id と答えを 1 行にし、末尾に回答欄の印を付ける", () => {
  assert.equal(answerLine("t052", "A。急ぎで"), `t052 は A。急ぎで${ANSWER_MARK}`);
  assert.equal(ANSWER_MARK, "（一覧の回答欄から）");
});

test("answerLine: 改行は「 / 」でつなぎ、空の行と前後の空白は落とす", () => {
  assert.equal(answerLine("t001", "  B。\n理由は二つ\n\n 一つ目 \n"), `t001 は B。 / 理由は二つ / 一つ目${ANSWER_MARK}`);
});

// submit を受けた時点の値とキャレット（⌘Enter が改行を入れた後）から、改行を消した値を作る。main.js の submit の処理と同じ手順
function dropSubmitNewline(value, range) {
  const at = submitNewlineAt(value, range);
  return at === null ? value : value.slice(0, at) + value.slice(at + 1);
}

test("submitNewlineAt: 文の途中で ⌘Enter を押して入った改行を見つけ、消すと送る 1 行に「 / 」が入らない", () => {
  // 「A。理由|は二つ」の | で ⌘Enter → 「A。理由\n|は二つ」
  const value = "A。理由\nは二つ";
  assert.equal(submitNewlineAt(value, { start: 5, end: 5 }), 4);
  assert.equal(dropSubmitNewline(value, { start: 5, end: 5 }), "A。理由は二つ");
  assert.equal(answerLine("t001", dropSubmitNewline(value, { start: 5, end: 5 })), `t001 は A。理由は二つ${ANSWER_MARK}`);
});

test("submitNewlineAt: 末尾で ⌘Enter を押して入った改行を見つける", () => {
  assert.equal(submitNewlineAt("B。急ぎで\n", { start: 6, end: 6 }), 5);
  assert.equal(dropSubmitNewline("B。急ぎで\n", { start: 6, end: 6 }), "B。急ぎで");
});

test("submitNewlineAt: Enter で入れた改行は ⌘Enter の 1 つだけを消して残す", () => {
  // 「B。\n理由は二つ|」の | で ⌘Enter → 「B。\n理由は二つ\n|」
  assert.equal(dropSubmitNewline("B。\n理由は二つ\n", { start: 9, end: 9 }), "B。\n理由は二つ");
  // 空の行の上で ⌘Enter → 直前の 1 つだけを消す
  assert.equal(dropSubmitNewline("B。\n\n", { start: 4, end: 4 }), "B。\n");
});

test("submitNewlineAt: 位置は UTF-16 の単位（サロゲートペアの文字の後ろでもずれない）", () => {
  const value = "A。🍣\nうまい";
  assert.equal(value.indexOf("\n"), 4);
  assert.equal(submitNewlineAt(value, { start: 5, end: 5 }), 4);
});

test("submitNewlineAt: キャレットの直前が改行でない・範囲を選んでいる・先頭・値が無いときは null", () => {
  // 「送る」のボタンからではなく、改行が入らずに submit が来たときにほかの文字を消さない
  assert.equal(submitNewlineAt("A。急ぎで", { start: 5, end: 5 }), null);
  assert.equal(submitNewlineAt("A。\n急ぎで", { start: 3, end: 5 }), null);
  assert.equal(submitNewlineAt("\nA", { start: 0, end: 0 }), null);
  assert.equal(submitNewlineAt(undefined, { start: 1, end: 1 }), null);
  assert.equal(submitNewlineAt("A\n", null), null);
});

test("answerLine: 中身が無ければ null", () => {
  assert.equal(answerLine("t001", ""), null);
  assert.equal(answerLine("t001", " \n \n"), null);
  assert.equal(answerLine("t001", undefined), null);
});

test("answerStateFor: 送った質問のままのあいだは送れた状態を出す", () => {
  const sent = { id: "t001", kind: "sent", text: "", at: 1, question: "# 1 問目（全 2 問中 1 問目）\n" };
  assert.equal(answerStateFor(sent, { id: "t001", question: "# 1 問目（全 2 問中 1 問目）\n" }), sent);
});

test("answerStateFor: question.md が次の問いに書き直されたか回答済みになったら、送れた状態を出さない", () => {
  const sent = { id: "t001", kind: "sent", text: "", at: 1, question: "# 1 問目（全 2 問中 1 問目）\n" };
  assert.equal(answerStateFor(sent, { id: "t001", question: "# 2 問目（全 2 問中 2 問目）\n" }), null);
  assert.equal(answerStateFor(sent, { id: "t001", question: null }), null);
});

test("answerStateFor: 別の thread・状態なし・thread なしは null、送信中と失敗は質問が変わっても出す", () => {
  const sending = { id: "t001", kind: "sending", text: "", question: "# 1 問目\n" };
  const error = { id: "t001", kind: "error", text: "回答欄が空です" };
  assert.equal(answerStateFor(sending, { id: "t002", question: "# 1 問目\n" }), null);
  assert.equal(answerStateFor(null, { id: "t001", question: "# 1 問目\n" }), null);
  assert.equal(answerStateFor(sending, undefined), null);
  assert.equal(answerStateFor(sending, { id: "t001", question: "# 2 問目\n" }), sending);
  assert.equal(answerStateFor(error, { id: "t001", question: "# 2 問目\n" }), error);
});

test("isSendingFor: その thread の答えを送信中のときだけ true（入力欄・選択肢・送るを止める）", () => {
  const sending = { id: "t001", kind: "sending", text: "", question: "# 1 問目\n", value: "A。急ぎで" };
  assert.equal(isSendingFor(sending, "t001"), true);
  assert.equal(isSendingFor(sending, "t002"), false);
  assert.equal(isSendingFor({ ...sending, kind: "sent" }, "t001"), false);
  assert.equal(isSendingFor({ ...sending, kind: "error", text: "x" }, "t001"), false);
  assert.equal(isSendingFor(null, "t001"), false);
});

test("answerDraftFor: 送信中か送れなかった答えは、その thread の質問を開き直したときに送ろうとした文を戻す", () => {
  const sending = { id: "t001", kind: "sending", text: "", question: "# 1 問目\n", value: "A。\n急ぎで" };
  assert.equal(answerDraftFor(sending, "t001"), "A。\n急ぎで");
  assert.equal(answerDraftFor({ ...sending, kind: "error", text: "coordinator が blocked です" }, "t001"), "A。\n急ぎで");
});

test("answerDraftFor: 別の thread・送れた後・空で送ろうとした失敗・状態なしは空", () => {
  const sent = { id: "t001", kind: "sent", text: "", at: 1, question: "# 1 問目\n", value: "A。" };
  assert.equal(answerDraftFor(sent, "t001"), "");
  assert.equal(answerDraftFor({ ...sent, kind: "sending" }, "t002"), "");
  assert.equal(answerDraftFor({ id: "t001", kind: "error", text: "回答欄が空です" }, "t001"), "");
  assert.equal(answerDraftFor(null, "t001"), "");
});
