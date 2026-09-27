package xyz.amani.console

import android.content.Intent
import android.content.pm.PackageManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * 点火器：通过 Termux 的 RUN_COMMAND 接口在 Termux 里执行固定命令（启动 / 重启 Amani 服务）。
 * 需要 Termux 的 ~/.termux/termux.properties 中 allow-external-apps=true，并授予本应用 RUN_COMMAND 权限。
 */
class MainActivity : FlutterActivity() {
    private val perm = "com.termux.permission.RUN_COMMAND"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "amani/igniter").setMethodCallHandler { call, result ->
            when (call.method) {
                "termuxInstalled" -> result.success(installed("com.termux"))
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
                "openTermux" -> {
                    packageManager.getLaunchIntentForPackage("com.termux")?.let { startActivity(it) }
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun installed(pkg: String) = try { packageManager.getPackageInfo(pkg, 0); true } catch (e: Exception) { false }
}
