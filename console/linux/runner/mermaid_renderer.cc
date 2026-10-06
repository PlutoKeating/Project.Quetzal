#include "mermaid_renderer.h"

#include <dlfcn.h>
#include <gtk/gtk.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>

// 实现见 mermaid_renderer.h 的说明。WebKitGTK 的 C 接口在 4.0 / 4.1 之间没有变化，这里只声明用到的几个函数（dlsym 取得）。
namespace {

typedef struct _WebKitUserContentManager WebKitUserContentManager;
typedef struct _WebKitWebView WebKitWebView;
typedef struct _WebKitJavascriptResult WebKitJavascriptResult;
typedef struct _WebKitPolicyDecision WebKitPolicyDecision;
typedef struct _WebKitNavigationAction WebKitNavigationAction;
typedef struct _WebKitURIRequest WebKitURIRequest;
typedef struct _JSCValue JSCValue;

constexpr int kSnapshotRegionFullDocument = 1;         // WEBKIT_SNAPSHOT_REGION_FULL_DOCUMENT
constexpr int kSnapshotOptionsTransparent = 1 << 1;    // WEBKIT_SNAPSHOT_OPTIONS_TRANSPARENT_BACKGROUND
constexpr int kPolicyNavigationAction = 0;             // WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION
constexpr int kPolicyNewWindowAction = 1;              // WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION
constexpr double kMaxPixels = 16e6;                    // 一张图最多 1600 万像素（RGBA 64 MB），超了就降低倍率
constexpr guint kJobTimeoutMs = 15000;
constexpr guint kLoadTimeoutMs = 15000;

struct WebKit {
  WebKitUserContentManager* (*ucm_new)();
  gboolean (*ucm_register)(WebKitUserContentManager*, const char*);
  GtkWidget* (*view_new_ucm)(WebKitUserContentManager*);
  void (*load_uri)(WebKitWebView*, const char*);
  void (*run_js)(WebKitWebView*, const char*, GCancellable*, GAsyncReadyCallback, gpointer);
  void (*eval_js)(WebKitWebView*, const char*, gssize, const char*, const char*, GCancellable*, GAsyncReadyCallback, gpointer);
  void (*set_bg)(WebKitWebView*, const GdkRGBA*);
  void (*set_zoom)(WebKitWebView*, gdouble);
  void (*snapshot)(WebKitWebView*, int, int, GCancellable*, GAsyncReadyCallback, gpointer);
  cairo_surface_t* (*snapshot_finish)(WebKitWebView*, GAsyncResult*, GError**);
  JSCValue* (*result_value)(WebKitJavascriptResult*);
  char* (*jsc_to_string)(JSCValue*);
  WebKitNavigationAction* (*nav_action)(WebKitPolicyDecision*);
  WebKitURIRequest* (*action_request)(WebKitNavigationAction*);
  const char* (*request_uri)(WebKitURIRequest*);
  void (*decision_ignore)(WebKitPolicyDecision*);
};

struct Job {
  FlMethodCall* call;
  std::string code;
  bool dark;
  double scale;
};

struct Renderer {
  WebKit wk = {};
  bool tried = false;     // 已经尝试过加载 WebKitGTK
  bool ok = false;        // WebKitGTK 可用
  bool ready = false;     // view.html 已加载（收到 ready）
  bool failed = false;    // 页面没能加载：之后的请求一律 unavailable
  GtkWidget* window = nullptr;
  GtkWidget* view = nullptr;
  std::string page_uri;
  std::deque<Job> queue;
  bool busy = false;
  Job current = {nullptr, "", false, 2.0};
  unsigned seq = 0;       // 当前这张图的序号（view.html 回报时带上，迟到的旧消息丢掉）
  double zoom = 2.0;
  guint timer = 0;
};

Renderer* R = nullptr;

template <typename T>
bool Sym(void* h, T* fn, const char* name) {
  *reinterpret_cast<void**>(fn) = dlsym(h, name);
  return *fn != nullptr;
}

std::string JsonString(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          snprintf(b, sizeof b, "\\u%04x", c);
          o += b;
        } else {
          o += static_cast<char>(c);
        }
    }
  }
  return o + "\"";
}

