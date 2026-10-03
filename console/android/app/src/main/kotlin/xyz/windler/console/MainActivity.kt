package xyz.windler.console

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Termux 桥（MethodChannel windler/igniter）：
 *  - run：通过 Termux 的 RUN_COMMAND 接口在 Termux 里后台执行一个程序（点火、安装器）。
 *    需要 Termux 的 ~/.termux/termux.properties 中 allow-external-apps=true，并授予本应用 RUN_COMMAND 权限。
 *  - 三件套检测、打开应用、系统的电池优化 / 各厂商自启动管理页（保活引导）。
 * 听觉桥（MethodChannel windler/hearing + EventChannel windler/hearing/events）：启停耳朵（HearingService）、麦克风权限、服务事件。
 */
class MainActivity : FlutterActivity() {
    private val perm = "com.termux.permission.RUN_COMMAND"
    private var hearingSink: EventChannel.EventSink? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "windler/hearing").setMethodCallHandler { call, result ->
            when (call.method) {
                "hasPermission" -> result.success(checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                "requestPermission" -> {
                    val wanted = mutableListOf(android.Manifest.permission.RECORD_AUDIO)
                    if (android.os.Build.VERSION.SDK_INT >= 33) wanted.add("android.permission.POST_NOTIFICATIONS")
                    requestPermissions(wanted.toTypedArray(), 2); result.success(null)
                }
                "start" -> { HearingService.start(this, call.argument<String>("base")!!, call.argument<String>("token")!!, call.argument<Int>("sensitivity") ?: 2); result.success(true) }
                "stop" -> { HearingService.stop(this); result.success(true) }
                "isRunning" -> result.success(HearingService.running)
                "mute" -> { HearingService.muteUntil = System.currentTimeMillis() + (call.argument<Int>("ms") ?: 0); result.success(true) }
                else -> result.notImplemented()
            }
        }
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, "windler/hearing/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(args: Any?, sink: EventChannel.EventSink) {
                hearingSink = sink
                HearingService.listener = { kind, data -> hearingSink?.success(mapOf("kind" to kind) + data) }
            }
            override fun onCancel(args: Any?) { hearingSink = null; HearingService.listener = null }
        })
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "windler/igniter").setMethodCallHandler { call, result ->
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
