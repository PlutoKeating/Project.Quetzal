package xyz.quetzal.console

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.DisplayMetrics
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

/**
 * 手：Quetzal 的无障碍服务（用户在系统设置 → 无障碍里开启「Quetzal 操作屏幕」后才运行）。
 * 让 agent 看当前界面的节点树、点击、滑动、输入、返回 / 主页 / 最近任务、打开应用、截图（Android 11+）。
 *  - 不监听任何无障碍事件、不记录屏幕内容：只在运行基座经身体接口（BodyServer 的 /v1/hands/…）调用时读一次当前界面。
 *  - 每次调用都先经过运行基座的闸门（「操作屏幕与应用」，缺省每次询问）与审计；急停时闸门直接拒绝。
 *  - 读屏时记住这一次的节点，ref = "<读屏序号>:<下标>"：按编号操作时优先直接对节点做动作（点击、设值），失效了再按坐标做手势。
 */
class HandsService : AccessibilityService() {
    companion object {
        @Volatile var instance: HandsService? = null

        /** 用户有没有在系统设置里开启（开启了但服务还没连上时 instance 为 null）。 */
        fun enabled(ctx: Context): Boolean {
            val me = ComponentName(ctx, HandsService::class.java)
            val list = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return list.split(':').any { ComponentName.unflattenFromString(it) == me }
        }

        fun require(): HandsService = instance ?: throw IllegalStateException(
            "手机上的无障碍服务没有开启：请打开 Quetzal App → 控制 → 权限 →「操作屏幕」，按提示在系统设置的无障碍里开启「Quetzal 操作屏幕」")
    }

    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var seq = 0
    private var nodes: List<AccessibilityNodeInfo> = emptyList()

    override fun onServiceConnected() { instance = this }
    override fun onUnbind(intent: Intent?): Boolean { instance = null; return super.onUnbind(intent) }
    override fun onDestroy() { instance = null; super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    fun status(): JSONObject = JSONObject().put("ok", true).put("connected", true).put("screenshot", Build.VERSION.SDK_INT >= 30).put("sdk", Build.VERSION.SDK_INT)

    private fun screen(): Pair<Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= 30) { val b = wm.maximumWindowMetrics.bounds; return b.width() to b.height() }
        val m = DisplayMetrics()
        @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    // ---------- 读屏
    fun snapshot(limit: Int): JSONObject {
        val root = rootInActiveWindow ?: throw IllegalStateException("读不到当前界面（可能在锁屏，或这个界面不允许读取）")
        val (w, h) = screen()
        val kept = ArrayList<AccessibilityNodeInfo>()
        val out = JSONArray()
        val s = synchronized(lock) { ++seq }
        val stack = ArrayDeque<AccessibilityNodeInfo>().apply { addLast(root) }
        var visited = 0
        val r = Rect()
        while (stack.isNotEmpty() && kept.size < limit && visited < 6000) {
            val n = stack.removeLast(); visited++
            if (!n.isVisibleToUser) continue
            for (i in n.childCount - 1 downTo 0) n.getChild(i)?.let { stack.addLast(it) }
            n.getBoundsInScreen(r)
            if (r.width() <= 0 || r.height() <= 0) continue
            val editable = n.isEditable
            val hint = if (Build.VERSION.SDK_INT >= 26) n.hintText?.toString() else null
            val showingHint = Build.VERSION.SDK_INT >= 26 && n.isShowingHintText
            val text = n.text?.toString()
            val desc = n.contentDescription?.toString()
            val name = if (editable) (hint ?: desc ?: (if (showingHint) text else null)) else (text ?: desc)
            val value = if (editable && !n.isPassword && !showingHint) text else null
            out.put(JSONObject().put("c", n.className?.toString() ?: "").put("n", name?.take(200) ?: "").put("v", value?.take(200) ?: "")
                .put("b", JSONArray(listOf(r.left, r.top, r.width(), r.height()))).put("r", "$s:${kept.size}")
                .put("k", n.isClickable || n.isLongClickable).put("e", editable).put("s", n.isScrollable)
                .put("en", n.isEnabled).put("f", n.isFocused || n.isAccessibilityFocused).put("se", n.isSelected)
                .put("ch", if (n.isCheckable) n.isChecked else JSONObject.NULL))
            kept.add(n)
        }
        synchronized(lock) { if (seq == s) nodes = kept }
        val pkg = root.packageName?.toString()
        val label = pkg?.let { try { packageManager.getApplicationLabel(packageManager.getApplicationInfo(it, 0)).toString() } catch (_: Exception) { null } }
        val title = windows.firstOrNull { it.isActive }?.title?.toString()
        return JSONObject().put("ok", true).put("width", w).put("height", h).put("app", if (label != null && label != pkg) "$label（$pkg）" else pkg ?: "")
            .put("window", title ?: "").put("elements", out)
    }

