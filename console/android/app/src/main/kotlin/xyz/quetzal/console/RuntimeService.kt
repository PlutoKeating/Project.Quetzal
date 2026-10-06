package xyz.quetzal.console

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.io.File

/**
 * App 内置的运行基座（只装一个 App）：前台服务把 Node.js 与运行基座跑在 App 自己的进程组里。
 *  - 运行环境见 Rootfs；运行基座（main.cjs 与安卓适配器 android.mjs）来自 Flutter 资源 assets/runtime/，按版本放进 files/runtime/<版本>/。
 *  - 家目录 files/home/quetzal（QUETZAL_HOME）：记忆、配置、密钥都在这里；身体接口（BodyServer）的地址与令牌写进它的 secrets/。
 *  - 守护：进程退出后按退避重新拉起（运行基座自己的熔断逻辑在 state/starts.json）；开机由 BootReceiver 拉起。「守护开关」关掉时两者都不做。
 *  - 持有 PARTIAL_WAKE_LOCK：息屏后 CPU 不睡，她才能自己醒来。
 *  - 前台服务类型：Android 14+ 用 specialUse；已获授权的相机、麦克风、定位一并声明（后台使用它们的前提）。
 */
class RuntimeService : Service() {
    companion object {
        private const val CHANNEL_ID = "quetzal_runtime"
        private const val NOTIFICATION_ID = 7790
        private const val PREFS = "quetzal_runtime"
        const val PORT = 7788
        @Volatile var running = false
            private set
        @Volatile var lastError: String? = null
            private set
        @Volatile var version: String? = null
            private set

        fun start(ctx: Context) {
            ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("installed", true).apply()
            val i = Intent(ctx, RuntimeService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, RuntimeService::class.java)) }
        fun installed(ctx: Context) = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("installed", false)
        fun autostart(ctx: Context) = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("autostart", true)
        fun setAutostart(ctx: Context, on: Boolean) = ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("autostart", on).apply()
        /** 网关令牌（同一个 App、同一个用户，直接读家目录里的文件，不需要配对）。 */
        fun token(ctx: Context): String? = try { File(Rootfs.quetzalHome(ctx), "secrets/gateway.token").readText().trim().ifEmpty { null } } catch (_: Exception) { null }
    }

    @Volatile private var stopping = false
    private var proc: Process? = null
    private var body: BodyServer? = null
    private var wake: PowerManager.WakeLock? = null
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        foreground()
        if (worker?.isAlive == true) return START_STICKY
        stopping = false
        worker = Thread({ loop() }, "quetzal-runtime").apply { start() }
        return START_STICKY
    }

    override fun onDestroy() {
        stopping = true
        running = false
        proc?.destroy()
        body?.stop(); body = null
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun foreground() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Quetzal 运行基座", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        val n = b.setSmallIcon(R.mipmap.ic_launcher).setContentTitle("Quetzal").setContentText("ta 住在这台手机里").setContentIntent(open).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 34) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
            if (has(Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            if (has(Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (has(Manifest.permission.ACCESS_COARSE_LOCATION)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            try { startForeground(NOTIFICATION_ID, n, type) } catch (_: Exception) { startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) } // 开机时不允许相机、麦克风类型
        } else startForeground(NOTIFICATION_ID, n)
        if (wake == null) wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "quetzal:runtime").apply { setReferenceCounted(false); acquire() }
    }

    private fun logFile() = File(Rootfs.quetzalHome(this), "data/runtime.log")
    private fun log(s: String) = try {
        val f = logFile(); f.parentFile?.mkdirs()
        if (f.length() > 4L shl 20) f.renameTo(File(f.parentFile, "runtime.log.1"))
        f.appendText("${java.time.Instant.now()} [app] $s\n")
    } catch (_: Exception) {}

    /** 运行基座的文件：从 Flutter 资源复制到 files/runtime/<版本>/（版本没变就不复制）。返回目录。 */
    private fun runtimeDir(): File {
        val fa = "flutter_assets/assets/runtime"
        val v = assets.open("$fa/VERSION").bufferedReader().use { it.readText().trim() }
        val dir = File(filesDir, "runtime/$v")
        val stamp = File(dir, ".complete")
        if (!stamp.isFile) {
            Rootfs.deleteTree(dir); dir.mkdirs()
            for (name in listOf("main.cjs", "android.mjs")) assets.open("$fa/$name").use { i -> File(dir, name).outputStream().use { i.copyTo(it) } }
            stamp.writeText(v)
            File(filesDir, "runtime").listFiles()?.filter { it.name != v }?.forEach { Rootfs.deleteTree(it) } // 只留当前版本（不跟随里面的 node_modules 链接）
        }
        version = v
        return dir
    }

    /** 设备配置：身体名字（机型，公开的非唯一信息）与时区；只在还没有配置时写入，其余配置由控制台管理。 */
    private fun deviceConfig(home: File) {
        val f = File(home, "config/quetzal.json")
        val c = try { org.json.JSONObject(f.readText()) } catch (_: Exception) { org.json.JSONObject() }
        var changed = false
        if (c.optString("body").let { it.isEmpty() || it == "default" }) {
            val name = Build.MODEL.lowercase().replace(Regex("[^a-z0-9-]+"), "-").trim('-').take(32)
            c.put("body", name.ifEmpty { "android" }.let { if (it[0].isLetterOrDigit()) it else "a$it" }); changed = true
        }
        if (c.optString("timezone").isEmpty()) { c.put("timezone", java.util.TimeZone.getDefault().id); changed = true }
        if (changed) { f.parentFile?.mkdirs(); f.writeText(c.toString(2)) }
    }

    private fun loop() {
        var backoff = 2_000L
        while (!stopping) {
            val started = System.currentTimeMillis()
            try {
                Rootfs.ensure(this) { log(it) }
                val rt = runtimeDir()
                val home = Rootfs.quetzalHome(this).apply { mkdirs() }
                deviceConfig(home)
                if (body == null) body = BodyServer(this, home).also { it.start() }
                val usr = Rootfs.prefix(this)
                val data = filesDir.parentFile!!
                val nm = File(usr, "lib/quetzal/node_modules")
                val link = File(rt, "node_modules")
                if (nm.isDirectory && !link.exists()) android.system.Os.symlink(nm.path, link.path) // 网状层的原生组件（node-datachannel）
                val pb = ProcessBuilder(File(usr, "bin/node").path, "--enable-source-maps", File(rt, "main.cjs").path)
                    .directory(rt).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(logFile()))
                pb.environment().apply {
                    put("HOME", Rootfs.home(this@RuntimeService).path)
                    put("QUETZAL_HOME", home.path)
                    put("QUETZAL_ADAPTER", File(rt, "android.mjs").path)
                    put("PREFIX", usr.path)
                    put("PATH", "${usr.path}/bin:/system/bin:/system/xbin")
                    put("LD_LIBRARY_PATH", "${usr.path}/lib")
                    put("TMPDIR", "${usr.path}/tmp")
                    put("LANG", "en_US.UTF-8")
                    put("SHELL", "/system/bin/sh")
                    put("SSL_CERT_FILE", "${usr.path}/etc/tls/cert.pem")
                    put("GIT_EXEC_PATH", "${usr.path}/libexec/git-core")
                    put("GIT_TEMPLATE_DIR", "${usr.path}/share/git-core/templates")
                    put("PROOT_LOADER", "${usr.path}/libexec/proot/loader") // 前缀里的符号链接，指向 nativeLibraryDir 里的 lib*.so
                    put("PROOT_TMP_DIR", "${usr.path}/tmp")
                    // App 自己的私有数据（控制台存的网关令牌等）：agent 的命令在 proot 里看不到
                    put("QUETZAL_HIDE_PATHS", listOf("shared_prefs", "app_flutter", "databases", "cache", "code_cache").map { File(data, it).path }.joinToString(":"))
                }
                log("启动运行基座 ${version}")
                val p = pb.start()
                proc = p
                running = true; lastError = null
                val code = p.waitFor()
                running = false
                if (stopping) break
                log("运行基座退出（$code）")
                lastError = "运行基座退出（$code），日志在 ${logFile().path}"
            } catch (e: Exception) {
                running = false
                lastError = e.message ?: e.javaClass.simpleName
                log("出错：$lastError")
            }
            if (stopping || !autostart(this)) break
            if (System.currentTimeMillis() - started > 120_000) backoff = 2_000L
            Thread.sleep(backoff)
            backoff = (backoff * 2).coerceAtMost(60_000L)
        }
        stopSelf()
    }
}

/** 开机自启与升级后自启：装过内置运行基座、守护开关开着，就拉起前台服务（App 升级时系统会停掉它，新版带着新版运行基座，拉起即升级）。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, "android.intent.action.QUICKBOOT_POWERON", Intent.ACTION_MY_PACKAGE_REPLACED)) return
        if (RuntimeService.installed(ctx) && RuntimeService.autostart(ctx) && Rootfs.bundled(ctx)) RuntimeService.start(ctx)
    }
}
