// 今月の売上着地予想（POST /api/query { mode: "forecast" }）。
// 売上を「MICALLE商品」と「それ以外（通常商品）」に完全に分けて予想する。
//   MICALLEの販売時期はトクトクSALEと重ならないことも多いため、トクトクの効果は通常商品だけで測る。
//
// ① 通常商品の着地 = 昨日までの実績 + 残り日数 × 通常日の1日平均 + 残りのトクトク日 × 通常日の1日平均 × 上乗せ率 × 期間補正
//      上乗せ率 … 過去のトクトクSALEで「トクトク日の1日平均 ÷ その月の通常日の1日平均 − 1」（通常商品のみ）の平均
//      期間補正 … いつもの長さ（7日以下）なら 悲観0.85／標準1.00／楽観1.15。
//                8日以上の長いセールは1日あたりの効果が薄まるので 悲観0.70／標準0.85／楽観1.00
// ② MICALLEの着地 = MICALLEを売る月なら、過去のMICALLE月の販売額（少ない月／平均／多い月）。売らない月は今月の実績のみ
// 着地 = ① + ②。売上の定義はダッシュボードと同じ（顧客支払額＋TikTok負担クーポン − 返金額、キャンセル・未払いは除く）。

// トクトクSALEの日程（公開情報）。kind: "sale"=トクトクSALE / "thanks"=トクトク大感謝祭（規模が違うので上乗せ率に使わない）
export const DEFAULT_SALES = {
  "2025-10": { start: "2025-10-27", end: "2025-10-31", kind: "sale" },
  "2025-11": { start: "2025-11-25", end: "2025-11-28", kind: "sale" },
  "2025-12": { start: "2025-12-22", end: "2025-12-29", kind: "thanks" },
  "2026-01": { start: "2026-01-26", end: "2026-01-30", kind: "sale" },
  "2026-03": { start: "2026-03-20", end: "2026-03-26", kind: "sale" },
  "2026-04": { start: "2026-04-17", end: "2026-04-21", kind: "sale" },
  "2026-06": { start: "2026-06-23", end: "2026-06-30", kind: "thanks" },
  "2026-07": { start: "2026-07-16", end: "2026-07-19", kind: "sale" },
  "2026-08": { start: "2026-08-25", end: "2026-08-30", kind: "sale" },
  "2026-09": { start: "2026-09-25", end: "2026-09-30", kind: "sale" },
  "2026-10": { start: "2026-10-22", end: "2026-10-26", kind: "sale" },
  "2026-11": { start: "2026-11-19", end: "2026-11-29", kind: "sale" },
};
export const LONG_SALE_DAYS = 8;
// MICALLE商品の売上が月の売上のこの割合以上なら「MICALLEを売った月」と判定（設定で月ごとに上書き可）
export const MICALLE_SHARE = 0.10;
const MICALLE_RE = /MICALLE|\[M[MARXF][A-Z]\d{3}|\b(MAH|MAK|MAG|MXH|MRI|MRH|MRA|MRM|MME|MMD|MMB|MMK|MMJ|MXE|MFF)\d{3}/i;
export const isMicalleProduct = (name) => MICALLE_RE.test(String(name || ""));

const dayList = (start, end) => { const out = []; for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse(end + "T00:00:00Z"); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const monthDays = (m) => { const [y, mo] = m.split("-").map(Number); return dayList(`${m}-01`, new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)); };
const prevMonth = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7); };
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sum = (days, map) => days.reduce((s, d) => s + (map[d] || 0), 0);

// core / mic: { "YYYY-MM-DD": 売上 }（通常商品 / MICALLE商品）
// cfg: { sales: {月: {start,end,kind}}, micalle: {月: true/false}, dataStart }
export function computeForecast({ core, mic, cfg, today, month }) {
  const sales = { ...DEFAULT_SALES, ...(cfg.sales || {}) };
  const dataStart = cfg.dataStart || today;
  const inSale = (m, d) => { const s = sales[m]; return !!(s && d >= s.start && d <= s.end); };
  const complete = (m) => monthDays(m).slice(-1)[0] < today && monthDays(m).filter((d) => d >= dataStart).length >= 20;
  const micShare = (m) => { const ds = monthDays(m); const t = sum(ds, core) + sum(ds, mic); return t ? sum(ds, mic) / t : 0; };
  const isMicalle = (m) => (cfg.micalle && typeof cfg.micalle[m] === "boolean") ? cfg.micalle[m] : micShare(m) >= MICALLE_SHARE;

  // 過去のトクトクSALE（通常商品だけで効果を測る）
  const saleHistory = [];
  for (const m of Object.keys(sales).sort()) {
    const s = sales[m];
    if (!s || m >= month || s.kind !== "sale" || s.start < dataStart || !complete(m)) continue;
    const ds = monthDays(m).filter((d) => d >= dataStart);
    const tok = ds.filter((d) => inSale(m, d)), non = ds.filter((d) => !inSale(m, d));
    const tokAvg = avg(tok.map((d) => core[d] || 0)), nonAvg = avg(non.map((d) => core[d] || 0));
    if (!nonAvg) continue;
    saleHistory.push({ month: m, start: s.start, end: s.end, days: tok.length, tokAvg: Math.round(tokAvg), nonAvg: Math.round(nonAvg), uplift: nonAvg ? Math.round((tokAvg / nonAvg - 1) * 1000) / 1000 : 0 });
  }
  const uplift = avg(saleHistory.map((h) => h.uplift));

  // 過去のMICALLE月の販売額
  const micHistory = [];
  for (let m = prevMonth(month); m >= dataStart.slice(0, 7); m = prevMonth(m)) {
    if (!complete(m) || !isMicalle(m)) continue;
    micHistory.unshift({ month: m, sales: Math.round(sum(monthDays(m), mic)), share: Math.round(micShare(m) * 1000) / 10 });
  }

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
  const factors = long ? { pessimistic: 0.70, standard: 0.85, optimistic: 1.00 } : { pessimistic: 0.85, standard: 1.00, optimistic: 1.15 };
  const micalle = isMicalle(month);
  const micVals = micHistory.map((h) => h.sales);
  const micTarget = micVals.length ? { pessimistic: Math.min(...micVals), standard: Math.round(avg(micVals)), optimistic: Math.max(...micVals) } : { pessimistic: 0, standard: 0, optimistic: 0 };

  const scenarios = {};
  for (const k of Object.keys(factors)) {
    const saleExtra = baseline * uplift * factors[k] * restSale;
    const coreTotal = coreActual + baseline * rest.length + saleExtra;
    const micTotal = micalle ? Math.max(micActual, micTarget[k]) : micActual;
    scenarios[k] = { factor: factors[k], total: Math.round(coreTotal + micTotal), core: Math.round(coreTotal), micalle: Math.round(micTotal), saleExtra: Math.round(saleExtra) };
  }
  return {
    ok: true, month, today,
    sale: sale ? { ...sale, days: saleLen, long } : null, micalle, micalleAuto: !(cfg.micalle && typeof cfg.micalle[month] === "boolean"),
    actual: Math.round(coreActual + micActual), coreActual: Math.round(coreActual), micActual: Math.round(micActual),
    daysPast: past.length, daysRest: rest.length, restSale,
    baseline: Math.round(baseline), baselineFrom, baselineDays: normalPast.length,
    uplift: Math.round(uplift * 1000) / 1000, scenarios, saleHistory, micHistory,
  };
}
