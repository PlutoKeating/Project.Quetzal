namespace Quetzalcoatl.App.Services;

using System.Runtime.InteropServices;

/// <summary>
/// 系统托盘图标（原生 <c>Shell_NotifyIcon</c>，零第三方依赖）。
/// 创建一个消息专用隐藏窗口接收托盘回调；右键弹出原生 Win32 菜单（显示主窗口 / 退出）。
/// 任何一步失败都返回 <c>IsActive == false</c>，绝不抛异常打断主窗口。
/// </summary>
public sealed class TrayIcon : IDisposable
{
    private const uint WmApp = 0x8000;
    private const uint WmTrayCallback = WmApp + 1;
    private const uint WmCommand = 0x0111;
    private const uint WmNull = 0x0000;
    private const uint NifMessage = 0x00000001;
    private const uint NifIcon = 0x00000002;
    private const uint NifTip = 0x00000004;
    private const uint NimAdd = 0x00000000;
    private const uint NimDelete = 0x00000002;
    private const uint NimSetVersion = 0x00000004;
    private const uint MfString = 0x00000000;
    private const uint TpmReturnCmd = 0x0100;
    private const uint TpmRightButton = 0x0002;
    private const int IdShow = 1001;
    private const int IdQuit = 1002;
    private const int IdiApplication = 32512;
    private const int WmLButtonUp = 0x0202;
    private const int WmRButtonUp = 0x0205;
    private const uint NotifyIconVersion4 = 4;

    private readonly WndProcDelegate _wndProc;
    private readonly string _className;
    private readonly IntPtr _instance;
    private IntPtr _window;
    private readonly Action _onShow;
    private readonly Action _onQuit;
    private bool _disposed;

    private TrayIcon(IntPtr instance, string className, WndProcDelegate wndProc, Action onShow, Action onQuit)
    {
        _instance = instance;
        _className = className;
        _wndProc = wndProc;
        _onShow = onShow;
        _onQuit = onQuit;
    }

    /// <summary>托盘是否成功注册。</summary>
    public bool IsActive { get; private set; }

    /// <summary>创建托盘图标；失败时返回一个非活动实例（调用方无需判空）。</summary>
    public static TrayIcon Create(string tooltip, Action onShow, Action onQuit)
    {
        var className = $"QuetzalcoatlTray_{Environment.ProcessId}";
        var instance = GetModuleHandleW(null);
        try
        {
            // WNDPROC 必须有一位非空接收者：先构造实例，再创建窗口（WM_NCCREATE 会同步回调）。
            TrayIcon? icon = null;
            WndProcDelegate proc = (hWnd, message, wParam, lParam) =>
                icon!.HandleMessage(hWnd, message, wParam, lParam);
            var windowClass = new WndClassEx
            {
                cbSize = (uint)Marshal.SizeOf<WndClassEx>(),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(proc),
                hInstance = instance,
                lpszClassName = className,
            };
            icon = new TrayIcon(instance, className, proc, onShow, onQuit);

            var atom = RegisterClassExW(ref windowClass);
            if (atom == 0 && Marshal.GetLastWin32Error() != ErrorClassAlreadyExists)
            {
                return icon;
            }

            var window = CreateWindowExW(0, className, "Quetzalcoatl Tray", 0, 0, 0, 0, 0, HwndMessage, IntPtr.Zero, instance, IntPtr.Zero);
            if (window == IntPtr.Zero)
            {
                return icon;
            }

            icon._window = window;
            var data = new NotifyIconData
            {
                cbSize = (uint)Marshal.SizeOf<NotifyIconData>(),
                hWnd = window,
                uID = 1,
                uFlags = NifMessage | NifIcon | NifTip,
                uCallbackMessage = WmTrayCallback,
                hIcon = LoadIconW(IntPtr.Zero, new IntPtr(IdiApplication)),
                szTip = tooltip.Length > 120 ? tooltip[..120] : tooltip,
                szInfo = string.Empty,
                szInfoTitle = string.Empty,
            };
            icon.IsActive = ShellNotifyIconW(NimAdd, ref data);

            data.uVersionOrTimeout = NotifyIconVersion4;
            _ = ShellNotifyIconW(NimSetVersion, ref data);
            return icon;
        }
        catch (Exception)
        {
            // 托盘不是主窗口的生存前提：注册失败时静默退化为“关闭即退出”。
            return new TrayIcon(instance, className, (h, m, w, l) => DefWindowProcW(h, m, w, l), onShow, onQuit);
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            var data = new NotifyIconData
            {
                cbSize = (uint)Marshal.SizeOf<NotifyIconData>(),
                hWnd = _window,
                uID = 1,
                szTip = string.Empty,
                szInfo = string.Empty,
                szInfoTitle = string.Empty,
            };
            _ = ShellNotifyIconW(NimDelete, ref data);
            if (_window != IntPtr.Zero)
            {
                _ = DestroyWindow(_window);
                _window = IntPtr.Zero;
            }

            _ = UnregisterClassW(_className, _instance);
        }
        catch (Exception)
        {
            // 退出路径绝不因托盘清理失败而中断。
        }
    }

