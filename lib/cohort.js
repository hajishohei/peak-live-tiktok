// 顧客の継続購入（リピート）分析。POST /api/query { mode: "cohort" } から呼ばれる。
// 注文を購入者ごとに時系列で並べ、次の数字を出す（個人を特定できる情報は返さない）。
//   ・初回購入月ごとの新規顧客数と、30/60/90/180日以内に2回目を買った割合
//   ・初回購入からの経過月ごとの「まだ買っている人の割合」「新規1人あたりの売上」
//   ・リピーター（2回以上購入）の購入間隔・購入頻度・1か月あたりの購入金額
//   ・月ごとの売上を「その月の新規」と「既存顧客」に分けた推移
// 金額はダッシュボードの売上と同じ定義（顧客支払額＋TikTok負担クーポン − 返金額）。
const DAY = 86400;
const jstMonth = (t) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 7);
const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const r1 = (x) => Math.round(x * 10) / 10;
const pct = (a, b) => (b ? r1((a / b) * 100) : null);

export function cohortAnalysis(allOrders, refundByOrder, { buyerKey, sellerAmount, exclude }) {
  const refunds = refundByOrder || {};
  const nowT = Math.floor(Date.now() / 1000);
  const nowMonth = jstMonth(nowT);
  const buyers = new Map();
  for (const o of allOrders) {
    const st = o.status || o.order_status || "";
    if (exclude.has(st)) continue;
    const k = buyerKey(o); if (!k) continue;
    const t = Number(o.create_time) || 0; if (!t) continue;
    const amt = Math.max(0, sellerAmount(o) - (refunds[o.id] || 0));
    if (!buyers.has(k)) buyers.set(k, []);
    buyers.get(k).push({ t, amt });
  }
  if (!buyers.size) return { ok: true, empty: true };

  let firstT = Infinity;
  for (const list of buyers.values()) { list.sort((a, b) => a.t - b.t); firstT = Math.min(firstT, list[0].t); }
  const dataStart = jstMonth(firstT);
  // 取得開始月は「それ以前の購入」が見えず新規が水増しされるため、コホートの集計から外す
  const cohortStartIdx = monthIndex(dataStart) + 1;

  const cohorts = {};      // 初回月 -> 集計
  const monthly = {};      // 月 -> { newBuyers, newSales, retBuyers, retSales }
  const intervals = [];    // リピーターの購入間隔（日）
  const repStats = [];     // リピーター1人ごとの指標
  const MAXK = 12;

  for (const list of buyers.values()) {
    const fm = jstMonth(list[0].t), fIdx = monthIndex(fm);
    // 月次（新規/既存の売上内訳）
    const seenMonth = new Set();
    for (let i = 0; i < list.length; i++) {
      const m = jstMonth(list[i].t);
      const mm = monthly[m] || (monthly[m] = { newBuyers: 0, newSales: 0, retBuyers: 0, retSales: 0, orders: 0 });
      mm.orders++;
      if (m === fm) { mm.newSales += list[i].amt; if (!seenMonth.has(m)) mm.newBuyers++; }
      else { mm.retSales += list[i].amt; if (!seenMonth.has(m)) mm.retBuyers++; }
      seenMonth.add(m);
    }
    // リピーター
    if (list.length >= 2) {
      for (let i = 1; i < list.length; i++) intervals.push((list[i].t - list[i - 1].t) / DAY);
      const spanMonths = Math.max(1, monthIndex(jstMonth(nowT)) - fIdx + 1); // 初回月〜今月
      const total = list.reduce((s, x) => s + x.amt, 0);
      repStats.push({ orders: list.length, activeMonths: seenMonth.size, spanMonths, total });
    }
    // コホート
    if (fIdx < cohortStartIdx) continue;
    const c = cohorts[fm] || (cohorts[fm] = { n: 0, firstSales: 0, within: { 30: 0, 60: 0, 90: 0, 180: 0 }, observable: { 30: 0, 60: 0, 90: 0, 180: 0 }, ever: 0, active: Array(MAXK + 1).fill(0), sales: Array(MAXK + 1).fill(0) });
    c.n++; c.firstSales += list[0].amt;
    const t0 = list[0].t;
    for (const d of [30, 60, 90, 180]) {
      if (nowT - t0 >= d * DAY) { // その日数ぶん経過している人だけを母数にする
        c.observable[d]++;
        if (list.length >= 2 && list[1].t - t0 <= d * DAY) c.within[d]++;
      }
    }
    if (list.length >= 2) c.ever++;
    const seenK = new Set();
    for (const x of list) {
      const k = monthIndex(jstMonth(x.t)) - fIdx; if (k > MAXK) continue;
      c.sales[k] += x.amt; if (!seenK.has(k)) { c.active[k]++; seenK.add(k); }
    }
  }

  // コホート表（観測できている月だけ値を入れる）
  const nowIdx = monthIndex(nowMonth);
  const cohortRows = Object.keys(cohorts).sort().map((m) => {
    const c = cohorts[m], fIdx = monthIndex(m);
    const maxK = Math.min(MAXK, nowIdx - fIdx);
    return {
      month: m, newBuyers: c.n, firstOrderAvg: Math.round(c.firstSales / c.n),
      repeat30: pct(c.within[30], c.observable[30]), repeat60: pct(c.within[60], c.observable[60]),
      repeat90: pct(c.within[90], c.observable[90]), repeat180: pct(c.within[180], c.observable[180]),
      repeatEver: pct(c.ever, c.n),
      activeRate: c.active.slice(0, maxK + 1).map((a) => pct(a, c.n)),
      salesPerNew: c.sales.slice(0, maxK + 1).map((s) => Math.round(s / c.n)),
      complete90: c.observable[90] === c.n,
    };
  });

  // 全コホートを人数で重み付けした平均（経過月kが観測できているコホートだけで平均）
  const curve = [];
  for (let k = 0; k <= MAXK; k++) {
    let n = 0, act = 0, sal = 0, cn = 0;
    for (const m of Object.keys(cohorts)) {
      if (nowIdx - monthIndex(m) < k) continue;
      // 当月(k=経過0で今月)など途中の月は除く：k月目が締まっているコホートのみ
      if (monthIndex(m) + k >= nowIdx) continue;
      const c = cohorts[m]; n += c.n; act += c.active[k]; sal += c.sales[k]; cn++;
    }
    if (!n) break;
    curve.push({ k, cohorts: cn, buyers: n, activeRate: pct(act, n), salesPerNew: Math.round(sal / n) });
  }
  let cum = 0; for (const p of curve) { cum += p.salesPerNew; p.cumSalesPerNew = cum; }

  const sumObs = (d) => Object.values(cohorts).reduce((s, c) => [s[0] + c.within[d], s[1] + c.observable[d]], [0, 0]);
  const rep = {};
  for (const d of [30, 60, 90, 180]) { const [w, o] = sumObs(d); rep["repeat" + d] = pct(w, o); rep["base" + d] = o; }

  // リピーターの指標
  const bucket = { "〜7日": 0, "8〜14日": 0, "15〜30日": 0, "31〜60日": 0, "61〜90日": 0, "91日〜": 0 };
  for (const d of intervals) {
    if (d <= 7) bucket["〜7日"]++; else if (d <= 14) bucket["8〜14日"]++; else if (d <= 30) bucket["15〜30日"]++;
    else if (d <= 60) bucket["31〜60日"]++; else if (d <= 90) bucket["61〜90日"]++; else bucket["91日〜"]++;
  }
  const repN = repStats.length;
  const totOrders = repStats.reduce((s, x) => s + x.orders, 0);
  const totActive = repStats.reduce((s, x) => s + x.activeMonths, 0);
  const totSpan = repStats.reduce((s, x) => s + x.spanMonths, 0);
  const totSales = repStats.reduce((s, x) => s + x.total, 0);
  const freq = { "2回": 0, "3〜4回": 0, "5〜9回": 0, "10回以上": 0 };
  for (const x of repStats) { if (x.orders === 2) freq["2回"]++; else if (x.orders <= 4) freq["3〜4回"]++; else if (x.orders <= 9) freq["5〜9回"]++; else freq["10回以上"]++; }
  const repeaters = {
    count: repN, shareOfBuyers: pct(repN, buyers.size),
    medianIntervalDays: r1(median(intervals)), avgIntervalDays: r1(intervals.reduce((s, x) => s + x, 0) / (intervals.length || 1)),
    intervalDist: Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, pct(v, intervals.length)])),
    ordersPerActiveMonth: r1(totOrders / (totActive || 1)),
    activeMonthShare: pct(totActive, totSpan), // 初回月以降のうち、買った月の割合
    spendPerActiveMonth: Math.round(totSales / (totActive || 1)), // 買った月の平均購入金額
    spendPerMonthOverLife: Math.round(totSales / (totSpan || 1)), // 初回月〜今月で均した月平均
    avgOrders: r1(totOrders / (repN || 1)), freqDist: Object.fromEntries(Object.entries(freq).map(([k, v]) => [k, pct(v, repN)])),
  };

  const monthlyRows = Object.keys(monthly).sort().map((m) => {
    const x = monthly[m];
    return { month: m, newBuyers: x.newBuyers, newSales: Math.round(x.newSales), returningBuyers: x.retBuyers, returningSales: Math.round(x.retSales), orders: x.orders, partial: m === nowMonth, isDataStart: m === dataStart };
  });

  return {
    ok: true, generatedAt: new Date(nowT * 1000).toISOString(), dataStart, totalBuyers: buyers.size,
    note: "取得開始月はそれ以前の購入が見えないため、コホートからは除外。率の母数は、その日数ぶん経過した新規顧客のみ。",
    repeatRates: rep, curve, cohorts: cohortRows, repeaters, monthly: monthlyRows,
  };
}