// 从 view.html 的 JSON 消息里取一个数（{"h":343,"w":259,"id":"3"} 这样的简单对象）。
bool JsonNumber(const char* msg, const char* key, double* out) {
  std::string k = std::string("\"") + key + "\":";
  const char* p = strstr(msg, k.c_str());
  if (p == nullptr) return false;
  p += k.size();
  if (*p == '"') p++;
  char* end = nullptr;
  *out = strtod(p, &end);
  return end != p;
}

void Respond(FlMethodCall* call, FlValue* result) {
  fl_method_call_respond_success(call, result, nullptr);
  g_object_unref(call);
}

void RespondError(FlMethodCall* call, const char* code, const char* message) {
  fl_method_call_respond_error(call, code, message, nullptr, nullptr);
  g_object_unref(call);
}

void Pump();

void Finish() {
  if (R->timer != 0) {
    g_source_remove(R->timer);
    R->timer = 0;
  }
  R->busy = false;
  R->current.call = nullptr;
  Pump();
}

void FailAll(const char* code, const char* message) {
  if (R->busy && R->current.call != nullptr) RespondError(R->current.call, code, message);
  R->busy = false;
  R->current.call = nullptr;
  while (!R->queue.empty()) {
    RespondError(R->queue.front().call, code, message);
    R->queue.pop_front();
  }
}

gboolean OnJobTimeout(gpointer) {
  R->timer = 0;
  if (R->busy && R->current.call != nullptr) RespondError(R->current.call, "timeout", "图表渲染超时");
  R->current.call = nullptr;
  R->seq++;  // 之后迟到的消息不再算数
  Finish();
  return G_SOURCE_REMOVE;
}

gboolean OnLoadTimeout(gpointer) {
  R->timer = 0;
  if (!R->ready) {
    R->failed = true;
    FailAll("unavailable", "图表页没能加载");
  }
  return G_SOURCE_REMOVE;
}

cairo_status_t PngWrite(void* closure, const unsigned char* data, unsigned int length) {
  g_byte_array_append(static_cast<GByteArray*>(closure), data, length);
  return CAIRO_STATUS_SUCCESS;
}

void OnSnapshot(GObject* source, GAsyncResult* res, gpointer data) {
  const unsigned seq = GPOINTER_TO_UINT(data);
  GError* error = nullptr;
  cairo_surface_t* s = R->wk.snapshot_finish(reinterpret_cast<WebKitWebView*>(source), res, &error);
  if (seq != R->seq || !R->busy || R->current.call == nullptr) {  // 已经超时放弃了
    if (s != nullptr) cairo_surface_destroy(s);
    if (error != nullptr) g_error_free(error);
    return;
  }
  if (s == nullptr) {
    RespondError(R->current.call, "render", error != nullptr ? error->message : "截图失败");
    if (error != nullptr) g_error_free(error);
    Finish();
    return;
  }
  GByteArray* png = g_byte_array_new();
  cairo_surface_write_to_png_stream(s, PngWrite, png);
  cairo_surface_destroy(s);
  g_autoptr(FlValue) result = fl_value_new_map();
  fl_value_set_string_take(result, "png", fl_value_new_uint8_list(png->data, png->len));
  fl_value_set_string_take(result, "scale", fl_value_new_float(R->zoom));
  g_byte_array_unref(png);
  Respond(R->current.call, result);
  Finish();
}

gboolean Snap(gpointer data) {
  R->wk.snapshot(reinterpret_cast<WebKitWebView*>(R->view), kSnapshotRegionFullDocument, kSnapshotOptionsTransparent,
                 nullptr, OnSnapshot, data);
  return G_SOURCE_REMOVE;
}