    private IntPtr HandleMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        switch (message)
        {
            case WmTrayCallback:
                var notification = (int)(lParam.ToInt64() & 0xFFFF);
                if (notification == WmLButtonUp)
                {
                    _onShow();
                    return IntPtr.Zero;
                }

                if (notification == WmRButtonUp)
                {
                    ShowMenu(hWnd);
                    return IntPtr.Zero;
                }

                return IntPtr.Zero;
            case WmCommand:
                var command = (int)(wParam.ToInt64() & 0xFFFF);
                if (command == IdShow)
                {
                    _onShow();
                }
                else if (command == IdQuit)
                {
                    _onQuit();
                }

                return IntPtr.Zero;
            default:
                return DefWindowProcW(hWnd, message, wParam, lParam);
        }
    }

    private void ShowMenu(IntPtr hWnd)
    {
        var menu = CreatePopupMenu();
        if (menu == IntPtr.Zero)
        {
            return;
        }

        try
        {
            _ = AppendMenuW(menu, MfString, (UIntPtr)IdShow, "显示主窗口");
            _ = AppendMenuW(menu, MfString, (UIntPtr)IdQuit, "退出 Quetzalcoatl");
            _ = GetCursorPos(out var point);
            _ = SetForegroundWindow(hWnd);
            var command = (int)TrackPopupMenu(menu, TpmReturnCmd | TpmRightButton, point.X, point.Y, 0, hWnd, IntPtr.Zero);
            if (command == IdShow)
            {
                _onShow();
            }
            else if (command == IdQuit)
            {
                _onQuit();
            }

            _ = PostMessageW(hWnd, WmNull, IntPtr.Zero, IntPtr.Zero);
        }
        finally
        {
            _ = DestroyMenu(menu);
        }
    }

    private const int ErrorClassAlreadyExists = 1410;

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WndClassEx
    {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)]
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szInfo;
        public uint uVersionOrTimeout;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point32
    {
        public int X;
        public int Y;
    }

    private static readonly IntPtr HwndMessage = new(-3);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandleW(string? lpModuleName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassExW(ref WndClassEx windowClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(
        uint exStyle,
        string className,
        string windowName,
        uint style,
        int x,
        int y,
        int width,
        int height,
        IntPtr parent,
        IntPtr menu,
        IntPtr instance,
        IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool UnregisterClassW(string className, IntPtr instance);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProcW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr LoadIconW(IntPtr instance, IntPtr iconName);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "Shell_NotifyIconW")]
    private static extern bool ShellNotifyIconW(uint message, ref NotifyIconData data);

    [DllImport("user32.dll")]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll")]
    private static extern bool DestroyMenu(IntPtr menu);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool AppendMenuW(IntPtr menu, uint flags, UIntPtr item, string? text);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point32 point);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint TrackPopupMenu(IntPtr menu, uint flags, int x, int y, int reserved, IntPtr hWnd, IntPtr rect);

    [DllImport("user32.dll")]
    private static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
