package xyz.quetzal.console

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Termux 桥（MethodChannel quetzal/igniter）：
 *  - run：通过 Termux 的 RUN_COMMAND 接口在 Termux 里后台执行一个程序（点火、安装器）。
 *    需要 Termux 的 ~/.termux/termux.properties 中 allow-external-apps=true，并授予本应用 RUN_COMMAND 权限。
 *  - 三件套检测、打开应用、系统的电池优化 / 各厂商自启动管理页（保活引导）。
 * 听觉桥（MethodChannel quetzal/hearing + EventChannel quetzal/hearing/events）：启停耳朵（HearingService）、麦克风权限、服务事件。
 * 更新桥（MethodChannel quetzal/updater）：App 自身的更新——自己的版本号、缓存目录、是否允许安装未知应用、打开对应设置页、
 *  用 FileProvider 把下载好的 APK 交给系统安装器（Dart 侧 updater.dart 负责问 GitHub、下载与校验）。
 *  交给安装器之前核对 APK 的包名与签名证书和正在运行的 App 一致（checkApk；install 里再查一次，不一致就拒绝）。
 */
class MainActivity : FlutterActivity() {
    private val perm = "com.termux.permission.RUN_COMMAND"
    private var hearingSink: EventChannel.EventSink? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "quetzal/hearing").setMethodCallHandler { call, result ->
            when (call.method) {
                "hasPermission" -> result.success(checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                "requestPermission" -> {
                    val wanted = mutableListOf(android.Manifest.permission.RECORD_AUDIO)
                    if (android.os.Build.VERSION.SDK_INT >= 33) wanted.add("android.permission.POST_NOTIFICATIONS")
                    requestPermissions(wanted.toTypedArray(), 2); result.success(null)
                }
                "start" -> { HearingService.start(this, call.argument<String>("base")!!, call.argument<String>("token")!!, call.argument<String>("fingerprint") ?: "", call.argument<Int>("sensitivity") ?: 2); result.success(true) }
                "stop" -> { HearingService.stop(this); result.success(true) }
                "isRunning" -> result.success(HearingService.running)
                "play" -> { HearingService.instance?.play(call.argument<String>("id")!!, call.argument<String>("url")!!); result.success(HearingService.instance != null) }
                "stopPlayback" -> { HearingService.instance?.stop(interrupted = false); result.success(true) }
                else -> result.notImplemented()
            }
        }
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, "quetzal/hearing/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(args: Any?, sink: EventChannel.EventSink) {
                hearingSink = sink
                HearingService.listener = { kind, data -> hearingSink?.success(mapOf("kind" to kind) + data) }
            }
            override fun onCancel(args: Any?) { hearingSink = null; HearingService.listener = null }
        })
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "quetzal/updater").setMethodCallHandler { call, result ->
            when (call.method) {
                "version" -> result.success(version(packageName))
                "cacheDir" -> result.success(cacheDir.absolutePath)
                "canInstall" -> result.success(Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls())
                "requestInstallPermission" -> {
                    if (Build.VERSION.SDK_INT >= 26) startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                    result.success(null)
                }
                "checkApk" -> result.success(checkApk(call.argument<String>("path")!!))
                "install" -> {
                    try {
                        val path = call.argument<String>("path")!!
                        checkApk(path)?.let { result.error("INSTALL_REFUSED", "安装包的签名证书与当前 App 不一致：$it", null); return@setMethodCallHandler }
                        val uri = FileProvider.getUriForFile(this, "$packageName.files", File(path))
                        startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("INSTALL_FAILED", e.message, null)
                    }
                }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "quetzal/igniter").setMethodCallHandler { call, result ->
            when (call.method) {
                "packageVersion" -> result.success(version(call.argument<String>("pkg")!!))
                "hasPermission" -> result.success(checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED)
                "requestPermission" -> { requestPermissions(arrayOf(perm), 1); result.success(null) }
                "run" -> {
                    val path = call.argument<String>("path")!!
                    val args = call.argument<List<String>>("args") ?: emptyList()
                    try {
                        val i = Intent().apply {
                            setClassName("com.termux", "com.termux.app.RunCommandService")
                            action = "com.termux.RUN_COMMAND"
                            putExtra("com.termux.RUN_COMMAND_PATH", path)
                            putExtra("com.termux.RUN_COMMAND_ARGUMENTS", args.toTypedArray())
                            putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
                        }
                        startService(i)
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("IGNITE_FAILED", e.message, null)
                    }
                }
                "openApp" -> {
                    val pkg = call.argument<String>("pkg")!!
                    val i = packageManager.getLaunchIntentForPackage(pkg)
                    if (i != null) startActivity(i) else result.error("NO_APP", "没有安装 $pkg", null).also { return@setMethodCallHandler }
                    result.success(null)
                }
                "openAppDetails" -> { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + call.argument<String>("pkg")))); result.success(null) }
                "openBatterySettings" -> { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); result.success(null) }
                "requestIgnoreBattery" -> {
                    val pm = getSystemService(POWER_SERVICE) as PowerManager
                    if (!pm.isIgnoringBatteryOptimizations(packageName))
                        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                    result.success(pm.isIgnoringBatteryOptimizations(packageName))
                }
                "openAutostart" -> { openAutostart(); result.success(null) }
                else -> result.notImplemented()
            }
        }
    }

    /** 签名证书的 SHA-256 集合；拿不到时为 null。API 28+ 用 signingInfo（含轮换历史），更早或取不到时退回 signatures。 */
    @Suppress("DEPRECATION")
    private fun certs(info: PackageInfo?, history: Boolean): Set<String>? {
        if (info == null) return null
        var sigs: Array<Signature>? = null
        if (Build.VERSION.SDK_INT >= 28) {
            val si = info.signingInfo
            if (si != null) sigs = if (si.hasMultipleSigners()) si.apkContentsSigners else if (history) si.signingCertificateHistory else si.apkContentsSigners
        }
        if (sigs.isNullOrEmpty()) sigs = info.signatures
        if (sigs.isNullOrEmpty()) return null
        return sigs.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { b -> "%02x".format(b) } }.toSet()
    }

    /** 下载的 APK 是否可以交给系统安装器：包名相同，且正在运行的 App 的当前签名证书都在新包的证书（含轮换历史）里。可以返回 null，否则返回原因。 */
    @Suppress("DEPRECATION")
    private fun checkApk(path: String): String? = try {
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES else PackageManager.GET_SIGNATURES
        val apk = packageManager.getPackageArchiveInfo(path, flags)
        val mine = certs(packageManager.getPackageInfo(packageName, flags), history = false)
        val theirs = certs(apk, history = true)
        when {
            apk == null -> "无法解析安装包"
            apk.packageName != packageName -> "包名不同（${apk.packageName}）"
            mine == null || theirs == null -> "读不到签名证书"
            !theirs.containsAll(mine) -> "签名证书不同"
            else -> null
        }
    } catch (e: Exception) { "核对失败：${e.message}" }

    private fun version(pkg: String): String? = try { packageManager.getPackageInfo(pkg, 0).versionName } catch (e: Exception) { null }

    /** 各厂商的自启动 / 后台运行管理页（尽力而为），都打不开时退回 Termux 的应用详情页。 */
    private fun openAutostart() {
        val candidates = listOf(
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity",
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            "com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity",
            "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
            "com.asus.mobilemanager" to "com.asus.mobilemanager.autostart.AutoStartActivity",
        )
        for ((pkg, cls) in candidates) {
            val i = Intent().setComponent(ComponentName(pkg, cls)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (packageManager.resolveActivity(i, 0) != null) { try { startActivity(i); return } catch (_: Exception) {} }
        }
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:com.termux")))
    }
}
