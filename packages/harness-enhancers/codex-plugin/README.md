# Codex 插件：Quetzalcoatl

这是 `qz connect` 接上 Codex 时写出的本地插件源的模板，内嵌进 `qz` 二进制，不需要手工拷贝。
接上命令把它写到 `QUETZALCOATL_HOME/hosts/codex/marketplace/`，再用 Codex 自己的插件命令装入：

```sh
codex plugin marketplace add --json <插件源目录>
codex plugin add quetzalcoatl@quetzalcoatl-local
```

## 它做什么

与 Claude Code 的插件相同：会话开始送入他的核心，每次提交带上相关往事，工具调用之前登记所属会话并拦下模型在命令行里冒充宿主的调用，回合结束核对改动。工具通道（`qz mcp`）提供查往事与写回的工具。任何失败都放行。

## 第一次要在 Codex 里信任钩子

Codex 把新装的钩子标为未信任并跳过它们。装好后打开 Codex，在 `/hooks` 里信任 Quetzalcoatl 的四个钩子；`qz doctor` 会告诉你信任了没有。工具通道不需要这一步。

## 模板占位符

| 占位符 | 替换成 |
| --- | --- |
| `{{QZ_BIN}}` | 当前 `qz` 可执行文件的绝对路径，按 shell 规则加引号 |
| `{{QZ_BIN_RAW}}` | 同一路径，不加引号（用于 JSON 里的 `command` 字段） |
| `{{QZ_VERSION}}` | 当前 `qz` 的版本号；Codex 按版本号缓存插件，升级时据此刷新 |
