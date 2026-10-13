# 上游源码

官方源码：[https://github.com/OpenRLHF/OpenRLHF](https://github.com/OpenRLHF/OpenRLHF)，依据 PDF 第 1 页。

`upstream/` 为 Git submodule；主仓库锁定具体提交，见 `metadata.json` 与 `.gitmodules`。当前锁定的是此次获取的上游默认分支提交，尚未确认是否对应论文实验版本。

初始化与固定版本更新见研究根目录说明。二次开发代码放 `../development/`，实验入口放 `../experiments/`；如修改 submodule，必须先在其仓库提交，再在主仓库提交新的 gitlink。
