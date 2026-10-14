// 画面の進行。計算はすべて engine.js に任せる
import {
  axisScores,
  buildModel,
  explorationRate,
  rankTools,
  selectNextQuestion,
  sessionLength,
} from "./engine.js";

const $ = (id) => document.getElementById(id);

const state = {
  model: null,
  explore: 1,
  turnstileSiteKey: null,
  answers: [],
  current: null,
  selected: null,
  ranking: [],
  labels: [],
};

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function init() {
  const [config, axes, tools, questions] = await Promise.all(
    ["config", "axes", "tools", "questions"].map((name) => loadJson(`data/${name}.json`)),
  );
  // 学習データが取れないとき（ローカル表示など）は初期値だけで動かす
  let table = { counts: {}, labeledResponses: 0, turnstileSiteKey: null };
  try {
    table = await loadJson("api/table");
  } catch (e) {
    console.warn("学習データを読めませんでした。初期値で動かします", e);
  }
  state.model = buildModel({ config, axes, tools, questions }, table.counts);
  state.explore = explorationRate(config, table.labeledResponses);
  state.turnstileSiteKey = table.turnstileSiteKey;

  $("q-total").textContent = sessionLength(config);
  $("btn-start").disabled = false;
  $("btn-start").textContent = "始める";
}

function show(name) {
  for (const el of document.querySelectorAll(".screen")) el.hidden = el.id !== `screen-${name}`;
  window.scrollTo(0, 0);
}

function start() {
  state.answers = [];
  state.labels = [];
  nextQuestion();
  show("question");
}

function nextQuestion() {
  const { model } = state;
  state.current = selectNextQuestion(model, state.answers, { explore: state.explore });
  state.selected = null;
  const total = sessionLength(model.config);
  $("q-number").textContent = state.answers.length + 1;
  $("q-text").textContent = state.current.text;
  $("btn-next").disabled = true;
  $("btn-next").textContent = state.answers.length + 1 >= total ? "診断する" : "次へ";

  const scale = $("q-scale");
  scale.replaceChildren();
  const labels = model.config.scale.labels;
  // 「とてもそう思う」を上に並べる
  for (let a = labels.length - 1; a >= 0; a--) {
    const btn = document.createElement("button");
    btn.textContent = labels[a];
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.addEventListener("click", () => {
      state.selected = a;
      for (const b of scale.children) b.setAttribute("aria-checked", String(b === btn));
      $("btn-next").disabled = false;
    });
    scale.append(btn);
  }
}

function next() {
  if (state.selected === null) return;
  state.answers.push({ q: state.current.id, a: state.selected });
  if (state.answers.length >= sessionLength(state.model.config)) showResult();
  else nextQuestion();
}

function showResult() {
  const { model } = state;
  const ranked = rankTools(model, state.answers);
  const { axesShown, nearbyCount } = model.config.result;
  state.ranking = ranked.slice(0, 1 + nearbyCount).map((r) => r.tool.id);
  const top = ranked[0].tool;

  $("r-tool").textContent = top.name;
  $("r-illust").textContent = `${top.name}（絵は準備中）`;

  // 本人の位置がはっきりしている軸から順に、短く出す
  const scores = axisScores(model, state.answers)
    .filter((s) => s.axis.display)
    .sort((x, y) => Math.abs(y.score) - Math.abs(x.score))
    .slice(0, axesShown);
  const axesEl = $("r-axes");
  axesEl.replaceChildren();
  for (const { axis, score } of scores) {
    const lean = score >= 0 ? axis.high : axis.low;
    const row = document.createElement("div");
    row.className = "axis-row";
    row.innerHTML = `
      <div class="axis-bar">
        <span class="axis-end"></span>
        <span class="axis-track"><span class="axis-dot"></span></span>
        <span class="axis-end high"></span>
      </div>
      <div class="axis-text"></div>`;
    row.querySelector(".axis-end").textContent = axis.low;
    row.querySelector(".axis-end.high").textContent = axis.high;
    row.querySelector(".axis-dot").style.left = `${((score + 1) / 2) * 100}%`;
    row.querySelector(".axis-text").textContent = `あなたは「${lean}」寄りです。`;
    axesEl.append(row);
  }

  const nearby = ranked.slice(1, 1 + nearbyCount).map((r) => r.tool.name);
  $("r-nearby").textContent = nearby.length ? `ほかにも、${nearby.join("・")}がこちらを気にしています。` : "";

  renderSurvey();
  $("survey").hidden = false;
  $("after").hidden = true;
  show("result");
}

function renderSurvey() {
  const { model } = state;
  const max = model.config.labelWeights.length;
  const list = $("s-tools");
  list.replaceChildren();
  $("s-none").checked = false;
  $("s-error").hidden = true;

  const refresh = () => {
    for (const btn of list.children) {
      const rank = state.labels.indexOf(btn.dataset.tool);
      if (rank >= 0) btn.dataset.rank = rank + 1;
      else delete btn.dataset.rank;
      btn.disabled = $("s-none").checked;
    }
    $("btn-send").disabled = !$("s-none").checked && state.labels.length === 0;
  };

  for (const tool of model.tools) {
    const btn = document.createElement("button");
    btn.textContent = tool.name;
    btn.dataset.tool = tool.id;
    btn.addEventListener("click", () => {
      const i = state.labels.indexOf(tool.id);
      if (i >= 0) state.labels.splice(i, 1);
      else if (state.labels.length < max) state.labels.push(tool.id);
      refresh();
    });
    list.append(btn);
  }
  $("s-none").onchange = () => {
    if ($("s-none").checked) state.labels = [];
    refresh();
  };
  refresh();
  renderTurnstile();
}

function renderTurnstile() {
  const key = state.turnstileSiteKey;
  const box = $("turnstile");
  box.replaceChildren();
  if (!key) return;
  const render = () => window.turnstile.render(box, { sitekey: key });
  if (window.turnstile) return render();
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
  s.onload = render;
  document.head.append(s);
}

async function send() {
  $("btn-send").disabled = true;
  const token = state.turnstileSiteKey ? window.turnstile?.getResponse() : undefined;
  try {
    const res = await fetch("api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers: state.answers,
        labels: state.labels,
        ranking: state.ranking,
        turnstileToken: token,
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  } catch (e) {
    $("s-error").textContent = `送信できませんでした（${e.message}）。もう一度お試しください。`;
    $("s-error").hidden = false;
    $("btn-send").disabled = false;
    if (state.turnstileSiteKey) window.turnstile?.reset();
    return;
  }
  showAfter();
}

// 文言は仮。擬人化の文言は未決事項
function showAfter() {
  const top = state.model.tools.find((t) => t.id === state.ranking[0]);
  let message;
  if (state.labels.length === 0) {
    message = `${top.name}は、あなたと似た考えの人たちがやっている道具です。よかったら始めてみてください。`;
  } else if (state.labels.includes(top.id)) {
    message = `${top.name}とは両想いでした！ご協力ありがとうございました。`;
  } else {
    message = `${top.name}からの片思いでした。似た考えの人たちがやっている道具なので、よかったら手に取ってみてください。ご協力ありがとうございました。`;
  }
  $("a-message").textContent = message;
  $("survey").hidden = true;
  $("after").hidden = false;
}

$("btn-start").addEventListener("click", start);
$("btn-next").addEventListener("click", next);
$("btn-send").addEventListener("click", send);
$("btn-retry").addEventListener("click", () => show("start"));

init().catch((e) => {
  $("btn-start").textContent = "読み込みに失敗しました";
  console.error(e);
});
