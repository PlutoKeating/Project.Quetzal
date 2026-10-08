package xyz.quetzal.console

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.ImageReader
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * 身体接口：App 把手机的身体能力（电池、传感器、通知、相机、麦克风、定位、振动、手电、剪贴板、播放音频）提供给 App 内置的运行基座。
 *  - 只监听 127.0.0.1 的随机端口；每次启动生成 256 位随机令牌，与端口一起写进 QUETZAL_HOME/secrets/body.json（0600）。
 *    运行基座的安卓适配器（runtime/adapters/android/）读它；agent 的命令在 proot 沙箱里看不到密钥目录，绕不过闸门直接调用身体。
 *  - 极简 HTTP/1.1：一个请求一个连接（Connection: close），请求体 JSON，最大 64 KiB；令牌定长比较。
 *  - 路径只能落在 QUETZAL_HOME 之内（拍照、录音的输出与播放的输入），防止被当成任意文件读写的跳板。
 */
class BodyServer(private val ctx: Context, private val quetzalHome: File) {
    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    private val token = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null

    fun start() {
        val s = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        server = s
        val secrets = File(quetzalHome, "secrets").apply { mkdirs(); setReadable(false, false); setReadable(true, true); setExecutable(false, false); setExecutable(true, true) }
        val f = File(secrets, "body.json")
        val tmp = File(secrets, "body.json.tmp")
        tmp.writeText(JSONObject().put("port", s.localPort).put("token", token).toString())
        tmp.setReadable(false, false); tmp.setReadable(true, true)
        tmp.renameTo(f)
        pool.execute {
            while (!s.isClosed) {
                val c = try { s.accept() } catch (_: Exception) { break }
                pool.execute { handle(c) }
            }
        }
    }

    fun stop() { try { server?.close() } catch (_: Exception) {}; main.post { player?.release(); player = null } }

