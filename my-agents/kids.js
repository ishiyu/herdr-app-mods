// agent の行の下に並べる子の行の決め方。herdr に依存させず、node のテストから読めるようにしてある。

// asking は Needs you の次で、作業中より先に色に出す。project-threads の一覧でも要対応のタブは作業中より上に並ぶ
const RANK = { blocked: 5, asking: 4, done: 3, working: 2, idle: 1 };

// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
export const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

// project-threads の thread が bin/report で terminal に付ける報告のラベル（labels.report）のうち、人の対応を待っているもの。
// 一覧（project-threads）の要対応のタブに入る「あなた待ち」（needs-you）と「行き詰まり」（blocked）
const ASKING = new Set(["needs-you", "blocked"]);

// 子の行の印と畳みの数の色に使う状態。kidStatus に asking（報告のラベルで人の対応を待っている）を足したもの。
// 作業中と Needs you をラベルより先に見るのは、project-threads の一覧（state.js の groupOf）と同じ順にするため。
// 質問のファイル（threads/<id>/question.md）は読まない（user の決定）。そのため、一覧が質問のファイルで要対応に入れる thread
// （done の報告の後に coordinator が質問を書いた、入力でラベルが消えた後も質問が残っている、など）は asking にならない。
// ラベルは thread への入力のたびに hook が消すので、答えを送れば asking でなくなる。
// Needs you の判定（kidRows と permission-notify の通知）には入れない
export const kidLook = (k, listed) => {
  const s = kidStatus(k, listed);
  return s !== "working" && s !== "blocked" && ASKING.has(k.labels?.report) ? "asking" : s;
};

// `subs`（tree() の結果。深さ優先で、各行に罫線の lines）のうち、行に出す子と、畳みの印で数える子。
// 開いているときは全部を出す。畳んでいるときも Needs you（kidStatus が blocked）の子だけは出し、残りを hidden にする。
// Needs you の子を畳みの中に隠すと、user の対応が要るのに見落とすため。
// 出す子は孫も 1 段に並べ直す。間の子は畳みの中なので、元の深さの罫線では繋がる先の行が無い
export function kidRows(subs, folded, listed) {
  if (!folded) return { rows: subs, hidden: [] };
  const urgent = subs.filter((s) => kidStatus(s.t, listed) === "blocked");
  return {
    rows: urgent.map((s, i) => ({ t: s.t, lines: [i === urgent.length - 1 ? "└" : "├"] })),
    hidden: subs.filter((s) => kidStatus(s.t, listed) !== "blocked"),
  };
}

// 子のうちいちばん急ぐ状態（kidLook）。畳みの数をこの色で出す。子が無ければ null
export function mostUrgent(subs, listed) {
  return subs.map((s) => kidLook(s.t, listed)).reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
}
