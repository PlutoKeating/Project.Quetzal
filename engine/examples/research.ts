// 只使用合成模型和工具；不读取密钥、运行配置或私有灵魂。
import { runResearchGroup, type ResearchEnvironment } from "../src/index.ts";

const group = await runResearchGroup({
  task: "synthetic-addition", samples: 3,
  metadata: { datasetVersion: "addition-v1", modelVersion: "synthetic-v1", toolVersion: "add-v1", strategyVersion: "two-step-v1", experienceVersion: "none" },
  limits: { maxSteps: 4, maxModelCalls: 4, maxToolCalls: 1, maxReportedTokens: 100, maxOutputTokens: 40, timeoutMs: 1000 },
  factory: ({ sample }): ResearchEnvironment => {
    let calls = 0, result: number | undefined;
    return {
      messages: [{ role: "user", content: "用提供的工具求 2 + 3" }],
      tools: [{ name: "add", description: "合成加法", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }],
      async chat() {
        calls++;
        return { text: calls === 1 ? "" : String(sample === 2 ? 6 : result), toolCalls: calls === 1 ? [{ id: "add", name: "add", args: { a: 2, b: 3 } }] : [], usage: { input: 2, output: 1 }, model: "synthetic" };
      },
      async execute(call) {
        if (call.name !== "add") return { text: "未知工具", status: "denied" };
        result = Number(call.args.a) + Number(call.args.b);
        return { text: String(result), status: "ok" };
      },
      redactArgs: (args) => args,
      async evaluate(record) {
        const correct = result === 5 && record.result?.text === "5";
        return { status: correct ? "success" : "failure", score: correct ? 1 : 0, evidence: [`工具观测值=${result}；最终答案=${record.result?.text}`] };
      },
      cleanup() { result = undefined; },
    };
  },
});
console.log(JSON.stringify(group, null, 2));
