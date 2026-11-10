// 行に出す名前の決め方。herdr に依存させず、node のテストから読めるようにしてある。

// program が terminal の題名の先頭に付ける状態の記号（claude の ✳ や回転する点字など）を落とす
export const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// 題名が何かを言っているか。program 名そのものや、シェルが出す cwd・user@host は言っていない
export function telling(live, program) {
  return Boolean(live) && live !== program?.name && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== program?.key;
}

// pane を持たない子（hc run で起動された terminal。terminals() の 1 件）の行の名前。
// 人が付けた名前、テンプレート名、program が出した題名、program 名の順に使う。
// 題名を program 名より先に見るのは、名前もテンプレートも無い claude の子がどれも「Claude Code」になり、見分けがつかないため
// （project-threads の thread は、claude の --name で `<project>/<id> <題名>` を題名に出している）
// cwd の判定は記号を落とす前の題名で見る。clean は `~/` も落とすので、落とした後では cwd と見分けられない
// `parent` は親の行に出ている名前。題名の行頭の繰り返しを落とすのに使う（unrepeated）
export function kidLabel(k, parent = "") {
  const raw = (k.title ?? "").trim();
  const live = clean(raw);
  const shown = telling(raw, k.program) && telling(live, k.program) ? live : "";
  return k.name || k.template || unrepeated(shown, parent) || k.program?.name || k.address;
}

// 語に使う文字。`project:pj-mod` の `:` や空白・`/` は語を区切る
const WORD = "\\p{L}\\p{N}_.-";

// 題名の行頭の `<語>/` を、その語が親の行の名前に 1 語として出ているときだけ落とす。
// 子の行は親の行のすぐ下に並ぶので、親が `project:pj-mod` なら子の `pj-mod/t009 …` の `pj-mod/` は読まなくても分かり、狭い行の幅だけを食う。
// 語の一部が重なるだけ（親が `pj-mod-old`）や、`/` の後ろが空のときは落とさない
export function unrepeated(label, parent) {
  const m = new RegExp(`^([${WORD}]+)/(?=\\S)`, "u").exec(label);
  if (!m) return label;
  const words = (parent ?? "").split(new RegExp(`[^${WORD}]+`, "u"));
  return words.includes(m[1]) ? label.slice(m[0].length) : label;
}
