// GET /api/table：学習済みのカウントを配る。確率への変換はブラウザ側（engine.js）で行う
const CACHE_SECONDS = 300;

export async function onRequestGet({ request, env, waitUntil }) {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const [rows, total] = await Promise.all([
    env.DB.prepare("SELECT question, tool, answer, n FROM counts").all(),
    // 学習済み回答数：道具ID（文字列）を1つ以上含む回答だけを数える（自由記入のみ・ジャグリングをしていない人は除く）
    env.DB.prepare("SELECT COUNT(*) AS c FROM responses WHERE EXISTS (SELECT 1 FROM json_each(labels) WHERE type = 'text')").first(),
  ]);

  const counts = {};
  for (const { question, tool, answer, n } of rows.results) {
    counts[question] ??= {};
    counts[question][tool] ??= [];
    counts[question][tool][answer] = n;
  }

  const response = Response.json(
    {
      counts,
      labeledResponses: total?.c ?? 0,
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
    },
    { headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` } },
  );
  waitUntil(cache.put(request, response.clone()));
  return response;
}
