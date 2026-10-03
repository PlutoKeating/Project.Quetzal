package xyz.windler.console

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.konovalov.vad.webrtc.VadWebRTC
import com.konovalov.vad.webrtc.config.FrameSize
import com.konovalov.vad.webrtc.config.Mode
import com.konovalov.vad.webrtc.config.SampleRate
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue

/**
 * 耳朵：常驻的麦克风前台服务。
 *  - 采集：AudioRecord，VOICE_RECOGNITION 音源（系统为语音识别调好的降噪链），16 kHz 单声道 16 位；有的话再挂系统的 NoiseSuppressor 与 AutomaticGainControl。
 *  - 断句：WebRTC VAD（android-vad，MIT）逐 20ms 帧判断有没有人声，自带起止迟滞；这里加前置缓冲（说话前 300ms）、最短时长与最长时长。
 *  - 投递：一句话开始就打开到运行基座网关 /hear?stream=1 的分块 POST，边采集边送 PCM（不经过 Flutter，App 退到后台也照常）；
 *    基座用流式识别，中间结果经网关推送给控制台显示，说完后由基座交给 agent 判断。
 *  - 事件：说话开始 / 结束、基座返回的识别结果、错误，经 MainActivity 的 EventChannel 给 Flutter（只用于界面提示，不影响投递）。
 * Android 9 起后台应用拿不到麦克风，所以必须是前台服务（Android 10+ 声明 microphone 类型；Android 14+ 还要 FOREGROUND_SERVICE_MICROPHONE 权限）。
 */
