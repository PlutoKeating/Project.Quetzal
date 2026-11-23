-- Quetzal V1 合成 SQLite 历史样本转储（用于 qz import-v1 幂等双库迁移测试，100% 合成数据）
-- 严格对齐 V1 runtime/src/store.ts、mind/goals.ts、mind/projects.ts、mind/canvas.ts、mind/workspace.ts 表结构。
-- 身体编号段（ID_RANGE = 4294967296）：
--   laptop:  idPrefixOf("laptop")  = 791475 -> base = 3399359240601600
--   handset: idPrefixOf("handset") = 346685 -> base = 1489000737013760

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS timeline(
  id INTEGER PRIMARY KEY,
  ts INTEGER,
  kind TEXT,
  title TEXT,
  detail TEXT,
  body TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  ts INTEGER,
  role TEXT,
  channel TEXT,
  text TEXT,
  session TEXT,
  process TEXT,
  attachments TEXT,
  mode TEXT,
  body TEXT,
  via TEXT
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY,
  ts INTEGER,
  actor TEXT,
  action TEXT,
  reason TEXT,
  args TEXT,
  result TEXT
);
CREATE TABLE IF NOT EXISTS usage(
  day TEXT,
  model TEXT,
  body TEXT,
  input INTEGER,
  output INTEGER,
  cost REAL,
  PRIMARY KEY(day, model, body)
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  title TEXT,
  channel TEXT,
  created INTEGER,
  updated INTEGER,
  archived INTEGER DEFAULT 0,
  changed INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  pin_changed INTEGER DEFAULT 0,
  project TEXT,
  project_changed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tool_calls(
  call TEXT,
  session TEXT,
  ts INTEGER,
  tool TEXT,
  args TEXT,
  result TEXT,
  status TEXT,
  ms INTEGER,
  PRIMARY KEY(call, session)
);
CREATE TABLE IF NOT EXISTS context_sources(
  ref TEXT PRIMARY KEY,
  conv TEXT,
  ts INTEGER,
  content TEXT
);
CREATE TABLE IF NOT EXISTS workspaces(
  key TEXT PRIMARY KEY,
  body TEXT,
  uuid TEXT,
  dir TEXT,
  changed INTEGER,
  source TEXT,
  author TEXT
);
CREATE TABLE IF NOT EXISTS canvas_docs(
  id TEXT PRIMARY KEY,
  conv TEXT,
  title TEXT,
  kind TEXT,
  lang TEXT,
  created INTEGER,
  changed INTEGER,
  deleted INTEGER DEFAULT 0,
  body TEXT
);
CREATE TABLE IF NOT EXISTS canvas_versions(
  id TEXT PRIMARY KEY,
  doc TEXT,
  ts INTEGER,
  author TEXT,
  body TEXT,
  content TEXT,
  note TEXT,
  parent TEXT
);
CREATE TABLE IF NOT EXISTS canvas_comments(
  id TEXT PRIMARY KEY,
  doc TEXT,
  thread TEXT,
  ts INTEGER,
  author TEXT,
  body TEXT,
  text TEXT,
  quote TEXT,
  start INTEGER,
  end INTEGER,
  version TEXT,
  prefix TEXT,
  suffix TEXT,
  resolved INTEGER DEFAULT 0,
  changed INTEGER,
  suggestion TEXT
);
CREATE TABLE IF NOT EXISTS canvas_runs(
  id TEXT PRIMARY KEY,
  doc TEXT,
  version TEXT,
  ts INTEGER,
  by TEXT,
  body TEXT,
  lang TEXT,
  code INTEGER,
  out TEXT,
  err TEXT,
  images TEXT,
  ms INTEGER,
  dir TEXT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS messages_session ON messages(session, id);
CREATE INDEX IF NOT EXISTS messages_session_ts ON messages(session, ts, id);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts, id);
CREATE INDEX IF NOT EXISTS timeline_ts ON timeline(ts, id);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS tool_calls_ts ON tool_calls(ts);
CREATE INDEX IF NOT EXISTS context_sources_ts ON context_sources(ts);

INSERT INTO kv(k, v) VALUES
  ('store.ids', '{"prefix":791475,"at":1790841600000}'),
  ('goals.migrated', 'true'),
  ('thought', '{"text":"把多写者冲突消解在单写者哈希链里。","ts":1790928000000}'),
  ('projects', '[{"id":"a1b2c3d4e5f60718","name":"脊柱迁移演练","description":"合成测试项目","instructions":"所有回答保持可验证与幂等。","color":"#2e8b57","icon":"folder","created":1790841600000,"updated":1790928000000}]'),
  ('goals', '[{"id":"g001a2b3","title":"完成历史库单向幂等导入校验","detail":"确保多次导入同一灵魂目录与多身体 SQLite 库不产生重复事件","steps":[{"id":"1","text":"读取 v14 灵魂目录文件","status":"done","updated":1790845200000},{"id":"2","text":"按编号段合并多身体会话消息","status":"doing","updated":1790931600000}],"status":"open","note":"","created":1790841600000,"updated":1790931600000,"progressed":1790931600000,"convs":["conv-arch-01"],"body":"laptop"}]');

INSERT INTO sessions(id, title, channel, created, updated, archived, changed, pinned, pin_changed, project, project_changed) VALUES
  ('conv-arch-01', '状态脊柱迁移讨论', '控制台', 1790841600000, 1790931600000, 0, 1790841600000, 1790842000000, 1790842000000, 'a1b2c3d4e5f60718', 1790842000000),
  ('conv-daily-02', '晚间阅读随记', '控制台', 1790928000000, 1790928300000, 0, 1790928000000, 0, 0, NULL, 0);

-- laptop 身体产生的消息（段号 791475，base = 3399359240601600）
INSERT INTO messages(id, ts, role, channel, text, session, process, attachments, mode, body, via) VALUES
  (3399359240601601, 1790841610000, 'user', '控制台', '请帮我核对一下多身体消息编号段在迁移时的去重规则。', 'conv-arch-01', NULL, NULL, NULL, 'laptop', 'laptop'),
  (3399359240601602, 1790841625000, 'agent', '控制台', '每具身体的消息编号位于 `prefix * 2^32 + seq` 区间内，导入时可按确定性内容与原主键计算幂等摘要。', 'conv-arch-01', '[{"type":"tool","call":"call-001","name":"hello_tool","status":"ok"}]', NULL, NULL, 'laptop', NULL);

-- handset 身体复制而来的消息（段号 346685，base = 1489000737013760）
INSERT INTO messages(id, ts, role, channel, text, session, process, attachments, mode, body, via) VALUES
  (1489000737013761, 1790928100000, 'user', '控制台', '在手机上补充一条测试记录，稍后在电脑端一起合并导入。', 'conv-daily-02', NULL, NULL, NULL, 'handset', 'handset'),
  (1489000737013762, 1790928120000, 'agent', '控制台', '已记录在手持端会话中，编号段与桌面端天然正交无冲突。', 'conv-daily-02', NULL, NULL, NULL, 'handset', NULL);

INSERT INTO timeline(id, ts, kind, title, detail, body) VALUES
  (3399359240601601, 1790841626000, 'chat', '回复：状态脊柱迁移讨论', '{"conv":"conv-arch-01","steps":1,"tokens":512,"model":"synthetic-test-model"}', 'laptop'),
  (1489000737013761, 1790928121000, 'chat', '回复：晚间阅读随记', '{"conv":"conv-daily-02","steps":1,"tokens":256,"model":"synthetic-test-model"}', 'handset');

INSERT INTO audit(id, ts, actor, action, reason, args, result) VALUES
  (1, 1790841620000, 'sentinel', 'sentinel.review', '合成冒烟工具只读校验通过', '{"tool":"hello_tool","decision":"allow","risk":"low"}', 'allow: 合成测试放行');

INSERT INTO usage(day, model, body, input, output, cost) VALUES
  ('2026-10-01', 'synthetic-test-model', 'laptop', 400, 112, 0.0015),
  ('2026-10-02', 'synthetic-test-model', 'handset', 180, 76, 0.0008);

INSERT INTO tool_calls(call, session, ts, tool, args, result, status, ms) VALUES
  ('call-001', 'conv-arch-01', 1790841622000, 'hello_tool', '{"tag":"spine-v2"}', 'hello: spine-v2', 'ok', 12);

INSERT INTO canvas_docs(id, conv, title, kind, lang, created, changed, deleted, body) VALUES
  ('doc-001', 'conv-arch-01', '迁移核对清单', 'markdown', 'markdown', 1790841700000, 1790841700000, 0, 'laptop');

INSERT INTO canvas_versions(id, doc, ts, author, body, content, note, parent) VALUES
  ('ver-001', 'doc-001', 1790841700000, 'agent', 'laptop', '# 迁移核对清单\n\n- [x] 验证 v14 灵魂目录\n- [x] 验证双身体编号段幂等导入\n', '初版清单', NULL);

COMMIT;
