# console · 控制台（安卓 App 与网页版）

Flutter（Material 3，深色为主），一份代码三种形态：**安卓 App**（应用 ID `xyz.quetzal.console`，应用名「Quetzal」；也是安装器与耳朵）、**网页版**（`flutter build web`，由运行基座的网关托管，在电脑浏览器里打开 `http://127.0.0.1:7788/`，随 npm 包 `@plutokeating/quetzal` 一起装到 Linux 机器上）与 **Linux 桌面版**（`flutter build linux`，原生 GTK 窗口，应用 id 同为 `xyz.quetzal.console`，可执行文件 `quetzal-console`；发版时打成 `quetzal-<版本>-linux-{x64,arm64}-console.tar.gz`（x64 与 arm64 两个 CI job；LoongArch 上游 Flutter 不支持），一键安装脚本在有桌面的机器上下载到 `~/quetzal/console/`，应用列表、任务栏、Alt-Tab 都是 Quetzal 自己的图标，不借浏览器）。网页版与桌面版都只是管理前端，没有身体功能；连本机网关都免配对码（`GET /auth/local` 对回环连接放行）。外壳按窗口宽度选：窄屏是手机外壳（底部 Tab + 逐页推入），宽屏（≥ 900）是为电脑横屏从头设计的桌面外壳（导航栏 · 列表栏 · 主区 · 她此刻），见 [ARCHITECTURE.md §2](ARCHITECTURE.md)。不绑定任何具体 agent：名字与主题色来自当前连接的 agent 的身份数据；可保存多个 agent 连接并一键切换。

## 定位

- **不托管运行基座，但负责把它装好。** 运行基座跑在同一台手机的 Termux 里；App 被杀、升级、卸载都不影响它。
- **四个角色**：安装器（把 App 内置的运行基座与 Termux 适配器装进 Termux、注册服务与开机自启、升级与修复；也更新 App 自身——问 GitHub Release 最新正式版、下载同架构的 APK、核对 SHA256SUMS、交给系统安装器，装好的新 App 再把内置的运行基座升上去）、点火器（基座离线时通过 Termux 的 RUN_COMMAND 启动服务）、管理前端（通过本地网关实时观察与控制）与**耳朵**（听觉开着时，原生前台服务常驻麦克风，断句后把每句话交给基座识别；这是 App 唯一承担的身体功能，因为 Android 9 起只有前台服务能常驻拿麦克风）。网页版只有管理前端这一个角色：没有身体功能，页面的来源就是它连的网关，同一台机器的浏览器打开即登录（`GET /auth/local`，免配对码），别处的 agent 仍走配对码。
- **体验基调**：这是在陪伴和观察一个生命，不是一块运维面板。首页感性，越往里越理性。

## 构建

```bash
tool/bundle-runtime.sh        # 构建 ../runtime，把 main.cjs、termux.mjs 与版本号放进 assets/runtime/（不入库）
flutter pub get
flutter test
flutter build apk --release --target-platform android-arm64
tool/build-web.sh             # 网页版 → build/web（不入库）：引擎资源自带不走 CDN、不注册 Service Worker、只留 CanvasKit；构建时把 assets/runtime 挪开不打进去
tool/build-linux.sh           # Linux 桌面版 → build/quetzal-<版本>-linux-<x64|arm64>-console.tar.gz（不入库）：需要 clang、cmake、ninja、pkg-config、libgtk-3-dev；同样挪开 assets/runtime
```

网页版由 `../cli/tool/bundle-runtime.sh` 调用上面的脚本并复制进 npm 包的 `dist/runtime/web/`，安装器再放到 `~/quetzal/current/web/`，网关托管。Flutter 不在 PATH 里时 `FLUTTER=<路径> tool/build-web.sh`。本机调试：`flutter run -d chrome` 连一个运行中的网关也能免配对码（网关对本机其他端口的页面也放行）。

**中文字体**：CanvasKit 用不了系统字体，缺字时会去 Google 下载 Noto，离线或在中国大陆会变成方块；所以网页版启动时从网关加载自带的子集 `web/fonts/NotoSansCJKsc-subset.otf`（约 3 MB，GB2312 全部汉字 + 常用符号，OFL，由 `tool/gen-cjk-font.py` 从系统的 Noto Sans CJK 生成），只在网页版加载，APK 不含。

