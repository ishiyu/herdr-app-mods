import { test } from "node:test";
import assert from "node:assert/strict";
import { affectsBranch, anyAffectsBranch } from "../gitwatch.js";

const repo = "/Users/me/src/app/.git";
const at = (rel) => affectsBranch(`${repo}/${rel}`, repo);

test("affectsBranch: branch の切り替えと commit・fetch・push は取り直す", () => {
  assert.equal(at("HEAD"), true);
  assert.equal(at("refs/heads/main"), true);
  assert.equal(at("refs/heads/feat/deep/name"), true);
  assert.equal(at("refs/remotes/origin/main"), true);
  assert.equal(at("packed-refs"), true);
  assert.equal(at("reftable/tables.list"), true);
});

test("affectsBranch: upstream の付け替え（config）は ahead/behind を変えるので取り直す", () => {
  assert.equal(at("config"), true);
});

test("affectsBranch: lock ファイルは、改名後の名前の変更として扱う", () => {
  assert.equal(at("HEAD.lock"), true);
  assert.equal(at("refs/heads/main.lock"), true);
  assert.equal(at("packed-refs.lock"), true);
  assert.equal(at("index.lock"), false);
  assert.equal(at("worktrees/app=feat-x/index.lock"), false);
});

test("affectsBranch: index・objects・logs など表示に出ないものは取り直さない", () => {
  assert.equal(at("index"), false);
  assert.equal(at("objects/ab/cdef0123"), false);
  assert.equal(at("objects/pack/pack-1.pack"), false);
  assert.equal(at("logs/HEAD"), false);
  assert.equal(at("logs/refs/heads/main"), false);
  assert.equal(at("COMMIT_EDITMSG"), false);
  assert.equal(at("FETCH_HEAD"), false);
  assert.equal(at("ORIG_HEAD"), false);
  assert.equal(at("hooks/pre-commit"), false);
  assert.equal(at("modules/sub/HEAD"), false);
});

test("affectsBranch: worktree の追加・削除と、その worktree の branch の切り替えは取り直す", () => {
  assert.equal(at("worktrees"), true);
  assert.equal(at("worktrees/app=feat-x"), true);
  assert.equal(at("worktrees/app=feat-x/HEAD"), true);
});

test("affectsBranch: worktree の index や logs は取り直さない", () => {
  assert.equal(at("worktrees/app=feat-x/index"), false);
  assert.equal(at("worktrees/app=feat-x/logs/HEAD"), false);
  assert.equal(at("worktrees/app=feat-x/ORIG_HEAD"), false);
  assert.equal(at("worktrees/app=feat-x/refs/bisect/bad"), false);
});

test("affectsBranch: root そのもの（通知が溜まりすぎた合図）は取り直す", () => {
  assert.equal(affectsBranch(repo, repo), true);
});

test("affectsBranch: repo の外に見えるパスは、分類できないので取り直す", () => {
  assert.equal(affectsBranch("/private/var/other/.git/index", repo), true);
  assert.equal(affectsBranch(`${repo}-backup/index`, repo), true);
});

test("anyAffectsBranch: 1 件でも当たれば取り直し、全部外れなら取り直さない", () => {
  assert.equal(anyAffectsBranch([`${repo}/index`, `${repo}/refs/heads/main`], repo), true);
  assert.equal(anyAffectsBranch([`${repo}/index`, `${repo}/objects/ab/cd`], repo), false);
  assert.equal(anyAffectsBranch([], repo), false);
});
