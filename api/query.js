// TikTok Shop Admin API プロキシ（サーバー側のみでトークン使用）。
// フロント public/index.html は POST /api/query を叩く。
//
// 署名アルゴリズム（公式 "Sign your API request" 準拠）:
//   1. sign と access_token を除く全クエリパラメータを取得
//   2. キーを辞書順ソート
//   3. {key}{value} を連結
//   4. 先頭に API パスを付与:  input = path + input
//   5. Content-Type が multipart/form-data でなければ body(JSON文字列) を末尾に付与
//   6. APP_SECRET で前後を包む:  input = secret + input + secret
//   7. HMAC-SHA256(input, key=secret) → 16進小文字
import crypto from "crypto";

const API_BASE = "https://open-api.tiktokglobalshop.com";

function calcSign(path, params, bodyStr, secret) {
  const keys = Object.keys(params).filter((k) => k !== "sign" && k !== "access_token").sort();
  let input = path;
  for (const k of keys) input += k + params[k];
  if (bodyStr) input += bodyStr;
  input = secret + input + secret;
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

function buildQS(params) {
  return Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
}

// 1リクエスト分の TikTok Shop API 呼び出し
async function callTT({ path, method = "GET", query = {}, bodyObj = null, env, shopCipher }) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const params = { app_key: env.key, timestamp: ts, ...query };
  if (shopCipher) params.shop_cipher = shopCipher;
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  params.sign = calcSign(path, params, bodyStr, env.secret);
  const url = `${API_BASE}${path}?${buildQS(params)}`;
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-tts-access-token": env.token },
    body: bodyObj ? bodyStr : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { code: -1, message: `HTTP ${r.status}: ${text.slice(0, 200)}` }; }
  return json;
}

// 認可済みショップ（shop_cipher を取得）。warm な間はキャッシュ。
let cachedShop = null;
async function getShop(env) {
  if (process.env.TTS_SHOP_CIPHER) {
    cachedShop = cachedShop || { cipher: process.env.TTS_SHOP_CIPHER, name: env.store || "", region: "JP" };
    return cachedShop;
  }
  if (cachedShop) return cachedShop;
  const j = await callTT({ path: "/authorization/202309/shops", method: "GET", env });
  if (j.code !== 0) throw new Error("shops: " + (j.message || JSON.stringify(j)));
  const shops = (j.data && j.data.shops) || [];
  const s = shops[0];
  if (!s) throw new Error("認可済みショップが見つかりません（インストール/トークンを確認）");
  cachedShop = { cipher: s.cipher, name: s.name, region: s.region };
  return cachedShop;
}

// 期間内の注文を全ページ取得（最大 80ページ × 100 = 8000件）
async function fetchOrders(env, shopCipher, ge, lt) {
  const orders = [];
  let pageToken = "";
  for (let i = 0; i < 80; i++) {
    const query = { page_size: "100", sort_field: "create_time", sort_order: "ASC" };
    if (pageToken) query.page_token = pageToken;
    const bodyObj = { create_time_ge: ge, create_time_lt: lt };
    const j = await callTT({
      path: "/order/202309/orders/search",
      method: "POST",
      query,
      bodyObj,
      env,
      shopCipher,
    });
    if (j.code !== 0) throw new Error("orders: " + (j.message || JSON.stringify(j)));
    const d = j.data || {};
    (d.orders || []).forEach((o) => orders.push(o));
    pageToken = d.next_page_token || "";
    if (!pageToken) break;
  }
  return orders;
}

// JST(UTC+9) の日付・時刻
function jst(unixSec) {
  const d = new Date((Number(unixSec) + 9 * 3600) * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), dow: d.getUTCDay() };
}
const EXCLUDE = new Set(["CANCELLED", "UNPAID"]); // 集計から除外する注文ステータス

