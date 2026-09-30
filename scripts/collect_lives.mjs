#!/usr/bin/env node
/**
 * BCチョイス LIVE配信データ収集スクリプト（Playwright）
 *
 * これまでAIエージェント（Claude）がブラウザを操作して行っていた収集作業を、
 * そのままコードに落としたものです。判断が要らない決め打ちの処理しか無いため、
 * スクリプトで回したほうが速く、確実で、コストもかかりません。
 *
 * やること:
 *   1. セラーセンターのLIVE詳細一覧から、直近7日ぶんの配信（live_id・日時・GMV等）を取得
 *   2. ダッシュボードの /api/live_sessions に投入（既存の紹介時間は保持したまま上書き）
 *   3. 紹介時間（ピン留め）が未収集の配信を、1回につき数本ぶん収集して投入
 *   4. 結果をログに書き、異常があれば終了コード1で終わる
 *
 * 使い方:
 *   初回（TikTokにログインする）:  node scripts/collect_lives.mjs --login
 *   通常実行:                      node scripts/collect_lives.mjs
 *   バックフィルを多めに回す:      node scripts/collect_lives.mjs --pins 10
 *
 * 必要な環境変数:
 *   DASH_USER / DASH_PASS   ダッシュボードのBasic認証（Vercelに設定しているものと同じ）
 *
 * 補足:
 *   ブラウザのプロファイルは scripts/.browser-profile に保存され、TikTokのログインが維持されます。
 *   このディレクトリは .gitignore に入れてください（セッション情報を含むため）。
 */
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, ".browser-profile");
const LOG_PATH = path.join(__dirname, "collect_lives.log");

const DASH = "https://peak-live-tiktok.vercel.app";
const LIST_URL = "https://seller-jp.tiktok.com/compass/live-analysis/live-details?shop_region=JP";
const TREND_URL = (id) => `https://shop.tiktok.com/workbench/live/trend-analysis?room_id=${id}&region=JP`;

const args = process.argv.slice(2);
const LOGIN_MODE = args.includes("--login");
const PIN_LIMIT = (() => { const i = args.indexOf("--pins"); return i >= 0 ? Math.max(0, Number(args[i + 1]) || 0) : 4; })();

const log = [];
function say(msg) { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); log.push(line); }
function flushLog() { try { fs.appendFileSync(LOG_PATH, log.join("\n") + "\n"); } catch (e) {} }

// ---------------------------------------------------------------------------
// ページ内で実行する関数。AIが試行錯誤して見つけた手法をそのまま使っています。
// ---------------------------------------------------------------------------

// LIVE一覧: テーブルのDOMにlive_idが無く、Reactの内部プロパティにだけ入っているため、
// fiberを遡って行データの配列を取り出す。
const EXTRACT_LIVES = async () => {
  const findData = () => {
    const ff = (el) => { const k = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")); return k ? el[k] : null; };
    const row = Array.from(document.querySelectorAll("tr")).filter((r) => r.querySelectorAll("td").length > 2)[0];
    if (!row) return [];
    let f = ff(row), d = 0;
    while (f && d < 25) {
      const p = f.memoizedProps;
      if (p && Array.isArray(p.data) && p.data.length && p.data[0] && p.data[0].liveId) return p.data;
      f = f.return; d++;
    }
    return [];
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const seen = new Map();
  const grab = () => { for (const r of findData()) if (r && r.liveId) seen.set(String(r.liveId), r); };
  const btn = (re) => Array.from(document.querySelectorAll("button,li,a,span")).find((e) => {
    const al = (e.getAttribute && (e.getAttribute("aria-label") || "")) || "";
    const cl = (e.className && e.className.toString()) || "";
    return (re.test(al) || re.test(cl)) && !/disabled/i.test(cl) && e.offsetParent !== null;
  });
  grab();
  for (let i = 0; i < 12; i++) {
    const b = btn(/next/i); if (!b) break;
    const n = seen.size; b.click(); await sleep(2400); grab();
    if (seen.size === n) break;
  }
  return Array.from(seen.values()).map((r) => ({
    liveId: String(r.liveId), start: r.start_time, end: r.endTime, duration: r.duration,
    gmv: Number((r.revenue || {}).amount || 0), viewers: r.watch_pv || 0, impressions: r.product_view || 0,
  })).sort((a, b) => b.start - a.start);
};

// ピン留め: グラフはcanvas描画なのでDOMから読めない。合成マウスイベントで横断ホバーし、
// 出てくるツールチップ（5分刻み）を集める。取りこぼし防止に刻み幅を変えて2回走査する。
const SCAN_PINS = async () => {
  const c = document.querySelector("canvas");
  if (!c) return { error: "canvasが見つかりません" };
  const r = c.getBoundingClientRect();
  if (r.width < 200) return { error: "グラフの幅が想定外です: " + Math.round(r.width) };
  const y = r.top + r.height * 0.55;
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const hov = (x) => { for (const t of ["pointermove", "mousemove"]) c.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true })); };
  const seen = new Map();
  const scan = async (step, wait) => {
    for (let x = r.left + 8; x <= r.right - 8; x += step) {
      hov(x); await sleep(wait);
      const t = ((document.querySelector(".vchart-tooltip-container") || {}).innerText || "").replace(/\n+/g, "|").trim();
      const m = t.match(/^([0-9]{1,2}:[0-9]{2}\s*[-～][^|]*)\|/); if (!m) continue;
      const k = m[1].trim(); if (!seen.has(k)) seen.set(k, t);
    }
  };
  await scan(12, 110);
  await scan(17, 150);
  return { lines: [...seen.values()] };
};