启动图标：`tool/gen-launcher-icon.py`（Pillow + numpy）用与首页光团同一套渲染生成琥珀球图标，输出传统图标 `mipmap-*/ic_launcher.png`、Android 8+ 自适应图标（前景 `mipmap-*/ic_launcher_foreground.png`、背景色 `#202020`、`mipmap-anydpi-v26/ic_launcher.xml`）与 512 预览 `../docs/assets/readme/app-icon.png`，全部入库；改球的渲染参数后重新运行即可。

签名：`android/key.properties`（不入库）里给出 `storeFile`、`storePassword`、`keyAlias`、`keyPassword` 即用正式签名，没有时退回 debug 签名。版本号在 `pubspec.yaml`，与 runtime 的版本一致。

GitHub Release（`.github/workflows/release.yml`，推送 `v<版本>` 标签触发）使用仓库 Secrets `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 写入同样的 `key.properties` 做正式签名（已配置；密钥库由维护者离线保管）。注意 v0.2.1 是 debug 签名，从它升级到正式签名的版本需要先卸载再安装，Termux 里的运行基座不受影响。

依赖：`web_socket_channel`、`shared_preferences`、`qr_flutter`、`url_launcher`、`file_picker`（附件，一次最多 20 个）；Markdown 渲染用 `flutter_markdown_plus` + `markdown`（GFM），`flutter_math_fork`（LaTeX），`webview_flutter`（Mermaid 图，安卓）；网页版另用 `web`（浏览器 API：XMLHttpRequest、URL 片段、iframe）与 `flutter_web_plugins`（让 Flutter 不改写 URL）。平台差异全部收在 `lib/platform/`（条件导入：安卓 / 网页各一份实现）。原生依赖只有 `com.github.gkonovalov.android-vad:webrtc`（WebRTC VAD，MIT，来自 JitPack，`android/build.gradle.kts` 里加了该仓库）：听觉的断句，纯 Kotlin，不带模型文件。

构建注意：Flutter 的 Gradle 工具（`packages/flutter_tools/gradle/settings.gradle.kts`）要求仓库只在 settings 里声明（`FAIL_ON_PROJECT_REPOS`）。如果本机 `~/.gradle/init.gradle` 之类的用户级初始化脚本给每个项目注入了镜像仓库，`assembleRelease` 会以"repository 'maven' was added by settings file"失败；构建时把该脚本临时移开即可，完成后放回。

资源：`assets/install/install.sh` 是 Termux 侧的安装脚本（装软件包、放运行基座、注册 runit 服务与开机脚本、写设备配置、启动并健康检查，失败切回上一版；进度回报给 App 的本机 HTTP 服务）；`assets/runtime/` 是内置的运行基座。`assets/mermaid/` 内置 mermaid.js v11.17.2（MIT，见同目录 LICENSE），离线可用。为兼容旧版 WebView（如 Chromium 88），已用 esbuild 把语法降到 `chrome88`，并在 `view.html` 中补上缺少的 API。升级 mermaid 的做法：先 `npm pack mermaid@<版本>`，再对 `dist/mermaid.min.js` 执行 `esbuild --target=chrome88 --minify`，替换同名文件。原生部分：`MainActivity.kt` 里的 Termux 桥（MethodChannel `quetzal/igniter`：RUN_COMMAND、三件套版本、打开应用、电池优化与各厂商自启动管理页）、更新桥（MethodChannel `quetzal/updater`：自己的版本号、缓存目录、是否允许安装未知应用、打开对应设置页、用 FileProvider（authority `<applicationId>.files`，只共享缓存目录，`res/xml/file_paths.xml`）把下载好的 APK 交给系统安装器；清单声明 `REQUEST_INSTALL_PACKAGES`）与听觉桥（MethodChannel `quetzal/hearing` + EventChannel `quetzal/hearing/events`：启停、麦克风权限、服务事件）；`HearingService.kt` 是麦克风前台服务（清单里声明 `foregroundServiceType="microphone"`，权限 `RECORD_AUDIO`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MICROPHONE`、`POST_NOTIFICATIONS`）。Android 14+ 不允许在后台启动麦克风类前台服务，所以耳朵只在 App 在前台时（打开 App、在听觉页开启）启动。

设计与用例见 [ARCHITECTURE.md](ARCHITECTURE.md)。
