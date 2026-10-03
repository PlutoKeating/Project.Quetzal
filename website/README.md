# website · Windler 产品官网

Windler 的产品官网源码：首页、亮点功能、文档教程（`/docs`）、下载页，以及 About / Terms / Privacy。纯前端，没有后端；构建时预渲染为静态 HTML，托管在 Cloudflare Workers（静态资源模式），线上地址 https://windler.plutokeating.beer 。

```bash
npm ci
npm run dev        # 本地开发 http://localhost:5173
npm run check      # 类型检查 + 设计系统检查 + 构建
npm run preview    # 用 wrangler 本地模拟线上托管（读取 build/client）
```

文档：[开发说明](docs/README.md) · [架构](docs/ARCHITECTURE.md) · [运维（部署 / 域名 / 回滚）](docs/DEVOPS.md)
