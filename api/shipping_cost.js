// 送料コスト（エンコントロ請求書・月次手入力）の保存/一覧取得: POST/GET /api/shipping_cost
// 請求書には月合計しか書かれていない前提で、管理費(固定費)・発送手数料(変動費)・配送料(変動費)を月ごとに保存する。
// 実際の按分計算（1件あたり単価・選択期間への日割り/注文数割り）は api/query.js の computeShippingCost が行う。
// このダッシュボードはBasic認証(middleware.js)配下なので、live_ingestのような別キー保護は不要。
import { saveShippingMonthly, loadShippingMonthly, deleteShippingMonthly } from "./query.js";

function numOrZero(v) {
  if (v === "" || v == null) return 0;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(200).json({ ok: false, error: "Vercel Blob未設定" });
    return;
  }
  let p;
  if (req.method === "POST") {
    p = req.body;
    if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  } else {
    p = req.query || {};
  }
  p = p || {};

  // 一覧取得（読み取り専用）: 保存済みの月次請求書データを返す
  if (p.list != null) {
    try {
      const monthly = await loadShippingMonthly();
      res.status(200).json({ ok: true, monthly });
    } catch (e) {
      res.status(200).json({ ok: false, error: String((e && e.message) || e) });
    }
    return;
  }

  const month = String(p.month || "").trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    res.status(200).json({ ok: false, error: "month は YYYY-MM 形式で指定してください" });
    return;
  }
  // 削除: ?delete=1&month=YYYY-MM でその月のデータを消す
  if (p.delete != null) {
    try {
      const monthly = await deleteShippingMonthly(month);
      res.status(200).json({ ok: true, deleted: month, totalMonths: Object.keys(monthly).length });
    } catch (e) {
      res.status(200).json({ ok: false, error: String((e && e.message) || e) });
    }
    return;
  }

  const rec = {
    managementFee: numOrZero(p.managementFee),
    shippingFee: numOrZero(p.shippingFee),
    deliveryFee: numOrZero(p.deliveryFee),
    note: String(p.note || "").slice(0, 200),
    updatedAt: Date.now(),
  };
  try {
    const monthly = await saveShippingMonthly(month, rec);
    res.status(200).json({ ok: true, month, rec, totalMonths: Object.keys(monthly).length });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
