// 診断用: 返品・返金(returns) APIの実レスポンス構造を確認する（個人情報は出力しない）。
// 目的: ダッシュボードの「返品・返金済み」が¥0になる原因（パス/項目名/権限/ステータス値の不一致）を特定する。
// 使い方: デプロイ後に /api/returns_probe を開く（必要なら ?days=60 で期間調整）。確認後はこのファイルを削除可。
import { callTT, getShop } from "./query.js";

// 値の中身（氏名・住所など）は出さず、構造だけ見えるように匿名化する。
function shape(v, depth = 0) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) {
      // ステータス・金額・件数・時刻・ID有無など、PIIでない手がかりだけ素通し
      if (/status|state|type|amount|currency|total|count|time|reason|role|id$/i.test(k)) o[k] = redact(v[k], k);
      else o[k] = "<" + typeofShort(v[k]) + ">";
    }
    return o;
  }
  return "<" + typeofShort(v) + ">";
}
function typeofShort(v) { return Array.isArray(v) ? "array" : typeof v; }
function redact(v, k) {
  if (v == null) return null;
  if (typeof v === "object") return shape(v);
  // order_id / return_id 等のIDは値を出さず有無だけ
  if (/id$/i.test(k)) return v ? "<id:present>" : "";
  return v; // status/amount/time/reason 等はそのまま（手がかり）
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const env = {
    store: process.env.TTS_SHOP || "",
    key: process.env.TTS_APP_KEY, secret: process.env.TTS_APP_SECRET,
    token: process.env.TTS_ACCESS_TOKEN, refresh: process.env.TTS_REFRESH_TOKEN,
  };
  if (!env.key || !env.secret || (!env.token && !env.refresh)) {
    res.status(200).json({ ok: false, error: "TTS認証情報が未設定" }); return;
  }
  const days = Math.min(180, Math.max(1, Number((req.query && req.query.days) || 60)));
  const now = Math.floor(Date.now() / 1000);
  const ge = now - days * 24 * 3600, lt = now + 24 * 3600;
  try {
    const shop = await getShop(env);
    const attempts = [
      { path: "/return_refund/202309/returns/search", body: { create_time_ge: ge, create_time_lt: lt } },
      { path: "/return_refund/202309/returns/search", body: { update_time_ge: ge, update_time_lt: lt } },
      { path: "/return_refund/202309/returns/search", body: {} },
    ];
    const results = [];
    for (const a of attempts) {
      try {
        const j = await callTT({ path: a.path, method: "POST", query: { page_size: "20" }, bodyObj: a.body, env, shopCipher: shop.cipher });
        const d = j.data || {};
        const list = d.return_orders || d.returns || d.list || [];
        const statuses = {};
        for (const r of list) {
          const s = r.return_status || r.refund_status || r.status || "(none)";
          statuses[s] = (statuses[s] || 0) + 1;
        }
        results.push({
          path: a.path, bodyKeys: Object.keys(a.body),
          code: j.code, message: j.message,
          dataKeys: Object.keys(d),
          recordCount: list.length,
          statusDistribution: statuses,
          firstRecordShape: list[0] ? shape(list[0]) : null,
        });
        if (j.code === 0 && list.length) break; // 成功して中身があれば十分
      } catch (e) {
        results.push({ path: a.path, bodyKeys: Object.keys(a.body), error: String((e && e.message) || e) });
      }
    }
    res.status(200).json({ ok: true, days, shop: { name: shop.name, region: shop.region }, results });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
