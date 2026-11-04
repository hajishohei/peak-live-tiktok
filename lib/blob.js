// @vercel/blob の get/put と同じ形で Cloudflare Workers KV（バインディング名 DATA）を読み書きする薄いラッパー。
// 既存コードの `res.statusCode === 200 && res.stream` / `put(path, body, { contentType })` をそのまま使える。
// KV は1件25MBまで・書き込みは無料枠で1日1,000回まで（このアプリの保存は1日数十回）。
import { env } from "cloudflare:workers";

export function blobConfigured() {
  return !!(env && env.DATA);
}
export async function get(path) {
  const body = await env.DATA.get(path, { type: "stream" });
  return body ? { statusCode: 200, stream: body } : null;
}
export async function put(path, body) {
  await env.DATA.put(path, body);
  return { pathname: path };
}
