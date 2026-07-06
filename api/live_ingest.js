// 日次配信時間の取り込み口: POST または GET /api/live_ingest
// 専用スケジュールタスク（ばーびーの昨日分）や手動UIから、ある日の配信時間を1件追記する。
// Blob(tts-live-daily.json)に保存され、/api/query が日次にマージ（再デプロイ不要）。
// GET例: /api/live_ingest?date=2026-06-28&sec=12846&liveCount=2&key=xxx
//        （sec の代わりに hours=3.5 や hms=3時間34分6秒 でも可）
// POST(JSON): { date, sec?|hours?|hms?, liveCount?, key? }
import { saveLiveDaily, loadLiveDaily, saveLiveDailyBulk } from "./query.js";

function hmsToSec(s) {
  const m = String(s || "").match(/(?:(\d+)\s*時間)?\s*(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(200).json({ ok: false, error: "Vercel Blob未設定" }); return;
  }
  let p;
  if (req.method === "POST") {
    p = req.body; if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  } else {
    p = req.query || {};
  }
  p = p || {};
  // 読み取り専用モード（書き込まない）: 現在保存されている日次データを一覧で返す。
  if (p.list != null || p.peek != null) {
    try {
      const cur = await loadLiveDaily();
      const dates = Object.keys(cur || {}).sort();
      const days = {}; let totalSec = 0;
      for (const d of dates) { const v = cur[d] || {}; days[d] = { sec: v.sec || 0, hms: v.hms || "", liveCount: v.liveCount || 0 }; totalSec += v.sec || 0; }
      res.status(200).json({ ok: true, mode: "list", totalDays: dates.length, totalSec, totalHms: `${Math.floor(totalSec/3600)}時間${Math.floor((totalSec%3600)/60)}分`, days });
    } catch (e) { res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
    return;
  }
  const need = process.env.LIVE_INGEST_KEY;
  if (need && String(p.key || "") !== String(need)) { res.status(200).json({ ok: false, error: "認証キーが違います" }); return; }
  // 一括インポート: days = { "YYYY-MM-DD": {hours|sec|hms, liveCount} , ... }。replaceMonth="YYYY-MM"でその月を入れ替え。
  if (p.days != null) {
    let map = p.days; if (typeof map === "string") { try { map = JSON.parse(map); } catch (e) { res.status(200).json({ ok: false, error: "days のJSONが不正です" }); return; } }
    const recMap = {};
    for (const d of Object.keys(map || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const v = map[d] || {};
      let sec = 0;
      if (v.sec != null && v.sec !== "") sec = Math.max(0, Math.round(Number(v.sec) || 0));
      else if (v.hours != null && v.hours !== "") sec = Math.max(0, Math.round((Number(v.hours) || 0) * 3600));
      else if (v.hms) sec = hmsToSec(v.hms);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      recMap[d] = { sec, hms: ((h ? h + "時間" : "") + (m ? m + "分" : "") + (s ? s + "秒" : "")) || "0", liveCount: Number(v.liveCount || 0) || 0 };
    }
    try {
      const total = await saveLiveDailyBulk(recMap, p.replaceMonth ? String(p.replaceMonth) : null);
      res.status(200).json({ ok: true, imported: Object.keys(recMap).length, replaceMonth: p.replaceMonth || null, totalDays: total });
    } catch (e) { res.status(200).json({ ok: false, error: String((e && e.message) || e) }); }
    return;
  }
  const date = String(p.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(200).json({ ok: false, error: "date は YYYY-MM-DD 形式で指定してください" }); return; }
  let sec = 0;
  if (p.sec != null && p.sec !== "") sec = Math.max(0, Math.round(Number(p.sec) || 0));
  else if (p.hours != null && p.hours !== "") sec = Math.max(0, Math.round((Number(p.hours) || 0) * 3600));
  else if (p.hms) sec = hmsToSec(p.hms);
  const liveCount = Number(p.liveCount || 0) || 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const rec = { sec, hms: ((h ? h + "時間" : "") + (m ? m + "分" : "") + (s ? s + "秒" : "")) || "0", liveCount };
  try {
    const total = await saveLiveDaily(date, rec);
    res.status(200).json({ ok: true, date, rec, totalDays: total });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
