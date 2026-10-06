#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include <algorithm>
#include <string>
#include <vector>

#include "flutter_window.h"
#include "single_instance.h"
#include "utils.h"

namespace {

bool HasArg(const std::vector<std::string>& args, const char* name) {
  return std::find(args.begin(), args.end(), name) != args.end();
}

// 找到已经在运行的那个控制台的窗口（它可能刚启动、窗口还没建好：最多等 wait_ms）。
HWND FindRunning(DWORD wait_ms) {
  const ULONGLONG until = ::GetTickCount64() + wait_ms;
  for (;;) {
    HWND h = ::FindWindowW(single_instance::kWindowClassName, nullptr);
    if (h != nullptr || ::GetTickCount64() >= until) return h;
    ::Sleep(100);
  }
}

}  // namespace

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();
  const bool background = HasArg(command_line_arguments, "--background");
  const bool replace = HasArg(command_line_arguments, "--replace");

  // 单实例：互斥量由主线程持有到进程结束（结束时被系统释放，--replace 的新进程这时才接管）
  HANDLE mutex = ::CreateMutexW(nullptr, TRUE, single_instance::kMutexName);
  if (mutex != nullptr && ::GetLastError() == ERROR_ALREADY_EXISTS) {
    if (!replace) {
      // 已经有一个在运行：后台启动什么都不做（它已经在托盘里了）；否则让它把窗口提到最前
      if (!background) {
        HWND running = FindRunning(5000);
        if (running != nullptr) {
          ::AllowSetForegroundWindow(ASFW_ANY);  // 前台权在我们手里（用户刚点开），交给它
          ::PostMessageW(running, single_instance::ActivateMessage(), 0, 0);
        }
      }
      ::CloseHandle(mutex);
      return EXIT_SUCCESS;
    }
    // --replace：请旧的退出，等它释放互斥量（正常退出与崩溃都算）
    HWND running = FindRunning(5000);
    if (running != nullptr) {
      ::PostMessageW(running, single_instance::QuitMessage(), 0, 0);
    }
    const DWORD w = ::WaitForSingleObject(mutex, 15000);
    if (w != WAIT_OBJECT_0 && w != WAIT_ABANDONED) {
      ::CloseHandle(mutex);
      return EXIT_FAILURE;
    }
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project, background);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 800);
  if (!window.Create(L"Quetzal", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  if (mutex != nullptr) {
    ::ReleaseMutex(mutex);
    ::CloseHandle(mutex);
  }
  return EXIT_SUCCESS;
}
