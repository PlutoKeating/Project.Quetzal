import test from "node:test";
import assert from "node:assert/strict";
import { runResearchGroup, type ResearchEnvironment, type ResearchLimits } from "../src/index.ts";

const limits: ResearchLimits = { maxSteps: 4, maxModelCalls: 4, maxToolCalls: 2, maxReportedTokens: 100, maxOutputTokens: 20, timeoutMs: 100 };
const response = (text = "完成", tools = false) => ({ text, toolCalls: tools ? [{ id: "a", name: "tool", args: {} }] : [], model: "fake", usage: { input: 2, output: 3 } });
function environment(): ResearchEnvironment {
  return { messages: [{ role: "user", content: "任务" }], tools: [{ name: "tool", description: "合成工具", parameters: {} }], async chat() { return response(); },
    async evaluate() { return { status: "unknown", score: null, evidence: ["缺少可验证结果"] }; }, cleanup() {} };
}

test("每样本重新创建环境，独立评分与组用量汇总，清理恰好一次", async () => {
  const counts: number[] = [], cleaned: number[] = [];
  const group = await runResearchGroup({ task: "test", samples: 3, limits, factory: ({ sample }) => {
    const env = environment(); let count = 0;
    env.chat = async () => { counts.push(++count); return response(sample === 2 ? "错" : "对"); };
    env.evaluate = async (record) => ({ status: record.result?.text === "对" ? "success" : "failure", score: record.result?.text === "对" ? 1 : 0, evidence: ["独立答案比对"] });
    env.cleanup = () => { cleaned.push(sample); };
    return env;
  } });
  assert.deepEqual(counts, [1, 1, 1]); assert.deepEqual(cleaned, [0, 1, 2]);
  assert.deepEqual(group.totals, { steps: 3, modelCalls: 3, toolCalls: 0, reportedTokens: 15, incompleteUsage: 0, success: 2, failure: 1, unknown: 0 });
  assert.ok(group.samples.every((s) => s.trace.models.length === 1));
});

test("循环任务按模型调用或步骤上限结束，工具有单独上限", async () => {
  for (const [changed, expected] of [ [{ maxModelCalls: 1 }, "model_call_limit"], [{ maxSteps: 1 }, "step_limit"], [{ maxToolCalls: 0 }, "tool_call_limit"] ] as const) {
    let cleanup = 0;
    const group = await runResearchGroup({ task: "loop", samples: 1, limits: { ...limits, ...changed }, factory: () => {
      const env = environment(); env.chat = async () => response("", true); env.execute = async () => ({ text: "继续", status: "ok" }); env.cleanup = () => { cleanup++; }; return env;
    } });
    assert.equal(group.samples[0].termination, expected); assert.equal(cleanup, 1);
    assert.equal(group.samples[0].assessment.status, "unknown");
  }
});

test("用量报告事后超限，不再执行模型返回的工具，准确保留已报告成本", async () => {
  let executed = 0;
  const group = await runResearchGroup({ task: "tokens", samples: 1, limits: { ...limits, maxReportedTokens: 4 }, factory: () => {
    const env = environment(); env.chat = async () => response("", true); env.execute = async () => { executed++; return { text: "ok", status: "ok" }; }; return env;
  } });
  assert.equal(group.samples[0].termination, "token_limit"); assert.equal(group.totals.reportedTokens, 5); assert.equal(executed, 0);
});

test("模型或工具忽略 AbortSignal 也不能无限等待，总超时后清理", async () => {
  for (const hung of ["model", "tool", "evaluate", "factory"] as const) {
    let cleaned = 0;
    const group = await runResearchGroup({ task: hung, samples: 1, limits: { ...limits, timeoutMs: 20 }, factory: () => {
      if (hung === "factory") return new Promise<ResearchEnvironment>(() => {});
      const env = environment(); env.cleanup = () => { cleaned++; };
      if (hung === "model") env.chat = () => new Promise(() => {});
      if (hung === "tool") { env.chat = async () => response("", true); env.execute = () => new Promise(() => {}); }
      if (hung === "evaluate") env.evaluate = () => new Promise(() => {});
      return env;
    } });
    assert.equal(group.samples[0].termination, "timeout"); assert.equal(cleaned, hung === "factory" ? 0 : 1);
  }
});

