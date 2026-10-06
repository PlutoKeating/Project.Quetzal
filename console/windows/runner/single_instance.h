#ifndef RUNNER_SINGLE_INSTANCE_H_
#define RUNNER_SINGLE_INSTANCE_H_

#include <windows.h>

// 控制台是单实例（与 linux/runner/my_application.cc 同义）：
//   - 命名互斥量（每个登录会话一个）表示「已经有一个在运行」；
//   - 再次启动时新进程找到已在运行的窗口（类名 QUETZAL_CONSOLE_WINDOW，窗口隐藏在托盘里也找得到），
//     发「激活」消息让它把窗口显示并提到最前，然后自己退出；
//   - --background：只起托盘、不开窗口（登录时 HKCU\...\Run 的启动项用它）；已经有一个在运行时什么都不做；
//   - --replace：让已在运行的那个退出、等它真的退出（互斥量被释放）后接管：升级后「重新打开」、安装器换上新版本时用。
namespace single_instance {

constexpr const wchar_t kMutexName[] = L"Local\\xyz.quetzal.console";
constexpr const wchar_t kWindowClassName[] = L"QUETZAL_CONSOLE_WINDOW";

// 跨进程的窗口消息（RegisterWindowMessage 按名字在整个桌面会话里取同一个编号）。
inline UINT ActivateMessage() {
  static const UINT m = ::RegisterWindowMessageW(L"xyz.quetzal.console.activate");
  return m;
}
inline UINT QuitMessage() {
  static const UINT m = ::RegisterWindowMessageW(L"xyz.quetzal.console.quit");
  return m;
}

}  // namespace single_instance

#endif  // RUNNER_SINGLE_INSTANCE_H_