    private fun handle(c: Socket) = c.use { sock ->
        sock.soTimeout = 120_000
        val input = sock.getInputStream().buffered()
        fun line(): String { val b = StringBuilder(); while (true) { val ch = input.read(); if (ch < 0 || ch == '\n'.code) break; if (ch != '\r'.code) b.append(ch.toChar()); if (b.length > 8192) break }; return b.toString() }
        val req = line().split(" ")
        val headers = HashMap<String, String>()
        while (true) { val l = line(); if (l.isEmpty()) break; val i = l.indexOf(':'); if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim() }
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        val (status, out) = if (req.size < 2 || len > 65536) 400 to err("请求不对")
        else if (!same(headers["authorization"]?.removePrefix("Bearer ")?.trim(), token)) 401 to err("令牌不对")
        else {
            val body = ByteArray(len); var off = 0; while (off < len) { val r = input.read(body, off, len - off); if (r < 0) break; off += r }
            val json = if (len > 0) try { JSONObject(String(body, Charsets.UTF_8)) } catch (_: Exception) { JSONObject() } else JSONObject()
            try { route(req[0], req[1], json) } catch (e: Exception) { 500 to err(e.message ?: e.javaClass.simpleName) }
        }
        val bytes = out.toString().toByteArray(Charsets.UTF_8)
        val o = sock.getOutputStream()
        o.write("HTTP/1.1 $status ${if (status == 200) "OK" else "Error"}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        o.write(bytes); o.flush()
    }

    private fun same(a: String?, b: String): Boolean = a != null && MessageDigest.isEqual(a.toByteArray(), b.toByteArray())
    private fun err(msg: String) = JSONObject().put("ok", false).put("error", msg)
    private fun ok() = JSONObject().put("ok", true)
    private fun granted(p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
    /** 只接受 QUETZAL_HOME 之内的路径。 */
    private fun inside(path: String): File {
        val f = File(path).canonicalFile
        if (!f.path.startsWith(quetzalHome.canonicalPath + File.separator)) throw IllegalArgumentException("路径必须在运行基座的家目录里")
        return f
    }

    private fun route(method: String, path: String, a: JSONObject): Pair<Int, JSONObject> = when ("$method $path") {
        "GET /v1/info" -> 200 to info()
        "GET /v1/device-id" -> 200 to JSONObject().put("ok", true).put("id", deviceId())
        "GET /v1/sample" -> 200 to sample()
        "GET /v1/sensors" -> 200 to JSONObject().put("ok", true).put("sensors", JSONArray(sensors().getSensorList(Sensor.TYPE_ALL).map { it.name }))
        "POST /v1/sensor" -> 200 to JSONObject().put("ok", true).put("values", JSONArray(readSensor(sensors().getSensorList(Sensor.TYPE_ALL).firstOrNull { it.name == a.optString("name") } ?: throw IllegalArgumentException("没有这个传感器"), 3000)?.map { it.toDouble() } ?: throw IllegalStateException("没有读到数值")))
        "POST /v1/notify" -> { notify(a.optString("title"), a.optString("text")); 200 to ok() }
        "POST /v1/play" -> { play(inside(a.getString("file"))); 200 to ok() }
        "POST /v1/stop" -> { main.post { player?.release(); player = null }; 200 to ok() }
        "POST /v1/vibrate" -> { vibrate(a.optLong("ms", 500).coerceIn(1, 3000)); 200 to ok() }
        "POST /v1/torch" -> { torch(a.optBoolean("on")); 200 to ok() }
        "POST /v1/clipboard" -> 200 to clipboard(if (a.has("text")) a.getString("text") else null)
        "POST /v1/location" -> 200 to location()
        "POST /v1/photo" -> { photo(a.optInt("camera", 0), inside(a.getString("file"))); 200 to ok() }
        "POST /v1/record" -> { record(a.optInt("seconds", 5).coerceIn(1, 120), inside(a.getString("file"))); 200 to ok() }
        "GET /v1/supervision" -> 200 to JSONObject().put("ok", true).put("enabled", RuntimeService.autostart(ctx))
        "POST /v1/supervision" -> { RuntimeService.setAutostart(ctx, a.optBoolean("enabled", true)); 200 to ok() }
        else -> 404 to err("没有这个接口")
    }

    // ---------- 采样
    private fun sensors() = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private fun info(): JSONObject {
        val sm = sensors()
        return JSONObject().put("ok", true).put("model", Build.MODEL)
            .put("sensors", JSONObject().put("light", sm.getDefaultSensor(Sensor.TYPE_LIGHT)?.name).put("accel", sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.name))
            .put("camera", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY))
            .put("torch", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH))
    }

