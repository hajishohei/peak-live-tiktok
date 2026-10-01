// LIVE・動画の一元分析API（読み取り専用）
//
// 背景（2026-09-28 実データで検証済み）:
//  - shop/performance(202405) は GMVを LIVE / VIDEO / PRODUCT_CARD の3流入元に分解して返す ... OK
//  - shop_videos/performance(202409) は動画1本ごとのGMV・販売数・紐づく商品を返す ....... OK
//  - shop_lives/performance(202508) は「自社LIVE一覧」だがTikTok側の内部エラー(36009003)で使用不可
//      → LIVE一覧(live_id・開始終了時刻)は毎日のスケジュールタスクがブラウザから取得し、
//        /api/live_ingest 経由でBlobに蓄積する。ここではそれを読んで使う。
//  - 個別LIVEの products_performance(202512) / performance_per_minutes(202510) は live_id があればOK
//
// 主要な導出:
//   配信中GMV = 分単位データ(performance_per_minutes)の合計（＝配信時間内に発生した売上）
//   LIVE帰属GMV = 商品別実績(products_performance)の合計（＝配信終了後の後追い購入も含む）
//   後追いGMV  = LIVE帰属GMV − 配信中GMV
import { callTT, getShop, loadLiveSessions, loadLiveCache, saveLiveCache } from "./query.js";

function addDay(d) { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function amt(o) { return o && o.amount != null ? num(o.amount) : 0; }
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }

// ---- (1) ショップ全体のGMVを流入元(LIVE/動画/商品カード)で分解 ----
async function fetchBreakdown(env, shop, since, until) {
  const j = await callTT({
    path: "/analytics/202405/shop/performance", method: "GET",
    query: { start_date_ge: since, end_date_lt: addDay(until), currency: "LOCAL" },
    env, shopCipher: shop.cipher,
  });
  if (!j || j.code !== 0) return { ok: false, code: j && j.code, message: (j && j.message) || "取得失敗" };
  const iv = (((j.data || {}).performance || {}).intervals || [])[0] || {};
  const pick = (arr, type) => { const f = (arr || []).find((x) => x.type === type); return f || null; };
  const gb = iv.gmv_breakdowns || [];
  const ib = iv.product_impression_breakdowns || [];
  const vb = iv.product_page_view_breakdowns || [];
  const live = amt(pick(gb, "LIVE")), video = amt(pick(gb, "VIDEO")), card = amt(pick(gb, "PRODUCT_CARD"));
  const total = amt(iv.gmv) || (live + video + card);
  const share = (x) => (total > 0 ? Math.round((x / total) * 1000) / 10 : 0);
  return {
    ok: true,
    period: { since, until },
    gmv: { total, live, video, productCard: card },
    share: { live: share(live), video: share(video), productCard: share(card) },
    orders: num(iv.orders), skuOrders: num(iv.sku_orders), unitsSold: num(iv.units_sold),
    avgOrderValue: amt(iv.avg_order_value),
    refunds: amt(iv.refunds), cancellationsAndReturns: num(iv.cancellations_and_returns),
    impressions: { total: num(iv.product_impressions), live: num((pick(ib, "LIVE") || {}).amount), video: num((pick(ib, "VIDEO") || {}).amount), productCard: num((pick(ib, "PRODUCT_CARD") || {}).amount) },
    pageViews: { total: num(iv.product_page_views), live: num((pick(vb, "LIVE") || {}).amount), video: num((pick(vb, "VIDEO") || {}).amount), productCard: num((pick(vb, "PRODUCT_CARD") || {}).amount) },
  };
}

