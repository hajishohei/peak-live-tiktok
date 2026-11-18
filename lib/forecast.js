// 当月の売上着地予想（POST /api/query { mode: "forecast" }）。
// 売上を「MICALLE商品」と「それ以外（通常商品）」に完全に分けて予想する。変数は「トクトクの長さ」と「MICALLE期間の有無」。
//
// ① 通常商品 = 昨日までの実績 + 残り日数 × 通常日の1日平均 + 残りのトクトク日 × 通常日の1日平均 × 上乗せ率 × 期間補正
//      上乗せ率 … 過去のトクトク（7日以内の回）で「トクトク日の1日平均 ÷ その月の通常日の1日平均 − 1」（通常商品のみ）の中央値
//      期間補正 … 7日以内の回は 悲観0.85／標準1.00／楽観1.15
//                8日以上の長い回は、過去の長い回の実績（上乗せ率 ÷ 短い回の中央値）を標準とし、悲観−0.15／楽観+0.15。
//                長い回の実績がなければ 0.70／0.85／1.00
// ② MICALLE = 今月の実績 + 今月始まるMICALLE期間の残りの見込み
//      見込み … 過去のMICALLE期間（開始日〜終了日の7日後まで）のMICALLE商品の売上の 少ない回／平均／多い回
// 着地 = ① + ②。売上の定義はダッシュボードと同じ（顧客支払額＋TikTok負担クーポン − 返金額、キャンセル・未払いは除く）。

