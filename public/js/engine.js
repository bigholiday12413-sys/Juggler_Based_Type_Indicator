// 診断エンジン
// 道具・軸・質問・設定はすべてデータ（public/data/*.json）から受け取り、ここには固有の値を持たない。
// 質問や軸を差し替えても、このファイルは変更せずに動く。

// 回答の段階数 L に対し、各段階を -1（まったくそう思わない）〜 +1（とてもそう思う）に並べる
export function levelPositions(levels) {
  if (levels < 2) return [0];
  return Array.from({ length: levels }, (_, k) => -1 + (2 * k) / (levels - 1));
}

function normalize(arr) {
  const sum = arr.reduce((s, v) => s + v, 0);
  return sum > 0 ? arr.map((v) => v / sum) : arr.map(() => 1 / arr.length);
}

// 初期値：道具の軸上の位置と、質問がどの軸をどの向きで聞いているかから、回答の傾きを弱く作る。
// 道具に位置が設定されていない軸しか関係しない質問は、均等分布のままにする。
export function initialDistribution(tool, question, config) {
  const levels = config.scale.labels.length;
  const xs = levelPositions(levels);
  const uniform = xs.map(() => 1 / levels);
  const qAxes = question.axes || {};
  const tAxes = tool.axes || {};

  let mean = 0;
  let known = 0;
  for (const [axis, weight] of Object.entries(qAxes)) {
    if (tAxes[axis] === undefined) continue;
    mean += weight * tAxes[axis];
    known += Math.abs(weight);
  }
  if (known === 0) return uniform;

  mean = Math.max(-1, Math.min(1, mean));
  const { strength, sigma } = config.prior;
  const lambda = strength * Math.min(1, known);
  const bump = normalize(xs.map((x) => Math.exp(-((x - mean) ** 2) / (2 * sigma ** 2))));
  return xs.map((_, k) => (1 - lambda) * uniform[k] + lambda * bump[k]);
}

// 確率表：P(回答 | 道具, 質問) = (実データのカウント + 疑似カウント × 初期値) / (合計 + 疑似カウント)
// counts の形：{ [questionId]: { [toolId]: number[levels] } }（無い所は 0 扱い）
export function buildModel(data, counts = {}) {
  const { tools, questions, config } = data;
  const alpha = config.prior.pseudoCount;
  const prob = {};
  for (const q of questions) {
    prob[q.id] = {};
    for (const t of tools) {
      const init = initialDistribution(t, q, config);
      const c = counts[q.id]?.[t.id] || [];
      const total = init.reduce((s, _, k) => s + (c[k] || 0), 0);
      prob[q.id][t.id] = init.map((p, k) => ((c[k] || 0) + alpha * p) / (total + alpha));
    }
  }
  return { ...data, prob };
}

// 事後確率：事前は全道具で均等（人口比は使わない）。回答ごとにベイズ更新する
export function posterior(model, answers) {
  const { tools, prob } = model;
  const logp = tools.map(() => 0);
  for (const { q, a } of answers) {
    if (!prob[q]) continue;
    tools.forEach((t, i) => {
      logp[i] += Math.log(prob[q][t.id][a]);
    });
  }
  const max = Math.max(...logp);
  return normalize(logp.map((l) => Math.exp(l - max)));
}

export function rankTools(model, answers) {
  const post = posterior(model, answers);
  return model.tools
    .map((tool, i) => ({ tool, p: post[i] }))
    .sort((x, y) => y.p - x.p);
}

function entropy(dist) {
  return -dist.reduce((s, p) => (p > 0 ? s + p * Math.log(p) : s), 0);
}

// 質問を出したときに、回答後の候補の散らばり（エントロピー）がどれだけ残るかの期待値
export function expectedEntropy(model, post, questionId) {
  const { tools, prob } = model;
  const levels = model.config.scale.labels.length;
  let result = 0;
  for (let a = 0; a < levels; a++) {
    const joint = tools.map((t, i) => post[i] * prob[questionId][t.id][a]);
    const pa = joint.reduce((s, v) => s + v, 0);
    if (pa > 0) result += pa * entropy(joint.map((v) => v / pa));
  }
  return result;
}

