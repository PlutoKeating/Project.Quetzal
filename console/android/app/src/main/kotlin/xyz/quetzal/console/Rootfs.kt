package xyz.quetzal.console

import android.content.Context
import android.system.Os
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream

/**
 * App 内置的运行环境（只装一个 App）：Node.js、git、openssh、proot 及其依赖，由 tool/android-runtime/ 用 termux-packages
 * 以本 App 的前缀（/data/data/xyz.quetzal.console/files/usr）从源码编译。
 *  - 可执行文件以 lib<名>.so 放在 APK 的 jniLibs 里：安装时系统把它们解压到 nativeLibraryDir，那里是 Android 10+ 唯一允许 App 执行的位置
 *    （数据目录里的文件可以 dlopen，不能 exec）。这里在前缀里为它们建符号链接（执行时按目标文件判断，所以能执行）。
 *  - 其余文件（共享库、git 模板、证书……）打成 assets/runtime-env/rootfs.tar，首次启动（或 App 升级后）解压到 files/。
 *  - assets/runtime-env/manifest.json：{version, exec: {前缀里的路径: jniLibs 里的文件名}}。
 *  - App 升级后 nativeLibraryDir 可能换路径，所以版本号与 nativeLibraryDir 任一变了就重新解压、重建链接（家目录不动）。
 */
object Rootfs {
    private const val ASSET_DIR = "runtime-env"

    fun prefix(ctx: Context) = File(ctx.filesDir, "usr")
    /** 运行基座的家目录（记忆、配置、密钥都在这里）；在前缀之外，重新解压运行环境不会碰它。 */
    fun home(ctx: Context) = File(ctx.filesDir, "home")
    fun quetzalHome(ctx: Context) = File(home(ctx), "quetzal")

    /** 这个 App 里有没有内置运行环境（开发版可能没有）。 */
    fun bundled(ctx: Context): Boolean = try { ctx.assets.open("$ASSET_DIR/manifest.json").close(); true } catch (_: Exception) { false }

    private fun manifest(ctx: Context) = JSONObject(ctx.assets.open("$ASSET_DIR/manifest.json").bufferedReader().use { it.readText() })

    /** 确保运行环境就绪，必要时解压。返回内置运行环境的版本。 */
    @Synchronized
    fun ensure(ctx: Context, log: (String) -> Unit): String {
        val m = manifest(ctx)
        val version = m.getString("version")
        val lib = ctx.applicationInfo.nativeLibraryDir
        val usr = prefix(ctx)
        val stamp = File(usr, ".quetzal-rootfs")
        val want = "$version\n$lib\n"
        if (stamp.isFile && stamp.readText() == want) return version

        log("解压运行环境 $version")
        val staging = File(ctx.filesDir, "usr.staging")
        staging.deleteRecursively()
        staging.mkdirs()
        ctx.assets.open("$ASSET_DIR/rootfs.tar").use { untar(BufferedInputStream(it, 1 shl 16), staging) }
        // 可执行文件：链接到 nativeLibraryDir 里的 lib<名>.so
        val exec = m.getJSONObject("exec")
        for (rel in exec.keys()) {
            val target = File(lib, exec.getString(rel))
            if (!target.isFile) throw IllegalStateException("APK 里缺少 ${target.name}（$rel）")
            val link = File(staging, rel)
            link.parentFile?.mkdirs()
            link.delete()
            Os.symlink(target.absolutePath, link.absolutePath)
        }
        // git 运行钩子、别名与 GIT_SSH_COMMAND 用 $PREFIX/bin/sh：指向系统自带的 sh
        File(staging, "usr/bin/sh").let { if (!it.exists()) { it.parentFile?.mkdirs(); Os.symlink("/system/bin/sh", it.absolutePath) } }
        File(staging, "usr/tmp").mkdirs()
        File(staging, "usr/.quetzal-rootfs").writeText(want)
        // 原子地换掉旧的前缀
        val old = File(ctx.filesDir, "usr.old")
        old.deleteRecursively()
        if (usr.exists() && !usr.renameTo(old)) throw IllegalStateException("无法替换旧的运行环境")
        if (!File(staging, "usr").renameTo(usr)) throw IllegalStateException("无法放入新的运行环境")
        staging.deleteRecursively()
        old.deleteRecursively()
        log("运行环境已就绪")
        return version
    }

    /** 最小的 tar 读取：普通文件、目录、符号链接、硬链接（转成复制）；保留可执行位。路径必须在 dest 之内。 */
    private fun untar(input: InputStream, dest: File) {
        val root = dest.canonicalPath + File.separator
        val header = ByteArray(512)
        var longName: String? = null
        var longLink: String? = null
        fun readFully(buf: ByteArray, n: Int = buf.size) { var off = 0; while (off < n) { val r = input.read(buf, off, n - off); if (r < 0) throw IllegalStateException("tar 提前结束"); off += r } }
        fun str(off: Int, len: Int): String { var end = off; while (end < off + len && header[end] != 0.toByte()) end++; return String(header, off, end - off, Charsets.UTF_8) }
        fun octal(off: Int, len: Int): Long = str(off, len).trim().let { if (it.isEmpty()) 0 else it.toLong(8) }
        fun safe(name: String): File {
            val f = File(dest, name)
            if (!(f.canonicalPath + if (name.endsWith("/")) File.separator else "").let { it.startsWith(root) || it == root }) throw IllegalStateException("tar 里有越界路径：$name")
            return f
        }
        fun skipPad(size: Long) { val pad = ((512 - size % 512) % 512).toInt(); if (pad > 0) readFully(ByteArray(pad)) }
        fun readData(size: Long): ByteArray { val b = ByteArray(size.toInt()); readFully(b); skipPad(size); return b }
        while (true) {
            readFully(header)
            if (header.all { it == 0.toByte() }) break
            val type = header[156].toInt().toChar()
            val size = octal(124, 12)
            val prefix = str(345, 155)
            val name = longName ?: (if (prefix.isNotEmpty()) "$prefix/${str(0, 100)}" else str(0, 100))
            val linkName = longLink ?: str(157, 100)
            longName = null; longLink = null
            when (type) {
                'L' -> { longName = String(readData(size), Charsets.UTF_8).trimEnd('\u0000'); continue }
                'K' -> { longLink = String(readData(size), Charsets.UTF_8).trimEnd('\u0000'); continue }
                '5' -> safe(name).mkdirs()
                '2' -> { val f = safe(name); f.parentFile?.mkdirs(); f.delete(); Os.symlink(linkName, f.path) }
                '1' -> { val f = safe(name); f.parentFile?.mkdirs(); safe(linkName).copyTo(f, overwrite = true); f.setExecutable(safe(linkName).canExecute(), false) }
                '0', '\u0000', '7' -> {
                    val f = safe(name)
                    f.parentFile?.mkdirs()
                    f.outputStream().use { out ->
                        val buf = ByteArray(1 shl 16)
                        var left = size
                        while (left > 0) { val r = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt()); if (r < 0) throw IllegalStateException("tar 提前结束"); out.write(buf, 0, r); left -= r }
                    }
                    skipPad(size)
                    val mode = octal(100, 8).toInt()
                    if (mode and 0b001_001_001 != 0) f.setExecutable(true, false)
                }
                else -> { if (size > 0) readData(size) } // pax 扩展头等：跳过
            }
        }
    }
}
