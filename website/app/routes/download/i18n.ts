import type { Lang } from "~/i18n/core";
import type { PlatformId } from "@shared/releases";

export type DownloadMessages = {
  metaTitle: string;
  metaDescription: string;
  intro: string;
  cliTitle: string;
  cliNote: string;
  requirementsTitle: string;
  requirements: string[];
  verifyTitle: string;
  verifyText: string;
  platforms: Record<PlatformId, { label: string; note: string }>;
};

const zh: DownloadMessages = {
  metaTitle: "下载",
  metaDescription: "下载经 Ed25519 签名校验的 Quetzalcoatl 内核、守护进程与六种原生客户端。",
  intro:
    "每个资产都在 SHA256SUMS 里，清单由 Ed25519 签名。你可以直接用安装脚本（它替你验签），也可以下载压缩包自己核对。下载页只展示本产品带完整签名清单的发布；预发布版本会标注 pre-release。",
  cliTitle: "命令行与守护进程",
  cliNote:
    "压缩包包含 qz、quetzalcoatld 与 quetzalcoatl-sandbox-exec；原生桌面客户端随同一版本发布时，会出现在该版本的资产列表里。",
  requirementsTitle: "运行要求",
  requirements: [
    "Linux：glibc 2.31+，x86_64 或 arm64，GTK 4.14+ 与 libadwaita 1.9+ 用于原生窗口",
    "macOS：12 及以上，Intel 与 Apple silicon",
    "Windows：10 1809+ 或 11，PowerShell 5.1+",
    "Android / iOS：随应用商店或对应安装包发布，需要 iOS 18+ / Android 10+",
  ],
  verifyTitle: "先验签，再安装",
  verifyText:
    "安装脚本用内置公钥验证 SHA256SUMS.sig，再核对资产哈希，最后跑 qz --version 健康检查。任何一步失败都会回滚到上一个版本。自己核对的命令见发布签名页。",
  platforms: {
    "linux-x64": { label: "Linux x64", note: "Debian / Ubuntu / Fedora / Arch，glibc 2.31+" },
    "linux-arm64": { label: "Linux arm64", note: "树莓派、ARM 服务器与 Asahi" },
    "macos-arm64": { label: "macOS Apple silicon", note: "M 系列，macOS 12+" },
    "macos-x64": { label: "macOS Intel", note: "x86_64，macOS 12+" },
    "windows-x64": { label: "Windows x64", note: "Windows 10 1809+ / 11" },
    "windows-arm64": { label: "Windows arm64", note: "Windows 11 on ARM" },
  },
};

const en: DownloadMessages = {
  metaTitle: "Download",
  metaDescription: "Download the Ed25519-signed Quetzalcoatl kernel, daemon and six native clients.",
  intro:
    "Every asset is listed in SHA256SUMS, and the manifest is Ed25519 signed. Use the installer (it verifies for you) or download an archive and check it yourself. This page lists this product's releases with a complete signed manifest; pre-releases are labelled as such.",
  cliTitle: "Command line and daemon",
  cliNote:
    "Archives contain qz, quetzalcoatld and quetzalcoatl-sandbox-exec. When a native desktop client ships with the same version, it appears in that release's asset list.",
  requirementsTitle: "Requirements",
  requirements: [
    "Linux: glibc 2.31+, x86_64 or arm64; GTK 4.14+ and libadwaita 1.9+ for the native window",
    "macOS: 12 or newer, Intel or Apple silicon",
    "Windows: 10 1809+ or 11, PowerShell 5.1+",
    "Android / iOS: via the stores or the matching package; iOS 18+ / Android 10+",
  ],
  verifyTitle: "Verify first, install second",
  verifyText:
    "The installer verifies SHA256SUMS.sig with the embedded key, checks the artifact hash, then runs a qz --version health check. Any failure rolls back to the previous version. Commands to check it yourself are on the release signing page.",
  platforms: {
    "linux-x64": { label: "Linux x64", note: "Debian / Ubuntu / Fedora / Arch, glibc 2.31+" },
    "linux-arm64": { label: "Linux arm64", note: "Raspberry Pi, ARM servers and Asahi" },
    "macos-arm64": { label: "macOS Apple silicon", note: "M-series, macOS 12+" },
    "macos-x64": { label: "macOS Intel", note: "x86_64, macOS 12+" },
    "windows-x64": { label: "Windows x64", note: "Windows 10 1809+ / 11" },
    "windows-arm64": { label: "Windows arm64", note: "Windows 11 on ARM" },
  },
};

export const messages: Record<Lang, DownloadMessages> = { zh, en };
