// 在庫履歴の記録口: /api/stock_snapshot
// その日のTTS実在庫（商品ごと）をBlobに追記保存する。日次で呼ぶと在庫推移が蓄積され、
// 「在庫が増えた日＝発注（仕入れ）タイミング」を後から検知できる（個別ブランドの発注タイミング連動の土台）。
// 過去の遡及はできないため、今日から記録を開始する。1日複数回呼んでもその日分は上書き。
import { getShop, getAllProducts } from "./query.js";

const HIST_PATH = "tts-stock-history.json";

async function loadHist() {
  try {
    const { get } = await import("@vercel/blob");
    const res = await get(HIST_PATH, { access: "private" });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return JSON.parse(await new Response(res.stream).text());
  } catch (e) { return null; }
}
async function saveHist(obj) {
  const { put } = await import("@vercel/blob");
  await put(HIST_PATH, JSON.stringify(obj), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(200).json({ ok: false, error: "Vercel Blob未設定" }); return;
  }
  const env = {
    store: process.env.TTS_SHOP || "",
    key: process.env.TTS_APP_KEY, secret: process.env.TTS_APP_SECRET,
    token: process.env.TTS_ACCESS_TOKEN, refresh: process.env.TTS_REFRESH_TOKEN,
  };
  if (!env.key || !env.secret || (!env.token && !env.refresh)) { res.status(200).json({ ok: false, error: "TTS認証情報が未設定" }); return; }
  // JSTの当日
  const date = (req.query && req.query.date) || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const shop = await getShop(env);
    const products = await getAllProducts(env, shop.cipher);
    const snap = {};
    const titles = {};
    for (const p of (products || [])) {
      const id = String(p.id || "");
      if (!id) continue;
      snap[id] = (typeof p.stock === "number") ? p.stock : 0;
      titles[id] = p.title || "";
    }
    const hist = (await loadHist()) || { history: {}, titles: {}, dates: [] };
    hist.history[date] = snap;
    hist.titles = { ...(hist.titles || {}), ...titles };
    hist.dates = Object.keys(hist.history).sort();
    hist.builtAt = new Date().toISOString();
    await saveHist(hist);
    res.status(200).json({ ok: true, date, products: Object.keys(snap).length, totalDates: hist.dates.length });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
