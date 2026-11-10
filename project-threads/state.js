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

// 一覧の上に並べるタブ。開いたときは先頭（user が動かないと進まない thread）を選ぶ
export const TABS = ["要対応", "作業中", "対応完了", "待ち"];

// 見出しをどのタブに入れるか。local-projects の数の判定（claude-tools の plugins/local-projects/hooks/project.ts の
// COUNT_LETTERS。b → 要対応、w → 作業中、i → 対応完了か待ち）に合わせるが、waiting の報告は CI などの待ちの件数がタブで分かるよう、作業中（local-projects では w）でなく待ちに入れる。
// 停止はふつう done の後で、続きを頼むかは coordinator が決めるので、要対応でなく対応完了に入れる
const TAB_OF = {
  "許可待ち": "要対応",
  "エラー": "要対応",
  "あなた待ち": "要対応",
  "行き詰まり": "要対応",
  "作業中": "作業中",
  "待機中": "待ち",
  "未報告": "待ち",
  "報告済み": "対応完了",
  "停止": "対応完了",
};

export function tabOf(group) {
  return TAB_OF[group];
}

// タブごとの thread の数。0 件のタブも消さずに出すので、全部のタブを持つ
export function tabCountsOf(rows) {
  const counts = Object.fromEntries(TABS.map((tab) => [tab, 0]));
  for (const row of rows) counts[tabOf(row.group)] += 1;
  return counts;
}

export function tabLabel(tab, count) {
  return `${tab}(${count})`;
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

// 動いている thread の terminal のうち、記録（threads/<id>/thread.json）をまだ読めていないものの thread の id。
// bin/start は terminal が状態を報告するのを待ってから thread.json を書くので、その報告をきっかけに読み直すと
// thread.json が間に合わない。その後に terminal の変化が無い（作業が続いて報告もしない）と、signatureOf だけでは
// 読み直すきっかけが来ず、一覧に出ないままになる
export function unreadThreadIds(project, terminals, threads) {
  const prefix = `${project}/threads/`;
  const known = new Set(threads.map((x) => x.id));
  return terminals
    .filter((x) => x.state === "live" && (x.cwd ?? "").startsWith(prefix))
    .map((x) => x.cwd.slice(prefix.length).split("/")[0])
    .filter((id) => /^t\d+$/.test(id) && !known.has(id));
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
