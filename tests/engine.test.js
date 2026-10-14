import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyResponse,
  axisScores,
  buildModel,
  explorationRate,
  initialDistribution,
  posterior,
  rankTools,
  selectNextQuestion,
  sessionLength,
} from "../public/js/engine.js";

const load = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const data = {
  config: load("config"),
  axes: load("axes"),
  tools: load("tools"),
  questions: load("questions"),
};

// 再現できる乱数
function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}

function runSession(model, answerFor, explore, rng) {
  const answers = [];
  let q;
  while ((q = selectNextQuestion(model, answers, { explore, rng }))) answers.push({ q: q.id, a: answerFor(q) });
  return answers;
}

test("データの整合性：質問・道具が参照する軸がすべて定義されている", () => {
  const axisIds = new Set(data.axes.map((a) => a.id));
  for (const item of [...data.questions, ...data.tools]) {
    for (const axis of Object.keys(item.axes)) assert.ok(axisIds.has(axis), `${item.id}: ${axis}`);
  }
  for (const [cat, n] of Object.entries(data.config.session.quotas)) {
    const pool = data.questions.filter((q) => q.category === cat).length;
    assert.ok(pool >= n, `${cat} の質問が足りません（${pool} < ${n}）`);
  }
});

test("初期値：位置のない道具は均等、位置のある道具は向きに沿って傾く", () => {
  const q = { id: "x", axes: { compete: 1 } };
  const flat = initialDistribution({ axes: {} }, q, data.config);
  assert.ok(flat.every((p) => Math.abs(p - 0.2) < 1e-9));
  const up = initialDistribution({ axes: { compete: 1 } }, q, data.config);
  assert.ok(up[4] > up[0]);
  const down = initialDistribution({ axes: { compete: 1 } }, { id: "y", axes: { compete: -1 } }, data.config);
  assert.ok(down[0] > down[4]);
  assert.ok(Math.abs(up.reduce((s, p) => s + p, 0) - 1) < 1e-9);
});

test("事後確率：回答なしなら全道具均等", () => {
  const model = buildModel(data);
  const post = posterior(model, []);
  for (const p of post) assert.ok(Math.abs(p - 1 / data.tools.length) < 1e-9);
});

test("出題：設定した問数とカテゴリ比率を守り、重複しない", () => {
  const model = buildModel(data);
  for (const explore of [1, 0]) {
    const answers = runSession(model, () => 2, explore, seeded(1));
    assert.equal(answers.length, sessionLength(data.config));
    assert.equal(new Set(answers.map((x) => x.q)).size, answers.length);
    const byId = Object.fromEntries(data.questions.map((q) => [q.id, q]));
    for (const [cat, n] of Object.entries(data.config.session.quotas)) {
      assert.equal(answers.filter((x) => byId[x.q].category === cat).length, n);
    }
  }
});

test("学習：ある道具の人が同じ傾向で答え続けると、その傾向の回答でその道具が1位になる", () => {
  const counts = {};
  const pattern = (q) => (q.id.charCodeAt(2) % 5); // 道具「ball」の人の架空の回答傾向
  const rng = seeded(7);
  for (let i = 0; i < 200; i++) {
    const answers = runSession(buildModel(data), pattern, 1, rng);
    applyResponse(counts, answers, ["ball"], data.config);
  }
  const model = buildModel(data, counts);
  const answers = runSession(model, pattern, 0, seeded(99));
  assert.equal(rankTools(model, answers)[0].tool.id, "ball");
});

test("アンケートの重み：選んだ順に重くなる", () => {
  const counts = applyResponse({}, [{ q: "b01", a: 4 }], ["ring", "poi", "club"], data.config);
  const w = data.config.labelWeights;
  assert.equal(counts.b01.ring[4], w[0]);
  assert.equal(counts.b01.poi[4], w[1]);
  assert.equal(counts.b01.club[4], w[2]);
});

test("軸の位置：向きを反映して -1〜+1 に入る", () => {
  const model = buildModel(data);
  const scores = axisScores(model, [
    { q: "b01", a: 4 },
    { q: "b03", a: 0 },
  ]);
  const compete = scores.find((s) => s.axis.id === "compete");
  assert.equal(compete.score, 1);
});

test("探索率：回答が増えるほど下がり、下限で止まる", () => {
  const c = data.config;
  assert.equal(explorationRate(c, 0), 1);
  assert.ok(explorationRate(c, c.exploration.rampResponses / 2) < 1);
  assert.equal(explorationRate(c, c.exploration.rampResponses * 10), c.exploration.min);
});
