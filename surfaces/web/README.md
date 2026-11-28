# `surfaces/web` — 治理面（Web）

Quetzalcoatl 唯一的自有界面在浏览器里的落地。它只做两件事：**看**和**签**。没有输入框，没有「和他聊聊」——想聊，去宿主。

规范在 [`docs/GOVERNANCE_SURFACE.md`](../../docs/GOVERNANCE_SURFACE.md)：用户来这里要什么、三栏版面、每一页的结构、与守护进程的接口。视觉语言只有一份，在 [`packages/design-system`](../../packages/design-system)；这里不带任何样式，也不重述数值。

TypeScript（`strict`、`noUncheckedIndexedAccess`、无裸 `any`），原生 DOM，无框架，无远程依赖。页面由本机 `quetzalcoatld` 同源托管，`qz open` 打开。

## 构建与测试

```bash
npm --prefix surfaces/web ci
npm --prefix surfaces/web run typecheck
npm --prefix surfaces/web run test:unit   # vitest + jsdom
npm --prefix surfaces/web run test:e2e    # Playwright：假守护进程 + 真 quetzalcoatld 冒烟
npm --prefix surfaces/web run build       # → dist/
npm --prefix surfaces/web run preview     # 构建并起假守护进程：http://127.0.0.1:43117
```

- `build`：esbuild 打出 `dist/assets/app.js`；设计系统的 `styles.css` 连同字体打成 `dist/assets/styles.css` 与 `dist/assets/fonts/*`；`scripts/optics.js` 原样复制为 `dist/assets/optics.js`。产物是纯静态文件，无内联脚本、无内联样式。
- `test:e2e` 的 `e2e/global-setup.ts` 会构建 `dist`，并以临时 `QUETZALCOATL_HOME` 启动**真实**的 `quetzalcoatld`（`target/debug/quetzalcoatld`，或 `QUETZALCOATL_DAEMON_BIN` 指定的二进制；都没有时现场 `cargo build`）。启动不了时测试直接失败，不跳过。
- `preview` 可加 `-- --scenario fresh` 看刚装好、什么都没有的样子。

## 版面

三栏，各有固定职责：

| 栏 | 内容 |
| --- | --- |
| 左：导航 | 品牌名（回到总览）与八页的入口；有事在等的那一页旁有一个琥珀色信号点。守护进程联系不上时，上方多一行状态词与下一步 |
| 中：正文 | 当前页。光学地平线只落在这里 |
| 右：出处 | 当前选中条目的来历；没有选中时是这一页的一句话说明，永不留空 |

窄屏（≤ 900px）：导航收成顶部一行可横向滚动的入口；出处栏变成正文下方的一段，选中条目后跟到它正下方。

| 视图 | 地址 | 结构 |
| --- | --- | --- |
| 总览 | `#/` | 居中的名字与「相处第 N 天」，其下三格：宿主、等你的事、同步 |
| 他 | `#/self` | 核心价值的编号栅格、性情（小一级）、可展开证据链的变化时间线 |
| 我 | `#/user` | 偏好与事实两栏对照；选中的一条就地展开三个动作 |
| 我们 | `#/us` | 承诺的编号栅格；一根带下限线的横向刻度（全站唯一的滑杆） |
| 往事 | `#/memories` | 主从：搜索、分段、分页的列表，和选中条目的全文、来历、生效时间与动作 |
| 底线 | `#/baseline` | 编号的条款清单、签署条（全站唯一的白色主按钮）、只读的部署约束 |
| 宿主 | `#/hosts` | 每个宿主一行四格：送核心、送往事、收信号、压缩后不丢 |
| 设备 | `#/devices` | 这台设备与同步并排在最上；其余按最近在线排序，行末是吊销 |
| 记录 | `#/audit` | 按天分组的时间线，每条一行：时间、动作、对象 |

全站仅有的文本输入：往事搜索、改一条时的文本、底线的短题与短句、口令。

## 与守护进程的接口

握手沿用本机会话：`POST /auth/local`（浏览器自带同源 `Origin`）取得会话令牌；之后每次调用是一次 `POST /rpc`，带 `Authorization: Bearer <token>`。

