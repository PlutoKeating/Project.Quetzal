# libfvad：WebRTC 的语音活动检测（VAD）抽出来的独立 C 库（BSD-3，见同目录 LICENSE / PATENTS / AUTHORS），桌面版耳朵的断句用它。
#   与安卓耳朵用的 android-vad（WebRTC 版）是同一套算法：模式 0–3、16 kHz 下 10/20/30 ms 一帧，两边的灵敏度含义一致。
#   来源：https://github.com/dpirch/libfvad 提交 532ab666c20d3cfda38bca63abbb0f152706c369（2024-02-19）
#         codeload 压缩包 SHA-256 bf639e4a5bc37b1c90e047c42524e80a1d0cecadeb6e0a61a33580fca22a00ab；只取 src/、include/ 与许可文件，源码未改。
#   编成共享库：Linux 放进 bundle/lib/libfvad.so，Windows 放在 exe 旁边 fvad.dll；Dart 经 dart:ffi 调用（lib/platform/fvad.dart）。
cmake_minimum_required(VERSION 3.10)
project(fvad LANGUAGES C)

add_library(fvad SHARED
  src/fvad.c
  src/signal_processing/division_operations.c
  src/signal_processing/energy.c
  src/signal_processing/get_scaling_square.c
  src/signal_processing/resample_48khz.c
  src/signal_processing/resample_by_2_internal.c
  src/signal_processing/resample_fractional.c
  src/signal_processing/spl_inl.c
  src/vad/vad_core.c
  src/vad/vad_filterbank.c
  src/vad/vad_gmm.c
  src/vad/vad_sp.c
)
target_include_directories(fvad PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
set_target_properties(fvad PROPERTIES
  C_STANDARD 11
  POSITION_INDEPENDENT_CODE ON
  C_VISIBILITY_PRESET default
  WINDOWS_EXPORT_ALL_SYMBOLS ON)  # fvad.h 没有 __declspec(dllexport)：让 MSVC 导出全部符号
if(MSVC)
  target_compile_definitions(fvad PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