    /** 按 ref 找回上一次读屏的节点（读屏之后又读过、或节点已经不在了时返回 null）。 */
    private fun node(ref: String?): AccessibilityNodeInfo? {
        if (ref.isNullOrEmpty()) return null
        val p = ref.split(':'); if (p.size != 2) return null
        val n = synchronized(lock) { if (p[0].toIntOrNull() != seq) null else nodes.getOrNull(p[1].toIntOrNull() ?: -1) } ?: return null
        return if (n.refresh() && n.isVisibleToUser) n else null
    }
    private fun up(n: AccessibilityNodeInfo?, test: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        var c = n; var k = 0
        while (c != null && k++ < 8) { if (test(c)) return c; c = c.parent }
        return null
    }

    // ---------- 手势
    private fun gesture(vararg strokes: GestureDescription.StrokeDescription) {
        val g = GestureDescription.Builder().apply { strokes.forEach { addStroke(it) } }.build()
        val latch = CountDownLatch(1)
        var done = false
        main.post {
            val sent = dispatchGesture(g, object : GestureResultCallback() {
                override fun onCompleted(d: GestureDescription?) { done = true; latch.countDown() }
                override fun onCancelled(d: GestureDescription?) { latch.countDown() }
            }, null)
            if (!sent) latch.countDown()
        }
        val total = strokes.maxOf { it.startTime + it.duration }
        if (!latch.await(total + 10_000, TimeUnit.MILLISECONDS) || !done) throw IllegalStateException("系统没有执行这个手势（可能被别的触摸打断了）")
    }
    private fun clampPoint(x: Double, y: Double): Pair<Float, Float> { val (w, h) = screen(); return x.coerceIn(0.0, w - 1.0).toFloat() to y.coerceIn(0.0, h - 1.0).toFloat() }
    private fun dot(x: Double, y: Double, start: Long, dur: Long): GestureDescription.StrokeDescription {
        val (px, py) = clampPoint(x, y)
        return GestureDescription.StrokeDescription(Path().apply { moveTo(px, py) }, start, max(1, dur))
    }
    private fun line(x1: Double, y1: Double, x2: Double, y2: Double, start: Long, dur: Long): GestureDescription.StrokeDescription {
        val (a, b) = clampPoint(x1, y1); val (c, d) = clampPoint(x2, y2)
        return GestureDescription.StrokeDescription(Path().apply { moveTo(a, b); lineTo(c, d) }, start, max(1, dur))
    }

