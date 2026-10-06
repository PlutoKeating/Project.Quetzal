#ifndef RUNNER_MERMAID_RENDERER_H_
#define RUNNER_MERMAID_RENDERER_H_

#include <flutter_linux/flutter_linux.h>

// Mermaid 图（Linux 桌面版）：Flutter 的 Linux 嵌入没有平台视图，嵌不进 WebKitGTK 的窗口部件；
// 所以在一个看不见的离屏窗口里用 WebKitGTK 跑内置的 assets/mermaid/view.html（真正的 mermaid.js），按图的原始尺寸排版后整页截图，
// 把 PNG 交给 Flutter 显示。WebKitGTK 用 dlopen 按需加载（libwebkit2gtk-4.1，退回 4.0）：控制台本身不链接它，
// 机器上没有时只是 render 返回 unavailable，Dart 侧退回让运行基座画（mermaid.render）。
// MethodChannel quetzal/mermaid：
//   render {code: String, dark: bool, scale: double} → {png: Uint8List, scale: double}（PNG 的像素 = CSS 像素 × scale）
//   错误码：unavailable（没有 WebKitGTK / 页面加载失败）、render（mermaid 报错，message 为原因）、timeout。
void mermaid_renderer_register(FlBinaryMessenger* messenger);

#endif  // RUNNER_MERMAID_RENDERER_H_
