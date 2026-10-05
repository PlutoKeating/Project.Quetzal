// systemd 单元文件：环境变量、入口与重启策略与 Android 的 runit 服务一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { unitText } from "../src/service.ts";

test("单元文件指向 current 下的运行基座与 Linux 适配器，退出即重启", () => {
  const u = unitText({ home: "/home/u/quetzal", node: "/usr/bin/node" });
  assert.match(u, /^Environment=QUETZAL_HOME=\/home\/u\/quetzal$/m);
  assert.match(u, /^Environment=QUETZAL_ADAPTER=\/home\/u\/quetzal\/current\/linux\.mjs$/m);
  assert.match(u, /^ExecStart=\/usr\/bin\/node --enable-source-maps \/home\/u\/quetzal\/current\/main\.cjs$/m);
  assert.match(u, /^Restart=always$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
});

test("路径带空格、引号、$ 与 % 时，单元文件里正确引用", () => {
  const u = unitText({ home: "/home/a b/it's $x 50%", node: "/opt/no de/node" });
  assert.match(u, /^Environment="QUETZAL_HOME=\/home\/a b\/it's \$\$x 50%%"$/m);
  assert.match(u, /^WorkingDirectory=\/home\/a b\/it's \$x 50%%\/current$/m);
  assert.match(u, /^ExecStart="\/opt\/no de\/node" --enable-source-maps "\/home\/a b\/it's \$\$x 50%%\/current\/main\.cjs"$/m);
  assert.throws(() => unitText({ home: "/home/a\nb", node: "/usr/bin/node" }));
});
