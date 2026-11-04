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
//   api/live_ingest … 外部ボット用（LIVE_INGEST_KEY で保護）
//   api/live_sessions … ローカル収集スクリプト用（COLLECT_KEY で保護）
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);
    if (!PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
      const denied = basicAuth(request, env);
      if (denied) return denied;
    }
    const m = path.match(/^api\/([a-z_]+?)(?:\.js)?\/?$/);
    if (m) {
      const handler = HANDLERS[m[1]];
      if (!handler) return new Response("Not Found", { status: 404 });
      return vercelAdapter(handler, request);
    }
    return env.ASSETS.fetch(request);
  },
};
