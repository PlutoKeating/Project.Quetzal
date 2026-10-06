// Windows 相关的纯逻辑（在任何平台上都能测）：netstat 解析、父进程链、沙箱里禁止连回的地址、PowerShell 引号。
import { test } from "node:test";
import assert from "node:assert/strict";
import { netstatOwner, isDescendant } from "../src/web.ts";
import { selfAddress, psq } from "../src/sandbox.ts";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1032
  TCP    127.0.0.1:7788         127.0.0.1:53211        ESTABLISHED     4120
  TCP    127.0.0.1:53211        127.0.0.1:7788         ESTABLISHED     9876
  TCP    [::1]:53300            [::1]:7788             ESTABLISHED     5555
`;

test("netstat：找出客户端一侧的进程", () => {
  assert.equal(netstatOwner(NETSTAT, 53211, 7788), 9876);
  assert.equal(netstatOwner(NETSTAT, 53300, 7788), 5555);
  assert.equal(netstatOwner(NETSTAT, 1, 7788), undefined);
});

test("父进程链：子孙、不是子孙、环", () => {
  const parent = new Map([[10, 5], [5, 1], [20, 10], [30, 31], [31, 30]]);
  assert.equal(isDescendant(20, 5, parent), true);
  assert.equal(isDescendant(10, 99, parent), false);
  assert.equal(isDescendant(30, 99, parent), true, "环：按是处理（拒绝）");
});

test("沙箱里不能借代理连回这台机器", () => {
  for (const h of ["localhost", "a.localhost", "127.0.0.1", "127.8.9.1", "0.0.0.0", "::1", "[::1]", "::ffff:127.0.0.1", "169.254.169.254", "fe80::1", "168.63.129.16"]) assert.equal(selfAddress(h), true, h);
  for (const h of ["example.com", "8.8.8.8", "192.168.1.20", "10.0.0.5", "2606:4700::1111"]) assert.equal(selfAddress(h), false, h);
});

test("PowerShell 单引号", () => {
  assert.equal(psq("C:\\a b\\it's"), "'C:\\a b\\it''s'");
});