// ---- (2) 動画ごとの実績（全ページ取得） ----
async function fetchVideos(env, shop, since, until, maxPages = 10) {
  const out = []; let token = null; let pages = 0; let latest = null; let totalCount = 0;
  do {
    const query = { start_date_ge: since, end_date_lt: addDay(until), page_size: "50", currency: "LOCAL" };
    if (token) query.page_token = token;
    const j = await callTT({ path: "/analytics/202409/shop_videos/performance", method: "GET", query, env, shopCipher: shop.cipher });
    if (!j || j.code !== 0) return { ok: false, code: j && j.code, message: (j && j.message) || "取得失敗", videos: out };
    const d = j.data || {};
    latest = d.latest_available_date || latest;
    totalCount = num(d.total_count) || totalCount;
    for (const v of d.videos || []) {
      out.push({
        id: String(v.id || ""), title: String(v.title || "").slice(0, 200),
        username: String(v.username || ""), postedAt: v.video_post_time || "",
        views: num(v.views), ctr: num(v.click_through_rate),
        gmv: amt(v.gmv), unitsSold: num(v.units_sold), skuOrders: num(v.sku_orders),
        products: (v.products || []).map((p) => ({ id: String(p.id || ""), name: String(p.name || "") })),
      });
    }
    token = d.next_page_token || null; pages++;
    // next_page_token が同じ値を返し続けるケースを避けるため、取得件数が0なら打ち切る
    if (!(d.videos || []).length) break;
  } while (token && pages < maxPages);
  out.sort((a, b) => b.gmv - a.gmv);
  const sum = out.reduce((s, v) => s + v.gmv, 0);
  const units = out.reduce((s, v) => s + v.unitsSold, 0);
  // 自社アカウント(.choice2)とアフィリエイター(それ以外)を分けて見る
  const byOwner = {};
  for (const v of out) { const k = v.username || "(不明)"; if (!byOwner[k]) byOwner[k] = { username: k, videos: 0, gmv: 0, unitsSold: 0, views: 0 }; const o = byOwner[k]; o.videos++; o.gmv += v.gmv; o.unitsSold += v.unitsSold; o.views += v.views; }
  return {
    ok: true, latestAvailableDate: latest, totalCount, fetched: out.length,
    gmvTotal: sum, unitsTotal: units,
    byCreator: Object.values(byOwner).sort((a, b) => b.gmv - a.gmv),
    videos: out,
  };
}

