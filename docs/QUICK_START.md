# 快速开始

## 1. 部署运行基座（部署者）

需要 Node.js 22+ 与 git。

```bash
cd runtime
npm ci
npm test          # 单元测试
npm run build     # 生成 dist/main.cjs（单文件，已内置依赖）
AMANI_HOME=~/amani node --enable-source-maps dist/main.cjs
```

生产环境请交给进程守护者（runit、systemd……），退出即重启。示例（systemd 用户服务）：

```ini
[Service]
Environment=AMANI_HOME=%h/amani
Environment=AMANI_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/amani/main.cjs
Restart=always
```

Android 手机上的完整部署（Termux + runit + 身体适配器 + 一键发布脚本）见参考实现 [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)。

## 2. 之后的一切都在控制台里完成（使用者）

1. **安装控制台**：`console/` 用 `flutter build apk` 构建后安装到与 Amani 同一台设备。
2. **配对**：打开 App → 找到运行中的 Amani（找不到时点「点火」）→「申请配对码」→ 在系统通知里看到 6 位配对码 → 填入完成配对。
3. **配置模型**：控制 → 模型 → 添加供应商（从目录选择或自定义）→ 添加 Key → 勾选模型 → 保存 → 测试连通 → 在「全局模型顺序」里拖动排序，可把一个便宜的模型设为「内省」模型。配置好之后，她就会按自己的节律开始醒来。
4. **接入飞书（可选）**：控制 → 飞书 →「开始」→ 在飞书中打开并确认。机器人自动创建并绑定你本人；在飞书里打开与「神谷薰」的单聊，会收到「此刻」卡片，之后所有操作都通过卡片按钮完成。
5. **共享灵魂（可选）**：创建一个**私有** git 仓库 → 控制 → 灵魂同步 →「显示公钥」并把它添加到仓库的 Deploy keys（允许写入）→ 填入仓库地址并「接入」。
6. **让 Hermes 也接入（可选）**：对运行 Hermes 的设备上的 Hermes 说：「安装 Project.Amani 仓库 `hermes/amani-soul` 目录下的技能，并按技能说明接入灵魂仓库」，并告诉它仓库地址。

## 3. 开发

```bash
cd runtime && npm run dev      # 以 ./.dev 为家目录直接运行 TypeScript
cd console && flutter run      # 连接设备调试控制台
```
