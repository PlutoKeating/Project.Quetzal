# console · 控制台（安卓 App 与网页版）

Flutter（Material 3，深色为主），一份代码三种形态：**安卓 App**（应用 ID `xyz.quetzal.console`，应用名「Quetzal」；只装这一个 App：运行基座与它的运行环境都在里面，App 也是身体与耳朵）、**网页版**（`flutter build web`，由运行基座的网关托管，在电脑浏览器里打开 `http://127.0.0.1:7788/`，随 npm 包 `@plutokeating/quetzal` 一起装到 Linux 机器上）与 **Linux 桌面版**（`flutter build linux`，原生 GTK 窗口，应用 id 同为 `xyz.quetzal.console`，可执行文件 `quetzal-console`；发版时打成 `quetzal-<版本>-linux-{x64,arm64}-console.tar.gz`（x64 与 arm64 两个 CI job；LoongArch 上游 Flutter 不支持），一键安装脚本在有桌面的机器上下载到 `~/.quetzal/console/`，应用列表、任务栏、Alt-Tab 都是 Quetzal 自己的图标，不借浏览器）。网页版与桌面版都只是管理前端，没有身体功能；连本机网关都免配对码（`GET /auth/local` 对回环连接放行）。外壳按窗口宽度选：窄屏是手机外壳（底部 Tab + 逐页推入），宽屏（≥ 900）是为电脑横屏从头设计的桌面外壳（导航栏 · 列表栏 · 主区 · 她此刻），见 [ARCHITECTURE.md §2](ARCHITECTURE.md)。不绑定任何具体 agent：名字与主题色来自当前连接的 agent 的身份数据；可保存多个 agent 连接并一键切换。

## 定位

- **运行基座就住在 App 里（只装一个 App）。** Node.js、git、openssh、proot 随 APK 安装：`tool/android-runtime/` 用 termux-packages 以 App 自己的前缀（`/data/data/xyz.quetzal.console/files/usr`）从源码重编，可执行文件以 `lib*.so` 放进 jniLibs（Android 10+ 唯一允许 App 执行的位置，不用降 targetSdk），其余文件打成 `rootfs.tar`。App 的前台服务 `RuntimeService` 解开运行环境、启动运行基座、退出后重启，开机与 App 升级后自启；不需要 Termux。
- **角色**：安装器（启动内置的运行基座、核对网关、取得令牌，不需要配对码；也更新 App 自身——问 GitHub Release 最新正式版、下载同架构的 APK、用内置的发布公钥核对 SHA256SUMS.sig 再按 SHA256SUMS 核对 APK、原生侧再核对 APK 的签名证书与当前 App 一致，才交给系统安装器；新 App 带着新版运行基座，装好即升级）、点火器（基座离线时重新启动前台服务）、**身体**（`BodyServer`：本机身体接口，把电池、传感器、通知、相机、麦克风、定位、振动、手电、剪贴板、播放提供给运行基座的安卓适配器 `runtime/adapters/android/`）、管理前端（通过本地网关实时观察与控制）与**耳朵**（听觉开着时，原生前台服务常驻麦克风，断句后把每句话交给基座识别；Android 9 起只有前台服务能常驻拿麦克风）。网页版只有管理前端这一个角色：没有身体功能，页面的来源就是它连的网关，同一台机器的浏览器打开即登录（`GET /auth/local`，免配对码），别处的 agent 仍走配对码。
- **体验基调**：这是在陪伴和观察一个生命，不是一块运维面板。首页感性，越往里越理性。

## 构建

