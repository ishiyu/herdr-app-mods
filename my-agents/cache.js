// claude の会話の prompt cache が cold になるまでの残り時間を、行の丸にする。herdr に依存させず、node のテストから読めるようにしてある。
//
// 会話の本体の cache の TTL は 1 時間で、要求の開始から数え、cache を読むだけでも延びる。working 中は要求のたびに延び直すので、
// cold になる時刻は「claude が working を抜けた時刻 + 1 時間」で推定する。statusline の prompt_cache.expires_at（Claude Code 自身の値）は読まない。
// そのため、席を外して約 3 分後に Claude Code が作る away_summary の延長を拾わず約 3 分早く出し、利用枠の超過で TTL が 5 分に落ちると長く出す。

export const TTL_MS = 60 * 60000;

// 残りがこの分を超えていればこの丸。user の指定「残り 60 分で ●、45 分で ◕、30 分で ◑、15 分で ◔、0 分で ◯」に合わせ、境目ちょうどは次の段に入れる。
// TTL によらず分で切るので、TTL が 5 分の cache なら最初から ◔ になる
const STEPS = [[45, "●"], [30, "◕"], [15, "◑"], [0, "◔"]];

export function cacheGlyph(left) {
  for (const [min, glyph] of STEPS) if (left > min * 60000) return glyph;
  return "◯";
}

// claude の terminal か。program は app の program 表の key、app と report.app は claude が OSC 7501 で名乗った名前
// （agents() は app、terminals() は status の記録を report に持つ）
export const isClaude = (t) => t?.program?.key === "claude" || t?.app === "claude-code" || t?.report?.app === "claude-code";

const int = (v) => (Number.isInteger(v) ? v : null);

// hc の terminal（terminals() の 1 件）から、claude が working を抜けた時刻を覚える。
// memo: address -> { status, turn, at, src }。at は working を抜けた時刻（ms）、src はその出どころ
//   - "hc": hc の status_ms。turn（status が working を抜けるたびに 1 増える）が増えたときの status_ms が抜けた時刻。
//     許可待ちのあと断って done になったときのように、working を通らない変化では turn が増えないので、上書きしない
//   - "seen": mod 自身が status の working から別の語への変わり目を見た時刻。terminals() が status_ms・turn を持たないときの代わり
// 返り値は memo を変えたか
export function noteCache(memo, t, now) {
  if (!isClaude(t)) return false;
  const prev = memo[t.address];
  const turn = int(t.turn);
  const ms = Number.isFinite(t.status_ms) ? t.status_ms : null;
  let at = prev?.at ?? null;
  let src = prev?.src ?? null;
  if (t.status !== "working") {
    if (turn !== null && ms !== null) {
      if (turn === 0) [at, src] = [null, null];
      else if (prev?.turn !== turn || src !== "hc") [at, src] = [ms, "hc"];
    } else if (prev?.status === "working") [at, src] = [now, "seen"];
  }
  const next = { status: t.status ?? null, turn, at, src };
  if (prev && prev.status === next.status && prev.turn === next.turn && prev.at === next.at && prev.src === next.src) return false;
  memo[t.address] = next;
  return true;
}

// 一覧から消えて 1 日たったものを忘れる。terminals() は起動の直後に空なので、一覧に無いだけでは消さない
export function pruneCache(memo, live, now) {
  for (const [address, m] of Object.entries(memo)) if (!live.has(address) && now - (m.at ?? 0) > 86400000) delete memo[address];
}

// 行の cache の状態。null は丸を出さない（claude でない、まだ 1 度も要求していない）。
// 後から statusline の値（label）を読む形を足すなら、ここに出どころを足す
export function cacheState(t, memo, ttl = TTL_MS) {
  if (!isClaude(t)) return null;
  if (t.status === "working") return { kind: "working" };
  if (int(t.turn) === 0) return null;
  const m = memo[t.address];
  if (m?.at == null) return { kind: "unknown" };
  return { kind: "until", until: m.at + ttl, src: m.src };
}

const SRC = { hc: "hc の時刻", seen: "mod が見た時刻" };

// 行に出す丸と hover の文。null は丸を出さない
export function cacheLook(state, now) {
  if (!state) return null;
  if (state.kind === "working") return { glyph: "●", tip: "cache: 応答中（要求のたびに延びる）" };
  // terminals() に status_ms・turn が無く、working の終わりもまだ見ていない。丸が出ないまま気づかない形にしないため、印を出して理由を hover で読ませる
  if (state.kind === "unknown") return { glyph: "?", tip: "cache: 分からない（hc の status_ms・turn が無く、working の終わりをまだ見ていない）" };
  const left = state.until - now;
  const src = SRC[state.src] ?? state.src;
  return {
    glyph: cacheGlyph(left),
    tip: left > 0 ? `cache 残り ${Math.ceil(left / 60000)} 分（1h と仮定・${src}）` : `cache cold（1h と仮定・${src}）`,
  };
}
