// agent の行の下に並べる子の行の決め方。herdr に依存させず、node のテストから読めるようにしてある。

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
export const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
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

// 子のうちいちばん急ぐ状態。畳みの数をこの色で出す。子が無ければ null
export function mostUrgent(subs, listed) {
  return subs.map((s) => kidStatus(s.t, listed)).reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
}