```bash
tool/android-runtime/build-packages.sh  # 用 Docker 跑 termux-packages（锁定提交见 versions.env），以 App 的前缀从源码编 Node.js、git、openssh、proot 及依赖 → build/android-runtime/
tool/android-runtime/reuse.sh           # 只在 CI：配方（versions.env、两个脚本、网状层锁定文件）没变时取用以往编好的同一份运行环境（Release 上签名核对过的 quetzal-android-runtime-<配方哈希>.tar.gz，或以往发版运行的产物），不再重编
tool/android-runtime/pack.sh            # 依赖闭包 → jniLibs/arm64-v8a/lib*.so（白名单里的可执行文件）+ android/app/src/main/assets/runtime-env/{rootfs.tar,manifest.json}；网状层原生组件按锁定的 sha512 下载、剥掉调试信息后放进 rootfs（都不入库；需要 dpkg-deb 与 NDK 的 llvm-strip）
tool/bundle-runtime.sh        # 构建 ../runtime，把 main.cjs、android.mjs 与版本号放进 assets/runtime/（不入库）
flutter pub get
flutter test
flutter build apk --release --target-platform android-arm64
tool/build-web.sh             # 网页版 → build/web（不入库）：引擎资源自带不走 CDN、不注册 Service Worker、只留 CanvasKit；构建时把 assets/runtime 挪开不打进去
tool/build-linux.sh           # Linux 桌面版 → build/quetzal-<版本>-linux-<x64|arm64>-console.tar.gz（不入库）：需要 clang、cmake、ninja、pkg-config、libgtk-3-dev、libayatana-appindicator3-dev（托盘图标）；同样挪开 assets/runtime
```

网页版由 `../cli/tool/bundle-runtime.sh` 调用上面的脚本并复制进 npm 包的 `dist/runtime/web/`，安装器再放到 `~/.quetzal/current/web/`，网关托管。Flutter 不在 PATH 里时 `FLUTTER=<路径> tool/build-web.sh`。本机调试：`flutter run -d chrome` 连一个运行中的网关也能免配对码（网关对本机其他端口的页面也放行）。

**中文字体**：CanvasKit 用不了系统字体，缺字时会去 Google 下载 Noto，离线或在中国大陆会变成方块；所以网页版启动时从网关加载自带的子集 `web/fonts/NotoSansCJKsc-subset.otf`（约 3 MB，GB2312 全部汉字 + 常用符号，OFL，由 `tool/gen-cjk-font.py` 从系统的 Noto Sans CJK 生成），只在网页版加载，APK 不含。

启动图标：`tool/gen-launcher-icon.py`（Pillow + numpy）用与首页光团同一套渲染生成琥珀球图标，输出传统图标 `mipmap-*/ic_launcher.png`、Android 8+ 自适应图标（前景 `mipmap-*/ic_launcher_foreground.png`、背景色 `#202020`、`mipmap-anydpi-v26/ic_launcher.xml`）与 512 预览 `../docs/assets/readme/app-icon.png`，全部入库；改球的渲染参数后重新运行即可。

签名：`android/key.properties`（不入库）里给出 `storeFile`、`storePassword`、`keyAlias`、`keyPassword` 即用正式签名，没有时退回 debug 签名。版本号在 `pubspec.yaml`，与 runtime 的版本一致。

