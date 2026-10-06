#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <flutter/method_channel.h>
#include <flutter/encodable_value.h>
#include <windows.h>

#include <memory>

#include "win32_window.h"

// A window that does nothing but host a Flutter view.
class FlutterWindow : public Win32Window {
 public:
  // Creates a new FlutterWindow hosting a Flutter view running |project|.
  // background：--background 启动，首帧后也不显示窗口（只起托盘，等「打开 Quetzal」或再次启动时再显示）。
  FlutterWindow(const flutter::DartProject& project, bool background);
  virtual ~FlutterWindow();

 protected:
  // Win32Window:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM const wparam,
                         LPARAM const lparam) noexcept override;

 private:
  // 把一个子进程（身体助手）放进「控制台退出就一起结束」的作业对象：控制台无论正常退出、被 --replace 接管还是崩溃，它都跟着结束。
  bool AdoptChild(int64_t pid);

  // The project to run.
  flutter::DartProject project_;
  bool background_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;

  // MethodChannel quetzal/desktop（adopt）。
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> desktop_channel_;
  HANDLE job_ = nullptr;
};

#endif  // RUNNER_FLUTTER_WINDOW_H_
