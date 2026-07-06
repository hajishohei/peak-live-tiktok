// data/live-hours_barbie.json → api/live_hours.js（サーバーレスで確実に読めるJSモジュール化）
// 使い方: node scripts/build_livehours.js
const fs = require("fs");
const dir = "/sessions/sweet-elegant-cray/mnt/peak-live-tiktok";
const src = JSON.parse(fs.readFileSync(dir + "/data/live-hours_barbie.json", "utf8"));
// hms文字列→秒（数値が無い場合の保険）
function hmsToSec(s) {
  const m = String(s || "").match(/(?:(\d+)\s*時間)?\s*(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}
for (const k of Object.keys(src.daily || {})) {
  const v = src.daily[k];
  if (v && (v.sec == null) && v.hms) v.sec = hmsToSec(v.hms);
}
for (const k of Object.keys(src.monthly || {})) {
  const v = src.monthly[k];
  if (v && (v.sec == null) && v.hms) v.sec = hmsToSec(v.hms);
}
const js = "// 自動生成: ばーびー(@.choice2)の配信時間。元データ: data/live-hours_barbie.json\n" +
  "// 更新: data/live-hours_barbie.json を更新 → node scripts/build_livehours.js → 再デプロイ\n" +
  "export const LIVE_HOURS = " + JSON.stringify(src) + ";\n" +
  "export default LIVE_HOURS;\n";
fs.writeFileSync(dir + "/lib/live_hours.js", js);
const md = Object.keys(src.monthly || {}).length, dd = Object.keys(src.daily || {}).length;
console.log("live_hours.js generated. monthly=" + md + " daily=" + dd);
