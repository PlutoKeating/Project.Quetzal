# 快速开始

## 1. 部署运行基座（部署者）

需要 Node.js 22+ 与 git。

```bash
cd runtime
npm ci
npm test          # 单元测试
npm run build     # 生成 dist/main.cjs（单文件，已内置依赖）
WINDLER_HOME=~/windler node --enable-source-maps dist/main.cjs
```

生产环境请交给进程守护者（runit、systemd……），退出即重启。示例（systemd 用户服务）：

```ini
[Service]
Environment=WINDLER_HOME=%h/windler
Environment=WINDLER_ADAPTER=/path/to/your-adapter.mjs
ExecStart=/usr/bin/node --enable-source-maps /opt/windler/main.cjs
Restart=always
```

Android 手机上的完整部署（Termux + runit + 身体适配器 + 一键发布脚本）见参考实现 [Project.Honor9](https://github.com/PlutoKeating/Project.Honor9)。

## 2. 之后的一切都在控制台里完成（使用者）

1. **安装控制台**：`console/` 用 `flutter build apk` 构建后安装到与 Windler 同一台设备。
2. **配对**：打开 App → 找到运行中的 Windler（找不到时点「点火」）→「申请配对码」→ 在系统通知里看到 6 位配对码 → 填入完成配对。
3. **配置模型**：控制 → 模型 → 添加供应商（从目录选择或自定义）→ 添加 Key → 勾选模型 → 保存 → 测试连通 → 在「全局模型顺序」里拖动排序，可把一个便宜的模型设为「内省」模型。配置好之后，她就会按自己的节律开始醒来。
4. **接入飞书（可选）**：控制 → 飞书 →「开始」→ 在飞书中打开并确认。机器人自动创建并绑定你本人；在飞书里打开与机器人（以 agent 的显示名命名）的单聊，会收到「此刻」卡片，之后所有操作都通过卡片按钮完成。
5. **身份**：控制 → 身份，给 agent 起名字、选主题色（写入它的灵魂仓库，所有身体同步）。
6. **共享灵魂（可选）**：在 GitHub 网页创建一个**私有**仓库 → 控制 → 灵魂同步 →「显示公钥」并把它添加到仓库的 Deploy keys（允许写入）→ 填入仓库地址并「接入」。之后同步全自动。
7. **让 Hermes / OpenClaw 也住进来（可选）**：灵魂同步页第 3 步有一句现成的话，复制发给那台机器上的 Hermes 或 OpenClaw，它会自己安装 soul-bridge；需要你做的只有在 GitHub 网页添加一次它给出的部署公钥。
8. **多个 agent**：点顶栏的名字 →「连接新的 agent」，填入另一个运行基座的网关地址并配对，之后一键切换。

## 3. 开发

```bash
cd runtime && npm run dev      # 以 ./.dev 为家目录直接运行 TypeScript
cd console && flutter run      # 连接设备调试控制台
```
