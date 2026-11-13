// thread の行をどの見出しに入れ、何を出すかを決める。herdr に依存させず、node のテストから読めるようにしてある。

// 一覧に出す順。人の対応が要るものを上に置く
export const GROUPS = ["許可待ち", "エラー", "あなた待ち", "行き詰まり", "作業中", "待機中", "未報告", "報告済み", "停止"];

const BY_REPORT = { "needs-you": "あなた待ち", blocked: "行き詰まり", waiting: "待機中", done: "報告済み" };

// terminal: thread の claude が動いている terminal（terminals() の 1 件）。動いていなければ null。
// 作業中は前の報告より優先する（報告のあとに追加の依頼を受けて動いている）。
// question: coordinator が書いた未回答の質問（threads/<id>/question.md）があるか。terminal が消えても（マシンの再起動など）
// user の答えを待っているので、停止でなくあなた待ちに入れる（message は止まった thread を再開してから答えを送る）
export function groupOf(terminal, question = false) {
  if (!terminal) return question ? "あなた待ち" : "停止";
  if (terminal.status === "blocked") return "許可待ち";
  if (terminal.status === "error") return "エラー";
  if (terminal.status === "working") return "作業中";
  return BY_REPORT[terminal.labels?.report] ?? "未報告";
}

// 一覧の上に並べるタブ。開いたときは先頭（user が動かないと進まない thread）を選ぶ。
// 対応完了は見返すことが少ないので末尾に置く
export const TABS = ["要対応", "作業中", "待ち", "対応完了"];

// タブの色（theme() の色の名前）。user の希望（要対応 = オレンジ、作業中と待ち = 黄、対応完了 = 緑）に近いものを選ぶ。
// theme にオレンジは無く、いちばん近いのが blocked（暗い theme で珊瑚色、paper で赤）。
// done は青なので、緑には端末の緑（ansi2）を使う。どれも明暗の theme ごとに読める値が入っている
const TAB_COLOR = { "要対応": "blocked", "作業中": "working", "待ち": "working", "対応完了": "ansi2" };

export function tabColorOf(tab) {
  return TAB_COLOR[tab];
}

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

// watchFolder(<project>/threads) が返した変更のうち、読み直すきっかけにするもの。どれも terminal の変化を伴わないので、
// signatureOf では拾えない。
// - 質問（question.md）の書き込みと回答済みへの移動。coordinator が Write で書く
// - thread のフォルダそのものの出入り。bin/cleanup は terminal を終わらせて消してから threads/<id> を .deleted/ へ移すので、
//   terminal の変化での読み直しは移す前を読み、片付けた thread が次の terminal の変化まで一覧に残る。
//   移動は元（threads/<id>）と先（threads/.deleted/<id>）の両方のパスで届く（FSEvents の実測）。フォルダの中のファイルの変化では読み直さない
// 束に threads/ そのものが入っていれば、溢れて取りこぼした変更があるので読み直す
export function threadsChanged(project, paths) {
  const root = `${project}/threads`;
  return paths.some((p) => p.replace(/\/+$/, "") === root
    || /\/threads\/t\d+\/question\.md$/.test(p)
    || /\/threads\/(?:\.deleted\/)?t\d+\/?$/.test(p));
}

// thread ごとに、動いている terminal・見出し・要約を付け、見出しの順（同じ見出しの中は新しい id が上）に並べる
export function rowsOf(threads, terminals) {
  return threads
    .map((thread) => {
      const terminal = terminals.find((x) => x.address === thread.terminal && x.state === "live") ?? null;
      return { thread, terminal, group: groupOf(terminal, hasQuestion(thread)), summary: summaryOf(terminal, thread.report) };
    })
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || b.thread.id.localeCompare(a.thread.id));
}

// 未回答の質問。coordinator が thread の blocked / needs-you の報告を受けて threads/<id>/question.md に書き、
// 回答済みにすると（bin/close-question。message と report も呼ぶ）threads/<id>/questions/ へ移る。thread.question はその中身
export function hasQuestion(thread) {
  return typeof thread?.question === "string";
}

export function questionCount(threads) {
  return threads.filter(hasQuestion).length;
}

