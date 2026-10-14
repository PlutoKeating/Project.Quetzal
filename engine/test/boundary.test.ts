import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// 验证真实源码的静态依赖边界，防止后续改动使独立引擎加载宿主入口。
test("引擎源码依赖图只包含自身模块", () => {
  const root = new URL("../src/", import.meta.url);
  for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(new URL(file, root), "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)) {
      const target = new URL(match[1], root);
      assert.ok(fileURLToPath(target).startsWith(fileURLToPath(root)), `${file} 越过引擎边界：${match[1]}`);
      assert.ok(fs.existsSync(target), `${file} 导入目标缺失：${match[1]}`);
    }
  }
});