    fun click(a: JSONObject) {
        val count = a.optInt("count", 1).coerceIn(1, 3)
        val long = a.optInt("holdMs", 0) > 0 || a.optString("button") == "right"
        val n = node(a.optString("ref"))
        if (n != null && count == 1) {
            if (long) up(n) { it.isLongClickable }?.let { if (it.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) return }
            else up(n) { it.isClickable }?.let { if (it.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return }
        }
        val x = a.getDouble("x"); val y = a.getDouble("y")
        val hold = if (long) max(a.optLong("holdMs", 0), 700) else 60L
        gesture(*Array(count) { dot(x, y, it * 160L, hold) })
    }

    fun drag(a: JSONObject) = gesture(line(a.getDouble("x1"), a.getDouble("y1"), a.getDouble("x2"), a.getDouble("y2"), 0, a.optLong("ms", 300).coerceIn(50, 10_000)))

    /** 滚动：一格约为屏幕的六分之一，一次滑动最多 0.6 屏，多的分几次滑。手指移动方向与内容相反：看下面的内容（down）手指往上滑。 */
    fun scroll(a: JSONObject) {
        val (w, h) = screen()
        val dir = a.optString("direction", "down")
        val vertical = dir == "up" || dir == "down"
        val span = if (vertical) h else w
        val cx = if (a.has("x")) a.getDouble("x") else w / 2.0
        val cy = if (a.has("y")) a.getDouble("y") else h / 2.0
        var left = a.optInt("amount", 3).coerceIn(1, 20) * span / 6.0
        while (left > 1) {
            val d = min(left, span * 0.6); left -= d
            val sign = if (dir == "down" || dir == "right") -1 else 1 // 手指移动的方向
            val (x1, y1, x2, y2) = if (vertical) listOf(cx, cy - sign * d / 2, cx, cy + sign * d / 2) else listOf(cx - sign * d / 2, cy, cx + sign * d / 2, cy)
            gesture(line(x1, y1, x2, y2, 0, 350))
            if (left > 1) Thread.sleep(250)
        }
    }

    // ---------- 输入
    private fun focusedInput(): AccessibilityNodeInfo? = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

    private fun currentText(n: AccessibilityNodeInfo): String =
        if ((Build.VERSION.SDK_INT >= 26 && n.isShowingHintText) || n.isPassword) "" else n.text?.toString() ?: ""

    private fun setText(n: AccessibilityNodeInfo, text: String, caret: Int): Boolean {
        val ok = n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) })
        if (ok) n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, caret); putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, caret)
        })
        return ok
    }

    /** 在输入框的光标处插入文字（有选中的就替换选中的）；设值不成时经剪贴板粘贴。 */
    fun type(a: JSONObject) {
        val text = a.optString("text")
        var n = node(a.optString("ref"))?.let { up(it) { x -> x.isEditable } }
        if (n == null && a.has("x") && a.has("y")) { click(JSONObject().put("x", a.getDouble("x")).put("y", a.getDouble("y")).put("ref", a.optString("ref"))); Thread.sleep(300); n = focusedInput() }
        if (n == null) n = focusedInput()
        if (n == null || !n.isEditable) throw IllegalStateException("没有正在输入的输入框：先点一下要输入的地方")
        n.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val cur = currentText(n)
        var s = n.textSelectionStart; var e = n.textSelectionEnd
        if (s < 0 || s > cur.length) s = cur.length
        if (e < s || e > cur.length) e = s
        if (setText(n, cur.substring(0, s) + text + cur.substring(e), s + text.length)) return
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val latch = CountDownLatch(1)
        main.post { cm.setPrimaryClip(ClipData.newPlainText("Quetzal", text)); latch.countDown() }
        latch.await(3, TimeUnit.SECONDS)
        if (!n.performAction(AccessibilityNodeInfo.ACTION_PASTE)) throw IllegalStateException("这个输入框不接受输入")
    }

    /** 按键：global 为系统的全局动作；edit 对当前输入框做编辑动作。 */
    fun key(a: JSONObject) {
        val kind = a.optString("kind"); val action = a.optString("action")
        if (kind == "global") {
            val id = when (action) {
                "back" -> GLOBAL_ACTION_BACK; "home" -> GLOBAL_ACTION_HOME; "recents" -> GLOBAL_ACTION_RECENTS
                "notifications" -> GLOBAL_ACTION_NOTIFICATIONS; "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS; "power" -> GLOBAL_ACTION_POWER_DIALOG
                "lock" -> if (Build.VERSION.SDK_INT >= 28) GLOBAL_ACTION_LOCK_SCREEN else throw IllegalStateException("安卓 9 以下不能锁屏")
                else -> throw IllegalArgumentException("没有这个全局动作：$action")
            }
            if (!performGlobalAction(id)) throw IllegalStateException("系统没有执行「$action」")
            return
        }
        val n = focusedInput() ?: throw IllegalStateException("没有正在输入的输入框：先点一下输入框")
        val ok = when (action) {
            "enter" -> if (Build.VERSION.SDK_INT >= 30) n.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) else throw IllegalStateException("安卓 11 以下不能按回车：点一下界面上的发送 / 搜索按钮")
            "copy" -> n.performAction(AccessibilityNodeInfo.ACTION_COPY)
            "cut" -> n.performAction(AccessibilityNodeInfo.ACTION_CUT)
            "paste" -> n.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            "select_all" -> n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0); putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, currentText(n).length) })
            "backspace", "delete" -> {
                val cur = currentText(n)
                var s = n.textSelectionStart; var e = n.textSelectionEnd
                if (s < 0 || s > cur.length) s = cur.length
                if (e < s || e > cur.length) e = s
                if (s == e) { if (action == "backspace") s = max(0, s - 1) else e = min(cur.length, e + 1) }
                setText(n, cur.substring(0, s) + cur.substring(e), s)
            }
            else -> throw IllegalArgumentException("手机上没有这个键：$action")
        }
        if (!ok) throw IllegalStateException("这个输入框不接受「$action」")
    }

    // ---------- 应用与窗口
    /** 打开应用：先当包名，再按启动器里的显示名（完全相同、再包含）找。 */
    fun open(id: String): JSONObject {
        val pm = packageManager
        var pkg = id.takeIf { pm.getLaunchIntentForPackage(it) != null }
        if (pkg == null) {
            val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
                .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            pkg = (apps.firstOrNull { it.second.equals(id, true) } ?: apps.filter { it.second.contains(id, true) }.minByOrNull { it.second.length })?.first
        }
        if (pkg == null) throw IllegalArgumentException("没有找到叫「$id」的应用（只打开装在这台手机上、有图标的应用）")
        val intent = pm.getLaunchIntentForPackage(pkg)!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        startActivity(intent)
        val label = try { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } catch (_: Exception) { pkg }
        return JSONObject().put("ok", true).put("app", label).put("package", pkg)
    }

    fun windowList(): JSONObject {
        val out = JSONArray()
        for (w in windows) {
            val r = Rect(); w.getBoundsInScreen(r)
            val pkg = try { w.root?.packageName?.toString() } catch (_: Exception) { null }
            val title = w.title?.toString()
            out.put(JSONObject().put("id", w.id.toString()).put("title", title ?: pkg ?: "").put("app", pkg ?: "").put("focused", w.isActive)
                .put("x", r.left).put("y", r.top).put("w", r.width()).put("h", r.height()))
        }
        return JSONObject().put("ok", true).put("windows", out)
    }

    // ---------- 截图（Android 11+ 的 AccessibilityService.takeScreenshot；更早的系统不提供）
    fun screenshot(file: File, maxEdge: Int): JSONObject {
        if (Build.VERSION.SDK_INT < 30) throw IllegalStateException("安卓 11 以下不能截图（系统不允许无障碍服务截图），只能读屏幕元素（screen_read）")
        val latch = CountDownLatch(1)
        var err: String? = null
        var size = 0 to 0
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                try {
                    val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace) ?: throw IllegalStateException("截图为空")
                    val bmp = hw.copy(Bitmap.Config.ARGB_8888, false); hw.recycle(); result.hardwareBuffer.close()
                    size = bmp.width to bmp.height
                    val k = if (maxEdge > 0) min(1.0, maxEdge.toDouble() / max(bmp.width, bmp.height)) else 1.0
                    val out = if (k < 1.0) Bitmap.createScaledBitmap(bmp, (bmp.width * k).toInt().coerceAtLeast(1), (bmp.height * k).toInt().coerceAtLeast(1), true) else bmp
                    file.outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                    if (out !== bmp) out.recycle(); bmp.recycle()
                } catch (e: Exception) { err = e.message ?: e.javaClass.simpleName }
                latch.countDown()
            }
            override fun onFailure(code: Int) {
                err = when (code) { ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "截得太快了，稍等一秒再截"; ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "这个界面不允许截图"; else -> "系统没有截图（错误 $code）" }
                latch.countDown()
            }
        })
        if (!latch.await(15, TimeUnit.SECONDS)) throw IllegalStateException("截图超时")
        err?.let { throw IllegalStateException(it) }
        return JSONObject().put("ok", true).put("width", size.first).put("height", size.second)
    }
}
