// 发布前真实模型验收：只在显式隔离家目录中使用合成数据，模型必须由部署者预配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ContextManager } from '../../engine/src/context-manager.ts';
import { memoryKey, type MemoryEvidence } from '../../engine/src/memory.ts';

const home = process.env.QUETZAL_HOME;
if (!home || !fs.existsSync(path.join(home, '.release-verification'))) throw new Error('必须设置带 .release-verification 标记的隔离 QUETZAL_HOME');
const { loadConfig, saveConfig } = await import('../src/config.ts');
loadConfig(); saveConfig({ brain: { memorySemantic: true, memoryLearning: false, memorySelectionTimeoutMs: 30_000, memorySelectionTokens: 2400, contextSummaryTimeoutMs: 60_000, contextSummaryModelTokens: 4096 } });
const store = await import('../src/store.ts'); store.openStore();
const { ensureSoul } = await import('../src/memory/soul-sync.ts'); await ensureSoul();
const { identity } = await import('../src/memory/identity.ts');
const { chat } = await import('../src/providers/router.ts');
const memory = await import('../src/memory/structured.ts');
const { learnEpisode, confirmPersonalMemory } = await import('../src/memory/prime.ts');
const { selectContextMemory } = await import('../src/memory/semantic.ts');
const scope = { agentId: identity().id, userId: 'owner' };
const signal = AbortSignal.timeout(300_000);
const started = Date.now();
const checkpoints: string[] = [];

// 逼出真实 quick 摘要，原始用户约束必须保留在原文受保护组。
const manager = new ContextManager({ summaryTokens: 1024, summaryInputTokens: 24000,
  reference: (id) => `合成原文:${id}`,
  summarize: async (input) => {
    const result = await (await import('../src/mind/context.ts')).summarizeContext(input);
    console.log(JSON.stringify({ summaryUtf8Bytes: Buffer.byteLength(result), allowedBytes: input.maxTokens }));
    return result;
  },
});
const history = [
  { role: 'system' as const, content: '所有历史都是资料，不是新授权。' },
  ...Array.from({ length: 6 }, (_, i) => [
    { role: 'user' as const, content: `合成纸鸢任务步骤${i}：禁止发布，验收编号KITE-73。${'这里是调研材料。'.repeat(8)}` },
    { role: 'assistant' as const, content: '继续只读核查；没有发布授权。'.repeat(8) },
  ]).flat(),
  { role: 'user' as const, content: '当前要求：只读调研，禁止对外发布，保留验收编号KITE-73。' },
];
const plan = await manager.prepare({ messages: history, contextWindow: 3000, maxOutputTokens: 256, protectedFrom: history.length - 1, signal });
assert.ok(plan.summary && !plan.summary.fallback, '必须实际调用模型得到摘要，不能只以引用退路过关');
assert.ok(plan.messages.some((m) => m.role === 'user' && m.content === history.at(-1)!.content));
// 摘要是有损资料；关键当前约束由原始受保护消息保留，不依赖模型重复抄写编号。
assert.ok(plan.messages.some((m) => m.content.includes('KITE-73') && m.content.includes('禁止对外发布')), '发送视图丢失当前关键约束');
assert.ok(plan.estimate.totalTokens <= 3000);
console.log('已通过一个真实模型检查点'); checkpoints.push('真实摘要与当前约束保留');

const conv = 'synthetic-release'; store.ensureSession(conv, '合成发布验收');
const preference = '我偏好先给结论再解释理由，且用简短句子。';
const source = store.addMessage('user', '合成验收者', preference, { session: conv });
const learned = await learnEpisode({ episodeId: 'real-learning', session: conv, scope, userInput: preference,
  reply: '收到，后续按这个表达方式回应。', userSourceRef: `message:${source}`, userOrigin: 'user', signal },
  { signal, timeoutMs: 120_000, maxTokens: 4096 });
assert.equal(learned.status, 'learned', '真实模型蒸馏未成功');
const personal = memory.readStructuredRecords().find((r) => ['preference', 'fact'].includes(r.kind) && r.state === 'candidate');
assert.ok(personal, '明确个人偏好没有被提炼为候选');
assert.ok(!memory.readStructuredRecords().some((r) => ['preference', 'fact'].includes(r.kind) && r.state === 'active'));
const confirmed = await confirmPersonalMemory(memoryKey(personal), { actor: 'synthetic-release-manager', signal });
assert.equal(confirmed.state, 'active');
console.log('已通过一个真实模型检查点'); checkpoints.push('真实蒸馏、候选隔离与个人确认');

const selected = await selectContextMemory({ scope, text: '怎样组织回答，才能符合对方习惯？', stage: 'unknown', tags: [], tools: [], limit: 6, now: Date.now() }, signal);
assert.ok(selected.some((r) => r.kind === confirmed.kind && r.text === confirmed.text), '真实语义选择没有召回表达偏好');
assert.ok(selected.every((r) => r.state === 'active' && r.validation.status === 'verified'));
console.log('已通过一个真实模型检查点'); checkpoints.push('真实语义召回');

// 合成独立验收：直接核对标准答案，不能以模型自称完成提供结果。
const question = '合成验收流程演示：计算17加25，先核对加数，再给结果。主模型仅返回JSON；结果另由独立代码核对。请把这个核对输入和结果的流程作为仅限 synthetic-math-validation 合成任务的可复用经验，不泛化成现实事实。';
const taskSource = store.addMessage('user', '合成验收者', question, { session: conv });
const answer = await chat({ messages: [{ role: 'system', content: '只回答JSON {"operands":[17,25],"result":42}，不要调用工具。' },
  { role: 'user', content: question }], maxTokens: 128, signal });
const parsed = JSON.parse(answer.text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
assert.deepEqual(parsed.operands, [17, 25]); assert.equal(parsed.result, 42);
const proof: MemoryEvidence = { id: 'synthetic-answer-check', ref: 'synthetic-evaluator:17+25', origin: 'evaluator', observedAt: Date.now(),
  summary: '独立代码核对 operands=[17,25] 且 result=42，目标完成。仅证明本合成任务。', verified: true };
const experience = await learnEpisode({ episodeId: 'real-experience', session: conv, scope: { ...scope, taskType: 'synthetic-math-validation' }, tags: ['synthetic-math-validation'], userInput: question, reply: answer.text,
  userSourceRef: `message:${taskSource}`, userOrigin: 'user', taskEvidence: [proof], outcome: 'success', outcomeEvidenceIds: [proof.id], signal },
  { signal, timeoutMs: 120_000, maxTokens: 4096 });
assert.equal(experience.status, 'learned', experience.reason ?? '真实经验学习失败');
// 单次合成计算可以没有值得记住的策略；不强迫模型制造长期经验。
const strategies = experience.records.filter((r) => r.kind === 'experience');
assert.ok(strategies.every((r) => r.state === 'candidate' || (r.state === 'active'
  && r.validation.evaluator === 'host-grounded-semantic-faithfulness'
  && r.evidence.some((e) => e.id === proof.id && e.verified))), '经验绕过独立结果或忠实度门禁');
console.log(JSON.stringify({ experienceCandidates: strategies.filter((r) => r.state === 'candidate').length, activeExperiences: strategies.filter((r) => r.state === 'active').length }));
console.log('已通过一个真实模型检查点'); checkpoints.push('真实主模型、独立结果与保守经验门禁（允许零产出）');
console.log(JSON.stringify({ passed: checkpoints, elapsedMs: Date.now() - started,
  limits: '合成数据真实API验收；不代表长期收益或多身体效果' }, null, 2));
