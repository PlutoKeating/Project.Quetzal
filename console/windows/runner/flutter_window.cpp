#include "flutter_window.h"

#include <flutter/standard_method_codec.h>

#include <optional>

#include "flutter/generated_plugin_registrant.h"
#include "single_instance.h"

FlutterWindow::FlutterWindow(const flutter::DartProject& project, bool background)
    : project_(project), background_(background) {}

FlutterWindow::~FlutterWindow() {
  if (job_ != nullptr) ::CloseHandle(job_);  // 关掉作业对象：里面的子进程随之结束
}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  desktop_channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      flutter_controller_->engine()->messenger(), "quetzal/desktop",
      &flutter::StandardMethodCodec::GetInstance());
  desktop_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
        if (call.method_name() == "adopt") {
          int64_t pid = 0;
          if (const auto* v = std::get_if<int32_t>(call.arguments())) pid = *v;
          else if (const auto* v64 = std::get_if<int64_t>(call.arguments())) pid = *v64;
          result->Success(flutter::EncodableValue(pid > 0 && AdoptChild(pid)));
        } else {
          result->NotImplemented();
        }
      });

  if (!background_) {
    flutter_controller_->engine()->SetNextFrameCallback([&]() {
      this->Show();
    });
  }

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

bool FlutterWindow::AdoptChild(int64_t pid) {
  if (job_ == nullptr) {
    job_ = ::CreateJobObjectW(nullptr, nullptr);
    if (job_ == nullptr) return false;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!::SetInformationJobObject(job_, JobObjectExtendedLimitInformation, &info, sizeof(info))) {
      ::CloseHandle(job_);
      job_ = nullptr;
      return false;
    }
  }
  HANDLE process = ::OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, static_cast<DWORD>(pid));
  if (process == nullptr) return false;
  const BOOL ok = ::AssignProcessToJobObject(job_, process);
  ::CloseHandle(process);
  return ok != FALSE;
}

void FlutterWindow::OnDestroy() {
  desktop_channel_ = nullptr;
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // 单实例：再次启动的那个进程请我们把窗口提到最前，或（--replace）请我们退出
  if (message == single_instance::ActivateMessage()) {
    background_ = false;
    ::ShowWindow(hwnd, ::IsIconic(hwnd) ? SW_RESTORE : SW_SHOW);
    ::SetForegroundWindow(hwnd);
    return 0;
  }
  if (message == single_instance::QuitMessage()) {
    ::DestroyWindow(hwnd);  // 不经过 WM_CLOSE（关窗只是收进托盘）；WM_DESTROY 之后消息循环结束
    return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
