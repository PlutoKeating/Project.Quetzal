// Mermaid 图：安卓在 WebView 里渲染，网页版在同源的 iframe 里渲染；两边都用 assets/mermaid/view.html + 内置的 mermaid.js，离线可用。
export 'mermaid_webview.dart' if (dart.library.js_interop) 'mermaid_web.dart';