```jsonc
// 请求（没有参数的方法不带 params）
{"method": "sea_memories", "params": {"query": "咖啡", "limit": 50}}
// 成功
{"kind": "sea_memories", "data": {"items": [], "next_cursor": null, "total": 0}}
// 失败
{"kind": "error", "data": {"code": "PASSPHRASE_REJECTED", "detail": "口令不对。"}}
```

十六个方法（十个读、六个写）的参数与载荷类型在 `src/api/types.ts`，类型化客户端在 `src/api/client.ts`。答复在进入界面之前逐字段解码（`src/api/decode.ts`）；形状不符时指出是哪个字段，界面显示「读取失败」而不是在渲染中途崩溃。会话令牌作废（401）时重新握手并重试一次。

## 状态

| 情形 | 判定 | 界面 |
| --- | --- | --- |
| 联系不上 | 握手或请求没有回来 | 导航上方一行琥珀色状态词与 `qz up`；读过的页面保留上一次的内容，所有写动作停用；每 4 秒自动再试，连上后自己恢复。从没读过的页面显示「联系不上」的版面 |
| 接口未就绪 | 握手成功，但方法不被认识（`403 PERMISSION_DENIED`、未知变体、`404`/`501`） | 「接口未就绪」的版面：现状、三步、方法名与答复、重试 |
| 读取失败 | 其它 `kind: "error"`，或答复读不懂 | 「读取失败」的版面：原因、方法、代码、重试 |
| 空 | 这一页或它的一部分还没有内容 | 每页各自的版面：它为什么是空的、内容从哪里来、下一步 |
| 写入失败 | 写方法返回错误 | 原内容不动，动作旁写明原因，并经断言通道播报 |

写操作成功后，被改的那一条就地更新，出处栏追加一行（「刚刚由你修改」等），经礼貌通道播报。不弹提示条，不跳转。

## 无障碍

- 地标：`header`（品牌与导航）、`nav`、`main`、`aside`（出处）。每页恰好一个 `h1`；换页后焦点落到它上面。
- 第一个 Tab 停靠点是「跳到正文」。所有控件都有 1px 冰蓝的可见焦点环。
- 一组可选的条目只占一个 Tab 停靠点，组内用方向键、Home、End 移动；分段控件同理。
- 重绘之后焦点回到原来的控件；写操作在途时用 `aria-disabled` 而不是 `disabled`，焦点不会掉出页面。
- 抹除与吊销用原生 `<dialog>`：焦点圈在里面，Esc 取消，关闭后回到触发它的按钮。
- 颜色从不是唯一信号：冰蓝（已生效、已验证、通）与琥珀（需要你、是你说的、不通）总带着文字。

## 假守护进程

`e2e/mock-daemon.mjs` 按契约应答十六个方法，静态托管 `dist`，供预览与 Playwright 使用。数据全部是合成的。写操作真的改变它内存里的数据并追加一条记录。

测试专用的控制口（不需要令牌）：

| 路径 | 作用 |
| --- | --- |
| `POST /__mock/reset` `{"scenario": "full" \| "fresh"}` | 换一套数据 |
| `POST /__mock/fail` `{"method", "code", "detail", "status"?, "times"?}` | 让某个方法接下来失败 |
| `GET /__mock/state` | 看内存里的现状 |

`full` 场景里的口令是 `mock-passphrase`。

## 目录

```
surfaces/web/
├── index.html              # 骨架：光学地平线、胶片颗粒、.qz-page
├── build.mjs
├── src/
│   ├── main.ts
│   ├── app.ts              # 三栏骨架、路由、连接状态、写动作的停用
│   ├── api/{types,decode,client}.ts
│   ├── shell/{routes,provenance}.ts
│   ├── ui/{dom,format,marks,situation,dialog,announcer}.ts
│   ├── views/{base,entry,overview,self,user,us,memories,baseline,hosts,devices,audit}.ts
│   ├── cache/、worker/      # WASM / OPFS 缓存设施：另一条产品线的地基，治理面不引用
├── tests/                  # vitest
└── e2e/                    # Playwright、假守护进程、真守护进程冒烟
```
