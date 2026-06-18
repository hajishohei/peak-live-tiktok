// TikTok Shop Admin API プロキシ（サーバー側のみでトークン使用）。
// フロント public/index.html は POST /api/query を叩く。
//
// 署名アルゴリズム（公式 "Sign your API request" 準拠）:
//   1. sign と access_token を除く全クエリパラメータを取得 → キーを辞書順ソート
//   2. {key}{value} を連結し、先頭に API パスを付与
//   3. multipart 以外なら body(JSON) を末尾に付与
//   4. APP_SECRET で前後を包む → HMAC-SHA256 → 16進小文字
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

// 指定期間 [ge, lt) の注文を全ページ取得（最大 120ページ × 100 = 12000件）
async function fetchOrders(env, shopCipher, ge, lt) {
  const orders = [];
  let pageToken = "";
  for (let i = 0; i < 120; i++) {
    const query = { page_size: "100", sort_field: "create_time", sort_order: "ASC" };
    if (pageToken) query.page_token = pageToken;
    const bodyObj = { create_time_ge: ge, create_time_lt: lt };
    const j = await callTT({
      path: "/order/202309/orders/search",
      method: "POST",
      query, bodyObj, env, shopCipher,
    });
    if (j.code !== 0) throw new Error("orders: " + (j.message || JSON.stringify(j)));
    const d = j.data || {};
    (d.orders || []).forEach((o) => orders.push(o));
    pageToken = d.next_page_token || "";
    if (!pageToken) break;
  }
  return orders;
}

// 直近 LOOKBACK 日の注文をまとめて取得し、サーバー側に短時間キャッシュ。
// → 期間切替・再読み込みはキャッシュ命中で一瞬になる（再取得は10分ごと）。
const LOOKBACK_DAYS = 400;
const ORDER_TTL_MS = 10 * 60 * 1000;
let orderCache = null; // { key, ts, orders }
async function getAllOrders(env, shopCipher) {
  const now = Math.floor(Date.now() / 1000);
  const ge = now - LOOKBACK_DAYS * 24 * 3600;
  const lt = now + 24 * 3600;
  if (orderCache && orderCache.key === shopCipher && Date.now() - orderCache.ts < ORDER_TTL_MS) {
    return orderCache.orders;
  }
  const orders = await fetchOrders(env, shopCipher, ge, lt);
  orderCache = { key: shopCipher, ts: Date.now(), orders };
  return orders;
}

// JST(UTC+9) の日付・時刻
function jst(unixSec) {
  const d = new Date((Number(unixSec) + 9 * 3600) * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), dow: d.getUTCDay() };
}
function buyerKey(o) { return o.user_id || o.buyer_email || null; }
function orderAmount(o) { const p = o.payment || {}; return Number(p.total_amount || o.total_amount || 0) || 0; }
const EXCLUDE = new Set(["CANCELLED", "UNPAID"]); // 売上集計から除外

