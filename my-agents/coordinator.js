// coordinator（project-threads の bin/open が起動した claude）の行に出す、project の thread の状態ごとの数。
// herdr に依存させず、node のテストから読めるようにしてある。
// 数は project-threads の一覧のタブの件数と同じにするため、判定は thread-state.js（project-threads/state.js の写し）をそのまま使う。
// mod は自分のフォルダの外を import できないので写しを置く（tests/coordinator.test.mjs が元と同じ中身かを検査する）
import { TABS, rowsOf, tabCountsOf } from "./thread-state.js";

// project のフォルダ（<repo>/.local/hc-projects/<名前>。project-threads の find_projects と同じ置き場所）と、その下の thread のフォルダ
const PROJECT = /^(.+\/\.local\/hc-projects\/[^/]+)(?:\/threads\/t\d+)?\/?$/;

// agent（`address`）が coordinator を務める project のフォルダ。違えば null。
// 子の terminal（parent がその agent）の作業フォルダで見る。子は hc run --cwd で起動され（thread は threads/<id>、報告の遅れの
// 見張りは project のフォルダ）、作業フォルダが変わらない。coordinator 自身の terminal の cwd は、bin/open を打ったシェルの
// 場所が残っていて別の project を指すことがある（2026-11-19 の実測）ので使わない。
// 子が別々の project を指していれば、多いほう（同数なら先に出たほう）にする。
// ほかのマシンの agent（`vps/t7`）は、threads/ がそのマシンにあってこの mod から読めないので数えない
export function projectOf(address, all) {
  if (address.includes("/")) return null;
  const seen = new Map();
  for (const k of all) {
    if (k.parent !== address || k.state !== "live") continue;
    const m = PROJECT.exec(k.cwd ?? "");
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  let best = null;
  for (const [project, n] of seen) if (best === null || n > seen.get(best)) best = project;
  return best;
}

// 一覧のタブの順（要対応・作業中・待ち・対応完了）に並べた thread の数。threads は readThreads の結果、all は terminals()
export function threadCounts(threads, all) {
  const counts = tabCountsOf(rowsOf(threads, all));
  return TABS.map((tab) => counts[tab]);
}

// 行に出す形（0 の項目も 0 で出す）と、hover で出す各数の意味
export const countsLabel = (counts) => counts.join("/");
export const countsTip = (counts) => TABS.map((tab, i) => `${tab} ${counts[i]}`).join(" / ");

// project の threads/ の thread を読む。一覧（project-threads/main.js の read）と同じ読み方にする:
// threads/ の直下の t<数字> だけ（片付けた .deleted/ は見ない）、thread.json がまだ無いものは飛ばす。
// io: { readdir（fs/promises）, readTextFile（herdr。無いファイルは null） }
export async function readThreads(project, { readdir, readTextFile }) {
  const dir = `${project}/threads`;
  const ids = (await readdir(dir)).filter((name) => /^t\d+$/.test(name)).sort();
  const threads = [];
  for (const id of ids) {
    const meta = await readTextFile(`${dir}/${id}/thread.json`);
    if (meta === null) continue;
    const report = await readTextFile(`${dir}/${id}/status.json`);
    const question = await readTextFile(`${dir}/${id}/question.md`);
    threads.push({ ...JSON.parse(meta), report: report === null ? null : JSON.parse(report), question });
  }
  return threads;
}
