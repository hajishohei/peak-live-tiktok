// 診断用(軽量): 注文APIで「購入者名」がどの項目に入るかだけを最小限で返す。値は伏せる。
// 使い方: /api/order_probe （?status=CANCELLED, ?days=30 可）。確認後は削除可。
import { callTT, getShop } from "./query.js";

// オブジェクトを浅く走査し、name/recipient/buyer 系の「キー経路」と値の有無(長さ)だけ収集
function findNamePaths(obj, prefix, out, depth) {
  if (!obj || typeof obj !== "object" || depth > 3) return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const path = prefix ? prefix + "." + k : k;
    if (/name|recipient|buyer|receiver|contact/i.test(k)) {
      if (v && typeof v !== "object") out[path] = "len" + String(v).length;
      else if (v && typeof v === "object") out[path] = "{obj}";
      else out[path] = "empty";
    }
    if (v && typeof v === "object" && !Array.isArray(v)) findNamePaths(v, path, out, depth + 1);
    else if (Array.isArray(v) && v[0] && typeof v[0] === "object") findNamePaths(v[0], path + "[]", out, depth + 1);
  }
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const env = {
    store: process.env.TTS_SHOP || "",
    key: process.env.TTS_APP_KEY, secret: process.env.TTS_APP_SECRET,
    token: process.env.TTS_ACCESS_TOKEN, refresh: process.env.TTS_REFRESH_TOKEN,
  };
  if (!env.key || !env.secret || (!env.token && !env.refresh)) { res.status(200).json({ ok: false, error: "TTS認証情報が未設定" }); return; }
  const days = Math.min(180, Math.max(1, Number((req.query && req.query.days) || 30)));
  const status = (req.query && req.query.status) || "";
  const now = Math.floor(Date.now() / 1000);
  const ge = now - days * 24 * 3600, lt = now + 24 * 3600;
  try {
    const shop = await getShop(env);
    const body = { create_time_ge: ge, create_time_lt: lt };
    if (status) body.order_status = status;
    const j = await callTT({ path: "/order/202309/orders/search", method: "POST", query: { page_size: "10" }, bodyObj: body, env, shopCipher: shop.cipher });
    const d = j.data || {};
    const orders = d.orders || [];
    const nameKeys = {};
    if (orders[0]) findNamePaths(orders[0], "", nameKeys, 0);
    // payment内訳（金額のみ。TT負担クーポンの項目名・値の確認用）
    const paymentSample = (orders[0] && orders[0].payment) ? orders[0].payment : null;
    res.status(200).json({
      ok: true, code: j.code, message: j.message, status: status || "(all)",
      orderCount: orders.length,
      topLevelKeys: orders[0] ? Object.keys(orders[0]) : [],
      nameRelatedFields: nameKeys, // 例: {"recipient_address.name":"len5"} のように、名前が入る項目と長さ
      paymentSample, // platform_discount / shipping_fee_platform_discount / total_amount などを確認
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