// トクトクの日程。2026年5月以降は事業部の連絡（2026-11-18）、それ以前は公開情報。
// kind: "sale"=トクトクSALE / "thanks"=トクトク大感謝祭（規模が違うので上乗せ率に使わない）
export const DEFAULT_SALES = {
  "2025-10": { start: "2025-10-27", end: "2025-10-31", kind: "sale" },
  "2025-11": { start: "2025-11-25", end: "2025-11-28", kind: "sale" },
  "2025-12": { start: "2025-12-22", end: "2025-12-29", kind: "thanks" },
  "2026-01": { start: "2026-01-26", end: "2026-01-30", kind: "sale" },
  "2026-03": { start: "2026-03-20", end: "2026-03-26", kind: "sale" },
  "2026-04": { start: "2026-04-17", end: "2026-04-21", kind: "sale" },
  "2026-05": { start: "2026-05-27", end: "2026-05-29", kind: "sale" },
  "2026-06": { start: "2026-06-23", end: "2026-06-30", kind: "thanks" },
  "2026-07": { start: "2026-07-17", end: "2026-07-27", kind: "sale" },
  "2026-08": { start: "2026-08-26", end: "2026-08-31", kind: "sale" },
  "2026-09": { start: "2026-09-25", end: "2026-09-30", kind: "sale" },
  "2026-10": { start: "2026-10-22", end: "2026-10-26", kind: "sale" },
  "2026-11": { start: "2026-11-19", end: "2026-11-29", kind: "sale" },
};
// MICALLE期間（事業部の連絡）。キーは開始日の月。その月の売上として見込む
export const DEFAULT_MICALLE = {
  "2026-02": { start: "2026-02-24", end: "2026-02-27" },
  "2026-04": { start: "2026-04-22", end: "2026-04-24" },
  "2026-06": { start: "2026-06-23", end: "2026-06-26" },
  "2026-09": { start: "2026-09-29", end: "2026-10-02" },
};
export const LONG_SALE_DAYS = 8;
export const MICALLE_TAIL_DAYS = 7; // 期間後もしばらく売れる分を含める
const MICALLE_RE = /MICALLE|\[M[MARXF][A-Z]\d{3}|\b(MAH|MAK|MAG|MXH|MRI|MRH|MRA|MRM|MME|MMD|MMB|MMK|MMJ|MXE|MFF)\d{3}/i;
export const isMicalleProduct = (name) => MICALLE_RE.test(String(name || ""));

const dayList = (start, end) => { const out = []; for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse(end + "T00:00:00Z"); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const monthDays = (m) => { const [y, mo] = m.split("-").map(Number); return dayList(`${m}-01`, new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)); };
const prevMonth = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7); };
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const sum = (days, map) => days.reduce((s, d) => s + (map[d] || 0), 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
export const mergeSales = (cfg) => { const o = { ...DEFAULT_SALES }; for (const [k, v] of Object.entries((cfg && cfg.sales) || {})) { if (v) o[k] = v; else delete o[k]; } return o; };
export const mergeMicalle = (cfg) => { const o = { ...DEFAULT_MICALLE }; for (const [k, v] of Object.entries((cfg && cfg.micallePeriods) || {})) { if (v) o[k] = v; else delete o[k]; } return o; };

// core / mic: { "YYYY-MM-DD": 売上 }（通常商品 / MICALLE商品）。cfg: { sales, micallePeriods, dataStart }
export function computeForecast({ core, mic, cfg, today, month }) {
  const sales = mergeSales(cfg), mics = mergeMicalle(cfg);
  const dataStart = cfg.dataStart || today;
  const inSale = (m, d) => { const s = sales[m]; return !!(s && d >= s.start && d <= s.end); };
  const complete = (m) => monthDays(m).slice(-1)[0] < today && monthDays(m).filter((d) => d >= dataStart).length >= 20;

  // 過去のトクトク（通常商品だけで効果を測る）
  const saleHistory = [];
  for (const m of Object.keys(sales).sort()) {
    const s = sales[m];
    if (m >= month || s.kind !== "sale" || s.start < dataStart || !complete(m)) continue;
    const ds = monthDays(m).filter((d) => d >= dataStart);
    const tok = ds.filter((d) => inSale(m, d)), non = ds.filter((d) => !inSale(m, d));
    const tokAvg = avg(tok.map((d) => core[d] || 0)), nonAvg = avg(non.map((d) => core[d] || 0));
    if (!nonAvg) continue;
    saleHistory.push({ month: m, start: s.start, end: s.end, days: tok.length, long: tok.length >= LONG_SALE_DAYS, tokAvg: Math.round(tokAvg), nonAvg: Math.round(nonAvg), uplift: r3(tokAvg / nonAvg - 1) });
  }
  const shortUps = saleHistory.filter((h) => !h.long).map((h) => h.uplift);
  const longUps = saleHistory.filter((h) => h.long).map((h) => h.uplift);
  const uplift = median(shortUps.length ? shortUps : saleHistory.map((h) => h.uplift));
  const longStd = longUps.length && uplift > 0 ? Math.min(1.2, Math.max(0.4, median(longUps) / uplift)) : 0.85;

  // 過去のMICALLE期間
  const micHistory = [];
  for (const [m, p] of Object.entries(mics).sort()) {
    const tailEnd = addDays(p.end, MICALLE_TAIL_DAYS);
    if (tailEnd >= today || p.start < dataStart) continue;
    micHistory.push({ month: m, start: p.start, end: p.end, sales: Math.round(sum(dayList(p.start, tailEnd), mic)) });
  }
  const micVals = micHistory.map((h) => h.sales);
  const micExp = micVals.length ? { pessimistic: Math.min(...micVals), standard: Math.round(avg(micVals)), optimistic: Math.max(...micVals) } : { pessimistic: 0, standard: 0, optimistic: 0 };

  // 今月
  const all = monthDays(month);
  const past = all.filter((d) => d < today), rest = all.filter((d) => d >= today);
  const sale = sales[month] || null;
  const saleLen = sale ? dayList(sale.start, sale.end).length : 0;
  const long = saleLen >= LONG_SALE_DAYS;
  const coreActual = sum(past, core), micActual = sum(past, mic);
  let normalPast = past.filter((d) => !inSale(month, d));
  let baseline = avg(normalPast.map((d) => core[d] || 0)), baselineFrom = "今月の通常日（通常商品）";
  if (!normalPast.length) {
    const pm = prevMonth(month);
    normalPast = monthDays(pm).filter((d) => !inSale(pm, d) && d >= dataStart);
    baseline = avg(normalPast.map((d) => core[d] || 0)); baselineFrom = "先月の通常日（通常商品）";
  }
  const restSale = rest.filter((d) => inSale(month, d)).length;
  const factors = long
    ? { pessimistic: r3(Math.max(0, longStd - 0.15)), standard: r3(longStd), optimistic: r3(longStd + 0.15) }
    : { pessimistic: 0.85, standard: 1.00, optimistic: 1.15 };
  const micPeriod = mics[month] || null;
  let micSoFar = 0;
  if (micPeriod) micSoFar = sum(dayList(micPeriod.start, addDays(micPeriod.end, MICALLE_TAIL_DAYS)).filter((d) => d < today), mic);

  const scenarios = {};
  for (const k of Object.keys(factors)) {
    const saleExtra = baseline * uplift * factors[k] * restSale;
    const coreTotal = coreActual + baseline * rest.length + saleExtra;
    const micAdd = micPeriod ? Math.max(0, micExp[k] - micSoFar) : 0;
    scenarios[k] = { factor: factors[k], total: Math.round(coreTotal + micActual + micAdd), core: Math.round(coreTotal), micalle: Math.round(micActual + micAdd), saleExtra: Math.round(saleExtra), micAdd: Math.round(micAdd) };
  }
  return {
    ok: true, month, today,
    sale: sale ? { ...sale, days: saleLen, long } : null, micalle: !!micPeriod, micPeriod,
    actual: Math.round(coreActual + micActual), coreActual: Math.round(coreActual), micActual: Math.round(micActual),
    daysPast: past.length, daysRest: rest.length, restSale,
    baseline: Math.round(baseline), baselineFrom, baselineDays: normalPast.length,
    uplift: r3(uplift), longFactorFromData: longUps.length > 0, longStd: r3(longStd),
    scenarios, saleHistory, micHistory,
  };
}

// ===== 予実の振り返り（月が終わってから） =====
// 毎日の予想（snapshot）を保存しておき、月が終わったら実績と比べて、ズレを3つの理由に分ける。
//   ① 通常日のペース … 残りの通常日に実際に売れた額 − 予想（通常日の1日平均 × 日数）
//   ② トクトク     … 残りのトクトク日に実際に売れた額 − 予想（通常日の1日平均 ×（1 + 上乗せ率 × 期間補正）× 日数）
//   ③ MICALLE     … 残りの期間に実際に売れたMICALLE − 予想（MICALLEの見込み − 予想時点の実績）
//   ①＋②＋③ ＝ 実際の着地 − 予想（標準）。予想時点までの実績は両方に同じだけ入るのでズレには出ない。
export function snapshotOf(fc) {
  return {
    date: fc.today, baseline: fc.baseline, uplift: fc.uplift, factor: fc.scenarios.standard.factor,
    sale: fc.sale ? { start: fc.sale.start, end: fc.sale.end, days: fc.sale.days } : null,
    micalle: fc.micalle, micTarget: fc.scenarios.standard.micalle, micActual: fc.micActual,
    total: { pessimistic: fc.scenarios.pessimistic.total, standard: fc.scenarios.standard.total, optimistic: fc.scenarios.optimistic.total },
  };
}
export function computeReview({ core, mic, month, snapshots, sales }) {
  const days = monthDays(month);
  const inSale = (d) => { const s = sales[month]; return !!(s && d >= s.start && d <= s.end); };
  const actualTotal = sum(days, core) + sum(days, mic);
  const normal = days.filter((d) => !inSale(d)), tok = days.filter((d) => inSale(d));
  const normalAvg = avg(normal.map((d) => core[d] || 0)), tokAvg = avg(tok.map((d) => core[d] || 0));
  const actualUplift = tok.length && normalAvg ? tokAvg / normalAvg - 1 : null;
  const list = (snapshots || []).filter((s) => s.date.slice(0, 7) === month).sort((a, b) => a.date.localeCompare(b.date));
  // 振り返る時点：最初の予想・トクトク開始前日の予想・月末前の最後の予想
  const pick = [];
  if (list.length) pick.push({ label: "最初の予想", s: list[0] });
  const sale = sales[month];
  if (sale) { const pre = list.filter((s) => s.date < sale.start).pop(); if (pre && !pick.some((p) => p.s === pre)) pick.push({ label: "トクトク開始前の予想", s: pre }); }
  if (list.length > 1 && !pick.some((p) => p.s === list[list.length - 1])) pick.push({ label: "最後の予想", s: list[list.length - 1] });
  const points = pick.map(({ label, s }) => {
    const rest = days.filter((d) => d >= s.date);
    const sIn = (d) => !!(s.sale && d >= s.sale.start && d <= s.sale.end);
    const restNormal = rest.filter((d) => !sIn(d)), restSale = rest.filter((d) => sIn(d));
    const pace = sum(restNormal, core) - s.baseline * restNormal.length;
    const saleGap = sum(restSale, core) - s.baseline * (1 + s.uplift * s.factor) * restSale.length;
    const micGap = sum(rest, mic) - Math.max(0, (s.micalle ? s.micTarget : s.micActual) - s.micActual);
    const diff = actualTotal - s.total.standard;
    const reasons = [];
    const big = (v) => Math.abs(v) >= Math.max(30000, Math.abs(diff) * 0.2);
    if (big(pace)) reasons.push(`通常日のペースが予想より${pace > 0 ? "良かった" : "悪かった"}（実際の1日平均 ${Math.round(restNormal.length ? sum(restNormal, core) / restNormal.length : 0).toLocaleString()}円／予想 ${s.baseline.toLocaleString()}円）`);
    if (big(saleGap)) reasons.push(`トクトクの伸びが予想より${saleGap > 0 ? "大きかった" : "小さかった"}（実際の上乗せ率 ${actualUplift == null ? "—" : Math.round(actualUplift * 100) + "%"}／予想 ${Math.round(s.uplift * s.factor * 100)}%）`);
    if (sale && s.sale && (sale.start !== s.sale.start || sale.end !== s.sale.end)) reasons.push(`トクトクの日程が予想時点と変わった（${s.sale.start}〜${s.sale.end} → ${sale.start}〜${sale.end}）`);
    if (big(micGap)) reasons.push(`MICALLEの売上が予想より${micGap > 0 ? "多かった" : "少なかった"}`);
    if (!reasons.length) reasons.push("大きなズレはなし（3つの理由とも小さい）");
    return { label, date: s.date, forecast: s.total.standard, range: [s.total.pessimistic, s.total.optimistic], diff: Math.round(diff), diffRate: s.total.standard ? Math.round((diff / s.total.standard) * 1000) / 10 : null, withinRange: actualTotal >= s.total.pessimistic && actualTotal <= s.total.optimistic, pace: Math.round(pace), sale: Math.round(saleGap), micalle: Math.round(micGap), reasons };
  });
  return { ok: true, month, actual: Math.round(actualTotal), normalAvg: Math.round(normalAvg), actualUplift: actualUplift == null ? null : Math.round(actualUplift * 1000) / 1000, micActual: Math.round(sum(days, mic)), points, snapshots: list.length };
}
