// 光学脚本必须作为独立文件进产物（CSP 的 script-src 不放行 data:），所以不让 Vite 把它内联成 data URI。
declare module "*?url&no-inline" {
  const src: string;
  export default src;
}