// 探索率：学習済みの回答が少ないうちはランダム寄り、増えるほど情報量による選択へ移す
export function explorationRate(config, labeledResponses) {
  const { min, rampResponses } = config.exploration;
  if (rampResponses <= 0) return min;
  return Math.max(min, 1 - labeledResponses / rampResponses);
}

export function sessionLength(config) {
  return Object.values(config.session.quotas).reduce((s, n) => s + n, 0);
}

// 次の質問を選ぶ。カテゴリごとの出題数（quotas）を守りつつ、
// 探索率の確率でランダム、それ以外は回答後の散らばりが最も小さくなる質問を選ぶ
export function selectNextQuestion(model, answers, { explore = 1, rng = Math.random } = {}) {
  const { questions, config } = model;
  if (answers.length >= sessionLength(config)) return null;

  const asked = new Set(answers.map((x) => x.q));
  const unasked = questions.filter((q) => !asked.has(q.id));
  if (unasked.length === 0) return null;

  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const remaining = { ...config.session.quotas };
  for (const { q } of answers) {
    const cat = byId[q]?.category;
    if (cat in remaining) remaining[cat] -= 1;
  }
  const cats = Object.keys(remaining).filter(
    (c) => remaining[c] > 0 && unasked.some((q) => q.category === c),
  );

  let pool = unasked;
  if (cats.length > 0) {
    // 残り枠に比例してカテゴリを選ぶ（特定のカテゴリが最後に固まらないように）
    const total = cats.reduce((s, c) => s + remaining[c], 0);
    let r = rng() * total;
    let cat = cats[cats.length - 1];
    for (const c of cats) {
      r -= remaining[c];
      if (r < 0) {
        cat = c;
        break;
      }
    }
    pool = unasked.filter((q) => q.category === cat);
  }

  if (rng() < explore) return pool[Math.floor(rng() * pool.length)];

  const post = posterior(model, answers);
  let best = pool[0];
  let bestH = Infinity;
  for (const q of pool) {
    const h = expectedEntropy(model, post, q.id);
    if (h < bestH) {
      bestH = h;
      best = q;
    }
  }
  return best;
}

// 本人の軸上の位置：その軸に関わる質問への回答を、向き付きで平均する（-1〜+1）
export function axisScores(model, answers) {
  const { axes, questions, config } = model;
  const xs = levelPositions(config.scale.labels.length);
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const sum = {};
  const weight = {};
  for (const { q, a } of answers) {
    for (const [axis, w] of Object.entries(byId[q]?.axes || {})) {
      sum[axis] = (sum[axis] || 0) + w * xs[a];
      weight[axis] = (weight[axis] || 0) + Math.abs(w);
    }
  }
  return axes
    .filter((ax) => weight[ax.id] > 0)
    .map((ax) => ({ axis: ax, score: sum[ax.id] / weight[ax.id], answered: weight[ax.id] }));
}

// アンケートで選ばれた道具（よくやる順）に、学習用の重みを付ける
export function labelWeights(labels, config) {
  const ws = config.labelWeights;
  return labels.slice(0, ws.length).map((toolId, i) => ({ toolId, weight: ws[i] }));
}

// 1件の回答をカウントに足す（サーバーのSQLと同じ処理。生ログからの再集計や検証に使う）
export function applyResponse(counts, answers, labels, config) {
  const levels = config.scale.labels.length;
  for (const { toolId, weight } of labelWeights(labels, config)) {
    for (const { q, a } of answers) {
      counts[q] ??= {};
      counts[q][toolId] ??= Array(levels).fill(0);
      counts[q][toolId][a] += weight;
    }
  }
  return counts;
}