GitHub Release（`.github/workflows/release.yml`，推送 `v<版本>` 标签触发）使用仓库 Secrets `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 写入同样的 `key.properties` 做正式签名（已配置；密钥库由维护者离线保管；发版时缺任一项直接失败，不再退回 debug 签名，因为 App 自身更新要求新包与已装 App 的签名证书一致）。注意 v0.2.1 是 debug 签名，从它升级到正式签名的版本需要先卸载再安装。发版工作流先在 `android-runtime` job 里跑上面两个 `tool/android-runtime/` 脚本，再交给 `build-apk`。

依赖：`web_socket_channel`、`shared_preferences`、`qr_flutter`、`url_launcher`、`file_picker`（附件，一次最多 20 个）、`crypto`（SHA-256：APK 核对、网关证书指纹）、`cryptography`（App 自身更新时用 Ed25519 核对 SHA256SUMS.sig：Dart 与 Android 9 以下的系统都没有 Ed25519，自己实现签名算法不可取；它是维护活跃的纯 Dart 实现，依赖都已是间接依赖；配对证明的 PBKDF2-HMAC-SHA256 也用它，网页版走浏览器的 WebCrypto）；Markdown 渲染用 `flutter_markdown_plus` + `markdown`（GFM），`flutter_math_fork`（LaTeX），`webview_flutter`（Mermaid 图，安卓）；网页版另用 `web`（浏览器 API：XMLHttpRequest、URL 片段、iframe）与 `flutter_web_plugins`（让 Flutter 不改写 URL）。平台差异全部收在 `lib/platform/`（条件导入：安卓 / 网页各一份实现）。原生依赖只有 `com.github.gkonovalov.android-vad:webrtc`（WebRTC VAD，MIT，来自 JitPack，`android/build.gradle.kts` 里加了该仓库）：听觉的断句，纯 Kotlin，不带模型文件。

构建注意：Flutter 的 Gradle 工具（`packages/flutter_tools/gradle/settings.gradle.kts`）要求仓库只在 settings 里声明（`FAIL_ON_PROJECT_REPOS`）。如果本机 `~/.gradle/init.gradle` 之类的用户级初始化脚本给每个项目注入了镜像仓库，`assembleRelease` 会以"repository 'maven' was added by settings file"失败；构建时把该脚本临时移开即可，完成后放回。

资源：`assets/runtime/` 是内置的运行基座（`main.cjs`、安卓适配器 `android.mjs`、`VERSION`），由 `RuntimeService` 复制到 `files/runtime/<版本>/`；内置运行环境在 Android 原生资源 `android/app/src/main/assets/runtime-env/`（不经 Flutter；不另行压缩，APK 本身是压缩的，AGP 也会把 `.gz` 资源解开）。`assets/mermaid/` 内置 mermaid.js v11.17.2（MIT，见同目录 LICENSE），离线可用。为兼容旧版 WebView（如 Chromium 88），已用 esbuild 把语法降到 `chrome88`，并在 `view.html` 中补上缺少的 API。升级 mermaid 的做法：先 `npm pack mermaid@<版本>`，再对 `dist/mermaid.min.js` 执行 `esbuild --target=chrome88 --minify`，替换同名文件。原生部分：`MainActivity.kt` 里的运行基座桥（MethodChannel `quetzal/runtime`：`bundled`、`status`、`token`、`start` / `restart` / `stop`、身体权限 `bodyPermissions` / `requestBodyPermissions`、电池优化与各厂商自启动管理页；打开 App 时装过的运行基座没在跑就拉起）、更新桥（MethodChannel `quetzal/updater`：自己的版本号、缓存目录、是否允许安装未知应用、打开对应设置页、核对下载的 APK 与当前 App 包名相同、签名证书一致（`checkApk`：API 28+ 用 `GET_SIGNING_CERTIFICATES`，允许证书轮换历史，更早退回 `GET_SIGNATURES`；`install` 里再查一次，不一致拒绝）、用 FileProvider（authority `<applicationId>.files`，只共享缓存目录，`res/xml/file_paths.xml`）把下载好的 APK 交给系统安装器；清单声明 `REQUEST_INSTALL_PACKAGES`）与听觉桥（MethodChannel `quetzal/hearing` + EventChannel `quetzal/hearing/events`：启停（`start` 带 `base`、`token`、钉住的证书指纹 `fingerprint`、`sensitivity`）、麦克风权限、服务事件）；`RuntimeService.kt` 是运行基座的前台服务（`foregroundServiceType="specialUse|camera|microphone|location"`，Android 14+ 按已授予的权限声明类型；`PARTIAL_WAKE_LOCK`；首次启动写入身体名字（机型）与时区；环境变量见 [家目录约定](../../website/content/docs/zh/reference/home-directory.md)）与 `BootReceiver`（`BOOT_COMPLETED`、`MY_PACKAGE_REPLACED`；厂商系统要放行「自启动」才收得到）；`BodyServer.kt` 是身体接口；`Rootfs.kt` 解开运行环境（GNU tar，路径必须在目标目录之内）并在前缀里建指向 `nativeLibraryDir` 的链接，版本或 `nativeLibraryDir` 变了就重新解开，家目录不动；`HearingService.kt` 是麦克风前台服务（清单里声明 `foregroundServiceType="microphone"`，权限 `RECORD_AUDIO`、`FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MICROPHONE`、`POST_NOTIFICATIONS`）。Android 14+ 不允许在后台启动麦克风类前台服务，所以耳朵只在 App 在前台时（打开 App、在听觉页开启）启动。

## 安全

- **App 自身更新失败即拒绝**：信任根是 `lib/updater.dart` 里内置的发布公钥（Ed25519，私钥只在发版工作流的 Secret `RELEASE_SIGNING_KEY` 里）。发布没有 `SHA256SUMS` / `SHA256SUMS.sig`、签名验不过、`commit <提交> <标签>` 行的标签与发布不符、SHA256SUMS 里没有这个 APK、哈希不符、APK 名字不合 `^quetzal-[A-Za-z0-9.+-]+-android-arm64\.apk$`、APK 的签名证书与当前 App 不一致——任何一条都不安装。镜像源与 GitHub 都只是搬运者。
- **身体接口**（`BodyServer.kt`）：只监听 127.0.0.1 的随机端口，每次启动生成 256 位随机令牌，端口与令牌写进 `QUETZAL_HOME/secrets/body.json`（0600）；令牌定长比较；拍照、录音的输出与播放的输入只能在 `QUETZAL_HOME` 之内。手机上别的 App 能连这个端口但没有令牌；agent 的命令在 proot 沙箱里看不到密钥目录，App 还用 `QUETZAL_HIDE_PATHS` 让沙箱遮住它自己的私有数据（`shared_prefs` 等，存着控制台的网关令牌）——运行基座与控制台是同一个系统用户，这一层由沙箱提供。
- **安装器**：网关令牌直接从家目录读取（同一个 App），先经 `/health` 与一次带令牌的 `status` RPC 核对才保存；端口上已有不是本 App 启动的运行基座（旧版 Termux 安装）时不再启动第二个，提示迁移。
- **网关令牌**：存在 `shared_preferences`（安卓是应用私有目录）；清单 `android:allowBackup="false"`，`res/xml/backup_rules.xml` 与 `data_extraction_rules.xml` 把云备份与设备迁移全部排除。没有用 `flutter_secure_storage`：Linux 桌面版要多依赖 libsecret（构建与运行都要，无桌面密钥环的机器上会失败），网页版只是把密钥放在 localStorage，安卓上收益有限，换来的是三种形态各一套存储与迁移；以后需要再评估。
- **局域网只走加密连接，钉住证书**（`lib/pins.dart`、`lib/platform/pin_io.dart`）：别的机器上的运行基座只能用 `https://<地址>:7789`（只填地址时自动补全；旧的 `http://<局域网地址>:7788` 档案连不上时回到配对页，提示「运行基座已改为加密连接，请重新配对」），明文只用于本机回环。运行基座的证书是自签名的，原生版（安卓、Linux 桌面）不靠 CA，`HttpOverrides.global` 接管所有 HttpClient——网关请求、WebSocket（`IOWebSocketChannel` 显式传入）、`Image.network`——对钉住的 host:port 直连、TLS 上下文不带系统 CA，只认 SHA-256（证书 DER）等于连接档案里 `fp` 的证书；其他地址（GitHub、官网）照常用系统 CA。配对：`/pair/info` 以「捕获」方式握手记下看到的指纹并显示给人核对（与配对通知里的短指纹一致），指纹与档案里的不同就清掉旧令牌（令牌只发给配对时核对过的证书）；配对码不上网络，提交 `proof` = hex(PBKDF2-HMAC-SHA256(配对码, "quetzal-pair-v2|" + 指纹, 100000, 32))（后台 isolate 计算），再核对运行基座回报的指纹。耳朵（`HearingService.kt`）连 https 时同样只认 Flutter 传来的指纹（自定义 `X509TrustManager`，主机名校验换成核对对端证书），没有指纹就不发请求。网页版的 TLS 由浏览器处理、不能钉住：人在浏览器的证书警告页上核对指纹，配对证明用 `/pair/info` 报告的指纹。
- **令牌不进网址**：HTTP 请求带请求头 `X-Quetzal-Token`（另带 `x-token` 给旧版运行基座）；WebSocket 连上后第一条消息发 `{"auth": "<令牌>"}`，旧版运行基座握手时就要 `?token=`，被拒或认证前就断开时自动退回旧方式，并记住这个网关（本次运行内）；耳朵的 `/hear` 与播放语音也用请求头。唯一的例外是附件图片预览（`Image.network`）：网页版由浏览器按网址加载，带不了自定义请求头，所以 `fileUrl` 仍带 `?token=`，只发给同一个网关。
- **外部链接**：一律经 `lib/links.dart` 的 `openExternal`：只放行 https（http 只限 localhost / 127.0.0.1 / ::1），不允许带用户名密码；网关、同步服务与 Markdown 里的链接都走这里，不合规的提示而不打开。
- **命令沙箱**：服务页显示运行基座报告的 `status.sandbox`（bwrap / proot / none；旧版运行基座没有这一项就不显示），none 时用醒目颜色提醒。

设计与用例见 [ARCHITECTURE.md](ARCHITECTURE.md)。
