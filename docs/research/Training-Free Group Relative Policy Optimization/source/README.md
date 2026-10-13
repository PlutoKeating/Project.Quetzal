# 上游源码

官方源码：[https://github.com/TencentCloudADP/youtu-agent](https://github.com/TencentCloudADP/youtu-agent)，依据 PDF 第 1 页。

`upstream/` 为 Git submodule；主仓库锁定具体提交，见 `metadata.json` 与 `.gitmodules`。论文明确使用 `training_free_GRPO` 分支。

初始化与固定版本更新见研究根目录说明。二次开发代码放 `../development/`，实验入口放 `../experiments/`；如修改 submodule，必须先在其仓库提交，再在主仓库提交新的 gitlink。
