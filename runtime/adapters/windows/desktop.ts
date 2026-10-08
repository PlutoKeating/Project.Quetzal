// Windows 桌面上的身体能力：通知（Toast）、截图、剪贴板、打开网址与文件、播放声音、拍照、录音。
//   都要在用户登录的桌面会话里做（开机自启的运行基座在会话 0，看不到桌面）：运行基座在交互会话里就直接调用这里，
//   在会话 0 就经身体助手（body.ts，由控制台托盘在登录时启动）调用同一份实现。
//   一切靠探测、不装任何东西：PowerShell 5.1 + .NET Framework + WinRT 是 Windows 10 起自带的；拍照还可以退回 ffmpeg。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { PsHost, runOnce, psq } from "./ps.ts";

/** 做不成：抛出错误，经身体助手传回运行基座，那次调用标为失败（只返回一句说明会被当成成功）。 */
const fail = (msg: string): never => { throw new Error(msg); };

export const ps = new PsHost();
const home = () => process.env.QUETZAL_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Quetzal", "home");
export const mediaDir = () => { const d = path.join(home(), "data", "media"); fs.mkdirSync(d, { recursive: true }); return d; };
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const sizeKB = (f: string) => Math.round(fs.statSync(f).size / 1024);
const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Toast 用的应用标识：在 HKCU 登记（未打包的应用要先登记才显示得出来），显示名 Quetzal；登记不了就借 PowerShell 的。 */
export const AUMID = "xyz.quetzal.console";
const POWERSHELL_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

export async function notify(title: string, text: string): Promise<void> {
  const icon = path.join(path.dirname(home()), "console", "quetzal.ico");
  const toast = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(text)}</text></binding></visual></toast>`;
  await ps.run(`
$id = ${psq(AUMID)}
try {
  $k = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $id
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
  New-ItemProperty -Path $k -Name DisplayName -Value 'Quetzal' -PropertyType String -Force | Out-Null
  if (Test-Path ${psq(icon)}) { New-ItemProperty -Path $k -Name IconUri -Value ${psq(icon)} -PropertyType String -Force | Out-Null }
} catch { $id = ${psq(POWERSHELL_AUMID)} }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml(${psq(toast)})
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`);
}

export async function screenshot(): Promise<string> {
  const f = path.join(mediaDir(), `screen-${stamp()}.png`);
  await ps.run(`
