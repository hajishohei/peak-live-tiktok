// Cloudflare Workers エントリ。旧 Vercel 構成（middleware.js の Basic 認証 + api/*.js + public/）を1本で再現する。
import { vercelAdapter } from "./adapter.js";
import auth from "../api/auth.js";
import callback from "../api/callback.js";
import live_analytics from "../api/live_analytics.js";
import live_ingest from "../api/live_ingest.js";
import live_sessions from "../api/live_sessions.js";
import order_probe from "../api/order_probe.js";
import product_analytics from "../api/product_analytics.js";
import query from "../api/query.js";
import returns_probe from "../api/returns_probe.js";
import shipping_cost from "../api/shipping_cost.js";
import snapshot from "../api/snapshot.js";
import stock_snapshot from "../api/stock_snapshot.js";

const HANDLERS = {
  auth, callback, live_analytics, live_ingest, live_sessions, order_probe,
  product_analytics, query, returns_probe, shipping_cost, snapshot, stock_snapshot,
};

// Basic認証をかけないパス（旧 middleware.js の matcher と同じ前方一致）
//   api/live_ingest … 合言葉 LIVE_INGEST_KEY、またはダッシュボードのBasic認証で可
//   api/live_sessions … 合言葉 COLLECT_KEY、またはダッシュボードのBasic認証で可
//   api/callback … TikTok OAuth のリダイレクト先
//   favicon.svg
const PUBLIC_PREFIXES = ["api/live_ingest", "api/live_sessions", "api/callback", "favicon.svg"];

function basicAuth(request, env) {
  const user = env.DASH_USER || "";
  const pass = env.DASH_PASS || "";
  if (!user || !pass) {
    // 未設定のまま公開しない（fail closed）
    return new Response(
      JSON.stringify({ error: "認証が未設定です。Cloudflare Workers の環境変数に DASH_USER / DASH_PASS を設定してください。" }),
      { status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
  const h = request.headers.get("authorization") || "";
  if (h.startsWith("Basic ")) {
    try {
      const decoded = atob(h.slice(6));
      const i = decoded.indexOf(":");
      const u = i >= 0 ? decoded.slice(0, i) : decoded;
      const p = i >= 0 ? decoded.slice(i + 1) : "";
      if (u === user && p === pass) return null;
    } catch (e) { /* 不正なBase64は未認証扱い */ }
  }
  return new Response("認証が必要です / Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Peak TOKYO Dashboard", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

// 旧 Vercel Blob → KV の一時移行口。IMPORT_TOKEN を設定している間だけ有効（移行後は変数を消す）。
// Vercel のダッシュボード（ブラウザ）から PUT で流し込むため、vercel.com からの CORS を許可する。
const IMPORT_CORS = {
  "Access-Control-Allow-Origin": "https://vercel.com",
  "Access-Control-Allow-Methods": "PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-import-token",
};
// GET /_import?t=<IMPORT_TOKEN> … ダウンロード済みの tts-*.json を選んでまとめて送る画面
const IMPORT_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>データ移行</title><body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:0 16px">
<h2>peak-live データ移行</h2><p>「ダウンロード」フォルダの <b>tts-</b> で始まる7ファイルを全部選んでください。</p>
<input type="file" id="f" multiple accept=".json"><ul id="o"></ul>
<script>
const t=new URLSearchParams(location.search).get("t");
f.onchange=async()=>{for(const file of f.files){const li=document.createElement("li");li.textContent=file.name+" … 送信中";o.append(li);
const name=file.name.replace(/ \\(\\d+\\)(?=\\.json$)/,"");
const r=await fetch("/_import/"+encodeURIComponent(name),{method:"PUT",headers:{"x-import-token":t},body:await file.text()});
li.textContent=name+(r.ok?" ✅ 完了":" ❌ 失敗 "+r.status);}};
</script>`;
async function importBlob(request, env, key) {
  if (!env.IMPORT_TOKEN) return new Response("Not Found", { status: 404 });
  if (request.method === "GET" && key === "") {
    if (new URL(request.url).searchParams.get("t") !== env.IMPORT_TOKEN) return new Response("forbidden", { status: 403 });
    return new Response(IMPORT_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: IMPORT_CORS });
  if (request.method !== "PUT" || request.headers.get("x-import-token") !== env.IMPORT_TOKEN || !/^tts-[a-z-]+\.json$/.test(key)) {
    return new Response("forbidden", { status: 403, headers: IMPORT_CORS });
  }
  const body = await request.text();
  JSON.parse(body); // 壊れたJSONは入れない
  await env.DATA.put(key, body);
  return new Response(JSON.stringify({ ok: true, key, bytes: body.length }), { headers: { ...IMPORT_CORS, "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);
    if (path === "_import" || path.startsWith("_import/")) return importBlob(request, env, decodeURIComponent(path.slice("_import/".length)));
    const isPublic = PUBLIC_PREFIXES.some((p) => path.startsWith(p));
    // 公開パスでも Basic 認証が通っていれば「ダッシュボード利用者」として扱う（live_* は合言葉なしで可）
    const dashAuthed = !basicAuth(request, env);
    if (!isPublic && !dashAuthed) return basicAuth(request, env);
    const m = path.match(/^api\/([a-z_]+?)(?:\.js)?\/?$/);
    if (m) {
      const handler = HANDLERS[m[1]];
      if (!handler) return new Response("Not Found", { status: 404 });
      return vercelAdapter(handler, request, { dashAuthed });
    }
    return env.ASSETS.fetch(request);
  },
  // 毎日 23:50 JST にその日のTTS在庫を記録（旧「Peak stock history daily」タスクの置き換え。PC不要）
  async scheduled(event, env, ctx) {
    const res = await vercelAdapter(HANDLERS.stock_snapshot, new Request("https://cron.local/api/stock_snapshot"));
    console.log("stock_snapshot", await res.text());
    // 月次の締め：月末から20日を過ぎた月の注文・返金を確定データとして保存（400日を過ぎても残す）
    try {
      const r2 = await vercelAdapter(HANDLERS.query, new Request("https://cron.local/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "close_months" }) }));
      console.log("close_months", (await r2.text()).slice(0, 300));
    } catch (e) { console.log("close_months failed", String(e)); }
  },
};