test("调用方取消终止不合作模型，取消后不创建后续样本", async () => {
  const ac = new AbortController(); let cleaned = 0, created = 0;
  const group = await runResearchGroup({ task: "cancel", samples: 3, limits, signal: ac.signal, factory: () => {
    created++; const env = environment(); env.chat = () => { ac.abort(); return new Promise(() => {}); }; env.cleanup = () => { cleaned++; }; return env;
  } });
  assert.equal(group.samples.length, 1); assert.equal(group.samples[0].termination, "cancelled"); assert.equal(cleaned, 1); assert.equal(created, 1);
});

test("超时后才返回的环境仍清理，清理卡住也有界", async () => {
  let cleaned = 0;
  const late = await runResearchGroup({ task: "late", samples: 1, limits: { ...limits, timeoutMs: 10 }, factory: async () => {
    await new Promise((r) => setTimeout(r, 20)); const env = environment(); env.cleanup = () => { cleaned++; }; return env;
  } });
  assert.equal(late.samples[0].termination, "timeout");
  await new Promise((r) => setTimeout(r, 25)); assert.equal(cleaned, 1);
  const stuck = await runResearchGroup({ task: "cleanup", samples: 1, limits: { ...limits, timeoutMs: 10 }, factory: () => {
    const env = environment(); env.cleanup = () => new Promise(() => {}); return env;
  } });
  assert.match(stuck.samples[0].error!, /清理失败/);
});

test("默认没有外部工具，环境输入不被循环原地修改，未知评分不假设成功", async () => {
  const env = environment(); let calls = 0;
  env.chat = async () => ++calls === 1 ? response("", true) : response();
  const group = await runResearchGroup({ task: "deny", samples: 1, limits, factory: () => env });
  assert.equal(group.samples[0].trace.tools[0].status, "denied");
  assert.equal(env.messages.length, 1); assert.equal(group.samples[0].assessment.status, "unknown");
});

test("拒绝重复环境与非法限制，不让样本隐式共享状态", async () => {
  const env = environment();
  const group = await runResearchGroup({ task: "same", samples: 2, limits, factory: () => env });
  assert.equal(group.samples[1].termination, "error"); assert.match(group.samples[1].error!, /新的环境/);
  await assert.rejects(runResearchGroup({ task: "bad", samples: 1, limits: { ...limits, maxSteps: 0 }, factory: environment }), /maxSteps/);
});

test("metadata 和预算在入口复制，调用方后续变化不修改实验版本与上限", async () => {
  const metadata = { datasetVersion: "v1", modelVersion: "fake-v1", seed: 42 }, mutableLimits = { ...limits };
  const group = await runResearchGroup({ task: "versions", samples: 1, limits: mutableLimits, metadata, factory: () => {
    metadata.datasetVersion = "v2"; mutableLimits.maxModelCalls = 99; return environment();
  } });
  assert.equal(group.metadata.datasetVersion, "v1"); assert.equal(group.metadata.seed, 42);
  assert.equal(group.limits.maxModelCalls, 4); assert.ok(Object.isFrozen(group.metadata));
});

test("未声明的工具不能调用执行端口，模型请求中止后的晚结果不改已返回轨迹", async () => {
  let executed = 0;
  const denied = await runResearchGroup({ task: "undeclared", samples: 1, limits, factory: () => {
    const env = environment(); env.tools = []; let calls = 0;
    env.chat = async () => ++calls === 1 ? response("", true) : response();
    env.execute = async () => { executed++; return { text: "不应执行", status: "ok" }; }; return env;
  } });
  assert.equal(executed, 0); assert.equal(denied.samples[0].trace.tools[0].status, "denied");
  const late = await runResearchGroup({ task: "late-chat", samples: 1, limits: { ...limits, timeoutMs: 10 }, factory: () => {
    const env = environment(); env.chat = async () => { await new Promise((r) => setTimeout(r, 30)); return response(); }; return env;
  } });
  const snapshot = structuredClone(late);
  await new Promise((r) => setTimeout(r, 35));
  assert.deepEqual(late, snapshot); assert.equal(late.totals.reportedTokens, 0); assert.equal(late.totals.incompleteUsage, 1);
});
