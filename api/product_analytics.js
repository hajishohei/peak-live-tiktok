// 商品別パフォーマンス（GMV/注文/販売数/CTR）を1商品ぶん取得: GET /api/product_analytics?id=&since=YYYY-MM-DD&until=YYYY-MM-DD
// アコーディオン展開時に遅延取得する用途。TikTok分析API /analytics/202405/shop_products/{id}/performance。
import { callTT, getShop } from "./query.js";

function addDay(d) { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }
function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
// 入れ子のどこにあるか不明なので、再帰的に代表フィールドを探す
function pick(obj) {
  const out = { gmv: null, orders: null, units: null, ctr: null };
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      const lk = k.toLowerCase();
      if (out.gmv == null && lk === "gmv") out.gmv = (v && typeof v === "object") ? num(v.amount) : num(v);
      else if (out.orders == null && (lk === "orders" || lk === "order_count")) out.orders = num(v);
      else if (out.units == null && (lk === "units_sold" || lk === "unit_sold" || lk === "sku_orders")) out.units = num(v);
      else if (out.ctr == null && (lk === "click_through_rate" || lk === "ctr")) out.ctr = num(v);
      if (v && typeof v === "object") walk(v);
    }
  })(obj);
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const env = {
    store: process.env.TTS_SHOP || "", key: process.env.TTS_APP_KEY, secret: process.env.TTS_APP_SECRET,
    token: process.env.TTS_ACCESS_TOKEN, refresh: process.env.TTS_REFRESH_TOKEN,
  };
  const q = req.query || {};
  const id = String(q.id || "").trim();
  const since = String(q.since || "").trim();
  const until = String(q.until || "").trim();

  // ===== 診断: LIVE分析APIがこのショップで使えるか調べる（読み取り専用・固定の候補のみ） =====
  // GET /api/product_analytics?probe=live&since=YYYY-MM-DD&until=YYYY-MM-DD
  // 公式ドキュメント確認済み: /analytics/202508/shop_lives/performance の interaction_performance に
  // acu/pcu/viewers/views/avg_viewing_duration/comments/new_followers 等が入る（Shopスコープ・Creator認可不要）。
  // 前回は内部エラー(36009003)だったため、日付範囲・任意パラメータを変えた複数パターンで再検証する。
  if (String(q.probe || "") === "live") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      res.status(200).json({ ok: false, error: "since / until (YYYY-MM-DD) が必要です" }); return;
    }
    const addDayN = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const wideEnd = addDay(until);
    const narrowStart = addDayN(until, -6); // 直近7日
    const VARIANTS = [
      { label: "overview: 直近7日・最小パラメータ", path: "/analytics/202508/shop_lives/overview_performance", query: { start_date_ge: narrowStart, end_date_lt: wideEnd } },
      { label: "overview: 直近7日・granularity/currency/account_type付き", path: "/analytics/202508/shop_lives/overview_performance", query: { start_date_ge: narrowStart, end_date_lt: wideEnd, granularity: "1D", currency: "LOCAL", account_type: "ALL", with_comparison: "false" } },
      { label: "list: 指定期間(元のsince〜until)・最小パラメータ", path: "/analytics/202508/shop_lives/performance", query: { start_date_ge: since, end_date_lt: wideEnd } },
      { label: "list: 直近7日・最小パラメータ", path: "/analytics/202508/shop_lives/performance", query: { start_date_ge: narrowStart, end_date_lt: wideEnd } },
      { label: "list: 直近7日・page_size/sort/currency/account_type付き", path: "/analytics/202508/shop_lives/performance", query: { start_date_ge: narrowStart, end_date_lt: wideEnd, page_size: "30", sort_field: "gmv", sort_order: "DESC", currency: "LOCAL", account_type: "ALL" } },
      { label: "list: 直近2日・最小パラメータ", path: "/analytics/202508/shop_lives/performance", query: { start_date_ge: addDayN(until, -1), end_date_lt: wideEnd } },
    ];
    try {
      const shop = await getShop(env);
      const out = [];
      for (const v of VARIANTS) {
        try {
          const j = await callTT({ path: v.path, method: "GET", query: v.query, env, shopCipher: shop.cipher });
          const d = j && j.data;
          out.push({
            label: v.label, path: v.path, query: v.query,
            code: j && j.code, message: String((j && j.message) || "").slice(0, 160),
            ok: j && j.code === 0,
            keys: d && typeof d === "object" ? Object.keys(d).slice(0, 30) : null,
            sample: d ? JSON.stringify(d).slice(0, 1400) : null,
          });
        } catch (e) { out.push({ label: v.label, path: v.path, query: v.query, error: String((e && e.message) || e).slice(0, 160) }); }
      }
      res.status(200).json({ ok: true, since, until, results: out });
    } catch (e) { res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
    return;
  }
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    res.status(200).json({ ok: false, error: "id, since(YYYY-MM-DD), until(YYYY-MM-DD) が必要です" }); return;
  }
  try {
    const shop = await getShop(env);
    const query = { start_date_ge: since, end_date_lt: addDay(until) };
    const j = await callTT({ path: `/analytics/202405/shop_products/${id}/performance`, method: "GET", query, env, shopCipher: shop.cipher });
    if (j.code !== 0) {
      // 28001007 = TikTokの分析APIがこの商品IDに対応していない（比較的新しく作成された商品で多発）。
      // ショップには存在していても分析データが提供されないケースがあるため、恒久的な非対応として扱う。
      const unsupported = Number(j.code) === 28001007 || /Precondition Required|existing product/i.test(String(j.message || ""));
      res.status(200).json({
        ok: false, code: j.code, unsupported,
        error: unsupported
          ? "この商品はTikTokの分析APIが対応していません（TikTok側の制約。比較的新しい商品で発生します）"
          : (j.message || "取得失敗"),
      });
      return;
    }
    const m = pick(j.data || {});
    res.status(200).json({ ok: true, id, since, until, metrics: m });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
