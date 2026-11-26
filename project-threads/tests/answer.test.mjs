import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_MARK, choicesOf, withChoice, answerLine, answerStateFor } from "../answer.js";

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

test("answerLine: 改行は「 / 」でつなぎ、空の行と前後の空白（⌘Enter の改行）は落とす", () => {
  assert.equal(answerLine("t001", "  B。\n理由は二つ\n\n 一つ目 \n"), `t001 は B。 / 理由は二つ / 一つ目${ANSWER_MARK}`);
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
