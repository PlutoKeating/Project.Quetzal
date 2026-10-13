# PDF 提取工具

使用 PyMuPDF 与 PyMuPDF4LLM 处理论文的标题、段落、表格、图片和矢量图区域，同时将每一页渲染为完整 PNG。选择专门的 PDF 库是为了支持双栏论文及图形提取；这些依赖只用于研究资料转换，不属于 Quetzal 运行基座依赖。

`requirements.txt` 锁定此次使用的直接与传递依赖版本。PyMuPDF4LLM 的安装依赖包含布局组件及 ONNX Runtime；脚本明确使用传统布局提取，不启用模型布局或 OCR，也不调用外部模型 API。API 参考：[PyMuPDF4LLM 官方文档](https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/api.html)。

从仓库根目录安装到仓库外的环境（本次验证使用 Python 3.14）：

```bash
# QUETZAL_HOME 必须事先设置为仓库外的目录
python3 -m venv "${QUETZAL_HOME:?请先设置仓库外的 QUETZAL_HOME}/research/tools/venv"
"$QUETZAL_HOME/research/tools/venv/bin/python" -m pip install -r docs/research/tools/requirements.txt
"$QUETZAL_HOME/research/tools/venv/bin/python" docs/research/tools/extract_pdf.py
```

Windows 使用相同的 Python 脚本，虚拟环境解释器路径为 `venv/Scripts/python.exe`；以上 shell 命令用于 Linux / macOS。

只重跑一篇：

```bash
"$QUETZAL_HOME/research/tools/venv/bin/python" docs/research/tools/extract_pdf.py --paper 2604.07645
```

输出在各论文的 `paper/markdown/`：`paper.md`、`extraction.json`、`assets/figures/` 和 `assets/pages/`。渲染与图形提取使用 160 DPI，每页在 Markdown 中附可展开的完整原图。脚本先核对原始 PDF 的 SHA-256，失败时不继续转换该论文。

`paper.md` 与清单会在重跑时覆盖；人工校对另存 `reviewed.md`。更换 PDF 或工具版本后，需审查旧图形资产是否仍被引用，并同步更新元数据与记录。自动转换可能影响公式字符、复杂表格和阅读顺序，原始 PDF 与逐页原图始终是校对依据。
