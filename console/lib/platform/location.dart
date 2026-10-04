// 页面所在的位置：网页版由此得知网关地址（页面的来源就是网关），并把当前位置写进 URL 的 #片段（可收藏、可前进后退）；安卓没有这些。
//   claimUrl()：网页版让 Flutter 放弃对 URL 的管理（否则它会把 #片段改成自己的路由）。
export 'location_io.dart' if (dart.library.js_interop) 'location_web.dart';
