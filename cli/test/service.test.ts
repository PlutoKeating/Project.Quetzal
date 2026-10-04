// systemd 单元文件：环境变量、入口与重启策略与 Android 的 runit 服务一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { unitText } from "../src/service.ts";

test("单元文件指向 current 下的运行基座与 Linux 适配器，退出即重启", () => {
  const u = unitText({ home: "/home/u/windler", node: "/usr/bin/node" });
  assert.match(u, /^Environment=WINDLER_HOME=\/home\/u\/windler$/m);
  assert.match(u, /^Environment=WINDLER_ADAPTER=\/home\/u\/windler\/current\/linux\.mjs$/m);
  assert.match(u, /^ExecStart=\/usr\/bin\/node --enable-source-maps \/home\/u\/windler\/current\/main\.cjs$/m);
  assert.match(u, /^Restart=always$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
});
