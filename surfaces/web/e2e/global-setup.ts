import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(HERE, "../../..");
const DIST = join(WEB_DIR, "dist");

function toolchainBin(name: string): string {
  const candidates = [
    process.env[name === "cargo" ? "CARGO" : "RUSTC"] ?? "",
    join(homedir(), ".rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin", name),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return name;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 20 * 60 * 1000,
  });
  if (result.status !== 0) {
    throw new Error(
      `命令失败: ${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function waitForHealth(baseUrl: string, stderr: () => string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(
    `真实 quetzalcoatld 在 ${timeoutMs} ms 内未就绪（${lastError}）。守护进程 stderr:\n${stderr()}`,
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 1. 构建静态资源（globalSetup 保证 e2e 不依赖外部手动步骤）。
  run(process.execPath, ["build.mjs"], WEB_DIR);
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error(`构建后仍缺少 ${join(DIST, "index.html")}`);
  }

  // 2. 真实守护进程二进制：显式覆盖 > target/debug 产物 > 现场构建（失败即大声报错）。
  const toolchain = dirname(toolchainBin("cargo"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${toolchain}:${process.env.PATH ?? ""}`,
    QUETZALCOATL_WEB_DIR: DIST,
    QUETZALCOATL_VOICE_AI: "0",
  };
  const binary =
    process.env.QUETZALCOATL_DAEMON_BIN ?? join(REPO_ROOT, "target/debug/quetzalcoatld");
  // 没有指定二进制时每次都让 cargo 增量构建一次，免得拿旧的守护进程去测新的页面。
  if (process.env.QUETZALCOATL_DAEMON_BIN === undefined) {
    run(toolchainBin("cargo"), ["build", "-p", "quetzalcoatl-daemon", "--bin", "quetzalcoatld"], REPO_ROOT, env);
  }
  if (!existsSync(binary)) {
    throw new Error(`未找到 quetzalcoatld 二进制: ${binary}`);
  }

  // 3. 临时 QUETZALCOATL_HOME + 回环随机端口启动真实守护进程。
  const home = await mkdtemp(join(tmpdir(), "qz-web-e2e-"));
  const logs: string[] = [];
  const child = spawn(binary, ["--home", home, "--ipc-addr", "127.0.0.1:0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  const exitState: { value: { code: number | null; signal: NodeJS.Signals | null } | null } = {
    value: null,
  };
  child.once("exit", (code, signal) => {
    exitState.value = { code, signal };
  });

  const runtimeInfo = join(home, "run/daemon.json");
  const deadline = Date.now() + 60_000;
  let address = "";
  while (Date.now() < deadline) {
    if (exitState.value) {
      throw new Error(
        `真实 quetzalcoatld 启动即退出 (code=${exitState.value.code}, signal=${exitState.value.signal})。日志:\n${logs.join("")}`,
      );
    }
    try {
      const parsed = JSON.parse(await readFile(runtimeInfo, "utf8")) as {
        ipc_http_addr?: string;
      };
      if (typeof parsed.ipc_http_addr === "string" && parsed.ipc_http_addr.length > 0) {
        address = parsed.ipc_http_addr;
        break;
      }
    } catch {
      // 尚未落盘
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  if (!address) {
    child.kill("SIGTERM");
    throw new Error(`真实 quetzalcoatld 未写出 run/daemon.json。日志:\n${logs.join("")}`);
  }

  const baseUrl = `http://${address}`;
  try {
    await waitForHealth(baseUrl, () => logs.join(""));
  } catch (error) {
    child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
    throw error;
  }

  process.env.QZ_REAL_DAEMON_URL = baseUrl;
  process.env.QZ_REAL_DAEMON_HOME = home;
  console.log(`real quetzalcoatld ready at ${baseUrl} (home=${home})`);

  return async () => {
    child.kill("SIGTERM");
    const stopDeadline = Date.now() + 10_000;
    while (!exitState.value && Date.now() < stopDeadline) {
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!exitState.value) child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  };
}