void OnMessage(WebKitUserContentManager*, WebKitJavascriptResult* js, gpointer) {
  char* msg = R->wk.jsc_to_string(R->wk.result_value(js));
  if (msg == nullptr) return;
  if (strstr(msg, "\"ready\":true") != nullptr) {
    R->ready = true;
    if (R->timer != 0 && !R->busy) {
      g_source_remove(R->timer);
      R->timer = 0;
    }
    Pump();
    g_free(msg);
    return;
  }
  double id = -1, h = 0, w = 0;
  if (!JsonNumber(msg, "id", &id) || static_cast<unsigned>(id) != R->seq || !R->busy || R->current.call == nullptr) {
    g_free(msg);
    return;
  }
  if (strstr(msg, "\"error\"") != nullptr) {
    RespondError(R->current.call, "render", msg);  // 原样交回（JSON），Dart 侧取 error 字段
    Finish();
  } else if (JsonNumber(msg, "h", &h) && JsonNumber(msg, "w", &w) && h > 0 && w > 0) {
    // 图很大时降低倍率，免得一张图占几百 MB
    double z = R->current.scale;
    if (w * h * z * z > kMaxPixels) z = std::sqrt(kMaxPixels / (w * h));
    if (std::fabs(z - R->zoom) > 0.01) {
      R->zoom = z;
      R->wk.set_zoom(reinterpret_cast<WebKitWebView*>(R->view), z);
      g_timeout_add(150, Snap, GUINT_TO_POINTER(R->seq));  // 等它按新倍率重新排版
    } else {
      Snap(GUINT_TO_POINTER(R->seq));
    }
  }
  g_free(msg);
}

gboolean OnDecidePolicy(WebKitWebView*, WebKitPolicyDecision* decision, int type, gpointer) {
  if (type != kPolicyNavigationAction && type != kPolicyNewWindowAction) return FALSE;
  const char* uri = R->wk.request_uri(R->wk.action_request(R->wk.nav_action(decision)));
  if (type == kPolicyNavigationAction && uri != nullptr && R->page_uri == uri) return FALSE;  // 只允许加载自己的图表页
  R->wk.decision_ignore(decision);
  return TRUE;
}

void RunJs(const std::string& script) {
  auto* view = reinterpret_cast<WebKitWebView*>(R->view);
  if (R->wk.eval_js != nullptr) {
    R->wk.eval_js(view, script.c_str(), -1, nullptr, nullptr, nullptr, nullptr, nullptr);
  } else {
    R->wk.run_js(view, script.c_str(), nullptr, nullptr, nullptr);
  }
}

void Pump() {
  if (R->busy || !R->ready || R->queue.empty()) return;
  R->current = R->queue.front();
  R->queue.pop_front();
  R->busy = true;
  R->seq++;
  if (std::fabs(R->zoom - R->current.scale) > 0.01) {
    R->zoom = R->current.scale;
    R->wk.set_zoom(reinterpret_cast<WebKitWebView*>(R->view), R->zoom);
  }
  RunJs("tag = \"" + std::to_string(R->seq) + "\"; render(" + JsonString(R->current.code) + ", " +
        (R->current.dark ? "true" : "false") + ", false, true);");
  R->timer = g_timeout_add(kJobTimeoutMs, OnJobTimeout, nullptr);
}

std::string PageUri() {
  g_autofree gchar* exe = g_file_read_link("/proc/self/exe", nullptr);
  if (exe == nullptr) return "";
  g_autofree gchar* dir = g_path_get_dirname(exe);
  g_autofree gchar* page = g_build_filename(dir, "data", "flutter_assets", "assets", "mermaid", "view.html", nullptr);
  if (!g_file_test(page, G_FILE_TEST_EXISTS)) return "";
  g_autofree gchar* uri = g_filename_to_uri(page, nullptr, nullptr);
  return uri != nullptr ? uri : "";
}