if (-not ('QuetzalDpi' -as [type])) { Add-Type -Name QuetzalDpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' }
[QuetzalDpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save(${psq(f)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`, 30_000);
  return fs.existsSync(f) ? `已截图：${f}（${sizeKB(f)} KB）` : fail("截图失败");
}

export async function clipboard(text?: string): Promise<string> {
  if (text != null) { await ps.run(`Set-Clipboard -Value ${psq(text)}`); return "已写入剪贴板"; }
  const out = await ps.run("Get-Clipboard -Raw");
  return out || "（剪贴板为空）";
}

// 打开：只接受网址（http / https / mailto）与普通文档、图片、音视频文件和文件夹；可执行的东西（.exe、.bat、.ps1、.lnk、.msi …）不打开——
// 那等于在沙箱外运行程序。她的命令本来就在沙箱里，这个工具不能成为出口
const OPENABLE = new Set([".txt", ".md", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".mov", ".mkv", ".webm",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".csv", ".json", ".log", ".epub", ".rtf"]);
export function openable(target: string): string | undefined {
  if (/^(https?|mailto):/i.test(target)) return undefined;
  if (/^[a-z][a-z0-9+.-]+:/i.test(target)) return "只能打开网址（http、https、mailto）或本地的文档、图片、音视频文件与文件夹";
  let st: fs.Stats;
  try { st = fs.statSync(target); } catch { return `找不到：${target}`; }
  if (st.isDirectory()) return undefined;
  return OPENABLE.has(path.extname(target).toLowerCase()) ? undefined : "不打开可执行的文件（程序、脚本、快捷方式、安装包）：那等于在沙箱外运行它";
}
export async function open(target: string): Promise<string> {
  const bad = openable(target);
  if (bad) return fail(bad);
  await ps.run(`Start-Process -FilePath ${psq(target)}`);
  return `已打开：${target}`;
}

/** 播放音频（语音合成的 MP3 等）：WPF 的 MediaPlayer，后台播放、立即返回。 */
export async function playAudio(file: string): Promise<void> {
  await ps.run(`
Add-Type -AssemblyName PresentationCore
if ($global:quetzalPlayer) { $global:quetzalPlayer.Stop(); $global:quetzalPlayer.Close() }
$global:quetzalPlayer = New-Object System.Windows.Media.MediaPlayer
$global:quetzalPlayer.Open([Uri]${psq(file)})
$global:quetzalPlayer.Play()
`);
}
export async function stopAudio(): Promise<void> {
  await ps.run("if ($global:quetzalPlayer) { $global:quetzalPlayer.Stop(); $global:quetzalPlayer.Close(); $global:quetzalPlayer = $null }").catch(() => {});
}

/** 拍照：先用 WinRT 的 MediaCapture（系统自带，受「设置 → 隐私 → 相机」控制），不行再试 ffmpeg 的 dshow。 */
export async function camera(): Promise<string> {
  const dir = mediaDir(), name = `photo-${stamp()}.jpg`, f = path.join(dir, name);
  const r = await runOnce(`
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$m = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asOp = ($m | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$asAct = ($m | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$t) { $task = $asOp.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
function AwaitAction($op) { $task = $asAct.Invoke($null, @($op)); $task.Wait(-1) | Out-Null }
[Windows.Media.Capture.MediaCapture, Windows.Media.Capture, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.MediaProperties.ImageEncodingProperties, Windows.Media.MediaProperties, ContentType = WindowsRuntime] | Out-Null
$mc = [Windows.Media.Capture.MediaCapture]::new()
$s = [Windows.Media.Capture.MediaCaptureInitializationSettings]::new()
$s.StreamingCaptureMode = [Windows.Media.Capture.StreamingCaptureMode]::Video
AwaitAction ($mc.InitializeAsync($s))
$folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync(${psq(dir)})) ([Windows.Storage.StorageFolder])
$file = Await ($folder.CreateFileAsync(${psq(name)}, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
AwaitAction ($mc.CapturePhotoToStorageFileAsync([Windows.Media.MediaProperties.ImageEncodingProperties]::CreateJpeg(), $file))
$mc.Dispose()
`, 60_000);
  if (fs.existsSync(f) && fs.statSync(f).size > 0) return `已拍摄：${f}（${sizeKB(f)} KB）`;
  const dev = await ffmpegCamera();
  if (dev) {
    const ok = await new Promise<boolean>((resolve) => execFile("ffmpeg", ["-y", "-loglevel", "error", "-f", "dshow", "-i", `video=${dev}`, "-frames:v", "1", f], { timeout: 30_000, windowsHide: true }, (e) => resolve(!e)));
    if (ok && fs.existsSync(f)) return `已拍摄：${f}（${sizeKB(f)} KB）`;
  }
  return fail(`拍照失败：${r.out.trim().split("\n").pop()?.slice(0, 200) || "没有摄像头，或「设置 → 隐私和安全性 → 相机」里没有允许桌面应用使用相机"}`);
}
function ffmpegCamera(): Promise<string | undefined> {
  return new Promise((resolve) => execFile("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { timeout: 15_000, windowsHide: true }, (_e, out, err) => {
    const m = String(err || out).match(/"([^"]+)"\s*\(video\)/);
    resolve(m?.[1]);
  }));
}

/** 录音：winmm 的 MCI（系统自带，16 kHz 单声道 WAV），受「设置 → 隐私 → 麦克风」控制。 */
export async function record(seconds: number): Promise<string> {
  const s = Math.max(1, Math.min(120, Math.round(seconds)));
  const f = path.join(mediaDir(), `audio-${stamp()}.wav`);
  const r = await runOnce(`
Add-Type -Name QuetzalMci -MemberDefinition '[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string c, System.Text.StringBuilder r, int l, IntPtr h);'
function Mci($c) { $e = [QuetzalMci]::mciSendString($c, $null, 0, [IntPtr]::Zero); if ($e -ne 0) { throw "MCI 错误 $e：$c" } }
Mci 'open new type waveaudio alias qrec'
try {
  Mci 'set qrec bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2'
  Mci 'record qrec'
  Start-Sleep -Seconds ${s}
  Mci 'stop qrec'
  Mci ('save qrec "' + ${psq(f)} + '"')
} finally { [QuetzalMci]::mciSendString('close qrec', $null, 0, [IntPtr]::Zero) | Out-Null }
`, (s + 30) * 1000);
  return fs.existsSync(f) && fs.statSync(f).size > 44 ? `已录制 ${s} 秒：${f}` : fail(`录音失败：${r.out.trim().split("\n").pop()?.slice(0, 200) || "没有麦克风，或「设置 → 隐私和安全性 → 麦克风」里没有允许桌面应用使用麦克风"}`);
}

/** 身体助手与适配器共用的操作表（body.ts 的 POST /call 按 op 分派到这里）。 */
export const ops: Record<string, (a: Record<string, any>) => Promise<unknown>> = {
  notify: (a) => notify(String(a.title ?? ""), String(a.text ?? "")),
  screenshot: () => screenshot(),
  "clipboard.get": () => clipboard(),
  "clipboard.set": (a) => clipboard(String(a.text ?? "")),
  open: (a) => open(String(a.target ?? "")),
  playAudio: (a) => playAudio(String(a.file ?? "")),
  stopAudio: () => stopAudio(),
  camera: () => camera(),
  record: (a) => record(Number(a.seconds) || 5),
};