// ---------------------------------------------------------------------------
// ツールチップ文字列 → pins配列
// 例: "16:16 - 16:21|派生GMV|0円|インプレッション数|617|ピン留め|フリルサロペットパンツ"
// ---------------------------------------------------------------------------
function parsePins(lines) {
  const num = (s) => Number(String(s || "").replace(/[^\d.-]/g, "")) || 0;
  return lines.map((line) => {
    const p = line.split("|").map((x) => x.trim());
    const range = p[0] || "";
    const [from, to] = range.split(/\s*[-～]\s*/);
    const idxGmv = p.indexOf("派生GMV");
    const idxImp = p.findIndex((x) => /インプレッション/.test(x));
    const idxPin = p.indexOf("ピン留め");
    return {
      from: (from || "").trim(),
      to: (to || "").trim(),
      minutes: 5,
      productName: idxPin >= 0 ? (p[idxPin + 1] || "") : "",
      gmv: idxGmv >= 0 ? num(p[idxGmv + 1]) : 0,
      impressions: idxImp >= 0 ? num(p[idxImp + 1]) : 0,
    };
  }).filter((x) => x.from);
}

function toSession(r, pins) {
  const jst = (u) => new Date((u + 9 * 3600) * 1000).toISOString();
  const s = jst(r.start), e = jst(r.end);
  return {
    liveId: r.liveId, date: s.slice(0, 10), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
    durationSec: r.duration, gmv: r.gmv, viewers: r.viewers, impressions: r.impressions,
    units: 0, pins: pins || [],
  };
}