// 行に出す質問の一言。最初の見出しの文字（無ければ最初の空でない行）
export function questionTitleOf(text) {
  if (typeof text !== "string") return "";
  const lines = text.replace(/<!--[\s\S]*?(-->|$)/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines.map(headingOf).find(Boolean);
  return heading ? heading[1] : (lines[0] ?? "");
}

export function questionLabel(count) {
  return `質問 ${count}`;
}

// 行を押したときに pane の中で詳細（質問か最後の報告）を開くか。開かない行は、これまでどおり thread の画面を重ねて開く。
// 許可待ちとエラーは画面で答える・見るものなので画面を開く。terminal の無い行は画面を開けないので詳細を開く
export function opensDetail(group, terminal) {
  return group === "あなた待ち" || group === "行き詰まり" || !terminal;
}

// 詳細に出すもの。want は user が選んだ側（"question" か "report"）で、無い側を選んでいればもう一方を出す。
// 質問も報告の写しも無ければ、status.json の要約だけを出す（"summary"）。報告の写しの無い古い thread がある
export function detailKindOf(thread, want) {
  const question = hasQuestion(thread);
  const report = typeof thread?.report?.detail === "string";
  if (want === "report" && report) return "report";
  if (question) return "question";
  return report ? "report" : "summary";
}

// 報告の写し（detail）の無い報告を詳細に出すときの Markdown
export function reportSummaryText(report) {
  if (!report) return "報告はまだありません。";
  return `**${report.status}**（${report.at}）\n\n${report.summary}\n\nこの報告には詳細のファイルがありません。`;
}

// TextView の id に含める本文の指紋。同じ id のまま本文が変わったときに描き直されるかが分からないので、本文ごとに id を変える
export function textKey(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 最後の報告の時点の context の大きさ（status.json の contextTokens）を、claude の statusline と同じ丸めで書く。
// 上限（context の窓）は会話の記録に無いので、使用率にはしない。bin/_lib.sh の format_tokens と揃える
export function contextLabel(tokens) {
  if (typeof tokens !== "number") return "";
  if (tokens >= 100000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`;
  return String(tokens);
}

// 一覧のヘッダに出す umbrella（project.json の umbrella と、bin/umbrella が登録した時点の題名）。無ければ空文字
export function umbrellaLabel(config) {
  if (typeof config?.umbrella !== "string") return "";
  return [config.umbrella, typeof config.umbrellaTitle === "string" ? config.umbrellaTitle : ""].filter(Boolean).join(" ");
}

export function age(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// 自律的にやってよいこと・確認すること。全 project 共通は ~/.config/project-threads/rules.md、repo 固有は
// <repo の元の checkout>/.local/hc-projects/repo-rules.md。どちらも見出し 2 つの Markdown で、user が手で書く
export const POLICY_ALLOW = "自律的にやってよいこと";
export const POLICY_CONFIRM = "確認すること";

// 見出しの行なら [深さ, 文字]、そうでなければ null
function headingOf(line) {
  const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  return m ? [m[1].length, m[2]] : null;
}

// 欄の本文の行を項目にする。「- 」「* 」「1. 」で始まる行が 1 項目で、字下げした続きの行はその項目に足す。箇条書きでない行も 1 項目にする
function itemsOf(lines) {
  const items = [];
  for (const line of lines) {
    // 欄の中の小見出しは項目にしない（下の項目は拾う）
    if (!line.trim() || headingOf(line)) continue;
    const bullet = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) items.push(bullet[1].trim());
    else if (/^\s/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
    else items.push(line.trim());
  }
  return items.filter(Boolean);
}

// 「## <title>」の下の行（次の ## か # まで）。見出しが無ければ空
function sectionLines(lines, title) {
  const start = lines.findIndex((line) => {
    const h = headingOf(line);
    return h && h[0] === 2 && h[1] === title;
  });
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const h = headingOf(line);
    return h && h[0] <= 2;
  });
  return end < 0 ? rest : rest.slice(0, end);
}

// repo-rules.md の中身（無ければ null）から 2 つの欄の項目を取る。<!-- --> の中（雛形の説明と例）は数えない
export function rulesOf(text) {
  if (typeof text !== "string") return { allow: [], confirm: [] };
  const lines = text.replace(/<!--[\s\S]*?(-->|$)/g, "").split("\n");
  return { allow: itemsOf(sectionLines(lines, POLICY_ALLOW)), confirm: itemsOf(sectionLines(lines, POLICY_CONFIRM)) };
}

// project が扱う repo の元の checkout。project を置いた repo（<repo>/.local/hc-projects/<名前>）を先頭に、
// thread の worktrees.txt に記録された worktree（<repo>=tmp-<slug>）の元の repo を、出てきた順に重ねずに並べる
export function policyReposOf(project, worktreeTexts) {
  const repos = [project.replace(/\/\.local\/hc-projects\/[^/]+\/?$/, "")];
  for (const text of worktreeTexts) {
    for (const line of (text ?? "").split("\n")) {
      const path = line.trim().replace(/\/+$/, "");
      if (!path.startsWith("/")) continue;
      const slash = path.lastIndexOf("/");
      const name = path.slice(slash + 1);
      const repo = name.includes("=") ? path.slice(0, slash + 1) + name.slice(0, name.indexOf("=")) : path;
      if (!repos.includes(repo)) repos.push(repo);
    }
  }
  return repos;
}

export function policyCount(policies) {
  return policies.reduce((n, p) => n + p.allow.length + p.confirm.length, 0);
}

export function policyLabel(count) {
  return count > 0 ? `方針 ${count}` : "方針 未設定";
}
