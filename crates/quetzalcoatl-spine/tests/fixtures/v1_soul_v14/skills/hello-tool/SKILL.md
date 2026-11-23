---
name: hello-tool
description: 输出确定性合成问候语并回显输入标签，用于迁移与自演化冒烟测试。
compatibility: 无需外部网络依赖
metadata:
  quetzal-tool: hello_tool
  quetzal-requires: sh
---

## 用途

用于在离线测试环境中验证技能文档解析、元数据读取与本地沙箱工具执行闭环。

## 参数

- `tag`（字符串，必填）：需要回显的测试标签。
