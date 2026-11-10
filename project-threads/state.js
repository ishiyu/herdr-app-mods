// thread の行をどの見出しに入れ、何を出すかを決める。herdr に依存させず、node のテストから読めるようにしてある。

// 一覧に出す順。人の対応が要るものを上に置く
export const GROUPS = ["許可待ち", "エラー", "あなた待ち", "行き詰まり", "作業中", "待機中", "未報告", "報告済み", "停止"];

const BY_REPORT = { "needs-you": "あなた待ち", blocked: "行き詰まり", waiting: "待機中", done: "報告済み" };

// terminal: thread の claude が動いている terminal（terminals() の 1 件）。動いていなければ null。
// 作業中は前の報告より優先する（報告のあとに追加の依頼を受けて動いている）
export function groupOf(terminal) {
  if (!terminal) return "停止";
  if (terminal.status === "blocked") return "許可待ち";
  if (terminal.status === "error") return "エラー";
  if (terminal.status === "working") return "作業中";
  return BY_REPORT[terminal.labels?.report] ?? "未報告";
}

// 行に出す要約。thread に入力があるとラベルが消えるので、ラベルと時刻の合わない古い報告は出さない。
// 止まった thread には最後の報告を出す（続きを頼むかの手がかりになる）
export function summaryOf(terminal, report) {
  if (!report) return "";
  if (!terminal) return `最後の報告 ${report.status}: ${report.summary}`;
  return terminal.labels?.["report.at"] === report.at ? report.summary : "";
}

// thread の terminal の増減・状態・報告の時刻をまとめた文字列。変わったときだけ threads/ を読み直す
export function signatureOf(project, terminals) {
  const prefix = `${project}/threads/`;
  return JSON.stringify(
    terminals
      .filter((x) => (x.cwd ?? "").startsWith(prefix))
      .map((x) => [x.address, x.state, x.status ?? null, x.labels?.["report.at"] ?? null]),
  );
}

// thread ごとに、動いている terminal・見出し・要約を付け、見出しの順（同じ見出しの中は新しい id が上）に並べる
export function rowsOf(threads, terminals) {
  return threads
    .map((thread) => {
      const terminal = terminals.find((x) => x.address === thread.terminal && x.state === "live") ?? null;
      return { thread, terminal, group: groupOf(terminal), summary: summaryOf(terminal, thread.report) };
    })
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || b.thread.id.localeCompare(a.thread.id));
}

export function age(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
