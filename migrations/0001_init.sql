-- 回答の生ログ。重み付けや平滑化を変えたときに、ここから集計をやり直せるようにする
CREATE TABLE responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  config_version TEXT NOT NULL,
  answers TEXT NOT NULL,   -- JSON: [{ "q": 質問ID, "a": 段階(0〜) }]（出題順）
  labels TEXT NOT NULL,    -- JSON: よくやる順の道具ID、または自由記入 {"other": 道具名}（0〜3個。空はジャグリングをしていない人）
  ranking TEXT NOT NULL    -- JSON: 表示した結果の上位の道具ID
);

-- 学習用の集計：道具 × 質問 × 回答段階 の重み付きカウント
CREATE TABLE counts (
  question TEXT NOT NULL,
  tool TEXT NOT NULL,
  answer INTEGER NOT NULL,
  n REAL NOT NULL,
  PRIMARY KEY (question, tool, answer)
);