bool Load() {
  if (R->tried) return R->ok;
  R->tried = true;
  void* h = dlopen("libwebkit2gtk-4.1.so.0", RTLD_NOW | RTLD_GLOBAL);
  if (h == nullptr) h = dlopen("libwebkit2gtk-4.0.so.37", RTLD_NOW | RTLD_GLOBAL);
  if (h == nullptr) return false;
  WebKit& k = R->wk;
  bool ok = Sym(h, &k.ucm_new, "webkit_user_content_manager_new") &&
            Sym(h, &k.ucm_register, "webkit_user_content_manager_register_script_message_handler") &&
            Sym(h, &k.view_new_ucm, "webkit_web_view_new_with_user_content_manager") &&
            Sym(h, &k.load_uri, "webkit_web_view_load_uri") &&
            Sym(h, &k.set_bg, "webkit_web_view_set_background_color") &&
            Sym(h, &k.set_zoom, "webkit_web_view_set_zoom_level") &&
            Sym(h, &k.snapshot, "webkit_web_view_get_snapshot") &&
            Sym(h, &k.snapshot_finish, "webkit_web_view_get_snapshot_finish") &&
            Sym(h, &k.result_value, "webkit_javascript_result_get_js_value") &&
            Sym(h, &k.jsc_to_string, "jsc_value_to_string") &&
            Sym(h, &k.nav_action, "webkit_navigation_policy_decision_get_navigation_action") &&
            Sym(h, &k.action_request, "webkit_navigation_action_get_request") &&
            Sym(h, &k.request_uri, "webkit_uri_request_get_uri") &&
            Sym(h, &k.decision_ignore, "webkit_policy_decision_ignore");
  Sym(h, &k.eval_js, "webkit_web_view_evaluate_javascript");  // 2.40 起
  Sym(h, &k.run_js, "webkit_web_view_run_javascript");        // 更早的版本
  if (!ok || (k.eval_js == nullptr && k.run_js == nullptr)) return false;
  R->page_uri = PageUri();
  if (R->page_uri.empty()) return false;

  // 离屏窗口拿不到 GL 上下文：WebKitGTK 2.42 起默认的 DMABuf 渲染器在这里起不来，退回共享内存（只影响这个看不见的页面）
  g_setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1", FALSE);
  WebKitUserContentManager* ucm = k.ucm_new();
  g_signal_connect(ucm, "script-message-received::out", G_CALLBACK(OnMessage), nullptr);
  k.ucm_register(ucm, "out");
  R->view = k.view_new_ucm(ucm);
  GdkRGBA clear = {0, 0, 0, 0};
  k.set_bg(reinterpret_cast<WebKitWebView*>(R->view), &clear);
  k.set_zoom(reinterpret_cast<WebKitWebView*>(R->view), R->zoom);
  g_signal_connect(R->view, "decide-policy", G_CALLBACK(OnDecidePolicy), nullptr);
  // 窗口很小：整页截图的大小就是图本身（文档至少和视口一样大）
  R->window = gtk_offscreen_window_new();
  gtk_window_set_default_size(GTK_WINDOW(R->window), 16, 16);
  gtk_container_add(GTK_CONTAINER(R->window), R->view);
  gtk_widget_show_all(R->window);
  k.load_uri(reinterpret_cast<WebKitWebView*>(R->view), R->page_uri.c_str());
  R->timer = g_timeout_add(kLoadTimeoutMs, OnLoadTimeout, nullptr);
  R->ok = true;
  return true;
}

void OnMethodCall(FlMethodChannel*, FlMethodCall* call, gpointer) {
  if (strcmp(fl_method_call_get_name(call), "render") != 0) {
    fl_method_call_respond_not_implemented(call, nullptr);
    return;
  }
  FlValue* args = fl_method_call_get_args(call);
  FlValue* code = fl_value_get_type(args) == FL_VALUE_TYPE_MAP ? fl_value_lookup_string(args, "code") : nullptr;
  if (code == nullptr || fl_value_get_type(code) != FL_VALUE_TYPE_STRING) {
    fl_method_call_respond_error(call, "args", "缺少 code", nullptr, nullptr);
    return;
  }
  FlValue* dark = fl_value_lookup_string(args, "dark");
  FlValue* scale = fl_value_lookup_string(args, "scale");
  if (!Load() || R->failed) {
    fl_method_call_respond_error(call, "unavailable", "这台电脑上没有 WebKitGTK（libwebkit2gtk-4.1）", nullptr, nullptr);
    return;
  }
  double s = scale != nullptr && fl_value_get_type(scale) == FL_VALUE_TYPE_FLOAT ? fl_value_get_float(scale) : 2.0;
  R->queue.push_back(Job{FL_METHOD_CALL(g_object_ref(call)), fl_value_get_string(code),
                         dark != nullptr && fl_value_get_type(dark) == FL_VALUE_TYPE_BOOL && fl_value_get_bool(dark),
                         s < 1.0 ? 1.0 : (s > 4.0 ? 4.0 : s)});
  Pump();
}

}  // namespace

void mermaid_renderer_register(FlBinaryMessenger* messenger) {
  if (R != nullptr) return;
  R = new Renderer();
  g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
  FlMethodChannel* channel = fl_method_channel_new(messenger, "quetzal/mermaid", FL_METHOD_CODEC(codec));
  fl_method_channel_set_method_call_handler(channel, OnMethodCall, nullptr, nullptr);  // 通道随进程存在，不释放
}
