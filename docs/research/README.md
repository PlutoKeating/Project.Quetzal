# 论文研究工作区

每篇论文使用标题作为目录名，标题中的 `:` 替换为全角 `：`，以兼容 Windows 路径。PDF 保留 2026-10-13 下载时的原始字节，编号、版本与校验值见各论文的 `metadata.json`。

| 编号与 PDF 版本 | 论文研究入口 | 论文资料 |
|---|---|---|
| 2405.11143v6 | [OpenRLHF: An Easy-to-use, Scalable and High-performance RLHF Framework](OpenRLHF%EF%BC%9A%20An%20Easy-to-use%2C%20Scalable%20and%20High-performance%20RLHF%20Framework/README.md) | [PDF](OpenRLHF%EF%BC%9A%20An%20Easy-to-use%2C%20Scalable%20and%20High-performance%20RLHF%20Framework/paper/original/2405.11143.pdf) · [Markdown](OpenRLHF%EF%BC%9A%20An%20Easy-to-use%2C%20Scalable%20and%20High-performance%20RLHF%20Framework/paper/markdown/paper.md) |
| 2604.07645v1 | [PRIME: Training Free Proactive Reasoning via Iterative Memory Evolution for User-Centric Agent](PRIME%EF%BC%9A%20Training%20Free%20Proactive%20Reasoning%20via%20Iterative%20Memory%20Evolution%20for%20User-Centric%20Agent/README.md) | [PDF](PRIME%EF%BC%9A%20Training%20Free%20Proactive%20Reasoning%20via%20Iterative%20Memory%20Evolution%20for%20User-Centric%20Agent/paper/original/2604.07645.pdf) · [Markdown](PRIME%EF%BC%9A%20Training%20Free%20Proactive%20Reasoning%20via%20Iterative%20Memory%20Evolution%20for%20User-Centric%20Agent/paper/markdown/paper.md) |
| 2510.08191v1 | [Training-Free Group Relative Policy Optimization](Training-Free%20Group%20Relative%20Policy%20Optimization/README.md) | [PDF](Training-Free%20Group%20Relative%20Policy%20Optimization/paper/original/2510.08191.pdf) · [Markdown](Training-Free%20Group%20Relative%20Policy%20Optimization/paper/markdown/paper.md) |

## 目录树

```text
docs/research/
├── README.md
├── .gitattributes             # PDF 与图片按二进制处理
├── .gitignore                 # 忽略本地环境与缓存
├── tools/
│   ├── README.md
│   ├── requirements.txt       # PDF 提取工具的锁定依赖
│   └── extract_pdf.py
└── <论文标题>/
    ├── README.md
    ├── metadata.json          # 论文版本、PDF 哈希、源码 URL 与提交
    ├── paper/
    │   ├── README.md
    │   ├── original/<arxiv-id>.pdf
    │   └── markdown/
    │       ├── paper.md
    │       ├── extraction.json
    │       └── assets/
    │           ├── figures/   # 自动识别的图片及矢量图区域
    │           └── pages/     # 每一页的完整 PNG
    ├── source/
    │   ├── README.md          # 官方仓库来源与版本说明
    │   └── upstream/          # Git submodule；PRIME 尚待确认来源
    ├── experiments/
    │   ├── README.md
    │   ├── configs/           # 配置模板与 .env.example
    │   ├── scripts/           # 复现与评测入口
    │   └── results/           # 脱敏后的指标与结果报告
    ├── development/
    │   ├── README.md
    │   ├── src/               # 二次开发与集成代码
    │   ├── tests/             # 验证测试
    │   └── patches/           # 基于固定上游版本的补丁
    ├── notes/
    │   ├── README.md
    │   ├── reading.md         # 阅读笔记与论文页码
    │   ├── code-map.md        # 论文概念到源码符号的映射
    │   ├── questions.md       # 待验证问题
    │   └── journal/           # 按日期保存过程记录
    ├── conclusions/
    │   ├── README.md
    │   ├── findings.md        # 有证据支持的结论与限制
    │   └── quetzal.md         # Quetzal 适用性与集成建议
    └── runtime/
        ├── README.md
        ├── .gitignore
        ├── logs/
        ├── outputs/
        ├── datasets/
        ├── checkpoints/
        ├── cache/
        └── venv/
```

