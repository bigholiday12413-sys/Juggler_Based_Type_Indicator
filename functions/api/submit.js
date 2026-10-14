// POST /api/submit：回答とアンケート（正解ラベル）を受け取り、生ログ保存とカウント加算を行う
import config from "../../public/data/config.json";
import questions from "../../public/data/questions.json";
import tools from "../../public/data/tools.json";
import { labelWeights, sessionLength } from "../../public/js/engine.js";

const questionIds = new Set(questions.map((q) => q.id));
const toolIds = new Set(tools.map((t) => t.id));
const levels = config.scale.labels.length;

function bad(message) {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // 未設定（ローカル開発など）のときは確認しない
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const data = await res.json();
  return data.success === true;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("JSONを読めません");
  }
  const { answers, labels, ranking, turnstileToken } = body ?? {};

  if (!Array.isArray(answers) || answers.length !== sessionLength(config)) return bad("回答数が違います");
  const seen = new Set();
  for (const x of answers) {
    if (!questionIds.has(x?.q) || seen.has(x.q)) return bad("質問IDが不正です");
    if (!Number.isInteger(x.a) || x.a < 0 || x.a >= levels) return bad("回答の値が不正です");
    seen.add(x.q);
  }
  if (!Array.isArray(labels) || labels.length > config.labelWeights.length) return bad("アンケートの選択数が違います");
  if (new Set(labels).size !== labels.length || !labels.every((t) => toolIds.has(t))) return bad("道具IDが不正です");
  if (!Array.isArray(ranking) || !ranking.every((t) => toolIds.has(t))) return bad("結果の道具IDが不正です");

  const ok = await verifyTurnstile(env, turnstileToken, request.headers.get("CF-Connecting-IP"));
  if (!ok) return Response.json({ ok: false, error: "ボット判定に失敗しました" }, { status: 403 });

  const cleanAnswers = answers.map(({ q, a }) => ({ q, a }));
  const statements = [
    env.DB.prepare(
      "INSERT INTO responses (config_version, answers, labels, ranking) VALUES (?, ?, ?, ?)",
    ).bind(config.version, JSON.stringify(cleanAnswers), JSON.stringify(labels), JSON.stringify(ranking)),
  ];
  const upsert = env.DB.prepare(
    "INSERT INTO counts (question, tool, answer, n) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (question, tool, answer) DO UPDATE SET n = n + excluded.n",
  );
  for (const { toolId, weight } of labelWeights(labels, config)) {
    for (const { q, a } of cleanAnswers) statements.push(upsert.bind(q, toolId, a, weight));
  }
  await env.DB.batch(statements);

  return Response.json({ ok: true });
}
