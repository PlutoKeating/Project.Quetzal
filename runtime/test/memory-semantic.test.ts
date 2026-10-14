import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest, ChatResult } from '../src/providers/types.ts';
import type { MemoryQuery, MemoryScope, MemoryConditions, MemoryStage } from '../../engine/src/memory.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-memory-semantic-'));
process.env.QUETZAL_HOME = home;
const { loadConfig, saveConfig } = await import('../src/config.ts'); loadConfig();
const { openStore } = await import('../src/store.ts'); openStore();
await (await import('../src/memory/soul-sync.ts')).ensureSoul();
const { identity } = await import('../src/memory/identity.ts');
const structured = await import('../src/memory/structured.ts');
const { selectContextMemory } = await import('../src/memory/semantic.ts');
const { emergencyStop, releaseStop } = await import('../src/guard/guard.ts');
const { memoryKey } = await import('../../engine/src/memory.ts');
const scope = { agentId: identity().id, userId: 'owner' };
after(() => fs.rmSync(home, { recursive: true, force: true }));
const reply = (keys: string[]): ChatResult => ({ text: JSON.stringify({ keys }), toolCalls: [], model: 'synthetic-semantic', usage: { input: 2, output: 3 } });
const query = (text: string): MemoryQuery => ({ scope, text, now: Date.now(), stage: 'exploration', tags: [], tools: [], limit: 6 });
const views = (request: ChatRequest): Array<{ key: string; text: string }> => JSON.parse(String(request.messages.at(-1)!.content)).candidates;
async function active(id: string, text: string, recordScope: MemoryScope = scope,
  conditions: MemoryConditions = { requiredTags: [], excludedTags: [], tools: [] }, stage: MemoryStage = 'any') {
  const now = Date.now();
  const evidence = { id: `source-${id}`, ref: `synthetic:user:${id}`, origin: 'user' as const, observedAt: now, summary: text, verified: true };
  const candidate = await structured.recordMemory({ id, kind: 'preference', preference: 'explicit', text, scope: recordScope,
    stage, zone: 'preference', conditions, evidenceIds: [evidence.id] }, [evidence], { now });
  return structured.reviewMemory(memoryKey(candidate), { accepted: true, independent: true, evaluator: 'synthetic-confirmation', score: 1, evidence: [evidence] }, { now });
}

test('生产语义选择召回无词面重合偏好，并缓存完整正文', async () => {
  saveConfig({ brain: { memorySemantic: true } });
  const record = await active('known_tea', '喜欢乌龙茶');
  const q = query('breakfast beverage'); let calls = 0;
  const model = async (request: ChatRequest) => { calls++; assert.ok(views(request).some((r) => r.key === memoryKey(record))); return reply([memoryKey(record)]); };
  assert.equal((await selectContextMemory(q, undefined, model))[0].text, record.text);
  assert.equal((await selectContextMemory({ ...q, now: Date.now() }, undefined, model))[0].text, record.text);
  assert.equal(calls, 1);
});

test('非法、跨scope、条件不符及未确认keys不能透传，语义选择允许零命中', async () => {
  const own = await active('own_choice', '喜欢咖啡');
  const foreign = await active('foreign_choice', '喜欢苏打水', { ...scope, userId: 'another' });
  const gated = await active('gated_choice', '喜欢温水', scope, { requiredTags: ['health'], excludedTags: [], tools: [] });
  const unverified = { id: 'source-unconfirmed', ref: 'synthetic:agent:unconfirmed', origin: 'agent' as const, observedAt: Date.now(), summary: '未经确认', verified: false };
  const candidate = await structured.recordMemory({ id: 'unconfirmed', kind: 'fact', text: '未经确认', scope, stage: 'any', zone: 'warning', conditions: { requiredTags: [], excludedTags: [], tools: [] }, evidenceIds: [unverified.id] }, [unverified]);
  const selected = await selectContextMemory(query('constrained retrieval'), undefined, async (request) => {
    const keys = views(request).map((r) => r.key);
    for (const r of [foreign, gated, candidate]) assert.ok(!keys.includes(memoryKey(r)));
    return reply([memoryKey(foreign), memoryKey(gated), memoryKey(candidate), 'invented@1', memoryKey(own)]);
  });
  assert.deepEqual(selected.map(memoryKey), [memoryKey(own)]);
  assert.deepEqual(await selectContextMemory(query('no appropriate knowledge'), undefined, async () => reply([])), []);
});

test('关闭语义选择只使用词面回退，不调用模型', async () => {
  saveConfig({ brain: { memorySemantic: false } });
  try {
    const forbidden = async (): Promise<ChatResult> => { throw new Error('不得调用模型'); };
    assert.ok((await selectContextMemory(query('乌龙茶'), undefined, forbidden)).some((r) => r.id === 'known_tea'));
    assert.deepEqual(await selectContextMemory(query('unmatched lexical request'), undefined, forbidden), []);
  } finally { saveConfig({ brain: { memorySemantic: true } }); }
});