// ---------------------------------------------------------------------------
async function main() {
  const user = process.env.DASH_USER || "";
  const pass = process.env.DASH_PASS || "";
  if (!LOGIN_MODE && (!user || !pass)) {
    say("環境変数 DASH_USER / DASH_PASS が未設定です。ダッシュボードのBasic認証に必要です。");
    process.exitCode = 1; return;
  }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !LOGIN_MODE,
    viewport: { width: 1600, height: 1000 },
    httpCredentials: user ? { username: user, password: pass } : undefined,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    if (LOGIN_MODE) {
      say("ログインモードです。開いたブラウザでTikTok Shopセラーセンターにログインしてください。");
      await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
      say("ログインが終わったらこのウィンドウを閉じずに、ターミナルで Ctrl+C を押してください。");
      await page.waitForTimeout(10 * 60 * 1000);
      return;
    }

    // --- 1. LIVE一覧 ---
    say("LIVE一覧を取得します…");
    await page.goto(LIST_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);

    if (/login|passport/i.test(page.url())) {
      say("TikTokのログインが切れています。`node scripts/collect_lives.mjs --login` で入り直してください。");
      process.exitCode = 1; return;
    }

    // 期間を「過去の7日間」にする（配信後もGMVが増え続けるため毎回取り直す）
    try {
      await page.getByText(/本日:|最後の28日|過去の7日間/).first().click({ timeout: 8000 });
      await page.waitForTimeout(1200);
      await page.getByText("過去の7日間", { exact: true }).first().click({ timeout: 8000 });
      await page.waitForTimeout(4000);
    } catch (e) {
      say("期間の切り替えに失敗しました（画面構造が変わった可能性）。表示中の期間のまま続行します: " + (e.message || e));
    }

    const lives = await page.evaluate(EXTRACT_LIVES);
    if (!lives.length) {
      say("LIVE一覧が0件でした。画面構造が変わった可能性があります。処理を中止します。");
      process.exitCode = 1; return;
    }
    say(`LIVE一覧 ${lives.length}件を取得しました（${lives[lives.length - 1] ? new Date((lives[lives.length - 1].start + 9 * 3600) * 1000).toISOString().slice(0, 10) : "?"} 〜 ${new Date((lives[0].start + 9 * 3600) * 1000).toISOString().slice(0, 10)}）`);

    // --- 2. 既存セッションを読んで、紹介時間を保持したまま投入 ---
    const cur = await (await fetch(`${DASH}/api/live_sessions?full=1`, {
      headers: { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") },
    })).json();
    const pinMap = {};
    for (const s of cur.sessions || []) if ((s.pins || []).length) pinMap[s.liveId] = s.pins;

    const sessions = lives.map((r) => toSession(r, pinMap[r.liveId] || []));
    const postRes = await postSessions(sessions, user, pass);
    say(`配信一覧を投入しました: saved=${postRes.saved} total=${postRes.totalSessions}`);

    // --- 3. 紹介時間が未収集の配信を処理 ---
    const already = new Set(Object.keys(pinMap));
    const known = (cur.sessions || []).map((s) => s.liveId);
    const allKnown = new Set([...known, ...lives.map((l) => l.liveId)]);
    // 対象: pins未収集のもの。GMVが大きい順（前日ぶんも自然に上位に来る）
    const byId = {};
    for (const s of cur.sessions || []) byId[s.liveId] = s;
    for (const r of lives) byId[r.liveId] = { ...(byId[r.liveId] || {}), ...toSession(r, pinMap[r.liveId] || []) };
    const targets = [...allKnown]
      .filter((id) => !already.has(id))
      .map((id) => byId[id])
      .filter(Boolean)
      .sort((a, b) => (b.gmv || 0) - (a.gmv || 0))
      .slice(0, PIN_LIMIT);

    say(`紹介時間の未収集は ${[...allKnown].filter((id) => !already.has(id)).length}件。今回は ${targets.length}件を処理します。`);

    let okCount = 0;
    for (const t of targets) {
      try {
        await page.goto(TREND_URL(t.liveId), { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(6000);
        const res = await page.evaluate(SCAN_PINS);
        if (res.error) { say(`  ${t.date} ${t.startTime} (${t.liveId}): ${res.error}`); continue; }
        const pins = parsePins(res.lines || []);
        if (!pins.length) { say(`  ${t.date} ${t.startTime} (${t.liveId}): ピン留めを取得できませんでした`); continue; }
        await postSessions([{ ...t, pins }], user, pass);
        okCount++;
        say(`  ${t.date} ${t.startTime} (${t.liveId}): ${pins.length}区間を収集`);
      } catch (e) {
        say(`  ${t.liveId}: 失敗 ${(e && e.message) || e}`);
      }
    }

    // --- 4. 確認 ---
    const after = await (await fetch(`${DASH}/api/live_sessions`, {
      headers: { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") },
    })).json();
    const withPins = (after.sessions || []).filter((s) => s.pinCount > 0).length;
    say(`完了: 保存 ${after.total}配信 / 紹介時間あり ${withPins}配信 / 今回新規 ${okCount}件`);
    if (okCount === 0 && targets.length > 0) {
      say("紹介時間を1件も取得できませんでした。画面構造の変更を疑ってください。");
      process.exitCode = 1;
    }
  } finally {
    await ctx.close();
    flushLog();
  }
}

async function postSessions(sessions, user, pass) {
  const r = await fetch(`${DASH}/api/live_sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    },
    body: JSON.stringify({ sessions }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("投入に失敗: " + (j.error || JSON.stringify(j)));
  return j;
}

main().catch((e) => { say("異常終了: " + ((e && e.stack) || e)); flushLog(); process.exit(1); });