    /**
     * 设备标识：Settings.Secure.ANDROID_ID（Android 8 起按签名密钥与用户区分；恢复出厂设置、换签名会变）。
     * 运行基座只用它的哈希派生身体 uuid（runtime/src/body/uuid.ts），原始值不记日志、不出这台手机。
     */
    @SuppressLint("HardwareIds")
    private fun deviceId(): String? = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)

    /** 读一次传感器：注册监听，等第一个读数（最多 timeoutMs）。 */
    private fun readSensor(s: Sensor, timeoutMs: Long): FloatArray? {
        val sm = sensors()
        var v: FloatArray? = null
        val latch = CountDownLatch(1)
        val t = HandlerThread("sensor").apply { start() }
        val l = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) { if (v == null) { v = e.values.clone(); latch.countDown() } }
            override fun onAccuracyChanged(s: Sensor?, a: Int) {}
        }
        sm.registerListener(l, s, SensorManager.SENSOR_DELAY_NORMAL, Handler(t.looper))
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        sm.unregisterListener(l)
        t.quitSafely()
        return v
    }

    private fun sample(): JSONObject {
        val o = JSONObject().put("ok", true)
        ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.let { b ->
            val level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1); val scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            val status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            val health = when (b.getIntExtra(BatteryManager.EXTRA_HEALTH, 0)) { BatteryManager.BATTERY_HEALTH_GOOD -> "GOOD"; BatteryManager.BATTERY_HEALTH_OVERHEAT -> "OVERHEAT"; BatteryManager.BATTERY_HEALTH_DEAD -> "DEAD"; BatteryManager.BATTERY_HEALTH_COLD -> "COLD"; else -> "UNKNOWN" }
            val plugged = when (b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)) { BatteryManager.BATTERY_PLUGGED_AC -> "AC"; BatteryManager.BATTERY_PLUGGED_USB -> "USB"; BatteryManager.BATTERY_PLUGGED_WIRELESS -> "WIRELESS"; else -> "UNPLUGGED" }
            if (level >= 0) o.put("battery", JSONObject().put("level", level * 100 / scale)
                .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
                .put("tempC", b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0).put("health", health))
            o.put("plugged", plugged)
        }
        val sm = sensors()
        sm.getDefaultSensor(Sensor.TYPE_LIGHT)?.let { s -> readSensor(s, 2000)?.let { o.put("lux", Math.round(it[0])) } }
        sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let { s -> readSensor(s, 2000)?.let { v -> o.put("motion", Math.round(abs(sqrt((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).toDouble()) - 9.81) * 100) / 100.0) } }
        o.put("screenOn", (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive)
        return o
    }

    // ---------- 表达
    private fun notify(title: String, text: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel("quetzal_say", "她说的话", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, "quetzal_say") else Notification.Builder(ctx).setPriority(Notification.PRIORITY_HIGH)
        nm.notify(7791, b.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(text).setStyle(Notification.BigTextStyle().bigText(text)).setContentIntent(open).setAutoCancel(true).build())
    }

    private fun play(f: File) {
        if (!f.isFile) throw IllegalArgumentException("没有这个文件")
        val done = CountDownLatch(1); var error: String? = null
        main.post {
            try { player?.release(); player = MediaPlayer().apply { setDataSource(f.path); setOnCompletionListener { it.release(); if (player === it) player = null }; prepare(); start() } }
            catch (e: Exception) { error = e.message }
            done.countDown()
        }
        done.await(10, TimeUnit.SECONDS)
        error?.let { throw IllegalStateException("播放失败：$it") }
    }

    private fun vibrate(ms: Long) {
        val v = ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        @Suppress("DEPRECATION")
        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)) else v.vibrate(ms)
    }

    private fun torch(on: Boolean) {
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true } ?: throw IllegalStateException("没有闪光灯")
        cm.setTorchMode(id, on)
    }

    private fun clipboard(text: String?): JSONObject {
        val latch = CountDownLatch(1); var got: String? = null
        main.post {
            val cb = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            if (text != null) cb.setPrimaryClip(ClipData.newPlainText("quetzal", text)) else got = cb.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(ctx)?.toString()
            latch.countDown()
        }
        latch.await(5, TimeUnit.SECONDS)
        return ok().put("text", got ?: "")
    }

    // ---------- 动作（相机、麦克风、定位需要用户授权；没有授权时报错，由她请你在 App 里允许）
    @SuppressLint("MissingPermission")
    private fun location(): JSONObject {
        if (!granted(Manifest.permission.ACCESS_COARSE_LOCATION)) throw SecurityException("没有定位权限：请在 Quetzal App 里允许定位")
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        // 只有粗略定位权限时只能用网络定位；用户给了精确定位才加上 GPS
        val providers = (listOf(LocationManager.NETWORK_PROVIDER) + if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) listOf(LocationManager.GPS_PROVIDER) else emptyList()).filter { lm.isProviderEnabled(it) }
        if (providers.isEmpty()) throw IllegalStateException("系统的定位服务关着（或网络定位不可用）")
        val last = (providers + LocationManager.PASSIVE_PROVIDER).mapNotNull { try { lm.getLastKnownLocation(it) } catch (_: Exception) { null } }.maxByOrNull { it.time }
        last?.takeIf { System.currentTimeMillis() - it.time < 120_000 }?.let { return loc(it) }
        var got: Location? = null
        val latch = CountDownLatch(1)
        val t = HandlerThread("location").apply { start() }
        val l = object : LocationListener {
            override fun onLocationChanged(x: Location) { if (got == null) { got = x; latch.countDown() } }
            @Deprecated("") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
            override fun onProviderEnabled(p: String) {}
            override fun onProviderDisabled(p: String) {}
        }
        @Suppress("DEPRECATION")
        for (p in providers) lm.requestSingleUpdate(p, l, t.looper)
        latch.await(60, TimeUnit.SECONDS)
        lm.removeUpdates(l); t.quitSafely()
        // 定不到新位置（室内 GPS 搜不到星、没有网络定位服务）：退回最近一次的已知位置，并说明是多久以前的
        return loc(got ?: last ?: throw IllegalStateException("60 秒内没有定到位置，也没有最近的已知位置"))
    }
    private fun loc(l: Location) = ok().put("latitude", l.latitude).put("longitude", l.longitude).put("accuracy", l.accuracy.toDouble())
        .put("ageMinutes", ((System.currentTimeMillis() - l.time) / 60_000).coerceAtLeast(0))

    private fun record(seconds: Int, f: File) {
        if (!granted(Manifest.permission.RECORD_AUDIO)) throw SecurityException("没有麦克风权限：请在 Quetzal App 里允许麦克风")
        f.parentFile?.mkdirs()
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(ctx) else MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioSamplingRate(44100); r.setAudioEncodingBitRate(96_000)
            r.setOutputFile(f.path)
            r.prepare(); r.start()
            Thread.sleep(seconds * 1000L)
            r.stop()
        } finally { r.release() }
    }

    /** 无预览拍照：Camera2，先在一个看不见的 SurfaceTexture 上预览 1 秒让自动曝光与对焦收敛，再拍一张 JPEG。 */
    @SuppressLint("MissingPermission")
    private fun photo(facing: Int, f: File) {
        if (!granted(Manifest.permission.CAMERA)) throw SecurityException("没有相机权限：请在 Quetzal App 里允许相机")
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val want = if (facing == 1) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == want } ?: cm.cameraIdList.firstOrNull() ?: throw IllegalStateException("没有相机")
        val sizes = cm.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)!!.getOutputSizes(ImageFormat.JPEG)
        val size = sizes.filter { it.width * it.height <= 3_200_000 }.maxByOrNull { it.width * it.height } ?: sizes.minByOrNull { it.width * it.height }!!
        val t = HandlerThread("camera").apply { start() }
        val h = Handler(t.looper)
        val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)
        val tex = SurfaceTexture(0).apply { setDefaultBufferSize(640, 480) }
        val preview = Surface(tex)
        val done = CountDownLatch(1)
        var error: String? = null
        var device: CameraDevice? = null
        reader.setOnImageAvailableListener({ r ->
            r.acquireLatestImage()?.use { img -> val buf = img.planes[0].buffer; val bytes = ByteArray(buf.remaining()); buf.get(bytes); f.parentFile?.mkdirs(); f.writeBytes(bytes) }
            done.countDown()
        }, h)
        try {
            cm.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(d: CameraDevice) {
                    device = d
                    @Suppress("DEPRECATION")
                    d.createCaptureSession(listOf(preview, reader.surface), object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(s: CameraCaptureSession) {
                            val p = d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply { addTarget(preview); set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO) }
                            s.setRepeatingRequest(p.build(), null, h)
                            h.postDelayed({
                                try {
                                    val c = d.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply { addTarget(reader.surface); set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO); set(CaptureRequest.JPEG_QUALITY, 90.toByte()) }
                                    s.capture(c.build(), null, h)
                                } catch (e: Exception) { error = e.message; done.countDown() }
                            }, 1200)
                        }
                        override fun onConfigureFailed(s: CameraCaptureSession) { error = "相机会话配置失败"; done.countDown() }
                    }, h)
                }
                override fun onDisconnected(d: CameraDevice) { error = "相机断开"; done.countDown() }
                override fun onError(d: CameraDevice, e: Int) { error = "相机错误 $e（可能被别的应用占用，或系统不允许后台用相机）"; done.countDown() }
            }, h)
            if (!done.await(20, TimeUnit.SECONDS)) error = error ?: "拍照超时"
        } finally {
            try { device?.close() } catch (_: Exception) {}
            reader.close(); preview.release(); tex.release(); t.quitSafely()
        }
        error?.let { throw IllegalStateException(it) }
        if (!f.isFile) throw IllegalStateException("没有得到照片")
    }
}
