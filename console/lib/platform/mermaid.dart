// Mermaid 图：都用内置的 mermaid.js（assets/mermaid/view.html，离线可用），按平台选宿主——
//   安卓：WebView；网页版：同源的 iframe；Windows 桌面版：WebView2（webview_windows）；
//   Linux 桌面版：Flutter 的 Linux 嵌入没有平台视图，嵌不进网页视图，由运行壳里看不见的 WebKitGTK 渲染后截图成 PNG（linux/runner/mermaid_renderer.cc）。
//   桌面上缺 WebView2 运行时 / WebKitGTK 时，请运行基座画成 SVG（网关 mermaid.render），再不行才显示源码。
export 'mermaid_io.dart' if (dart.library.js_interop) 'mermaid_web.dart';