// ---- (3) 個別LIVEの商品別実績＋分単位実績 → 配信中/後追いを分解 ----
async function fetchLiveDetail(env, shop, liveId, opts = {}) {
  const withMinutes = opts.withMinutes !== false;
  const res = { liveId: String(liveId), products: [], inLiveGmv: null, attributedGmv: 0, afterGmv: null, minutes: [] };
  // 商品別（LIVE帰属＝後追い購入も含む）
  try {
    const j = await callTT({
      path: `/analytics/202512/shop/${liveId}/products_performance`, method: "GET",
      query: { currency: "LOCAL", page_size: "100" }, env, shopCipher: shop.cipher,
    });
    if (j && j.code === 0) {
      for (const p of ((j.data || {}).products || [])) {
        const s = p.sales || {}, t = p.traffic || {};
        const gmv = amt(s.direct_gmv);
        res.products.push({
          id: String(p.id || ""), name: String(p.name || ""),
          gmv, unitsSold: num(s.items_sold), skuOrders: num(s.sku_orders), customers: num(s.customers),
          impressions: num(t.product_impressions), clicks: num(t.produt_clicks != null ? t.produt_clicks : t.product_clicks),
          ctr: num(t.ctr), addToCart: num(t.add_to_cart_count),
        });
        res.attributedGmv += gmv;
      }
      res.products.sort((a, b) => b.gmv - a.gmv);
      res.unitsTotal = res.products.reduce((s, p) => s + p.unitsSold, 0);
    } else { res.productsError = { code: j && j.code, message: (j && j.message) || "" }; }
  } catch (e) { res.productsError = { message: String((e && e.message) || e).slice(0, 120) }; }
  // 分単位（配信時間内に発生した売上）
  // 1ページ100分しか返らないため next_page_token を辿って全区間を取得する。
  // これを怠ると長時間配信で「配信中GMV」が過少になり、後追い比率が実際より高く出る。
  if (withMinutes) {
    let token = null, pages = 0, sum = 0;
    try {
      do {
        const query = { currency: "LOCAL", page_size: "100" };
        if (token) query.page_token = token;
        const j = await callTT({
          path: `/analytics/202510/shop_lives/${liveId}/performance_per_minutes`, method: "GET",
          query, env, shopCipher: shop.cipher,
        });
        if (!j || j.code !== 0) { res.minutesError = { code: j && j.code, message: (j && j.message) || "" }; break; }
        const ivs = (((j.data || {}).performance || {}).intervals || []);
        for (const iv of ivs) {
          const sales = iv.sales || {}, traffic = iv.traffic || {}, inter = iv.interactions || {};
          const g = amt(sales.gmv); sum += g;
          res.minutes.push({
            start: num(iv.start_time), end: num(iv.end_time), gmv: g,
            itemsSold: num(sales.items_sold), orders: num(sales.main_orders),
            impressions: num(traffic.impressions), productImpressions: num(traffic.product_impressions),
            productClicks: num(traffic.product_clicks), viewers: num(traffic.viewers), views: num(traffic.views),
            comments: num(inter.comments), likes: num(inter.likes), newFollowers: num(inter.new_followers),
          });
        }
        const nt = (j.data || {}).next_page_token || null;
        token = (nt && nt !== token && ivs.length) ? nt : null;
        pages++;
      } while (token && pages < 20);
      if (res.minutes.length) {
        res.inLiveGmv = Math.round(sum);
        res.minutePages = pages;
        // ※ここでの差分は「APIの直接GMV」基準。画面の派生GMV基準の後追いは overview 側で算出する。
        res.afterGmv = Math.max(0, Math.round(res.attributedGmv - sum));
        res.afterRate = res.attributedGmv > 0 ? Math.round((res.afterGmv / res.attributedGmv) * 1000) / 10 : 0;
      }
    } catch (e) { res.minutesError = { message: String((e && e.message) || e).slice(0, 120) }; }
  }
  return res;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const env = {
    store: process.env.TTS_SHOP || "", key: process.env.TTS_APP_KEY, secret: process.env.TTS_APP_SECRET,
    token: process.env.TTS_ACCESS_TOKEN, refresh: process.env.TTS_REFRESH_TOKEN,
  };
  const q = req.query || {};
  const mode = String(q.mode || "overview");
  const until = isDate(q.until) ? String(q.until) : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const since = isDate(q.since) ? String(q.since) : (() => { const x = new Date(until + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - 29); return x.toISOString().slice(0, 10); })();

  try {
    const shop = await getShop(env);

    if (mode === "breakdown") { res.status(200).json(await fetchBreakdown(env, shop, since, until)); return; }
    if (mode === "videos") { res.status(200).json(await fetchVideos(env, shop, since, until)); return; }
    if (mode === "live") {
      const liveId = String(q.live_id || "").trim();
      if (!/^\d+$/.test(liveId)) { res.status(200).json({ ok: false, error: "live_id が必要です" }); return; }
      res.status(200).json({ ok: true, ...(await fetchLiveDetail(env, shop, liveId)) }); return;
    }

    // overview: 流入元内訳 ＋ 動画 ＋ 蓄積済みLIVEセッション（各LIVEの配信中/後追い内訳つき）
    const sessions = await loadLiveSessions();
    const inRange = Object.values(sessions || {})
      .filter((s) => s && s.date >= since && s.date <= until)
      .sort((a, b) => String(b.date + (b.startTime || "")).localeCompare(String(a.date + (a.startTime || ""))));
    const limit = Math.max(1, Math.min(60, Number(q.limit) || 60));
    const targets = inRange.slice(0, limit);

    // 配信明細・流入元内訳・動画一覧のキャッシュ（Blob）。以降の処理すべてで使うので最初に読む。
    const cache = await loadLiveCache();
    let cacheDirty = false;

    // 流入元内訳と動画一覧は毎回APIを叩くと遅い（動画はページ送りで数秒かかる）。
    // 日中そう大きく動く数字でもないので、期間ごとに30分だけキャッシュする。
    // 置き場所は配信明細と同じBlob。キー名を __ で始めて配信IDと衝突しないようにしている。
    const ANALYTICS_TTL_MS = 30 * 60 * 1000;
    const ckBreak = `__breakdown__${since}_${until}`;
    const ckVideo = `__videos__${since}_${until}`;
    const fresh = (e) => e && e.builtAt && (Date.now() - e.builtAt) < ANALYTICS_TTL_MS;
    let breakdown, videos;
    if (fresh(cache[ckBreak]) && fresh(cache[ckVideo]) && String(q.refresh || "") !== "1") {
      breakdown = cache[ckBreak].data; videos = cache[ckVideo].data;
    } else {
      const got = await Promise.all([
        fetchBreakdown(env, shop, since, until).catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
        fetchVideos(env, shop, since, until).catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
      ]);
      breakdown = got[0];
      // 動画は全件持つと重いので、画面で使う分だけに絞って保存する
      videos = got[1] && got[1].ok
        ? { ok: true, totalCount: got[1].totalCount, fetched: got[1].fetched, gmvTotal: got[1].gmvTotal, unitsTotal: got[1].unitsTotal, byCreator: got[1].byCreator, videos: got[1].videos.slice(0, 30) }
        : got[1];
      cache[ckBreak] = { builtAt: Date.now(), data: breakdown };
      cache[ckVideo] = { builtAt: Date.now(), data: videos };
      cacheDirty = true;
    }
    // 古い期間のキャッシュが溜まり続けないよう、2日より前のものは捨てる
    for (const k of Object.keys(cache)) {
      if (k.startsWith("__") && cache[k] && cache[k].builtAt && Date.now() - cache[k].builtAt > 2 * 86400e3) { delete cache[k]; cacheDirty = true; }
    }

    // 配信中／配信後（後追い）の算出基準（2026-09-29 決定: 画面基準に一本化）
    //  - TikTokの画面(LIVEダッシュボード)の「派生GMV」と、APIの direct_gmv は別物で包含関係にもない。
    //  - 配信ごとのGMVと後追い比率は、収集スクリプトが画面から取った値で計算する:
    //      配信GMV ＝ 画面の派生GMV（収集のたびに直近7日分を取り直すので、配信後の購入も積み上がる）
    //      配信中  ＝ ピン留めタイムラインの5分バケットGMVの合計
    //      配信後  ＝ 配信GMV − 配信中
    //  - ピン留めが未収集の配信だけ、やむを得ずAPI基準（direct_gmv と分単位GMV）で代用する。
    // 配信明細のAPI呼び出しは1配信数回かかるため、未計算ぶんは1リクエスト maxCompute 件までに抑える。
    const maxCompute = Math.max(0, Math.min(8, Number(q.compute) != null && Number(q.compute) >= 0 ? Number(q.compute) : 4));
    let computed = 0, pending = 0;

    const lives = [];
    for (const s of targets) {
      let d = cache[s.liveId];
      if (!d) {
        if (computed >= maxCompute) { pending++; continue; }
        const full = await fetchLiveDetail(env, shop, s.liveId, { withMinutes: true });
        // キャッシュには分単位の生データまでは持たない（サイズ削減のため集計値のみ）
        d = {
          attributedGmv: full.attributedGmv, inLiveGmv: full.inLiveGmv, unitsTotal: full.unitsTotal || 0,
          minuteCount: (full.minutes || []).length,
          products: (full.products || []).slice(0, 60),
          productsError: full.productsError || null, minutesError: full.minutesError || null,
          builtAt: Date.now(),
        };
        cache[s.liveId] = d; cacheDirty = true; computed++;
      }
      const durationSec = num(s.durationSec);
      const pins = s.pins || [];
      const pinGmvSum = pins.reduce((a, p) => a + num(p.gmv), 0);
      // 基準は必ず揃える（画面基準とAPI基準を混ぜると後追い比率が壊れるため）。
      //  画面基準: 帰属＝画面の派生GMV、配信中＝5分バケットGMVの合計（どちらも画面由来）
      //  API基準 : 帰属＝direct_gmvの合計、配信中＝分単位GMVの合計（どちらもAPI由来）
      const useScreen = num(s.gmv) > 0 && pins.length > 0;
      const attributed = useScreen ? num(s.gmv) : Math.round(d.attributedGmv);
      const inLive = useScreen ? pinGmvSum : (d.inLiveGmv != null ? d.inLiveGmv : null);
      const after = (attributed > 0 && inLive != null) ? Math.max(0, attributed - inLive) : null;
      lives.push({
        liveId: s.liveId, date: s.date, startTime: s.startTime || "", endTime: s.endTime || "",
        durationSec, durationMin: durationSec ? Math.round(durationSec / 60) : null,
        viewers: num(s.viewers), impressions: num(s.impressions),
        attributedGmv: attributed,
        inLiveGmv: inLive,
        afterGmv: after,
        afterRate: (attributed > 0 && after != null) ? Math.round((after / attributed) * 1000) / 10 : null,
        basis: useScreen ? "画面(派生GMV)" : "API(直接GMV)",
        unitsTotal: num(s.units) || d.unitsTotal || 0,
        gmvPerHour: durationSec ? Math.round(attributed / (durationSec / 3600)) : null,
        apiDirectGmv: Math.round(d.attributedGmv),   // 参考値（API基準）。画面には出さない
        // 画面では件数しか使わないので、pinsと商品明細そのものは返さない（転送量を減らすため）。
        // 商品別の集計はこのあとサーバー側で済ませる。
        pinCount: pins.length,
        pinMinutes: pins.reduce((a, x) => a + num(x.minutes), 0),
        _products: d.products || [],    // 集計用（レスポンスからは後で外す）
        _pins: pins,                    // 集計用（同上）
        errors: [d.productsError, d.minutesError].filter(Boolean),
      });
    }
    if (cacheDirty) { try { await saveLiveCache(cache); } catch (e) { /* 保存失敗しても表示は続ける */ } }

    // 商品別の横断集計（LIVE分）: 何回紹介され、累計何個・いくら売れたか
    // あわせて週別・月別の内訳も作る（同じ商品でも時期によって売れ方が変わるため、
    // 「いま伸びているのか・落ちているのか」を商品ごとに見られるようにする）
    const weekKey = (d) => {            // 月曜はじまりの週。キーはその週の月曜の日付
      const x = new Date(d + "T00:00:00Z");
      const dow = (x.getUTCDay() + 6) % 7; // 月=0
      x.setUTCDate(x.getUTCDate() - dow);
      return x.toISOString().slice(0, 10);
    };
    // 1時間あたりGMVの分子は「その商品を紹介した配信での売上」だけにする。
    // 紹介していない配信でカタログ経由で売れた分まで入れると、紹介時間に対して過大に出るため。
    const bucketAdd = (store, key, p, mins) => {
      if (!store[key]) store[key] = { key, gmv: 0, pinnedGmv: 0, unitsSold: 0, pinMinutes: 0, lives: 0 };
      const b = store[key];
      b.gmv += p.gmv; b.unitsSold += p.unitsSold; b.pinMinutes += mins; b.lives++;
      if (mins > 0) b.pinnedGmv += p.gmv;
    };
    const byProduct = {};
    for (const lv of lives) {
      const pinMin = {};
      for (const p of lv._pins || []) { const k = String(p.productName || ""); pinMin[k] = (pinMin[k] || 0) + num(p.minutes); }
      const wk = lv.date ? weekKey(lv.date) : "", mo = (lv.date || "").slice(0, 7);
      for (const p of lv._products) {
        if (!byProduct[p.id]) byProduct[p.id] = { id: p.id, name: p.name, lives: 0, pinnedLives: 0, gmv: 0, pinnedGmv: 0, unitsSold: 0, impressions: 0, addToCart: 0, pinMinutes: 0, _w: {}, _m: {} };
        const o = byProduct[p.id];
        const mins = pinMin[p.name] || 0;
        o.lives++; o.gmv += p.gmv; o.unitsSold += p.unitsSold; o.impressions += p.impressions; o.addToCart += p.addToCart;
        o.pinMinutes += mins;
        if (mins > 0) { o.pinnedGmv += p.gmv; o.pinnedLives++; }
        if (wk) bucketAdd(o._w, wk, p, mins);
        if (mo) bucketAdd(o._m, mo, p, mins);
      }
    }
    const finishBuckets = (store) => Object.values(store)
      .sort((a, b) => String(a.key).localeCompare(String(b.key)))
      .map((b) => ({
        key: b.key, gmv: Math.round(b.gmv), unitsSold: b.unitsSold, pinMinutes: b.pinMinutes, lives: b.lives,
        gmvPerPinHour: b.pinMinutes > 0 ? Math.round(b.pinnedGmv / (b.pinMinutes / 60)) : null,
      }));
    const products = Object.values(byProduct).sort((a, b) => b.gmv - a.gmv).map((p) => {
      const { _w, _m, ...rest } = p;
      return {
        ...rest, gmv: Math.round(p.gmv), pinnedGmv: Math.round(p.pinnedGmv),
        // 紹介していない配信での売上（カタログ経由など）。「紹介しなくても売れる商品」の目安になる
        unpinnedGmv: Math.round(p.gmv - p.pinnedGmv),
        gmvPerPinHour: p.pinMinutes > 0 ? Math.round(p.pinnedGmv / (p.pinMinutes / 60)) : null,
        byWeek: finishBuckets(_w),
        byMonth: finishBuckets(_m),
      };
    });

    // 後追い比率は「配信中/後追いが両方出せた配信」だけで集計する（片方欠けた配信を混ぜると率が狂うため）
    const liveAgg = lives.reduce((a, l) => {
      a.attributed += l.attributedGmv || 0;
      a.units += l.unitsTotal || 0; a.durationSec += l.durationSec || 0;
      // API基準の配信は「配信後」が構造的に0になるため、後追い率の集計からは外す
      if (l.basis === "画面(派生GMV)" && l.inLiveGmv != null && l.afterGmv != null) { a.inLive += l.inLiveGmv; a.after += l.afterGmv; a.splitBase += l.attributedGmv || 0; a.splitCount++; }
      return a;
    }, { attributed: 0, inLive: 0, after: 0, units: 0, durationSec: 0, splitBase: 0, splitCount: 0 });

    res.status(200).json({
      ok: true,
      period: { since, until },
      // 3分類の総括（ご要望の「配信中・後追い・動画」）
      summary: {
        liveAttributedGmv: liveAgg.attributed,
        inLiveGmv: liveAgg.inLive,
        afterLiveGmv: liveAgg.after,
        afterLiveRate: liveAgg.splitBase > 0 ? Math.round((liveAgg.after / liveAgg.splitBase) * 1000) / 10 : null,
        afterLiveBasisLives: liveAgg.splitCount, // 後追い比率の算出に使えた配信数
        videoGmv: videos && videos.ok ? videos.gmvTotal : null,
        productCardGmv: breakdown && breakdown.ok ? breakdown.gmv.productCard : null,
        shopTotalGmv: breakdown && breakdown.ok ? breakdown.gmv.total : null,
        liveCount: lives.length,
        liveTotalMin: Math.round(liveAgg.durationSec / 60),
        liveUnits: liveAgg.units,
        gmvPerLiveHour: liveAgg.durationSec ? Math.round(liveAgg.attributed / (liveAgg.durationSec / 3600)) : null,
      },
      progress: { totalLivesInRange: inRange.length, loaded: lives.length, pending, computedThisRequest: computed,
                  hint: pending > 0 ? "未計算の配信があります（自動で続きを計算します）" : "" },
      breakdown, products,
      lives: lives.map(({ _products, _pins, ...rest }) => rest),
      videos: videos && videos.ok ? { total: videos.totalCount, fetched: videos.fetched, gmvTotal: videos.gmvTotal, unitsTotal: videos.unitsTotal, byCreator: videos.byCreator, top: videos.videos.slice(0, 30) } : videos,
      sessionsStored: Object.keys(sessions || {}).length,
      note: lives.length === 0 ? "この期間の配信データがありません。収集スクリプト（scripts/collect_lives.mjs）が動いているか確認してください。" : undefined,
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
