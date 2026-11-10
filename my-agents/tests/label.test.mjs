import { test } from "node:test";
import assert from "node:assert/strict";
import { kidLabel, telling, clean } from "../label.js";

const claude = { key: "claude", name: "Claude Code" };
const zsh = { key: "shell", name: "zsh" };
const kid = (more = {}) => ({ address: "t7t", parent: "t5b", state: "live", name: null, template: null, title: "", program: claude, ...more });

test("kidLabel: 名前もテンプレートも無い claude の子は、claude が出した題名（thread の id と題名）を出す", () => {
  assert.equal(kidLabel(kid({ title: "pj-mod/t012 sidebar の thread の行に id と題名を出す" })), "pj-mod/t012 sidebar の thread の行に id と題名を出す");
});

test("kidLabel: 題名の先頭の状態の記号は落とす", () => {
  assert.equal(kidLabel(kid({ title: "✳ pj-mod/t009 tests/run.sh を軽くする" })), "pj-mod/t009 tests/run.sh を軽くする");
  assert.equal(kidLabel(kid({ title: "⠂ pc-slow/t001 診断" })), "pc-slow/t001 診断");
});

test("kidLabel: 人が付けた名前とテンプレート名は題名より先", () => {
  assert.equal(kidLabel(kid({ name: "reviewer-1", title: "pj-mod/t001 x" })), "reviewer-1");
  assert.equal(kidLabel(kid({ template: "reviewer", title: "pj-mod/t001 x" })), "reviewer");
});

test("kidLabel: 題名が無い・何も言わないときは、これまでどおり program 名、それも無ければ address", () => {
  assert.equal(kidLabel(kid({ title: "" })), "Claude Code");
  assert.equal(kidLabel(kid({ title: undefined })), "Claude Code");
  assert.equal(kidLabel(kid({ title: "✳ Claude Code" })), "Claude Code");
  assert.equal(kidLabel(kid({ program: zsh, title: "~/ghq/github.com/ishiyu" })), "zsh");
  assert.equal(kidLabel(kid({ program: zsh, title: "y.ishida@host:~" })), "zsh");
  assert.equal(kidLabel(kid({ program: null, title: "" })), "t7t");
});

test("telling / clean: タブの題名の判定は従来どおり", () => {
  assert.equal(clean("✳ 題名 "), "題名");
  assert.equal(clean(null), "");
  assert.equal(telling("", claude), false);
  assert.equal(telling("Claude Code", claude), false);
  assert.equal(telling("claude", claude), false);
  assert.equal(telling("/tmp", zsh), false);
  assert.equal(telling("C:\\Users", zsh), false);
  assert.equal(telling("#673の対応方法", claude), true);
});
