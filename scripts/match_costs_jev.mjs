#!/usr/bin/env node
/**
 * 原価マッチング（TikTok商品名 ↔ SD仕入れマスタ）を Jev / TypeSafe で行うスクリプト
 *
 * 背景:
 *   現在の名寄せは api/query.js の matchBase() が担当していて、
 *   「新作」「全3色」などのノイズ語を手書きで剥がしてから、正規化名の包含判定と
 *   トークンのJaccard係数で突き合わせています。装飾語のパターンが増えるたびに
 *   NOISE_WORDS を足す必要があり、壊れやすいコードになっています。
 *   その結果、原価マッチ率は 17.1%（70商品中12商品）に留まっています。
 *
 * このスクリプトがやること:
 *   1. ダッシュボードから「原価が推定のまま（costSource === "estimate"）」の商品を取得
 *   2. 商品ごとに、SDマスタから候補を機械的に数件まで絞る（ここは安価な文字列処理で十分）
 *   3. Jev に「どの仕入れ品が同一商品か」を Choice で選ばせる（該当なしの選択肢つき）
 *   4. confidence が高いものだけ自動採用し、lib/name_overrides.js に書き出す
 *   5. confidence が低いものは scripts/match_review.csv に出し、人が目で確認する
 *
 * 使い方:
 *   export TYPESAFE_API_KEY="..."
 *   export DASH_USER="..." DASH_PASS="..."
 *   node scripts/match_costs_jev.mjs              # 判定して結果を書き出す
 *   node scripts/match_costs_jev.mjs --dry        # APIは叩くがファイルは書かない
 *   node scripts/match_costs_jev.mjs --limit 20   # 最初の20件だけ試す（検証用）
 *
 * 出力:
 *   lib/name_overrides.js    自動採用ぶんの対応表（TikTok商品名 → SD品番）
 *   scripts/match_review.csv 人の確認が必要なぶん
 *
 * 注意:
 *   採用しきい値は下の ADOPT_CONFIDENCE で調整します。最初は高め（0.85）にして、
 *   確認キューを見ながら下げていくのが安全です。誤った紐付けは粗利を直接歪めます。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SD_MASTER } from "../lib/sd_costs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DASH = "https://peak-live-tiktok.vercel.app";
const API = "https://api.typesafe.ai/v1/systemone";

const ADOPT_CONFIDENCE = 0.85;  // これ以上なら自動採用
const CANDIDATES = 6;           // Jevに提示する候補数
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? Number(args[i + 1]) || 0 : 0; })();

// --- 候補の絞り込み（既存ロジックと同じ考え方の軽い前処理） -----------------
const NOISE = /(新作|新色追加|新色|再入荷|再々入荷|再生産|追加生産|追加発注|追加|予約販売|予約|人気アイテム|人気商品|売れ筋アイテム|定番商品|定番|数量限定|web限定特別価格|web限定|特別価格|最終価格|セール|送料無料|即納|全\d色|春夏新作|秋冬新作|春新作|秋新作|春夏|秋冬)/g;
function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/[【《≪「（(\[].*?[】》≫」）)\]]/g, " ")
    .replace(NOISE, " ")
    .replace(/[★☆◎●◆◇■□♪♡♥※→←／＼/\\|・,，、。.！!？?＆&~〜ー\-_:：;；'"`#＃]/g, " ")
    .replace(/[\s　]+/g, "");
}
function tokens(s) {
  return new Set(String(s || "").toLowerCase()
    .replace(/[【《≪「（(\[].*?[】》≫」）)\]]/g, " ")
    .replace(NOISE, " ")
    .replace(/[★☆◎●◆◇■□♪♡♥※→←／＼/\\|・,，、。.！!？?＆&~〜ー\-_:：;；'"`#＃]/g, " ")
    .split(/[\s　]+/).filter((w) => w.length >= 2));
}
function jac(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); }
// 2-gram の重なりも見る（日本語は空白で切れないため、トークンだけだと弱い）
function bigrams(s) { const t = norm(s); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; }

const MASTER = SD_MASTER.map((m) => ({ ...m, _n: norm(m.name), _t: tokens(m.name), _g: bigrams(m.name) }));

function candidatesFor(name) {
  const n = norm(name), t = tokens(name), g = bigrams(name);
  return MASTER.map((m) => {
    let s = jac(t, m._t) * 0.5 + jac(g, m._g) * 0.5;
    if (n && m._n && (n.includes(m._n) || m._n.includes(n))) s += 0.25;
    return { m, s };
  }).sort((a, b) => b.s - a.s).slice(0, CANDIDATES).filter((x) => x.s > 0.05);
}

// --- Jev 呼び出し -----------------------------------------------------------
async function askJev(product, cands) {
  const criteria = { none: "この中に同一の商品は無い" };
  cands.forEach((c, i) => {
    criteria["c" + i] = `品番${c.m.base} / ${c.m.name}${c.m.maker ? " / メーカー品番" + c.m.maker : ""}${c.m.vendor ? " / 仕入先" + c.m.vendor : ""}`;
  });
  const state = [
    "TikTok Shopで販売しているアパレル商品の名称と、自社の仕入れマスタの商品名を突き合わせ、同一商品を特定したい。",
    "TikTokの商品名には「新作」「全3色」「送料無料」などの販促用の語や、ブランド名の表記ゆれが含まれることがある。",
    "仕入れマスタ側は品番と正式名称で管理されており、色やサイズの違いは同じ品番にまとまっている。",
    "",
    `TikTokの商品名: ${product}`,
  ].join("\n");
  const body = {
    state, model: "jev-latest",
    questions: {
      same_item: { type: "choice", instructions: "この中で、TikTokの商品名と同一の商品はどれ？表記ゆれや販促語の有無は無視して、商品そのものが同じかどうかで判断すること。", criteria },
    },
  };
  const r = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Jev API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const a = (j.answers || {}).same_item || {};
  return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, usage: j.usage };
}

// --- メイン -----------------------------------------------------------------
async function main() {
  for (const k of ["TYPESAFE_API_KEY", "DASH_USER", "DASH_PASS"]) {
    if (!process.env[k]) { console.error(`環境変数 ${k} が未設定です`); process.exit(1); }
  }
  const auth = "Basic " + Buffer.from(`${process.env.DASH_USER}:${process.env.DASH_PASS}`).toString("base64");

  // 直近3ヶ月ぶんの商品を対象にする
  const until = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const since = new Date(Date.now() + 9 * 3600e3 - 89 * 86400e3).toISOString().slice(0, 10);
  console.log(`ダッシュボードから商品を取得します（${since}〜${until}）…`);
  const res = await fetch(`${DASH}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ mode: "dashboard", since, until }),
  });
  const data = await res.json();
  const all = (data.products || []);
  let targets = all.filter((p) => p.costSource === "estimate" && p.name);
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(`商品 ${all.length}件のうち、原価が推定のままなのは ${all.filter((p) => p.costSource === "estimate").length}件。今回は ${targets.length}件を判定します。`);

  const adopted = {}, review = [];
  let calls = 0, inTok = 0, outTok = 0;

  for (const p of targets) {
    const cands = candidatesFor(p.name);
    if (!cands.length) { review.push({ name: p.name, base: "", sdName: "", conf: 0, note: "候補なし" }); continue; }
    let r;
    try { r = await askJev(p.name, cands); calls++; }
    catch (e) { console.error(`  失敗: ${p.name} … ${e.message}`); review.push({ name: p.name, base: "", sdName: "", conf: 0, note: "API失敗" }); continue; }
    if (r.usage) { inTok += r.usage.input_tokens || 0; outTok += r.usage.output_tokens || 0; }

    if (r.choice === "none" || !r.choice) {
      review.push({ name: p.name, base: "", sdName: "", conf: r.confidence || 0, note: "該当なしと判定" });
      continue;
    }
    const idx = Number(String(r.choice).replace(/^c/, ""));
    const pick = cands[idx];
    if (!pick) { review.push({ name: p.name, base: "", sdName: "", conf: r.confidence || 0, note: "候補の対応が取れず" }); continue; }

    if ((r.confidence || 0) >= ADOPT_CONFIDENCE) {
      adopted[p.name] = pick.m.base;
      console.log(`  採用 ${(r.confidence).toFixed(2)}  ${p.name}  →  ${pick.m.base} ${pick.m.name}`);
    } else {
      review.push({ name: p.name, base: pick.m.base, sdName: pick.m.name, conf: r.confidence || 0, note: "確信度が低い" });
    }
  }

  console.log(`\n判定 ${calls}件 / 自動採用 ${Object.keys(adopted).length}件 / 要確認 ${review.length}件`);
  console.log(`Jevトークン: 入力 ${inTok} / 出力 ${outTok}`);

  if (DRY) { console.log("--dry のためファイルは書きません。"); return; }

  // 対応表を書き出す（既存の手動対応表と同じ形式で query.js から読める）
  const js = `// Jevによる自動名寄せの結果（scripts/match_costs_jev.mjs が生成）
// キー: TikTokの商品名 / 値: SD仕入れマスタの品番
// 誤りを見つけたら直接ここを書き換えてください（再生成時は上書きされるので注意）
// 生成日時: ${new Date().toISOString()}
export const NAME_OVERRIDES = ${JSON.stringify(adopted, null, 2)};
`;
  fs.writeFileSync(path.join(ROOT, "lib", "name_overrides.js"), js);
  console.log("lib/name_overrides.js を書き出しました");

  const csv = ["商品名,提案された品番,提案されたSD商品名,確信度,メモ"]
    .concat(review.map((r) => [r.name, r.base, r.sdName, (r.conf || 0).toFixed(2), r.note].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")))
    .join("\n");
  fs.writeFileSync(path.join(__dirname, "match_review.csv"), csv);
  console.log("scripts/match_review.csv を書き出しました");
}

main().catch((e) => { console.error(e); process.exit(1); });
