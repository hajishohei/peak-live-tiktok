const fs=require('fs');
const dir='/sessions/sweet-elegant-cray/mnt/peak-live-tiktok';
const raw=fs.readFileSync(dir+'/data/原価マスタ.psv','utf8').trim().split('\n');
const header=raw.shift();
const rows=raw.map(l=>{const p=l.split('|');return {base:p[0],name:p[1],vendor:p[2],maker:p[3],cost:+p[4],minCost:+p[5],maxCost:+p[6],qty:+p[7],colors:+p[8]};});
// proper CSV
function csvCell(s){s=String(s==null?'':s);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
const csvHead=['SD品番(base)','SD商品名','仕入先','メーカー品番','原価(加重平均)','最小原価','最大原価','仕入数量累計','色数'];
const csv=[csvHead.join(',')].concat(rows.map(r=>[r.base,r.name,r.vendor,r.maker,r.cost,r.minCost,r.maxCost,r.qty,r.colors].map(csvCell).join(','))).join('\n');
fs.writeFileSync(dir+'/data/原価マスタ.csv','﻿'+csv);
// JS module
const js='// 自動生成: SD仕入れ実績から集計した原価マスタ（商品=base単位）。\n'+
'// 生成日: 2026-06-24 / 期間: 2025-11〜2026-06 / 元データ: data/原価マスタ.psv\n'+
'// 更新方法: data/原価マスタ.psv を更新→ node scripts/build_costs.js → 再デプロイ\n'+
'export const SD_MASTER = '+JSON.stringify(rows)+';\n'+
'export default SD_MASTER;\n';
fs.writeFileSync(dir+'/lib/sd_costs.js',js);
console.log('rows:',rows.length,'csvBytes:',Buffer.byteLength(csv),'jsBytes:',Buffer.byteLength(js));
console.log('totalQty:',rows.reduce((s,r)=>s+r.qty,0));
