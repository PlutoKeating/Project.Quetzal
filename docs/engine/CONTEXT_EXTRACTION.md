# 上下文与记忆纯策略提取切片

本切片从原 `runtime/src/memory/retrieval.ts` 提取实际算法，保留默认排序、字符预算和检索来源。它不是完整 ContextManager 或 MemoryBackend，也没有引入 token 预算、自动压缩、向量检索或 PRIME 默认策略。

| 文件 | 本切片职责 |
|---|---|
| [engine/src/retrieval.ts](../../engine/src/retrieval.ts) | 分词、逐篇评分、关键词摘录；评分时间由调用方传入 |
| [engine/src/context.ts](../../engine/src/context.ts) | 常驻条目预算选择、召回片段预算组装 |
| [engine/src/index.ts](../../engine/src/index.ts) | 公开策略及类型导出 |
| [runtime/src/memory/retrieval.ts](../../runtime/src/memory/retrieval.ts) | 旧导入路径兼容；读取文件、获取当前时间、选择 SQLite FTS5／降级及自动检索来源 |
| [engine/test/retrieval.test.ts](../../engine/test/retrieval.test.ts) | 独立分词、覆盖率、标题、新近评分和摘录检查 |
| [engine/test/context.test.ts](../../engine/test/context.test.ts) | 完整条目选择、顺序、UTF-16 成本与片段预算边界检查 |

## 接口与行为

`rank(query, docs, now)` 不读取文件、数据库或系统时钟。runtime 原 `rank(query, docs)` 签名保持兼容，传入 `Date.now()`。文档字段及分数公式没有变化。中文 ICU 分词继续根据当前 Node 环境的 `Intl.Segmenter` 可用性补充分词，跨 ICU 版本的分词结果不保证完全相同。

`selectCoreEntries(entries, context, budget)` 优先选相关条目，然后从列表末尾补足，最终按输入顺序输出。条目整条装入，过长跳过；每条成本仍为 `string.length + 3`，不是 token 数。常驻条目评分不使用实际时间戳，其位置回填规则不变。

`formatRecallBlock(hits, budget)` 按宿主给出的候选顺序装入来源标签与摘录，超预算候选跳过。保持原行为：连接候选的空行另加，因此最终字符串可能超过片段成本预算。runtime 仍只自动检索笔记／日记，最多 12 个候选，默认预算 3000；空查询不发起检索。

文件、日记日期转换、SQLite FTS5、索引更新、对话读取、灵魂写锁与 Git 同步均留在 runtime。`memory.ts` 与检索包装、索引的宿主循环依赖尚未全部消除。会话历史和宿主提示块仍由 `brain.ts`／`prompt.ts` 组装，本切片不修改这些入口。

## 验证边界

验证使用独立 engine 测试、现有 runtime 记忆／检索／上下文回归、两模块类型检查和构建。合成资料不含真实灵魂或用户记忆。具体命令与结果由对应交付记录报告；本文件本身不代表测试通过、实际模型验证或设备验证。