test('同版本scope或正文更改使语义缓存失效，不召回旧范围或旧正文', async () => {
  const scoped = await active('cache_scope', '缓存私有资料');
  const q = query('scope mutation alias');
  await selectContextMemory(q, undefined, async () => reply([memoryKey(scoped)]));
  await structured.updateStructuredRecords((records) => records.map((r) => r.id === scoped.id ? { ...r, scope: { ...r.scope, userId: 'another' } } : r));
  assert.deepEqual(await selectContextMemory(q, undefined, async (request) => {
    assert.ok(!views(request).some((r) => r.key === memoryKey(scoped))); return reply([memoryKey(scoped)]);
  }), []);
  const text = await active('cache_text', '初始正文'); const tq = query('text mutation alias');
  await selectContextMemory(tq, undefined, async () => reply([memoryKey(text)]));
  await structured.updateStructuredRecords((records) => records.map((r) => r.id === text.id ? { ...r, text: '更新正文' } : r));
  assert.equal((await selectContextMemory(tq, undefined, async () => reply([memoryKey(text)])))[0].text, '更新正文');
});

test('外部取消终止等待不配合signal的选择模型', { timeout: 1500 }, async () => {
  const controller = new AbortController();
  await assert.rejects(selectContextMemory(query('noncooperative cancellation'), controller.signal, async () => {
    queueMicrotask(() => controller.abort(new Error('synthetic selection cancelled')));
    return new Promise<ChatResult>(() => {});
  }), /synthetic selection cancelled/);
});

test('STOP终止不配合signal的选择模型，急停时不调用模型', { timeout: 1500 }, async () => {
  let calls = 0;
  try {
    const model = async () => { calls++; queueMicrotask(() => emergencyStop('synthetic')); return new Promise<ChatResult>(() => {}); };
    await assert.rejects(selectContextMemory(query('noncooperative STOP'), undefined, model), /急停|停止|STOP/);
    await assert.rejects(selectContextMemory(query('already STOP'), undefined, model), /急停|停止|STOP/);
    assert.equal(calls, 1);
  } finally { releaseStop('synthetic'); }
});

test('缓存不能跨越validFrom生效边界保留之前的空结果', async () => {
  const record = await active('future_boundary', '按生效时间召回的偏好');
  const q = query('scheduled validity boundary');
  const model = async () => reply([memoryKey(record)]);
  assert.deepEqual(await selectContextMemory({ ...q, now: record.validFrom - 1 }, undefined, model), []);
  assert.deepEqual((await selectContextMemory({ ...q, now: record.validFrom }, undefined, model)).map(memoryKey), [memoryKey(record)]);
});


test('缓存跨validUntil边界后重新门禁，过期偏好不能返回', async () => {
  const record = await active('expiry_boundary', '按失效时间停止召回的偏好');
  const until = record.validFrom + 1000;
  await structured.updateStructuredRecords((records) => records.map((r) => r.id === record.id ? { ...r, validUntil: until } : r));
  const q = query('expiry validity boundary'); let calls = 0;
  const model = async () => { calls++; return reply([memoryKey(record)]); };
  assert.deepEqual((await selectContextMemory({ ...q, now: until - 1 }, undefined, model)).map(memoryKey), [memoryKey(record)]);
  assert.deepEqual(await selectContextMemory({ ...q, now: until }, undefined, model), []);
  assert.equal(calls, 2);
});

test('配置100ms超时终止不合作模型等待，并回退到已过scope门禁的词面候选', { timeout: 2000 }, async () => {
  saveConfig({ brain: { memorySemantic: true, memorySelectionTimeoutMs: 100 } });
  let requestSignal: AbortSignal | undefined;
  // AbortSignal.timeout的计时器不保活；保留显式测试句柄以验证真正超时，而非进程退出取消测试。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const selected = await selectContextMemory(query('乌龙茶 timeout fallback'), undefined, async (request) => {
      requestSignal = request.signal;
      return new Promise<ChatResult>(() => {});
    });
    assert.equal(requestSignal?.aborted, true);
    assert.equal(requestSignal?.reason?.name, 'TimeoutError');
    assert.ok(selected.some((r) => r.id === 'known_tea'));
    assert.ok(selected.every((r) => r.state === 'active' && r.scope.agentId === scope.agentId && (!r.scope.userId || r.scope.userId === scope.userId)));
  } finally {
    clearInterval(keepAlive);
    saveConfig({ brain: { memorySelectionTimeoutMs: 5000 } });
  }
});
