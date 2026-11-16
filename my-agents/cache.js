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

// claude が working を抜けた時刻を memo に覚える。memo: address -> { turn, at, src }。at は working を抜けた時刻（ms）
// turn（hc の、status が working を抜けるたびに 1 増える数）を見て決める。terminals() の status_ms は使わない。
// mod の terminals() の status_ms は app の起動時の値のまま更新されず、起動の後にできた terminal では null だった（2026-11-16）
//   - "seen": この mod が動いている間に turn が増えたのを見た。見た時刻が抜けた時刻（描き直しは terminal の変化で起きるので、遅れはほぼ無い）
//   - "hc": この mod が動く前に抜けていた（起動の直後や、前の起動から turn が進んでいた）。`hc get` の status_ms を後から入れる（applyHc）
// watched はこの mod が動き始めてから見た address（memo は再起動をまたいで残るが、こちらは残さない）。
// 返り値: changed は memo を変えたか、ask は `hc get` で問い合わせる必要があるか
export function noteCache(memo, t, now, watched) {
  if (!isClaude(t)) return { changed: false, ask: false };
  const address = t.address;
  const turn = int(t.turn);
  const prev = memo[address];
  const seenBefore = watched.has(address);
  watched.add(address);
  let next = prev;
  let ask = false;
  if (turn === null || turn === 0) next = { turn, at: null, src: null };
  else if (t.status === "working") next = { turn, at: prev?.at ?? null, src: prev?.src ?? null };
  else if (prev?.turn === turn && prev.at != null) next = prev;
  else if (seenBefore && prev?.turn != null && prev.turn !== turn) next = { turn, at: now, src: "seen" };
  else [next, ask] = [{ turn, at: null, src: null }, true];
  const changed = !prev || prev.turn !== next.turn || prev.at !== next.at || prev.src !== next.src;
  if (changed) memo[address] = next;
  return { changed, ask };
}

// `hc get <address> --json` の結果を入れる。問い合わせの間に turn が進んでいたら、次の描き直しで noteCache が見るので入れない
export function applyHc(memo, address, h) {
  const m = memo[address];
  const state = typeof h?.status === "object" ? h.status?.state : h?.status;
  if (!m || m.at != null || int(h?.turn) !== m.turn || state === "working" || !Number.isFinite(h?.status_ms)) return false;
  memo[address] = { turn: m.turn, at: h.status_ms, src: "hc" };
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
  if (m?.at == null) return { kind: "unknown", turn: int(t.turn), err: m?.err ?? null };
  return { kind: "until", until: m.at + ttl, src: m.src };
}

const SRC = { hc: "hc get の時刻", seen: "mod が見た時刻" };

// 行に出す丸と hover の文。null は丸を出さない
export function cacheLook(state, now) {
  if (!state) return null;
  if (state.kind === "working") return { glyph: "●", tip: "cache: 応答中（要求のたびに延びる）" };
  // working を抜けた時刻がまだ無い（hc get の答え待ちか、失敗）。丸が出ないまま気づかない形にしないため、印を出して理由を hover で読ませる
  if (state.kind === "unknown") {
    const why = state.turn === null ? "terminals() に turn が無い" : state.err ? `hc get が失敗した: ${state.err}` : "hc get の答えを待っている";
    return { glyph: "?", tip: `cache: 分からない（${why}）` };
  }
  const left = state.until - now;
  const src = SRC[state.src] ?? state.src;
  return {
    glyph: cacheGlyph(left),
    tip: left > 0 ? `cache 残り ${Math.ceil(left / 60000)} 分（1h と仮定・${src}）` : `cache cold（1h と仮定・${src}）`,
  };
}
