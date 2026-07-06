// TikTok Shop Admin API プロキシ（サーバー側のみでトークン使用）。
// フロント public/index.html は POST /api/query を叩く。
//
// 署名アルゴリズム（公式 "Sign your API request" 準拠）:
//   1. sign と access_token を除く全クエリパラメータ → キーを辞書順ソート
//   2. {key}{value} を連結 → 先頭に API パスを付与
//   3. multipart 以外なら body(JSON) を末尾に付与
//   4. APP_SECRET で前後を包む → HMAC-SHA256 → 16進小文字
import crypto from "crypto";
import { SD_MASTER } from "../lib/sd_costs.js";
import { LIVE_HOURS } from "../lib/live_hours.js";
import { PURCHASES, PURCHASES_META } from "../lib/purchases.js";

const API_BASE = "https://open-api.tiktokglobalshop.com";

// ===== 原価マッチング（SD仕入れマスタ ↔ TikTok販売商品名） =====
// 方針: あいまい一致に頼り切らず、(1)手動対応表 (2)商品名一致 (3)メーカー品番一致 を優先。
//       それでも不明な商品は「売値×係数(既定50%)」で原価を仮定する。
const NOISE_WORDS = [
  "新作", "新色追加", "新色", "再入荷", "再々入荷", "再生産", "追加生産", "追加発注", "追加", "予約販売", "予約", "一部予約",
  "人気アイテム", "人気商品", "売れ筋アイテム", "定番商品", "定番", "数量限定", "web限定特別価格", "web限定", "特別価格", "最終価格",
  "skypink東京", "skypink", "each東京", "each", "セール", "送料無料", "即納", "全2色", "全3色", "全4色",
  "春夏新作", "秋冬新作", "春新作", "秋新作", "春夏", "秋冬", "2024", "2025", "2026", "ss", "aw", "オケ", "オケージョン", "フォーマル", "セレモニー",
];
function normName(s) {
  let t = String(s || "").toLowerCase();
  t = t.replace(/[【《≪「（(\[].*?[】》≫」）)\]]/g, " "); // 括弧グループ除去
  t = t.replace(/[★☆◎●◆◇■□♪♡♥※→←／＼\/\\|・,，、。.！!？?＆&~〜ー\-_:：;；'"`]/g, " ");
  for (const w of NOISE_WORDS) t = t.split(w).join(" ");
  t = t.replace(/[\s　]+/g, ""); // 空白除去
  return t;
}
function makerNorm(s) {
  return String(s || "").toLowerCase().replace(/[^0-9a-z]/g, "");
}
function tokensOf(s) {
  let t = String(s || "").toLowerCase();
  t = t.replace(/[【《≪「（(\[].*?[】》≫」）)\]]/g, " ");
  t = t.replace(/[★☆◎●◆◇■□♪♡♥※→←／＼\/\\|・,，、。.！!？?＆&~〜ー\-_:：;；'"`#＃]/g, " ");
  const arr = t.split(/[\s　]+/).filter(Boolean).filter((w) => !NOISE_WORDS.includes(w));
  return arr.filter((w) => w.length >= 2);
}
let COST_INDEX = null;
function getCostIndex() {
  if (COST_INDEX) return COST_INDEX;
  const byBase = new Map();
  const byNorm = new Map();
  const baseSet = new Set();
  const items = SD_MASTER.map((m) => {
    const norm = normName(m.name);
    const mk = makerNorm(m.maker);
    const tks = new Set(tokensOf(m.name));
    byBase.set(m.base, m);
    baseSet.add(String(m.base));
    if (norm && !byNorm.has(norm)) byNorm.set(norm, m.base);
    return { ...m, norm, mk, tks };
  });
  COST_INDEX = { items, byBase, byNorm, baseSet };
  return COST_INDEX;
}
// seller_sku 等のSKU文字列にSD品番(base=8桁)が含まれていれば対応付け。例: "15171630S2" → 15171630
function baseFromSku(sku) {
  if (!sku) return null;
  const idx = getCostIndex();
  const s = String(sku);
  const runs = s.match(/\d{7,}/g) || [];
  for (const r of runs) {
    if (idx.baseSet.has(r)) return r;
    for (let len = 8; len >= 7; len--) {
      if (r.length > len) { const head = r.slice(0, len); if (idx.baseSet.has(head)) return head; }
    }
  }
  return null;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
// 商品名(+任意でseller_sku) → {base, source, score} を返す。未一致は null。
function matchBase(name, overrides, sku) {
  const idx = getCostIndex();
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
    const v = overrides[name];
    if (!v || v === "NONE") return { base: null, source: "manual-none", score: 1 };
    if (idx.byBase.has(v)) return { base: v, source: "manual", score: 1 };
  }
  // seller_sku に SD品番が含まれる場合は最優先（最も確実）
  const skuBase = baseFromSku(sku);
  if (skuBase && idx.byBase.has(skuBase)) return { base: skuBase, source: "sd-sku", score: 1 };
  const n = normName(name);
  if (n && idx.byNorm.has(n)) return { base: idx.byNorm.get(n), source: "sd-name", score: 1 };
  // メーカー品番がTikTok名に含まれる（5桁以上の英数字コードのみ・誤検出抑制）
  for (const m of idx.items) {
    if (m.mk && m.mk.length >= 5 && n.includes(m.mk)) return { base: m.base, source: "sd-code", score: 0.97 };
  }
  // 正規化名の包含
  let best = null;
  for (const m of idx.items) {
    if (n.length >= 6 && m.norm.length >= 6 && (n.includes(m.norm) || m.norm.includes(n))) {
      const sc = Math.min(n.length, m.norm.length) / Math.max(n.length, m.norm.length);
      if (!best || sc > best.score) best = { base: m.base, source: "sd-contain", score: 0.8 * sc + 0.1 };
    }
  }
  if (best) return best;
  // トークン重なり（保守的しきい値）
  const tks = new Set(tokensOf(name));
  let bj = 0, bb = null;
  for (const m of idx.items) {
    const j = jaccard(tks, m.tks);
    if (j > bj) { bj = j; bb = m.base; }
  }
  if (bb && bj >= 0.5) return { base: bb, source: "sd-auto", score: bj };
  return null;
}
export { matchBase, normName, getCostIndex, applyCosts, applyTTInventory, baseFromSku, callTT, isExpiredAuth, buildAndSaveSnapshot, getShop, getAllProducts, saveLiveDaily, loadLiveDaily, saveLiveDailyBulk };
function manualCostFor(name, manualCosts) {
  if (!manualCosts) return null;
  const v = manualCosts[name];
  if (v === "" || v == null) return null;
  const n = Number(v);
  return (isFinite(n) && n >= 0) ? n : null;
}
function unitCostFor(p, overrides, manualCosts, rate) {
  const idx = getCostIndex();
  const mc = manualCostFor(p.name, manualCosts);
  if (mc != null) return { unit: mc, source: "manual-cost", score: 1, base: null, sdName: "", vendor: "" };
  const mt = matchBase(p.name, overrides, p.sellerSku);
  if (mt && mt.base && idx.byBase.has(mt.base)) {
    const m = idx.byBase.get(mt.base);
    return { unit: m.cost, source: mt.source, score: mt.score, base: m.base, sdName: m.name, vendor: m.vendor };
  }
  const avg = p.units ? p.net / p.units : 0;
  return { unit: Math.round(avg * rate), source: "estimate", score: 0, base: null, sdName: "", vendor: "" };
}

function calcSign(path, params, bodyStr, secret) {
  const keys = Object.keys(params).filter((k) => k !== "sign" && k !== "access_token").sort();
  let input = path;
  for (const k of keys) input += k + params[k];
  if (bodyStr) input += bodyStr;
  input = secret + input + secret;
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}
function buildQS(params) {
  return Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
}
// ===== アクセストークン自動更新（refresh_token使用）=====
// access_token は約7日で失効するが、refresh_token があれば自動で取り直す（手作業不要）。
let tokenState = null; // { access, exp, refresh }
function isExpiredAuth(j) {
  if (!j) return false;
  const m = String(j.message || "").toLowerCase();
  const codeBad = [105000, 105001, 105002, 36004003, 36004004].includes(Number(j.code));
  return codeBad || /expired|x-tts-access-token|access_token.*(expired|invalid)|invalid.*access_token|credential/.test(m);
}
async function refreshAccessToken(env) {
  if (!env.refresh) throw new Error("TTS_REFRESH_TOKEN が未設定です（初回のみ /api/auth で認可し、TTS_REFRESH_TOKEN を環境変数に設定してください）");
  const url = "https://auth.tiktok-shops.com/api/v2/token/refresh" +
    "?app_key=" + encodeURIComponent(env.key) +
    "&app_secret=" + encodeURIComponent(env.secret) +
    "&refresh_token=" + encodeURIComponent(env.refresh) +
    "&grant_type=refresh_token";
  const r = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch (e) {}
  const d = j.data || {};
  if (!d.access_token) throw new Error("アクセストークンの自動更新に失敗: " + (j.message || ("HTTP " + r.status)) + "（refresh_token が失効している可能性。/api/auth で再認可してください）");
  const ttl = Number(d.access_token_expire_in || 0);
  tokenState = { access: d.access_token, exp: Date.now() + Math.max(60, ttl - 120) * 1000, refresh: d.refresh_token || env.refresh };
  return tokenState.access;
}
function activeToken(env) {
  if (tokenState && tokenState.access && Date.now() < tokenState.exp) return tokenState.access;
  return env.token; // 起動直後は環境変数の固定トークン（失効していれば下で自動更新）
}
async function doRequest({ path, method, query, bodyObj, env, shopCipher }, token) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const params = { app_key: env.key, timestamp: ts, ...query };
  if (shopCipher) params.shop_cipher = shopCipher;
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
  params.sign = calcSign(path, params, bodyStr, env.secret);
  const url = `${API_BASE}${path}?${buildQS(params)}`;
  const r = await fetch(url, {
    method, headers: { "Content-Type": "application/json", "x-tts-access-token": token },
    body: bodyObj ? bodyStr : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { code: -1, message: `HTTP ${r.status}: ${text.slice(0, 200)}` }; }
  return json;
}
function isTransient(j) {
  if (!j) return false;
  const code = Number(j.code);
  const m = String(j.message || "").toLowerCase();
  return code === 98001001 || /internal error|try again|timeout|temporarily|rate limit|too many request|service.*unavailable|503|504/.test(m);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function callTT(opts) {
  const { method = "GET", query = {}, bodyObj = null } = opts;
  opts.method = method; opts.query = query; opts.bodyObj = bodyObj;
  let j;
  for (let attempt = 0; attempt < 4; attempt++) {
    j = await doRequest(opts, activeToken(opts.env));
    if (isExpiredAuth(j) && opts.env.refresh) {
      try { const fresh = await refreshAccessToken(opts.env); j = await doRequest(opts, fresh); }
      catch (e) { return { code: (j && j.code) || -1, message: (j && j.message ? j.message + " / " : "") + String(e.message || e) }; }
    }
    if (isTransient(j) && attempt < 3) { await sleep(700 * (attempt + 1)); continue; }
    break;
  }
  return j;
}

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

async function fetchOrders(env, shopCipher, ge, lt) {
  const orders = [];
  let pageToken = "";
  for (let i = 0; i < 120; i++) {
    const query = { page_size: "100", sort_field: "create_time", sort_order: "ASC" };
    if (pageToken) query.page_token = pageToken;
    const bodyObj = { create_time_ge: ge, create_time_lt: lt };
    const j = await callTT({ path: "/order/202309/orders/search", method: "POST", query, bodyObj, env, shopCipher });
    if (j.code !== 0) throw new Error("orders: " + (j.message || JSON.stringify(j)));
    const d = j.data || {};
    (d.orders || []).forEach((o) => orders.push(o));
    pageToken = d.next_page_token || "";
    if (!pageToken) break;
  }
  return orders;
}

// ===== 返品・返金（after-sale / returns） =====
// 発送前キャンセル(CANCELLED)は売上に未計上なので引かない。
// 返金済み(返品/返金 完了)は売上に計上済みなので、その金額を売上から引く。
function pickAmount(obj) {
  // refund_amount が {amount:"123"} / {refund_total:{amount}} / 数値 等のどれでも拾う
  if (obj == null) return 0;
  if (typeof obj === "number") return obj;
  if (typeof obj === "string") { const n = Number(obj.replace(/[^\d.\-]/g, "")); return isFinite(n) ? n : 0; }
  if (typeof obj === "object") {
    if (obj.amount != null) return pickAmount(obj.amount);
    for (const k of ["refund_total", "refund_amount", "total_amount", "value"]) if (obj[k] != null) return pickAmount(obj[k]);
  }
  return 0;
}
function isRefundCompleted(status) {
  const s = String(status || "").toUpperCase();
  return /COMPLETE/.test(s) || /REFUND_SUCCESS/.test(s) || s === "REFUNDED";
}
async function fetchReturns(env, shopCipher, ge, lt) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 120; i++) {
    const query = { page_size: "50", sort_field: "create_time", sort_order: "ASC" };
    if (pageToken) query.page_token = pageToken;
    const bodyObj = { create_time_ge: ge, create_time_lt: lt };
    const j = await callTT({ path: "/return_refund/202309/returns/search", method: "POST", query, bodyObj, env, shopCipher });
    if (j.code !== 0) throw new Error("returns: " + (j.message || JSON.stringify(j)));
    const d = j.data || {};
    (d.return_orders || d.returns || []).forEach((r) => out.push(r));
    pageToken = d.next_page_token || "";
    if (!pageToken) break;
  }
  return out;
}
let refundCache = null;
const REFUND_TTL_MS = 10 * 60 * 1000;
async function getRefundsByOrder(env, shopCipher) {
  if (refundCache && refundCache.key === shopCipher && Date.now() - refundCache.ts < REFUND_TTL_MS) return refundCache.val;
  const now = Math.floor(Date.now() / 1000);
  const ge = now - LOOKBACK_DAYS * 24 * 3600;
  const lt = now + 24 * 3600;
  let byOrder = {}, completed = 0, total = 0, refundTotal = 0, err = null;
  try {
    const list = await fetchReturns(env, shopCipher, ge, lt);
    for (const r of list) {
      total += 1;
      const status = r.return_status || r.refund_status || r.status || "";
      if (!isRefundCompleted(status)) continue;
      const oid = String(r.order_id || r.orderId || (r.order && r.order.id) || "");
      const amt = pickAmount(r.refund_amount || r.refund || r.refund_total || r);
      if (amt > 0) { if (oid) byOrder[oid] = (byOrder[oid] || 0) + amt; completed += 1; refundTotal += amt; }
    }
  } catch (e) { err = String((e && e.message) || e); }
  const refundOrders = Object.keys(byOrder).length;
  const val = { byOrder, completed, total, refundTotal, refundOrders, error: err };
  refundCache = { key: shopCipher, ts: Date.now(), val };
  return val;
}

// ===== スナップショット高速化（Vercel Blob） =====
// 過去注文を1ファイルに「冷凍保存」し、毎回は直近のみAPI取得して合体する。
const LOOKBACK_DAYS = 400;          // スナップショット未設定時のフル取得日数
const SNAPSHOT_OVERLAP_DAYS = 1;    // 直近の状態変化(キャンセル等)を取りこぼさない重複日数
const REFRESH_MIN_DAYS = 45;        // 直近この日数は毎回再取得し、最新項目(TT負担クーポン等)で上書き
const ROLL_THRESHOLD_SEC = 6 * 3600; // 基準日がこれ以上前なら自動ロール（前進）して保存
const ORDER_TTL_MS = 10 * 60 * 1000;
const SNAP_PATH = "tts-orders-snapshot.json";
const PROD_PATH = "tts-products-snapshot.json";
const PROD_BLOB_TTL_MS = 60 * 60 * 1000; // 商品在庫キャッシュ: 1時間
let orderCache = null;
let lastSnapInfo = null;            // 直近getAllOrders時のスナップショット情報（handlerで返す）
let snapMem = null;                 // Blob内容のメモリキャッシュ

function hashId(s) {
  if (!s) return "";
  return "b" + crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
}
// 注文から受取人名（購入者の特定用）を取り出す。APIバージョン差を吸収して複数候補から拾う。
function recipientName(o) {
  const r = o.recipient_address || o.recipientAddress || o.recipient || {};
  return r.name || r.full_name || r.receiver_name || o.buyer_name || "";
}
// aggregateが必要とする最小フィールドだけに整形。
// 購入者の特定（キャンセル分析の「誰」）のため、TikTok user_id と 受取人名 を保持する。
// 保存先のVercel Blobは非公開ストアで、店舗オーナー自身の注文データのみを扱う。
function trimOrder(o) {
  return {
    id: o.id,
    create_time: o.create_time,
    status: o.status || o.order_status || "",
    payment: { total_amount: orderAmount(o), currency: (o.payment && o.payment.currency) || "JPY", tt_funded: ttFundedDiscount(o) },
    user_id: o.user_id || o.buyer_email || "",
    buyer_name: recipientName(o),
    line_items: (o.line_items || []).map((li) => ({
      product_name: li.product_name || li.sku_name || "(商品名なし)",
      sale_price: Number(li.sale_price || 0) || 0,
      seller_sku: li.seller_sku || li.sku_id || "",
    })),
  };
}
function blobConfigured() {
  // 新仕様(OIDC)はBLOB_STORE_ID、旧仕様は静的トークンで判定
  return !!(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}
async function loadSnapshot() {
  if (snapMem && Date.now() - snapMem._ts < ORDER_TTL_MS) return snapMem;
  if (!blobConfigured()) return null;
  try {
    const { get } = await import("@vercel/blob");
    const res = await get(SNAP_PATH, { access: "private" });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    const text = await new Response(res.stream).text();
    const j = JSON.parse(text);
    snapMem = { builtAt: j.builtAt, cutoffTs: j.cutoffTs, orders: j.orders || [], _ts: Date.now() };
    return snapMem;
  } catch (e) { return null; }
}
async function saveSnapshotData(data) {
  const { put } = await import("@vercel/blob");
  await put(SNAP_PATH, JSON.stringify(data), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
  snapMem = { builtAt: data.builtAt, cutoffTs: data.cutoffTs, orders: data.orders, _ts: Date.now() };
}
async function buildAndSaveSnapshot(env, shopCipher) {
  const now = Math.floor(Date.now() / 1000);
  const ge = now - LOOKBACK_DAYS * 24 * 3600;
  const lt = now + 24 * 3600;
  const raw = await fetchOrders(env, shopCipher, ge, lt);
  const orders = raw.map(trimOrder);
  await saveSnapshotData({ builtAt: Date.now(), cutoffTs: now, orders });
  orderCache = null; // 次回再構築
  return { count: orders.length, builtAt: snapMem.builtAt };
}
// ===== 日次配信時間（Blob・HarboRボット/手動から追記） =====
const LIVE_DAILY_PATH = "tts-live-daily.json";
let liveDailyMem = null;
let RUNTIME_LIVE_DAILY = {}; // handlerがaggregate前にセット
async function loadLiveDaily() {
  if (liveDailyMem && Date.now() - liveDailyMem._ts < 5 * 60 * 1000) return liveDailyMem.daily;
  if (!blobConfigured()) return {};
  try {
    const { get } = await import("@vercel/blob");
    const res = await get(LIVE_DAILY_PATH, { access: "private" });
    if (!res || res.statusCode !== 200 || !res.stream) { liveDailyMem = { daily: {}, _ts: Date.now() }; return {}; }
    const j = JSON.parse(await new Response(res.stream).text());
    liveDailyMem = { daily: j.daily || {}, _ts: Date.now() };
    return liveDailyMem.daily;
  } catch (e) { return {}; }
}
async function saveLiveDaily(date, rec) {
  let cur = {}; try { cur = await loadLiveDaily(); } catch (e) {}
  const daily = { ...cur, [date]: rec };
  const { put } = await import("@vercel/blob");
  await put(LIVE_DAILY_PATH, JSON.stringify({ updated: Date.now(), daily }), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
  liveDailyMem = { daily, _ts: Date.now() };
  return Object.keys(daily).length;
}
// 一括保存: recMap = { "YYYY-MM-DD": {sec,hms,liveCount}, ... }。replaceMonth("YYYY-MM")指定でその月の既存を消してから入れる（誤データの入れ替え用）。
async function saveLiveDailyBulk(recMap, replaceMonth) {
  let cur = {}; try { cur = await loadLiveDaily(); } catch (e) {}
  const daily = { ...cur };
  if (replaceMonth) { for (const k of Object.keys(daily)) { if (k.slice(0, 7) === replaceMonth) delete daily[k]; } }
  for (const d of Object.keys(recMap || {})) daily[d] = recMap[d];
  const { put } = await import("@vercel/blob");
  await put(LIVE_DAILY_PATH, JSON.stringify({ updated: Date.now(), daily }), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
  liveDailyMem = { daily, _ts: Date.now() };
  return Object.keys(daily).length;
}

// ===== 月次配信時間（harbor-ranking data.json から自動取得・手作業ゼロ） =====
const BARBIE_ID = "7578682500742922257";
const RANKING_URL = "https://harbor-ranking.vercel.app/data.json";
let liveMonthlyMem = null;
let RUNTIME_LIVE_MONTHLY = {};
function hmsToSecQ(s) {
  const m = String(s || "").match(/(?:(\d+)\s*時間)?\s*(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}
async function fetchBarbieFromRanking() {
  if (liveMonthlyMem && Date.now() - liveMonthlyMem._ts < 6 * 3600 * 1000) return liveMonthlyMem.val;
  try {
    const r = await fetch(RANKING_URL, { headers: { accept: "application/json" } });
    const d = await r.json();
    const months = (d && d.months) || {};
    const monthly = {};
    for (const mk of Object.keys(months)) {
      const livers = (months[mk] && months[mk].livers) || [];
      const lv = livers.find((x) => String(x.id) === BARBIE_ID);
      if (lv) monthly[mk] = { sec: hmsToSecQ(lv.liveHours), hms: String(lv.liveHours || ""), liveCount: Number(lv.liveCount || 0) || 0 };
    }
    // 日次: data.json の barbieDaily（ボットが追記）または daily[BARBIE_ID]
    const bd = (d && (d.barbieDaily || (d.daily && d.daily[BARBIE_ID]))) || {};
    const daily = {};
    for (const dk of Object.keys(bd)) {
      const v = bd[dk] || {};
      const sec = (typeof v.sec === "number") ? v.sec : hmsToSecQ(v.hms);
      daily[dk] = { sec, liveCount: Number(v.liveCount || 0) || 0, hms: v.hms || "" };
    }
    const val = { monthly, daily };
    liveMonthlyMem = { val, _ts: Date.now() };
    return val;
  } catch (e) { return liveMonthlyMem ? liveMonthlyMem.val : { monthly: {}, daily: {} }; }
}

async function getAllOrders(env, shopCipher) {
  const now = Math.floor(Date.now() / 1000);
  const lt = now + 24 * 3600;
  if (orderCache && orderCache.key === shopCipher && Date.now() - orderCache.ts < ORDER_TTL_MS) {
    lastSnapInfo = orderCache.snapInfo; return orderCache.orders;
  }
  const snap = await loadSnapshot();
  let base = [], geLive;
  if (snap && snap.orders && snap.orders.length) {
    base = snap.orders;
    geLive = snap.cutoffTs - SNAPSHOT_OVERLAP_DAYS * 24 * 3600;
  } else {
    geLive = now - LOOKBACK_DAYS * 24 * 3600;
  }
  // 直近は常に再取得してスナップショットを最新項目（TT負担クーポン等）で上書きする。
  // 当月＋αを必ずカバーし、古いスナップショットに platform_discount が無くても正しく集計できるようにする。
  const refreshFrom = now - REFRESH_MIN_DAYS * 24 * 3600;
  if (geLive > refreshFrom) geLive = refreshFrom;
  const liveRaw = await fetchOrders(env, shopCipher, geLive, lt);
  const live = liveRaw.map(trimOrder);
  const map = new Map();
  for (const o of base) map.set(o.id, o);
  for (const o of live) map.set(o.id, o); // 直近が優先（最新ステータス反映）
  const orders = [...map.values()];
  // 自動ロール: スナップショットがあり基準日が6時間以上前なら、合体結果を保存して基準日を今に前進
  // （次回は前回開いた時からの差分≒1日分だけ取得すればよくなり高速化）
  if (snap && snap.orders && snap.orders.length && (now - snap.cutoffTs) > ROLL_THRESHOLD_SEC) {
    try {
      const keepFrom = now - LOOKBACK_DAYS * 24 * 3600;
      const trimmed = orders.filter((o) => (Number(o.create_time) || 0) >= keepFrom);
      await saveSnapshotData({ builtAt: snap.builtAt, cutoffTs: now, orders: trimmed });
    } catch (e) { /* ロール失敗は無視（次回再試行） */ }
  }
  const snapInfo = {
    configured: blobConfigured(),
    hasSnapshot: !!(snap && snap.orders && snap.orders.length),
    builtAt: snap ? snap.builtAt : null,
    snapshotOrders: base.length,
    liveOrders: live.length,
  };
  lastSnapInfo = snapInfo;
  orderCache = { key: shopCipher, ts: Date.now(), orders, snapInfo };
  return orders;
}

// ===== TikTok Shop 商品API（実在庫・商品リンク） =====
// /product/202309/products/search で出品中の商品とSKU・在庫を取得。商品権限(scope)が必要。
async function fetchProductsRaw(env, shopCipher) {
  const products = [];
  let pageToken = "";
  for (let i = 0; i < 50; i++) {
    const query = { page_size: "100" };
    if (pageToken) query.page_token = pageToken;
    const bodyObj = { status: "ALL" };
    const j = await callTT({ path: "/product/202309/products/search", method: "POST", query, bodyObj, env, shopCipher });
    if (j.code !== 0) { const e = new Error(j.message || JSON.stringify(j)); e.ttcode = j.code; throw e; }
    const d = j.data || {};
    (d.products || []).forEach((p) => products.push(p));
    pageToken = d.next_page_token || "";
    if (!pageToken) break;
  }
  return products;
}
// 在庫が search で取れない場合に備え、各商品の詳細から在庫を補完（最大N件）。
async function fillInventory(env, shopCipher, list) {
  const need = list.filter((p) => p.stock == null).slice(0, 80);
  for (const p of need) {
    try {
      const j = await callTT({ path: `/product/202309/products/${p.id}`, method: "GET", env, shopCipher });
      if (j.code === 0 && j.data) {
        const skus = j.data.skus || [];
        let tot = 0; const sk = [];
        for (const s of skus) {
          const q = (s.inventory || []).reduce((a, x) => a + (Number(x.quantity) || 0), 0);
          tot += q; sk.push({ sellerSku: s.seller_sku || "", stock: q });
        }
        p.stock = tot; p.skus = sk;
      }
    } catch (e) { /* 個別失敗は無視 */ }
  }
}
function normProducts(raw) {
  return raw.map((p) => {
    const skus = p.skus || [];
    let stock = null; const sk = [];
    if (skus.length) {
      stock = 0;
      for (const s of skus) {
        const inv = s.inventory || s.stock_infos || [];
        const q = Array.isArray(inv) ? inv.reduce((a, x) => a + (Number(x.quantity ?? x.available_stock ?? 0) || 0), 0) : (Number(s.stock_quantity ?? 0) || 0);
        const pr = s.price || {};
        const price = Number(pr.sale_price ?? pr.tax_exclusive_price ?? pr.amount ?? pr.original_price ?? 0) || 0;
        stock += q; sk.push({ sellerSku: s.seller_sku || s.sku_id || "", stock: q, price });
      }
    }
    const img = (p.main_images && p.main_images[0] && (p.main_images[0].thumb_urls || p.main_images[0].urls) || [])[0] || "";
    return {
      id: String(p.id || p.product_id || ""),
      title: p.title || p.product_name || "(無題)",
      status: p.status || p.product_status || "",
      stock, skus: sk, image: img,
      link: p.id ? `https://shop.tiktok.com/view/product/${p.id}` : "",
    };
  });
}
const PROD_TTL_MS = 10 * 60 * 1000;
let prodCache = null;
async function loadProductBlob() {
  if (!blobConfigured()) return null;
  try {
    const { get } = await import("@vercel/blob");
    const res = await get(PROD_PATH, { access: "private" });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return JSON.parse(await new Response(res.stream).text());
  } catch (e) { return null; }
}
async function saveProductBlob(list) {
  try {
    const { put } = await import("@vercel/blob");
    await put(PROD_PATH, JSON.stringify({ builtAt: Date.now(), products: list }), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
  } catch (e) { /* 保存失敗は無視 */ }
}
async function getAllProducts(env, shopCipher, forceFresh) {
  if (!forceFresh && prodCache && prodCache.key === shopCipher && Date.now() - prodCache.ts < PROD_TTL_MS) return prodCache.val;
  // Blobの商品キャッシュ（1時間）。毎回1000件超の商品取得をしないことで高速化
  if (!forceFresh && blobConfigured()) {
    const pb = await loadProductBlob();
    if (pb && pb.products && (Date.now() - (pb.builtAt || 0)) < PROD_BLOB_TTL_MS) {
      prodCache = { key: shopCipher, ts: Date.now(), val: pb.products };
      return pb.products;
    }
  }
  const raw = await fetchProductsRaw(env, shopCipher);
  const list = normProducts(raw);
  if (list.some((p) => p.stock == null)) await fillInventory(env, shopCipher, list);
  if (blobConfigured()) await saveProductBlob(list);
  prodCache = { key: shopCipher, ts: Date.now(), val: list };
  return list;
}

function jst(unixSec) {
  const d = new Date((Number(unixSec) + 9 * 3600) * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), dow: d.getUTCDay() };
}
function buyerKey(o) { return o.user_id || o.buyer_email || null; }
function orderAmount(o) { const p = o.payment || {}; return Number(p.total_amount || o.total_amount || 0) || 0; }
function numF(v) { const x = Number(v); return isFinite(x) ? x : 0; }
// TikTok(プラットフォーム)負担の割引額（商品＋送料）。販売者に補填されるので自社売上に加算する。
function ttFundedDiscount(o) { const p = o.payment || {}; return numF(p.platform_discount) + numF(p.shipping_fee_platform_discount); }
// 自社の実売上＝顧客支払額(total_amount) ＋ TikTok負担クーポン(platform_discount等)。
function sellerAmount(o) { const p = o.payment || {}; return orderAmount(o) + (p.tt_funded != null ? numF(p.tt_funded) : ttFundedDiscount(o)); }
function prodName(li) { return li.product_name || li.sku_name || "(商品名なし)"; }
const EXCLUDE = new Set(["CANCELLED", "UNPAID"]);

function aggregate(allOrders, ge, lt, refundByOrder) {
  const refunds = refundByOrder || {};
  // 有効注文を時系列に並べ、バイヤー初回注文時刻と各注文の購入回数(rank)を算出
  const valid = allOrders.filter((o) => !EXCLUDE.has(o.status || o.order_status || ""));
  valid.sort((a, b) => (Number(a.create_time) || 0) - (Number(b.create_time) || 0));
  const firstByBuyer = {}, rankByOrder = {}, seenCnt = {};
  for (const o of valid) {
    const k = buyerKey(o); if (!k) continue;
    const t = Number(o.create_time) || 0;
    if (firstByBuyer[k] === undefined) firstByBuyer[k] = t;
    seenCnt[k] = (seenCnt[k] || 0) + 1;
    rankByOrder[o.id] = seenCnt[k];
  }
  const byProduct = {}, byDay = {}, byHour = {}, byDow = {}, buyers = {}, newProd = {}, repProd = {}, prodCancel = {};
  const periodBuyers = {};
  let sales = 0, count = 0, units = 0, currency = "JPY";
  let cancelledCount = 0, cancelledAmt = 0, cancelledUnits = 0;
  let grossSales = 0, refundedAmt = 0, refundedCount = 0; // 返金済みを売上から差し引く
  let ttFundedTotal = 0; // 売上に含めたTikTok負担クーポンの合計（参考表示用）
  let returnsCount = 0, returnsAmount = 0; // 返品・返金済み（選択期間の注文に紐づくもの）
  const cancelByBuyer = {}; // buyerKey -> {count, amount}
  let cancelNew = 0, cancelExist = 0, cancelNoBuyer = 0; // キャンセル注文の新規/既存内訳(件数)
  let newSales = 0, newOrders = 0, newUnits = 0;
  let repSales = 0, repOrders = 0, repUnits = 0;
  const newOrderAmts = []; // 新規顧客の「1注文ごと」の金額（中央値算出用）
  for (const o of allOrders) {
    const t0 = Number(o.create_time) || 0;
    if (!(t0 >= ge && t0 < lt)) continue;
    const status = o.status || o.order_status || "";
    // 返品・返金済み（この期間の注文に紐づく返金）。ステータス問わずカウント。
    const rfThis = refunds[o.id] || 0;
    if (rfThis > 0) { returnsCount += 1; returnsAmount += rfThis; }
    if (status === "CANCELLED") {
      // 返金完了の注文は「返品・返金済み」側に計上するため、発送前キャンセルからは除外（2区分を排他に）
      if ((refunds[o.id] || 0) > 0) { continue; }
      cancelledCount += 1; cancelledAmt += orderAmount(o);
      const ck = buyerKey(o);
      if (ck) {
        const cb = cancelByBuyer[ck] || (cancelByBuyer[ck] = { count: 0, amount: 0, name: "", orders: [] });
        cb.count += 1; cb.amount += orderAmount(o);
        if (!cb.name && o.buyer_name) cb.name = o.buyer_name;
        cb.orders.push(o.id);
        // 新規=その月に初回有効購入があった人 / 既存=以前から購入歴 / 有効購入なし=キャンセルのみ
        if (firstByBuyer[ck] === undefined) cancelNoBuyer += 1;
        else if (firstByBuyer[ck] >= ge && firstByBuyer[ck] < lt) cancelNew += 1;
        else cancelExist += 1;
      } else cancelNoBuyer += 1;
      for (const li of (o.line_items || [])) {
        cancelledUnits += 1;
        const name = prodName(li);
        const pc = prodCancel[name] || (prodCancel[name] = { ordered: 0, cancelled: 0 });
        pc.cancelled += 1;
      }
      continue;
    }
    if (status === "UNPAID") continue;
    const pay = o.payment || {}; if (pay.currency) currency = pay.currency;
    const gross = sellerAmount(o); const t = jst(o.create_time); // 自社売上＝顧客支払＋TT負担クーポン
    ttFundedTotal += (gross - orderAmount(o));
    // 返金済みは売上から差し引く（発送前キャンセルは元々未計上なので対象外）
    const rf = Math.min(refunds[o.id] || 0, gross);
    if (rf > 0) { refundedAmt += rf; refundedCount += 1; }
    const amt = gross - rf; // ネット売上
    grossSales += gross;
    sales += amt; count += 1;
    const k = buyerKey(o); const rank = rankByOrder[o.id] || 1;
    const isNewCust = !!(k && firstByBuyer[k] !== undefined && firstByBuyer[k] >= ge && firstByBuyer[k] < lt);
    const isRepeatOrder = rank >= 2;
    if (k) { periodBuyers[k] = true; const b = buyers[k] || (buyers[k] = { orders: 0, spent: 0 }); b.orders += 1; b.spent += amt; }
    byDay[t.date] = byDay[t.date] || { sales: 0, units: 0, orders: 0 };
    byDay[t.date].sales += amt; byDay[t.date].orders += 1;
    byHour[t.hour] = byHour[t.hour] || { sales: 0, orders: 0 };
    byHour[t.hour].sales += amt; byHour[t.hour].orders += 1;
    byDow[t.dow] = byDow[t.dow] || { sales: 0, orders: 0 };
    byDow[t.dow].sales += amt; byDow[t.dow].orders += 1;
    if (isNewCust) { newSales += amt; newOrders += 1; newOrderAmts.push(amt); }
    if (isRepeatOrder) { repSales += amt; repOrders += 1; }
    for (const li of (o.line_items || [])) {
      units += 1; byDay[t.date].units += 1;
      const name = prodName(li); const sp = Number(li.sale_price || 0) || 0;
      const p = byProduct[name] || (byProduct[name] = { net: 0, units: 0, _orders: new Set(), _new: new Set(), _exist: new Set(), sellerSku: "" });
      if (!p.sellerSku && (li.seller_sku || li.sku_id)) p.sellerSku = String(li.seller_sku || li.sku_id);
      p.net += sp; p.units += 1; p._orders.add(o.id);
      if (k) { if (isNewCust) p._new.add(k); else p._exist.add(k); }
      const pc = prodCancel[name] || (prodCancel[name] = { ordered: 0, cancelled: 0 }); pc.ordered += 1;
      if (isNewCust) { newUnits += 1; const np = newProd[name] || (newProd[name] = { net: 0, units: 0, _orders: new Set() }); np.net += sp; np.units += 1; np._orders.add(o.id); }
      if (isRepeatOrder) { repUnits += 1; const rp = repProd[name] || (repProd[name] = { net: 0, units: 0, _orders: new Set() }); rp.net += sp; rp.units += 1; rp._orders.add(o.id); }
    }
  }
  const toArr = (m) => Object.entries(m).map(([name, v]) => ({
    name, net: v.net, units: v.units, orders: v._orders.size,
    newBuyers: v._new ? v._new.size : 0, existBuyers: v._exist ? v._exist.size : 0,
    sellerSku: v.sellerSku || "",
  })).sort((a, b) => b.net - a.net);
  const products = toArr(byProduct);
  const newCustomerProducts = toArr(newProd);
  const repeatCustomerProducts = toArr(repProd);
  const productCancel = Object.entries(prodCancel)
    .map(([name, v]) => { const tot = v.ordered + v.cancelled; return { name, ordered: v.ordered, cancelled: v.cancelled, total: tot, rate: tot ? v.cancelled / tot : 0 }; })
    .filter((r) => r.cancelled > 0)
    .sort((a, b) => (b.rate - a.rate) || (b.cancelled - a.cancelled));
  const days = Object.entries(byDay).map(([date, v]) => ({ date, ...v })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...(byHour[h] || { sales: 0, orders: 0 }) }));
  const dows = Array.from({ length: 7 }, (_, d) => ({ dow: d, ...(byDow[d] || { sales: 0, orders: 0 }) }));
  let newCount = 0, existingCount = 0;
  const newSpends = [], existSpends = []; // 顧客ごとの購入金額（新規/既存）
  for (const k of Object.keys(periodBuyers)) {
    const spend = buyers[k] ? buyers[k].spent : 0;
    if (firstByBuyer[k] !== undefined && firstByBuyer[k] >= ge && firstByBuyer[k] < lt) { newCount += 1; newSpends.push(spend); }
    else { existingCount += 1; existSpends.push(spend); }
  }
  const meanOf = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const medianOf = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const totalCustomers = newCount + existingCount;
  const repeatBuyers = Object.values(buyers).filter((b) => b.orders >= 2).length;
  const totalOrders = count + cancelledCount;
  // ===== キャンセルの顧客分析 =====
  const cancelBuyerArr = Object.entries(cancelByBuyer).map(([k, v]) => ({ key: k, count: v.count, amount: v.amount, name: v.name || "", orders: v.orders || [] }));
  const repeatCancelers = cancelBuyerArr.filter((c) => c.count >= 2).sort((a, b) => b.count - a.count);
  const repeatCancelOrders = repeatCancelers.reduce((s, c) => s + c.count, 0);
  const cancelUniqueBuyers = cancelBuyerArr.length;
  // 「誰」=購入者名 + TikTok user_id + 該当注文ID（店舗オーナーがセラーセンターで特定できるように）
  const repeatCancelersView = repeatCancelers.slice(0, 50).map((c, i) => ({
    rank: i + 1, name: c.name || "(名前なし)", userId: String(c.key), count: c.count, amount: c.amount, orderIds: c.orders.slice(0, 20),
  }));
  const cancellationDetail = {
    repeatCancelerCount: repeatCancelers.length, // 2回以上キャンセルした顧客数
    repeatCancelOrders, // その顧客らの累計キャンセル件数
    cancelUniqueBuyers, // キャンセルした延べ顧客（ユニーク）
    repeatCancelerRatio: cancelUniqueBuyers ? repeatCancelers.length / cancelUniqueBuyers : 0,
    newCancels: cancelNew, existCancels: cancelExist, noPurchaseCancels: cancelNoBuyer,
    newCancelRatio: cancelledCount ? cancelNew / cancelledCount : 0,
    existCancelRatio: cancelledCount ? cancelExist / cancelledCount : 0,
    list: repeatCancelersView,
  };
  // ===== 発送後返品の顧客分析（今月何回・累計何回、氏名・TikTok ID） =====
  // refunds(returns API由来, 直近400日)を注文に紐づけ、購入者ごとに集計。
  const retByBuyer = {};
  for (const o of allOrders) {
    const rf = refunds[o.id] || 0; if (rf <= 0) continue;
    const k = buyerKey(o); if (!k) continue;
    const t0 = Number(o.create_time) || 0; const inPeriod = t0 >= ge && t0 < lt;
    const b = retByBuyer[k] || (retByBuyer[k] = { key: k, name: "", monthCount: 0, monthAmt: 0, totalCount: 0, totalAmt: 0, monthOrders: [] });
    if (!b.name && o.buyer_name) b.name = o.buyer_name;
    b.totalCount += 1; b.totalAmt += rf;
    if (inPeriod) { b.monthCount += 1; b.monthAmt += rf; b.monthOrders.push(o.id); }
  }
  const retArr = Object.values(retByBuyer);
  const retThisMonth = retArr.filter((b) => b.monthCount > 0);
  const retRepeatMonth = retThisMonth.filter((b) => b.monthCount >= 2);
  const returnCustomers = {
    monthReturnOrders: retThisMonth.reduce((s, b) => s + b.monthCount, 0),
    monthReturnBuyers: retThisMonth.length,
    monthRepeatBuyers: retRepeatMonth.length,
    list: retThisMonth
      .sort((a, b) => (b.monthCount - a.monthCount) || (b.totalCount - a.totalCount) || (b.monthAmt - a.monthAmt))
      .slice(0, 100)
      .map((b, i) => ({ rank: i + 1, name: b.name || "", userId: String(b.key), monthCount: b.monthCount, totalCount: b.totalCount, monthAmt: b.monthAmt, totalAmt: b.totalAmt, orderIds: b.monthOrders.slice(0, 20) })),
  };
  // 注文ベース: 新規購入(初回注文) + 既存購入(2回目以降) = 注文数(count) になるよう算出
  const firstOrders = count - repOrders;
  const customers = {
    available: count > 0,
    // 注文ベース（新規購入 + 既存購入 = 注文数）
    firstOrders, repeatOrders: repOrders,
    newOrderRatio: count ? firstOrders / count : 0,
    repeatOrderRate: count ? repOrders / count : 0,
    // 実人数（ユニーク・参考）
    unique: totalCustomers, repeat: repeatBuyers,
    repeatRate: totalCustomers ? repeatBuyers / totalCustomers : 0,
    newCount, existingCount, newRatio: totalCustomers ? newCount / totalCustomers : 0,
    newSales, newOrders, newUnits, newAov: newOrders ? newSales / newOrders : 0,
    // 新規の「1注文あたり」中央値（平均=newAov）
    newOrderMedian: medianOf(newOrderAmts),
    repSales, repOrders, repUnits, repAov: repOrders ? repSales / repOrders : 0,
    // 顧客ごと（1人あたり・期間の全注文合計）平均・中央値
    newCustAvg: meanOf(newSpends), newCustMedian: medianOf(newSpends), newCustN: newSpends.length,
    existCustAvg: meanOf(existSpends), existCustMedian: medianOf(existSpends), existCustN: existSpends.length,
  };
  // ===== 推移（週次・月次）: 取得済み全期間を対象に新規購入者・売上を集計（期間フィルタに依存しない） =====
  const wkB = {}, moB = {}, dayB = {};
  const weekStart = (dateStr) => {
    const d = new Date(dateStr + "T00:00:00Z");
    const dow = d.getUTCDay();
    const diff = (dow === 0 ? 6 : dow - 1);
    d.setUTCDate(d.getUTCDate() - diff);
    return d.toISOString().slice(0, 10);
  };
  for (const o of valid) {
    const tt = jst(o.create_time);
    const sa = sellerAmount(o); // 自社売上＝顧客支払＋TT負担クーポン
    const amt = Math.max(0, sa - Math.min(refunds[o.id] || 0, sa));
    const liN = (o.line_items || []).length;
    const isFirst = (rankByOrder[o.id] || 1) === 1;
    const mk = tt.date.slice(0, 7);
    const wkey = weekStart(tt.date);
    const M = moB[mk] || (moB[mk] = { key: mk, sales: 0, orders: 0, units: 0, newBuyers: 0 });
    M.sales += amt; M.orders += 1; M.units += liN; if (isFirst) M.newBuyers += 1;
    const W = wkB[wkey] || (wkB[wkey] = { key: wkey, sales: 0, orders: 0, units: 0, newBuyers: 0 });
    W.sales += amt; W.orders += 1; W.units += liN; if (isFirst) W.newBuyers += 1;
    const D = dayB[tt.date] || (dayB[tt.date] = { key: tt.date, sales: 0, orders: 0, units: 0, newBuyers: 0 });
    D.sales += amt; D.orders += 1; D.units += liN; if (isFirst) D.newBuyers += 1;
  }
  const withRep = (b) => ({ ...b, repeatOrders: b.orders - b.newBuyers });
  const weekly = Object.values(wkB).sort((a, b) => (a.key < b.key ? -1 : 1)).map(withRep);
  const monthly = Object.values(moB).sort((a, b) => (a.key < b.key ? -1 : 1)).map(withRep);
  const daysAll = Object.values(dayB).sort((a, b) => (a.key < b.key ? -1 : 1)).map(withRep);
  // ===== ばーびー(@.choice2)の配信時間をマージ（日次があれば優先、無ければ月次を背景） =====
  const LH = LIVE_HOURS || {};
  const lhDaily = { ...(LH.daily || {}), ...(RUNTIME_LIVE_DAILY || {}) }; // 静的＋Blob日次を合成（Blob優先）
  const lhMonthly = { ...(LH.monthly || {}), ...(RUNTIME_LIVE_MONTHLY || {}) }; // 静的＋ランキング自動取得（自動優先）
  const hasDaily = Object.keys(lhDaily).length > 0;
  for (const d of daysAll) {
    const v = lhDaily[d.key];
    d.liveSec = v ? (v.sec || 0) : 0;
    d.liveCount = v ? (v.liveCount || 0) : 0;
    d.liveHasData = !!v;
  }
  // 配信はあったが注文が無い日も daysAll に含める（日別/週別の配信時間合計が月別と一致するように）
  const dayKeySet = new Set(daysAll.map((d) => d.key));
  for (const dk of Object.keys(lhDaily)) {
    if (!dayKeySet.has(dk) && (lhDaily[dk].sec || 0) > 0) {
      const v = lhDaily[dk];
      daysAll.push({ key: dk, sales: 0, orders: 0, units: 0, newBuyers: 0, repeatOrders: 0, liveSec: v.sec || 0, liveCount: v.liveCount || 0, liveHasData: true });
    }
  }
  daysAll.sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const w of weekly) {
    let sec = 0, cnt = 0, days = 0, has = false; const ws = new Date(w.key + "T00:00:00Z");
    for (let i = 0; i < 7; i++) {
      const dk = new Date(ws.getTime() + i * 86400000).toISOString().slice(0, 10);
      const v = lhDaily[dk]; if (v) { has = true; sec += v.sec || 0; cnt += v.liveCount || 0; if ((v.sec || 0) > 0) days++; }
    }
    w.liveSec = sec; w.liveCount = cnt; w.liveDays = days; w.liveHasData = has;
  }
  for (const m of monthly) {
    let sec = 0, cnt = 0, days = 0, has = false;
    for (const dk of Object.keys(lhDaily)) {
      if (dk.slice(0, 7) === m.key) { const v = lhDaily[dk]; has = true; sec += v.sec || 0; cnt += v.liveCount || 0; if ((v.sec || 0) > 0) days++; }
    }
    if (!has && lhMonthly[m.key]) { const mv = lhMonthly[m.key]; sec = mv.sec || 0; cnt = mv.liveCount || 0; m.liveDaysUnknown = true; }
    m.liveSec = sec; m.liveCount = cnt; m.liveDays = days; m.liveHasData = has || !!lhMonthly[m.key];
  }
  const liveHoursMeta = {
    creator: LH.creator || "", displayName: LH.displayName || "", updated: LH.updated || null,
    hasDaily, months: Object.keys(lhMonthly),
    latestDaily: hasDaily ? Object.keys(lhDaily).sort().slice(-1)[0] : null,
  };
  const trends = { weekly, monthly, daysAll, liveHoursMeta };
  return {
    currency,
    totals: { sales, grossSales, refundedAmt, refundedCount, ttFunded: ttFundedTotal, orders: count, units, aov: count ? sales / count : 0 },
    returns: { count: returnsCount, amount: returnsAmount },
    returnCustomers,
    cancellations: { count: cancelledCount, amount: cancelledAmt, units: cancelledUnits, rate: totalOrders ? cancelledCount / totalOrders : 0, totalOrders, ...cancellationDetail },
    products, newCustomerProducts, repeatCustomerProducts, productCancel,
    days, hours, dows, customers, trends,
  };
}

// SD仕入台帳の集計（請求書照合用）。指定月(sinceStr..untilStr, YYYY-MM-DD)の明細を月別・購入先別に集計。
function summarizePurchases(sinceStr, untilStr) {
  const rows = PURCHASES || [];
  if (!rows.length) return { available: false, meta: PURCHASES_META || { rows: 0 } };
  const inRange = (d) => d && (!sinceStr || d >= sinceStr) && (!untilStr || d <= untilStr);
  const period = rows.filter((r) => inRange(r.date));
  const sum = (arr) => arr.reduce((a, r) => { a.amount += r.cost * r.qty; a.qty += r.qty; return a; }, { amount: 0, qty: 0 });
  const groupBy = (arr, keyFn) => {
    const m = {};
    for (const r of arr) { const k = keyFn(r); const g = m[k] || (m[k] = { key: k, amount: 0, qty: 0, lines: 0 }); g.amount += r.cost * r.qty; g.qty += r.qty; g.lines += 1; }
    return Object.values(m);
  };
  const byVendor = groupBy(period, (r) => r.vendor || "(不明)").sort((a, b) => b.amount - a.amount);
  const byMonthAll = groupBy(rows, (r) => (r.date || "").slice(0, 7)).sort((a, b) => (a.key < b.key ? 1 : -1));
  const detail = period.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((r) => ({ date: r.date, vendor: r.vendor, name: r.name, color: r.color, base: r.base, cost: r.cost, qty: r.qty, amount: r.cost * r.qty }));
  const tot = sum(period);
  return {
    available: true,
    meta: PURCHASES_META || { rows: rows.length },
    period: { sinceStr, untilStr, amount: tot.amount, qty: tot.qty, lines: period.length, vendors: byVendor.length },
    byVendor, byMonthAll, detail: detail.slice(0, 500),
  };
}
// 原価ソースがSD仕入れ由来か（請求書照合用の分類）。
// sd-*（SDマスタにマッチ）と manual（手動でSD品番に対応付け）は SD原価。
// estimate（売価×係数）/ manual-cost（手入力の他社原価）/ manual-none は その他ブランド。
function isSdSource(s) {
  return /^sd-/.test(String(s || "")) || s === "manual";
}
// 商品名から「ブランド名」を推定（非SD＝個別ブランド用。あくまで推定）。
// 1) 【】（）［］ などの注記を除去 2) よく出るブランド表記を優先抽出 3) ラテン語ブランド語 4) 先頭の意味語 5) 不明
const BRAND_HINTS = [
  "skypink", "sky pink", "la brille", "blueeast", "speranza", "merry jenny", "snidel", "gelato pique",
  "axes femme", "earth music", "titivate", "fifth", "dholic", "gogosing", "stylenanda",
];
function brandFromTitle(title) {
  let t = String(title || "");
  if (!t) return "ブランド不明";
  const low = t.toLowerCase();
  for (const b of BRAND_HINTS) { if (low.includes(b)) return b.replace(/\b\w/g, (c) => c.toUpperCase()); }
  // 注記を除去
  let s = t.replace(/[【［(（《].*?[】］)）》]/g, " ").replace(/\s+/g, " ").trim();
  // ラテン文字のブランドらしき連なり（2文字以上）
  const lat = s.match(/[A-Za-z][A-Za-z&'’\- ]{1,}[A-Za-z]/);
  if (lat) { const w = lat[0].trim(); if (w.length >= 2 && !/^(the|and|set|for|new)$/i.test(w)) return w; }
  // 末尾の「〜東京」「〜ブランド」等のブランド慣用
  const jp = s.match(/([゠-ヿ一-鿿A-Za-z]{2,8})(?:東京|公式|ブランド)/);
  if (jp) return jp[1];
  return "ブランド不明";
}
// 集計結果に原価・粗利・在庫をマージ（破壊的にaggを更新）。
function applyCosts(agg, allOrders, overrides, manualCosts, rate) {
  const idx = getCostIndex();
  let revenue = 0, cogs = 0; const srcCount = {};
  // 請求書照合用: SD仕入れ分とその他ブランド分の原価・売上・粗利を分離
  let sdRevenue = 0, sdCogs = 0, sdProducts = 0, sdUnits = 0;
  let otherRevenue = 0, otherCogs = 0, otherProducts = 0, otherUnits = 0;
  const otherByBrand = {}; // 個別ブランド: brand -> {revenue,cogs,units,products}
  for (const p of agg.products) {
    const c = unitCostFor(p, overrides, manualCosts, rate);
    p.costUnit = c.unit;
    p.costTotal = c.unit * p.units;
    p.grossProfit = p.net - p.costTotal;
    p.margin = p.net ? p.grossProfit / p.net : 0;
    p.costSource = c.source;
    p.matchScore = Math.round((c.score || 0) * 100) / 100;
    p.matchedBase = c.base;
    p.matchedSdName = c.sdName;
    p.vendor = c.vendor;
    p.isSd = isSdSource(c.source);
    revenue += p.net; cogs += p.costTotal;
    if (p.isSd) { sdRevenue += p.net; sdCogs += p.costTotal; sdProducts += 1; sdUnits += p.units; }
    else {
      otherRevenue += p.net; otherCogs += p.costTotal; otherProducts += 1; otherUnits += p.units;
      const brand = brandFromTitle(p.name); p.brand = brand;
      const g = otherByBrand[brand] || (otherByBrand[brand] = { brand, revenue: 0, cogs: 0, units: 0, products: 0 });
      g.revenue += p.net; g.cogs += p.costTotal; g.units += p.units; g.products += 1;
    }
    srcCount[c.source] = (srcCount[c.source] || 0) + 1;
  }
  for (const list of [agg.newCustomerProducts || [], agg.repeatCustomerProducts || []]) {
    for (const p of list) {
      const c = unitCostFor(p, overrides, manualCosts, rate);
      p.costUnit = c.unit; p.costTotal = c.unit * p.units;
      p.grossProfit = p.net - p.costTotal; p.margin = p.net ? p.grossProfit / p.net : 0;
      p.costSource = c.source;
    }
  }
  agg.profit = {
    revenue, cogs, grossProfit: revenue - cogs, grossMargin: revenue ? (revenue - cogs) / revenue : 0, assumeRate: rate, sources: srcCount,
    // 請求書照合用の原価内訳
    split: {
      sd: { revenue: sdRevenue, cogs: sdCogs, grossProfit: sdRevenue - sdCogs, products: sdProducts, units: sdUnits },
      other: { revenue: otherRevenue, cogs: otherCogs, grossProfit: otherRevenue - otherCogs, products: otherProducts, units: otherUnits,
        byBrand: Object.values(otherByBrand).sort((a, b) => b.cogs - a.cogs) },
    },
  };
  // 在庫: 全期間(取得範囲内)の販売個数をbase単位で集計 → 仕入数量累計 − 純販売数
  const EXC = new Set(["CANCELLED", "UNPAID"]);
  const unitsByName = {};
  for (const o of allOrders) {
    const st = o.status || o.order_status || "";
    if (EXC.has(st)) continue;
    for (const li of (o.line_items || [])) {
      const nm = li.product_name || li.sku_name || "(商品名なし)";
      const e = unitsByName[nm] || (unitsByName[nm] = { units: 0, sku: "" });
      e.units += 1;
      if (!e.sku && (li.seller_sku || li.sku_id)) e.sku = String(li.seller_sku || li.sku_id);
    }
  }
  const soldByBase = {};
  const unmatchedSales = [];
  for (const nm of Object.keys(unitsByName)) {
    const e = unitsByName[nm];
    const mt = matchBase(nm, overrides, e.sku);
    if (mt && mt.base) soldByBase[mt.base] = (soldByBase[mt.base] || 0) + e.units;
    else unmatchedSales.push({ name: nm, units: e.units });
  }
  unmatchedSales.sort((a, b) => b.units - a.units);
  agg.inventory = idx.items.map((m) => {
    const sold = soldByBase[m.base] || 0;
    return { base: m.base, name: m.name, vendor: m.vendor, maker: m.maker, cost: m.cost, purchased: m.qty, sold, stock: m.qty - sold };
  }).sort((a, b) => b.stock - a.stock);
  agg.costMeta = {
    rate,
    totalProducts: agg.products.length,
    matchedProducts: agg.products.filter((p) => p.costSource !== "estimate" && p.costSource !== "manual-none").length,
    sources: srcCount,
    unmatchedSales: unmatchedSales.slice(0, 50),
  };
}

// TikTok実在庫(商品)に原価・粗利をマッチして agg.ttStock を作る。
// セラーセンターで「表示中（販売可能）」の商品か。停止/下書き/削除/凍結/審査中などは非表示として除外。
function isShownStatus(s) {
  const x = String(s || "").toUpperCase();
  if (!x) return true; // 不明は安全側で含める
  return !/(DEACTIV|DRAFT|DELET|FREEZE|FROZEN|SUSPEND|PENDING|FAIL|REVIEW|BANNED|REMOV|OFFLINE|UNLIST)/.test(x);
}
function applyTTInventory(agg, ttProducts, overrides, manualCosts, rate) {
  const idx = getCostIndex();
  const all = ttProducts || [];
  const shown = all.filter((p) => isShownStatus(p.status)); // 非表示商品は在庫に反映しない
  const items = shown.map((p) => {
    const prices = (p.skus || []).map((s) => s.price).filter((x) => x > 0);
    const salePrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
    const skuStr = (p.skus || []).map((s) => s.sellerSku).filter(Boolean).join(" ");
    let cost = null, costSource = "estimate", base = null, vendor = "";
    const mc = manualCostFor(p.title, manualCosts);
    if (mc != null) {
      cost = mc; costSource = "manual-cost";
    } else {
      const mt = matchBase(p.title, overrides, skuStr);
      if (mt && mt.base && idx.byBase.has(mt.base)) {
        const m = idx.byBase.get(mt.base);
        cost = m.cost; costSource = mt.source; base = m.base; vendor = m.vendor;
      } else if (salePrice) {
        cost = Math.round(salePrice * rate); // 未マッチは販売価格×係数で推定
      }
    }
    const stock = (typeof p.stock === "number") ? p.stock : null;
    const stockValue = (cost != null && stock != null) ? cost * stock : null;
    const margin = (salePrice && cost != null) ? (salePrice - cost) / salePrice : null;
    return { id: p.id, title: p.title, status: p.status, link: p.link, image: p.image, stock, skus: p.skus || [], salePrice, cost, costSource, base, vendor, stockValue, margin };
  }).sort((a, b) => (b.stock || 0) - (a.stock || 0));
  const totalStock = items.reduce((s, x) => s + (x.stock || 0), 0);
  const totalStockValue = items.reduce((s, x) => s + (x.stockValue || 0), 0);
  const matched = items.filter((x) => x.costSource !== "estimate").length;
  agg.ttStock = {
    available: true, count: items.length, totalStock, totalStockValue, matched,
    activeCount: items.length, hiddenExcluded: all.length - shown.length, totalAll: all.length,
    items,
  };
}

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
  const env = {
    store: process.env.TTS_SHOP || "",
    key: process.env.TTS_APP_KEY,
    secret: process.env.TTS_APP_SECRET,
    token: process.env.TTS_ACCESS_TOKEN,
    refresh: process.env.TTS_REFRESH_TOKEN,
  };
  // 軽量デバッグ(GET): 当月の配信時間マージ結果だけを返す（配信時間が出ない原因の切り分け用）。
  if (req.method === "GET" && req.query && req.query.debug === "live") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    try {
      const daily = await loadLiveDaily();
      const dkeys = Object.keys(daily || {}).sort();
      const monSum = {};
      for (const k of dkeys) { const mk = k.slice(0, 7); monSum[mk] = (monSum[mk] || 0) + (daily[k].sec || 0); }
      let rk = { monthly: {}, daily: {} }; try { rk = await fetchBarbieFromRanking(); } catch (e) {}
      res.status(200).json({
        ok: true,
        blobDailyDays: dkeys.length,
        blobDailyRange: dkeys.length ? (dkeys[0] + "〜" + dkeys[dkeys.length - 1]) : null,
        blobMonthlySec: monSum,
        rankingMonthlyKeys: Object.keys(rk.monthly || {}),
        rankingDailyDays: Object.keys(rk.daily || {}).length,
      });
    } catch (e) { res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  if (!env.key || !env.secret || (!env.token && !env.refresh)) {
    res.status(500).json({ error: "TTS_APP_KEY / TTS_APP_SECRET と、TTS_ACCESS_TOKEN または TTS_REFRESH_TOKEN のいずれかが未設定です" });
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
    // 軽量モード（ドリル/売れ筋の期間内訳など）: 返金API・商品在庫取得・仕入台帳・原価計算を省いて高速返却。
    const light = !!(body && (body.light || body.mode === "drill"));
    const R = resolveRange(body && body.since, body && body.until);
    const allOrders = await getAllOrders(env, shop.cipher);
    if (!light) {
      let rk = { monthly: {}, daily: {} };
      try { rk = await fetchBarbieFromRanking(); } catch (e) {}
      RUNTIME_LIVE_MONTHLY = rk.monthly || {};
      try { const bd = await loadLiveDaily(); RUNTIME_LIVE_DAILY = { ...bd, ...(rk.daily || {}) }; } catch (e) { RUNTIME_LIVE_DAILY = rk.daily || {}; }
    }
    let refunds = { byOrder: {}, completed: 0, total: 0, error: null };
    if (!light) { try { refunds = await getRefundsByOrder(env, shop.cipher); } catch (e) { refunds = { byOrder: {}, completed: 0, total: 0, error: String((e && e.message) || e) }; } }
    const agg = aggregate(allOrders, R.ge, R.lt, refunds.byOrder);
    // agg.returns は選択期間の注文に紐づく返金（aggregate内で算出）。全期間の合計は参考情報として保持。
    agg.refundInfo = { completed: refunds.completed, total: refunds.total, allTimeAmount: refunds.refundTotal || 0, allTimeOrders: refunds.refundOrders || 0, error: refunds.error };
    const overrides = (body && body.costOverrides) || {};
    const manualCosts = (body && body.manualCosts) || {};
    const rate = (body && typeof body.assumeRate === "number" && body.assumeRate > 0 && body.assumeRate < 1) ? body.assumeRate : 0.5;
    // 比較モード: 重い在庫取得(getAllProducts)と仕入台帳を省き、売上・顧客・返金・粗利・配信は保持して高速化。
    const skipInv = !!(body && body.compare);
    if (!light) {
      applyCosts(agg, allOrders, overrides, manualCosts, rate);
      if (!skipInv) {
        // TikTok Shop 実在庫（商品権限が必要。失敗してもダッシュボード本体は表示）
        try {
          const ttp = await getAllProducts(env, shop.cipher);
          applyTTInventory(agg, ttp, overrides, manualCosts, rate);
        } catch (e) {
          agg.ttStock = { available: false, error: String((e && e.message) || e), code: (e && e.ttcode) || null };
        }
        agg.purchasesLog = summarizePurchases(R.sinceStr, R.untilStr);
      }
    }
    res.status(200).json({
      shop: { name: shop.name || env.store, region: shop.region || "JP" },
      range: { since: R.sinceStr, until: R.untilStr },
      fetchedAll: allOrders.length,
      snapshotInfo: lastSnapInfo,
      ...agg,
    });
  } catch (e) {
    res.status(200).json({ error: String((e && e.message) || e) });
  }
}