// allOrders（広め取得）から、期間 [ge, lt) ぶんを集計。
// 新規/既存は「各顧客の初回注文日」で判定（初回が期間内＝新規）。
function aggregate(allOrders, ge, lt) {
  // 1) 各バイヤーの初回（有効）注文時刻
  const firstByBuyer = {};
  for (const o of allOrders) {
    const status = o.status || o.order_status || "";
    if (EXCLUDE.has(status)) continue;
    const k = buyerKey(o); if (!k) continue;
    const t = Number(o.create_time) || 0;
    if (firstByBuyer[k] === undefined || t < firstByBuyer[k]) firstByBuyer[k] = t;
  }
  // 2) 期間スライスを集計
  const byProduct = {}, byDay = {}, byHour = {}, byDow = {}, buyers = {}, newProd = {};
  let sales = 0, count = 0, units = 0, currency = "JPY";
  let cancelledCount = 0, cancelledAmt = 0;
  let newSales = 0, newOrders = 0, newUnits = 0;
  const newSet = new Set(), existSet = new Set();
  for (const o of allOrders) {
    const t0 = Number(o.create_time) || 0;
    if (!(t0 >= ge && t0 < lt)) continue;
    const status = o.status || o.order_status || "";
    if (status === "CANCELLED") { cancelledCount += 1; cancelledAmt += orderAmount(o); continue; }
    if (status === "UNPAID") continue;
    const pay = o.payment || {}; if (pay.currency) currency = pay.currency;
    const amt = orderAmount(o); const t = jst(o.create_time);
    sales += amt; count += 1;
    const k = buyerKey(o);
    let isNew = false;
    if (k) {
      const fb = firstByBuyer[k];
      if (fb !== undefined && fb >= ge && fb < lt) { isNew = true; newSet.add(k); } else { existSet.add(k); }
      const b = buyers[k] || (buyers[k] = { orders: 0, spent: 0 }); b.orders += 1; b.spent += amt;
    }
    byDay[t.date] = byDay[t.date] || { sales: 0, units: 0, orders: 0 };
    byDay[t.date].sales += amt; byDay[t.date].orders += 1;
    byHour[t.hour] = byHour[t.hour] || { sales: 0, orders: 0 };
    byHour[t.hour].sales += amt; byHour[t.hour].orders += 1;
    byDow[t.dow] = byDow[t.dow] || { sales: 0, orders: 0 };
    byDow[t.dow].sales += amt; byDow[t.dow].orders += 1;
    if (isNew) { newSales += amt; newOrders += 1; }
    for (const li of (o.line_items || [])) {
      units += 1; byDay[t.date].units += 1;
      const name = li.product_name || li.sku_name || "(商品名なし)";
      const sp = Number(li.sale_price || 0) || 0;
      const p = byProduct[name] || (byProduct[name] = { net: 0, units: 0, _orders: new Set() });
      p.net += sp; p.units += 1; p._orders.add(o.id);
      if (isNew) {
        newUnits += 1;
        const np = newProd[name] || (newProd[name] = { net: 0, units: 0, _orders: new Set() });
        np.net += sp; np.units += 1; np._orders.add(o.id);
      }
    }
  }
  const toArr = (m) => Object.entries(m)
    .map(([name, v]) => ({ name, net: v.net, units: v.units, orders: v._orders.size }))
    .sort((a, b) => b.net - a.net);
  const products = toArr(byProduct);
  const newCustomerProducts = toArr(newProd);
  const days = Object.entries(byDay).map(([date, v]) => ({ date, ...v })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...(byHour[h] || { sales: 0, orders: 0 }) }));
  const dows = Array.from({ length: 7 }, (_, d) => ({ dow: d, ...(byDow[d] || { sales: 0, orders: 0 }) }));
  const newCount = newSet.size, existingCount = existSet.size;
  const totalCustomers = newCount + existingCount;
  const repeatBuyers = Object.values(buyers).filter((b) => b.orders >= 2).length;
  const customers = {
    available: totalCustomers > 0,
    unique: totalCustomers,
    repeat: repeatBuyers,
    repeatRate: totalCustomers ? repeatBuyers / totalCustomers : 0,
    newCount, existingCount,
    newRatio: totalCustomers ? newCount / totalCustomers : 0,
    newSales, newOrders, newUnits, newAov: newOrders ? newSales / newOrders : 0,
  };
  return {
    currency,
    totals: { sales, orders: count, units, aov: count ? sales / count : 0 },
    cancellations: { count: cancelledCount, amount: cancelledAmt },
    products, newCustomerProducts, days, hours, dows, customers,
  };
}

// YYYY-MM-DD(JST) → unix秒。until は当日終端(+1日)。
function toUnix(dateStr, endOfDay) {
  const d = new Date(dateStr + "T00:00:00Z");
  let sec = Math.floor(d.getTime() / 1000) - 9 * 3600;
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
    const allOrders = await getAllOrders(env, shop.cipher); // 10分キャッシュ
    const agg = aggregate(allOrders, R.ge, R.lt);
    res.status(200).json({
      shop: { name: shop.name || env.store, region: shop.region || "JP" },
      range: { since: R.sinceStr, until: R.untilStr },
      cached: !!(orderCache && Date.now() - orderCache.ts > 50),
      fetchedAll: allOrders.length,
      ...agg,
    });
  } catch (e) {
    res.status(200).json({ error: String((e && e.message) || e) });
  }
}
