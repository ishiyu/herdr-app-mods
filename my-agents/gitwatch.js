// .git の下の変更のうち、行に出す branch と ahead/behind を変えうるものの見分け方。
// herdr に依存させず、node のテストから読めるようにしてある。

// 行に出すのは branch（HEAD）と ahead/behind（refs と upstream の設定）だけなので、
// index や objects が変わっても表示は変わらない。そこで git status を走らせ直さない
const FILES = new Set(["HEAD", "packed-refs", "config"]);
const TREES = new Set(["refs", "reftable"]);

// path は watchFolder が返した絶対パス、repo は見張っている .git（git-common-dir）
export function affectsBranch(path, repo) {
  // 溜まりすぎた通知は root 1 件にまとめて返る。何が変わったか分からないので取り直す
  if (path === repo) return true;
  // repo の外に見えるパス（別名で返ってきたなど）は分類できないので、取りこぼさない側に倒す
  if (!path.startsWith(`${repo}/`)) return true;
  // git は X.lock に書いてから X に改名する。通知がどちらの名前で来ても X の変更として扱う
  const parts = path.slice(repo.length + 1).replace(/\.lock$/, "").split("/");
  const [top] = parts;
  if (TREES.has(top)) return true;
  if (parts.length === 1) return FILES.has(top) || top === "worktrees";
  // worktree の追加・削除（worktrees/<名前> ごと増減する）と、その worktree の branch の切り替え
  if (top === "worktrees") return parts.length === 2 || (parts.length === 3 && parts[2] === "HEAD");
  return false;
}

export const anyAffectsBranch = (paths, repo) => paths.some((p) => affectsBranch(p, repo));