class HearingService : Service() {
    companion object {
        const val CHANNEL_ID = "windler_hearing"
        const val NOTIFICATION_ID = 7788
        private const val RATE = 16000
        private const val FRAME = 320 // 20ms
        private const val PREROLL_FRAMES = 15 // 说话前保留 300ms
        private const val MAX_MS = 30_000 // 超过就先切一段送出去，再开新的一句
        private val END = ByteArray(0) // 队列里的结束标记

        @Volatile var running = false
            private set
        @Volatile var listener: ((String, Map<String, Any?>) -> Unit)? = null
        private val main = Handler(Looper.getMainLooper())
        private fun emit(kind: String, data: Map<String, Any?> = emptyMap()) { val l = listener ?: return; main.post { l(kind, data) } }

        fun start(ctx: Context, base: String, token: String, sensitivity: Int) {
            val i = Intent(ctx, HearingService::class.java).putExtra("base", base).putExtra("token", token).putExtra("sensitivity", sensitivity)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, HearingService::class.java)) }
    }

    private var thread: Thread? = null
    private val poster = Executors.newSingleThreadExecutor()
    @Volatile private var base = ""
    @Volatile private var token = ""
    @Volatile private var sensitivity = 2

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) { stopSelf(); return START_NOT_STICKY }
        base = intent.getStringExtra("base") ?: base
        token = intent.getStringExtra("token") ?: token
        sensitivity = intent.getIntExtra("sensitivity", sensitivity)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            emit("error", mapOf("message" to "没有麦克风权限")); stopSelf(); return START_NOT_STICKY
        }
        startForegroundCompat()
        if (thread == null) {
            running = true
            thread = Thread({ loop() }, "windler-hearing").also { it.start() }
            emit("state", mapOf("running" to true))
        } else {
            restartRequested = true // 参数变了：让采集线程重建 VAD
        }
        return START_REDELIVER_INTENT
    }

    @Volatile private var restartRequested = false

    override fun onDestroy() {
        running = false
        thread?.interrupt(); thread = null
        poster.shutdown()
        emit("state", mapOf("running" to false))
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "听觉", NotificationManager.IMPORTANCE_LOW).apply { description = "Windler 正在用麦克风听"; setShowBadge(false) })
        }
        val open = android.app.PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), android.app.PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(this))
            .setContentTitle("Windler 在听").setContentText("听到有人说话会转给她；在 App 的「听觉」里关闭")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now).setOngoing(true).setContentIntent(open).build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) else startForeground(NOTIFICATION_ID, n)
    }

    /** 灵敏度 → VAD 模式：1 只认清晰的人声，3 轻声也算。 */
    private fun mode(): Mode = when (sensitivity) { 1 -> Mode.VERY_AGGRESSIVE; 3 -> Mode.NORMAL; else -> Mode.AGGRESSIVE }

    private fun loop() {
        while (running) {
            try { capture() } catch (e: InterruptedException) { return } catch (e: Exception) {
                emit("error", mapOf("message" to (e.message ?: e.toString())))
                try { Thread.sleep(5000) } catch (_: InterruptedException) { return } // 麦克风被占用等：稍后重试
            }
        }
    }

    private fun capture() {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, FRAME * 2 * 8))
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); throw IllegalStateException("麦克风初始化失败（可能被别的应用占用）") }
        val ns = if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true } else null
        val agc = if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(rec.audioSessionId)?.apply { enabled = true } else null
        val vad = VadWebRTC(sampleRate = SampleRate.SAMPLE_RATE_16K, frameSize = FrameSize.FRAME_SIZE_320, mode = mode(), speechDurationMs = 100, silenceDurationMs = 800)
        restartRequested = false
        rec.startRecording()
        emit("mic", mapOf("noiseSuppressor" to (ns != null), "agc" to (agc != null), "mode" to mode().name))
        try {
            val frame = ShortArray(FRAME)
            val preroll = ArrayDeque<ShortArray>(PREROLL_FRAMES)
            var utter: LinkedBlockingQueue<ByteArray>? = null // 进行中的一句话：采集线程往里放帧，上传线程边取边送
            var frames = 0
            fun flush(reason: String) {
                val u = utter ?: return
                utter = null
                emit("speech", mapOf("on" to false, "ms" to frames * 20, "reason" to reason))
                u.put(END)
            }
            while (running && !restartRequested && !Thread.currentThread().isInterrupted) {
                var got = 0
                while (got < FRAME) { val n = rec.read(frame, got, FRAME - got); if (n <= 0) throw IllegalStateException("麦克风读取失败（$n）"); got += n }
                val speech = vad.isSpeech(frame)
                if (speech) {
                    if (utter == null) {
                        val q = LinkedBlockingQueue<ByteArray>(); utter = q; frames = 0
                        val startedAt = System.currentTimeMillis() - PREROLL_FRAMES * 20L
                        for (p in preroll) { q.put(pcm(p)); frames++ }
                        stream(q, startedAt)
                        emit("speech", mapOf("on" to true))
                    }
                    utter!!.put(pcm(frame)); frames++
                    if (frames * 20 >= MAX_MS) { flush("too-long"); preroll.clear() }
                } else {
                    if (utter != null) flush("silence")
                    if (preroll.size == PREROLL_FRAMES) preroll.removeFirst()
                    preroll.addLast(frame.copyOf())
                }
            }
            if (utter != null) flush("stop")
        } finally {
            try { rec.stop() } catch (_: Exception) {}
            rec.release(); ns?.release(); agc?.release(); vad.close()
        }
    }

    private fun pcm(s: ShortArray): ByteArray { val b = ByteBuffer.allocate(s.size * 2).order(ByteOrder.LITTLE_ENDIAN); b.asShortBuffer().put(s); return b.array() }

    /** 边说边送：POST /hear?stream=1&started=<开始时刻>，分块传输，每 20ms 一帧；说完（END）关闭请求体，等基座识别完返回。失败只记事件，不重试。 */
    private fun stream(q: LinkedBlockingQueue<ByteArray>, startedAt: Long) {
        if (poster.isShutdown) return
        poster.execute {
            var sent = 0
            try {
                val url = URL("$base/hear?stream=1&token=${URLEncoder.encode(token, "UTF-8")}&started=$startedAt")
                val c = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"; doOutput = true; connectTimeout = 4000; readTimeout = 60_000
                    setChunkedStreamingMode(FRAME * 2)
                    setRequestProperty("Content-Type", "application/octet-stream")
                }
                c.outputStream.use { out ->
                    while (true) { val b = q.take(); if (b === END) break; out.write(b); sent += b.size }
                    out.flush()
                }
                val code = c.responseCode
                val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
                c.disconnect()
                val text = Regex("\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(body)?.groupValues?.get(1)?.let { unescape(it) } ?: ""
                val dropped = Regex("\"dropped\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(body)?.groupValues?.get(1)?.let { unescape(it) }
                if (code >= 400) emit("error", mapOf("message" to "基座拒绝了这句话（HTTP $code）"))
                else emit("heard", mapOf("text" to text, "dropped" to dropped, "ms" to sent / 32))
            } catch (e: Exception) {
                while (q.poll() != null) { /* 丢掉没送出去的帧 */ }
                emit("error", mapOf("message" to "送到基座失败：${e.message}"))
            }
        }
    }

    private fun unescape(s: String): String {
        val sb = StringBuilder(); var i = 0
        while (i < s.length) {
            val ch = s[i]
            if (ch == '\\' && i + 1 < s.length) {
                when (val n = s[i + 1]) {
                    'u' -> { if (i + 5 < s.length) { sb.append(s.substring(i + 2, i + 6).toInt(16).toChar()); i += 6; continue } }
                    'n' -> sb.append('\n'); 't' -> sb.append('\t'); else -> sb.append(n)
                }
                i += 2
            } else { sb.append(ch); i++ }
        }
        return sb.toString()
    }
}
