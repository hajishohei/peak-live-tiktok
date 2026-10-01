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