function aggregate(orders) {
  const byProduct = {}; // name -> {net, units, orders:Set}
  const byDay = {};     // date -> {sales, units, orders}
  const byHour = {};    // 0-23 -> {sales, orders}
  const byDow = {};     // 0-6  -> {sales, orders}
  const buyers = {};    // buyerKey -> {orders, spent}
  let sales = 0, count = 0, units = 0, currency = "JPY";
  for (const o of orders) {
    const status = o.status || o.order_status || "";
    if (EXCLUDE.has(status)) continue;
    const pay = o.payment || {};
    if (pay.currency) currency = pay.currency;
    const amt = Number(pay.total_amount || o.total_amount || 0) || 0;
    const t = jst(o.create_time);
    sales += amt; count += 1;
    const bkey = o.user_id || o.buyer_email || null;
    if (bkey) { const b = buyers[bkey] || (buyers[bkey] = { orders: 0, spent: 0 }); b.orders += 1; b.spent += amt; }
    byDay[t.date] = byDay[t.date] || { sales: 0, units: 0, orders: 0 };
    byDay[t.date].sales += amt; byDay[t.date].orders += 1;
    byHour[t.hour] = byHour[t.hour] || { sales: 0, orders: 0 };
    byHour[t.hour].sales += amt; byHour[t.hour].orders += 1;
    byDow[t.dow] = byDow[t.dow] || { sales: 0, orders: 0 };
    byDow[t.dow].sales += amt; byDow[t.dow].orders += 1;
    const items = o.line_items || [];
    for (const li of items) {
      units += 1;
      byDay[t.date].units += 1;
      const name = li.product_name || li.sku_name || "(商品名なし)";
      const sp = Number(li.sale_price || 0) || 0;
      const p = byProduct[name] || (byProduct[name] = { net: 0, units: 0, _orders: new Set() });
      p.net += sp; p.units += 1; p._orders.add(o.id);
    }
  }
  const products = Object.entries(byProduct)
    .map(([name, v]) => ({ name, net: v.net, units: v.units, orders: v._orders.size }))
    .sort((a, b) => b.net - a.net);
  const days = Object.entries(byDay)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...(byHour[h] || { sales: 0, orders: 0 }) }));
  const dows = Array.from({ length: 7 }, (_, d) => ({ dow: d, ...(byDow[d] || { sales: 0, orders: 0 }) }));
  const buyerArr = Object.values(buyers);
  const uniqueBuyers = buyerArr.length;
  const repeatBuyers = buyerArr.filter((b) => b.orders >= 2).length;
  const customers = {
    available: uniqueBuyers > 0,
    unique: uniqueBuyers,
    repeat: repeatBuyers,
    repeatRate: uniqueBuyers ? repeatBuyers / uniqueBuyers : 0,
  };
  return { currency, totals: { sales, orders: count, units, aov: count ? sales / count : 0 }, products, days, hours, dows, customers };
}

// YYYY-MM-DD(JST) → unix秒。until は当日終端(+1日)。
function toUnix(dateStr, endOfDay) {
  const d = new Date(dateStr + "T00:00:00Z");
  let sec = Math.floor(d.getTime() / 1000) - 9 * 3600; // JST起点をUTC秒へ
  if (endOfDay) sec += 24 * 3600;
  return sec;
}
function resolveRange(since, until) {
  const now = new Date();
  const todayJst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  let s = since, u = until === "today" || !until ? todayJst : until;
  const m = /^-(\d+)d$/.exec(since || "");
  if (m) {
    const back = new Date(now.getTime() + 9 * 3600 * 1000);
    back.setUTCDate(back.getUTCDate() - Number(m[1]));
    s = back.toISOString().slice(0, 10);
  }
  return { ge: toUnix(s, false), lt: toUnix(u, true), sinceStr: s, untilStr: u };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const env = {
    store: process.env.TTS_SHOP || "",
    key: process.env.TTS_APP_KEY,
    secret: process.env.TTS_APP_SECRET,
    token: process.env.TTS_ACCESS_TOKEN,
  };
  if (!env.key || !env.secret || !env.token) {
    res.status(500).json({ error: "TTS_APP_KEY / TTS_APP_SECRET / TTS_ACCESS_TOKEN のいずれか未設定" });
    return;
  }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const mode = (body && body.mode) || "dashboard";
  try {
    const shop = await getShop(env);
    if (mode === "shop") {
      res.status(200).json({ name: shop.name || env.store, region: shop.region || "JP", currency: "JPY" });
      return;
    }
    const R = resolveRange(body && body.since, body && body.until);
    const orders = await fetchOrders(env, shop.cipher, R.ge, R.lt);
    const agg = aggregate(orders);
    res.status(200).json({
      shop: { name: shop.name || env.store, region: shop.region || "JP" },
      range: { since: R.sinceStr, until: R.untilStr },
      fetched: orders.length,
      ...agg,
    });
  } catch (e) {
    res.status(200).json({ error: String((e && e.message) || e) });
  }
}