各预留目录通过说明文件或 `.gitkeep` 纳入 Git。实验与二次开发依赖、运行入口和配置必须跟随实际实现加入；当前模板不声称已完成实验或实现。

## PDF 提取

已使用本地 PDF 生成 Markdown、自动识别的图片以及全部 52 页的完整原图。原图用于保留所有图片、表格、矢量图、公式和页面布局；正文提取保留基本标题、段落、列表和可识别的 Markdown 表格。

自动转换不保证公式转为正确 LaTeX，复杂表格与双栏阅读顺序仍需校对。逐页原图是视觉核对依据；`extraction.json` 记录工具版本、PDF 哈希和产物清单。人工校对版另存 `paper/markdown/reviewed.md`，重跑提取不会修改该文件。工具安装与重跑方法见 [tools/README.md](tools/README.md)。

## 源码 submodule

- OpenRLHF：PDF 第 1 页明确给出 [OpenRLHF/OpenRLHF](https://github.com/OpenRLHF/OpenRLHF)。当前固定此次获取的默认分支提交，尚未确认其与论文实验版本一致。
- Training-Free GRPO：PDF 第 1 页明确给出 [TencentCloudADP/youtu-agent 的 training_free_GRPO 分支](https://github.com/TencentCloudADP/youtu-agent/tree/training_free_GRPO)，已按该分支添加。
- PRIME：截至 2026-10-13，在 PDF、[arXiv 页面](https://arxiv.org/abs/2604.07645)与[作者主页](https://kingofspace0wzz.github.io/)未找到可确认的官方源码链接；`source/` 已预留，尚未添加 submodule。

已有主仓库克隆中初始化研究源码（从仓库根目录执行）：

```bash
git submodule update --init --recursive -- docs/research/
git submodule status -- docs/research/
```

初始化遵循主仓库提交中锁定的 gitlink；日常研究不要使用 `update --remote` 自动漂移。确需更新时，在对应 submodule 中 fetch 并 checkout 选定的提交，同步修改论文 `metadata.json` 的 `source.commit`，记录原因与验证，然后提交主仓库的 gitlink 和元数据。

PRIME 来源确认后，按以下模式添加（占位 URL 必须替换为已核实地址）：

```bash
git submodule add --name research-prime <已确认的官方仓库URL> 'docs/research/PRIME： Training Free Proactive Reasoning via Iterative Memory Evolution for User-Centric Agent/source/upstream'
```

同时补齐 `metadata.json`、`source/README.md` 和核查记录。上游源码修改应在 submodule 仓库先提交；二次开发也可通过 `development/patches/` 保存补丁及应用说明。研究源码不接入 Quetzal 的编译、安装或部署流程。

## 研究工作流与产物

1. 在 `notes/reading.md` 精读并标注证据页码，逐项核对图表、公式及提取顺序。
2. 在 `notes/code-map.md` 记录概念到固定源码提交的映射，在 `notes/questions.md` 维护待验证问题。
3. 在 `experiments/` 编写复现入口、依赖、配置模板与评价标准，在 `development/` 保存二次开发和测试。
4. 在 `notes/journal/` 记录命令、版本、观察、失败及下一步；在 `experiments/results/` 留下脱敏结果。
5. 在 `conclusions/` 记录有证据支持的结论、反例、局限与 Quetzal 集成建议。

原始日志、模型权重、数据集、缓存、真实配置及虚拟环境默认放在仓库外的 `QUETZAL_HOME/research/<arxiv-id>/`，按 `runtime/` 中列出的目录分类。`runtime/` 提供位置脚手架与兜底忽略规则，运行产物不会随主仓库提交。凭据、个人数据和未经脱敏的输出不能写进研究笔记与结论。

论文、图片和上游源码保留原作者版权与各自许可；收录或自动转换不改变其许可，不自动适用本项目的 AGPLv3。
