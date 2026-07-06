// 履歴スナップショット更新エンドポイント: /api/snapshot
// 全注文(約400日)を取得してVercel Blobに「冷凍保存」する。ダッシュボードの「履歴を更新」ボタンから呼ばれる。
// 以降の /api/query は直近のみ取得＋このスナップショットと合体するため高速になる。
import { buildAndSaveSnapshot, getShop, getAllProducts } from "./query.js";

export default async function handler(req, res) {
  const env = {
    store: process.env.TTS_SHOP || "",
    key: process.env.TTS_APP_KEY,
    secret: process.env.TTS_APP_SECRET,
    token: process.env.TTS_ACCESS_TOKEN,
    refresh: process.env.TTS_REFRESH_TOKEN,
  };
  if (!env.key || !env.secret || (!env.token && !env.refresh)) {
    res.status(200).json({ ok: false, error: "TTS認証情報が未設定です" });
    return;
  }
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(200).json({ ok: false, error: "Vercel Blobが未設定です。VercelのStorageでBlobストアを作成し、プロジェクトに接続してください。" });
    return;
  }
  const t0 = Date.now();
  try {
    const shop = await getShop(env);
    const r = await buildAndSaveSnapshot(env, shop.cipher);
    let products = 0;
    try { const list = await getAllProducts(env, shop.cipher, true); products = list.length; } catch (e) { /* 商品更新失敗は無視 */ }
    res.status(200).json({ ok: true, count: r.count, products, builtAt: r.builtAt, elapsedMs: Date.now() - t0 });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - t0 });
  }
}
