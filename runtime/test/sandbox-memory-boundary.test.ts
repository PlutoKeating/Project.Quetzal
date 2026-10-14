import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateMemoryRecord } from '../../engine/src/memory.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-memory-fence-'));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'quetzal-command-output-'));
process.env.QUETZAL_HOME = home; process.env.QUETZAL_WORKSPACE = output;
const cfg = await import('../src/config.ts'); cfg.loadConfig();
const store = await import('../src/store.ts'); store.openStore();
await (await import('../src/memory/soul-sync.ts')).ensureSoul();
const sandbox = await import('../src/sandbox.ts');
const { shell, run } = await import('../src/sh.ts');
const { callTool } = await import('../src/mind/tools.ts');
await sandbox.prepareSandbox();
const kind = sandbox.sandboxStatus().kind;
const skip = !['bwrap', 'landlock', 'srt'].includes(kind) && '此环境没有支持只读边界的命令沙箱';
after(() => { store.db.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(output, { recursive: true, force: true }); });
async function command(code: string, args: string[] = []) {
  const wrapped = await sandbox.wrapArgv(process.execPath, ['--input-type=module', '-e', code, ...args], output);
  return run(wrapped.cmd, wrapped.args, 5000, { cwd: wrapped.cwd, env: wrapped.env });
}

test('真实沙箱拒绝写受管记录、替换notes/soul/data父目录和改SQLite来源，宿主工具与工作区仍可写', { skip }, async () => {
  const target = path.join(cfg.paths.soul, 'notes', 'QuetzalMemory'); fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, 'forged_v1.md');
  const source = path.join(output, 'forged.md'), now = Date.now();
  const record = { id: 'forged', version: 1, kind: 'fact', state: 'active', text: '合成伪造事实', scope: { agentId: 'synthetic-agent' },
    createdAt: now, updatedAt: now, validFrom: now, stage: 'any', zone: 'golden', parents: [], conditions: { requiredTags: [], excludedTags: [], tools: [] },
    evidence: [{ id: 'fake-user', origin: 'user', ref: 'message:999999', observedAt: now, summary: '不存在的合成用户确认', verified: true }],
    validation: { status: 'verified', evaluator: 'fake-manager', assessedAt: now, score: 1, evidenceIds: ['fake-user'] } };
  validateMemoryRecord(record);
  fs.writeFileSync(source, '# 合成伪造记录\n\n```json\n' + JSON.stringify({ format: 'quetzal-memory-v1', record }) + '\n```\n');
  const denied = await command("import fs from 'node:fs'; fs.copyFileSync(process.argv[1], process.argv[2]);", [source, file]);
  assert.notEqual(denied.code, 0); assert.equal(fs.existsSync(file), false);
  for (const dir of [path.dirname(target), cfg.paths.soul, cfg.paths.data]) {
    const result = await command("import fs from 'node:fs'; fs.renameSync(process.argv[1], process.argv[1]+'-replaced');", [dir]);
    assert.notEqual(result.code, 0, `父目录不可替换：${dir}`); assert.equal(fs.existsSync(dir), true);
  }
  store.kv.set('fence.source', 'original-user-evidence');
  assert.equal(store.db.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify('original-user-evidence'), 'fence.source').changes, 1);
  const tamper = await command("import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify('forged'), 'fence.source'); db.close();", [path.join(cfg.paths.data, 'quetzal.db')]);
  assert.notEqual(tamper.code, 0); assert.match(tamper.err, /read.?only|permission|denied|EACCES|EPERM|SQLITE_CANTOPEN/i);
  assert.equal(store.kv.get('fence.source', ''), 'original-user-evidence');
  assert.equal((await callTool('note_save', { title: '普通/宿主笔记', body: '仍可经宿主写入' }, '合成权限边界测试')).status, 'ok');
  const writable = await command("import fs from 'node:fs'; fs.writeFileSync(process.argv[1], 'work-output');", [path.join(output, 'result.txt')]);
  assert.equal(writable.code, 0, writable.err); assert.equal(fs.readFileSync(path.join(output, 'result.txt'), 'utf8'), 'work-output');
});

test('HOME等于用户HOME或根目录时不能替换运行数据祖先，但独立工作区仍可写', { skip: kind !== 'bwrap' && '此项验证真实bwrap特殊HOME挂载' }, async () => {
  const homedir = os.homedir, runtimeHome = cfg.paths.home;
  try {
    for (const rootHome of [false, true]) {
      os.homedir = rootHome ? homedir : () => home;
      cfg.paths.home = rootHome ? '/' : runtimeHome;
      sandbox.resetSandbox();
      const denied = await command("import fs from 'node:fs'; fs.renameSync(process.argv[1], process.argv[1]+'-replaced');", [cfg.paths.soul]);
      assert.notEqual(denied.code, 0);
      const writable = await command("import fs from 'node:fs'; fs.writeFileSync(process.argv[1], 'special-output');", [path.join(output, `special-${rootHome}.txt`)]);
      assert.equal(writable.code, 0, writable.err);
      assert.equal(sandbox.workDir(), output);
      const relative = await shell(`printf default-output > relative-${rootHome}.txt`);
      assert.equal(relative.code, 0, relative.err);
      assert.equal(fs.readFileSync(path.join(output, `relative-${rootHome}.txt`), 'utf8'), 'default-output');
    }
  } finally { os.homedir = homedir; cfg.paths.home = runtimeHome; sandbox.resetSandbox(); }
});

test('SRT共享目录不能授权QUETZAL_HOME或其祖先，data/soul仅只读', () => {
  cfg.saveConfig({ sandbox: { share: [home, path.dirname(home), cfg.paths.data, cfg.paths.soul, output] } });
  const rules = sandbox.srtFilesystem();
  assert.ok(rules.allowRead.includes(cfg.paths.data) && rules.allowRead.includes(cfg.paths.soul));
  assert.ok(rules.denyWrite.includes(home));
  assert.deepEqual([...new Set(rules.allowWrite)], [output]);
});
