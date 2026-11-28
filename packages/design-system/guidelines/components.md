# 组件规范

全部样式在 `components/components.css`。类名以 `.qz-` 开头；状态用 `.is-*`。所有组件都假定放在 `#000000` 的页面上，并且页面最底层有 `.qz-optical-horizon`。

通用规则：

- 没有卡片组件。需要并列内容时用**发丝线栅格**。
- 冰蓝与琥珀只通过下文明确列出的位置出现。
- 所有间距、方向用逻辑属性，组件在 RTL 下无需额外样式。

---

## 页面骨架

```html
<div class="qz-optical-horizon" aria-hidden="true"></div>
<div class="qz-grain" aria-hidden="true"></div>
<div class="qz-page">
  <header class="qz-nav">…</header>
  <main>…</main>
  <footer class="qz-footer">…</footer>
</div>
```

`.qz-page` 必须是透明背景且 `z-index: 1`，否则光学层会被盖住。`.qz-container` 提供 1180px 的内容宽度。

## 导航栏 `.qz-nav`

- 结构：`.qz-nav-inner` 内左侧 `.qz-brand`（标记 SVG 26px 高 + 字标），右侧 `.qz-nav-links`。
- 74px 高，sticky，84% 黑 + 16px 模糊，底部一条发丝线。
- 链接默认 `--qz-ink-secondary`，悬停变白，150ms。没有下划线，没有当前项背景。
- 字标：Sora 600、1.28rem、字距 -0.025em。品牌名始终 LTR。可以包一层 `.qz-wordmark` 成为光谱字标（见下）。
- 移动端不折叠成汉堡菜单：间距从 2.25rem 收到 1.05rem，所有入口保持可见。

## 光谱字标 `.qz-wordmark`

系统里唯一不是信号的颜色。把它包在品牌名或所有者名的文字外面：

```html
<a class="qz-brand" href="/"><span class="qz-wordmark">Quetzalcoatl</span></a>
<h1 class="qz-display">I'm <span class="qz-wordmark">PlutoKeating</span>.</h1>
```

- 六条横向色带，自上而下为 `--qz-spectrum-1` 到 `-6`（绿、黄、橙、红、紫、蓝），正好铺满大写字母高度；下伸部分延续蓝色。
- 在 `.qz-display` / `.qz-monument` 内自动带 0.02em 的镂空细缝，透出底色；其他尺寸不切缝。需要在别处强制切缝时加 `.is-slit`，字号小于约 2.5rem 时不要加。
- 只包名字本身，周围的文字和标点保持白色。
- 每页至多两处：导航栏品牌名，加上一个大标题中的名字。正文、按钮、页脚、标签里的同一个名字保持白色。
- 不要改色带顺序、不要改成渐变、不要加动效、不要用于图标或插图。
- 色带位置按 Sora 测量；CJK 字形没有大写高度的概念，不要用于中文名。
- `forced-colors` 模式下退回普通文字颜色。

## 菜单 `.qz-menu`

- 用原生 `<details>` / `<summary>` 实现，无需脚本即可开合；另加一个点击外部关闭的监听。
- 触发器 `.qz-menu-trigger`：等宽 0.78rem、4px 圆角、0.14 白边；悬停或展开时边提到 0.38 并变白。
- 浮层 `.qz-menu-popover`：`#070707`、6px 圆角、0.14 白边、系统中**唯一**的阴影。对齐到 `inline-end`。
- 菜单项 `.qz-menu-item`：左侧名称，右侧 `.qz-menu-item-meta`（等宽代码）。悬停 0.06 白填充；当前项 `.is-current` 0.08 白填充 + `aria-current="page"`。

## 按钮

| 类 | 角色 | 外观 |
| --- | --- | --- |
| `.qz-btn-white` | 主操作，一屏一个 | 纯白底黑字，5px 圆角，500 字重，悬停 0.88 不透明度 |
| `.qz-btn-outline` | 次操作 | 透明底，0.18 白边，6px 圆角；悬停边 0.42 + 0.05 白填充 |
| `.qz-link-arrow` | 第三级，跳转 | 纯文字 `#B5B5B5` + 15px 箭头，悬停变白 |
| `.qz-btn-copy` | 框内的小复制按钮 | 0.12 白边、4px 圆角；悬停整体反白 |

- 复制成功：加 `.is-copied`。主按钮整块变冰蓝；描边与小按钮只把边和字变冰蓝。1600–1800ms 后复原并恢复文案。
- 没有禁用态的专门样式；没有加载态。按钮内文字句首大写，不带图标（箭头只出现在跳转类）。
- 按钮**不**使用胶囊圆角，不使用琥珀色，不带阴影。
- 方向箭头加 `.qz-dir-arrow`，RTL 下自动翻转。

## 分段控件 `.qz-segmented`

- 容器：6px 圆角、发丝线边、`rgba(8,8,8,0.72)` 底、内边距 0.2rem。
- 分段 `.qz-segment`：0.78rem / 500；激活 `.is-active` 为 0.10 白填充 + 白字。
- 语义：容器 `role="tablist"`，分段 `role="tab"` + `aria-selected`。
- 分段也可以是页内锚点链接（`<a class="qz-segment">`），此时容器用 `<nav>`，当前项用 `aria-current` 标记，外观与 `.is-active` 相同。

## 输入框 `.qz-input`

一个带可选前置图标的单行文本输入，外观与命令条同族。

- 容器 `.qz-input` 承担边框与底色：6px 圆角、0.14 白边、90% 的 `#080808` 底；内部的 `<input>` 透明无边。
- 文字白色 0.86rem，占位符 `#666666`，光标是琥珀色（人在输入）。
- 悬停边提到 0.24；聚焦时边 0.42，并在容器外加 1px 冰蓝焦点环（3px 偏移）。
- 必须有可见或可被读屏读到的 `<label>`。没有错误态、禁用态的专门样式。
- 其余表单控件（复选框、开关、下拉、多行文本）仍未定义。

## 命令条 `.qz-command-bar`

一行等宽命令 + 右侧一个 `.qz-btn-white`。

- 8px 圆角、0.14 白边、90% 的 `#080808` 底；左内边距 1.25rem，右侧只留 0.42rem 让按钮贴边。
- 命令文字不换行，超长时横向滚动且隐藏滚动条。始终 `dir="ltr"`。
- 常与上方的分段控件、下方的 `.qz-meta-line` 组成 `.qz-action-stack`（纵向居中，间距 0.9rem）。

## Hero `.qz-hero`

- 最小高度 `100svh - 74px`，内容纵向与横向居中。
- 顺序：`.qz-display` 标题 → `.qz-lead` 副标题（最宽 66ch）→ `.qz-action-stack` → `.qz-hero-stage`（间距 3.85rem）。
- 标题与副标题使用 `text-wrap: balance`。
- hero 是唯一整体居中的区块（另一个是收尾区块）。

## 区块 `.qz-section` / 收尾 `.qz-close`

- 顶部一条发丝线，其上叠一条居中 80% 宽的高光线（`::before`），不透明度由 `--qz-edge` 驱动，静止回落值 0.35。
- 区块内的 `.qz-container` 不透明度为 `0.76 + --qz-lit × 0.24`。给区块加 `data-qz-lit` 以启用。
- `.qz-section-head`：`.qz-title` + 一段说明，最宽 72ch，下方 3.25rem。左对齐。
- `.qz-close`：居中的 `.qz-monument` 标题 + `.qz-close-note` + 一组操作。整页最后一个区块，语气安静。

## 发丝线栅格 `.qz-rail`

本系统中卡片的替代品。

- 上下各一条 0.10 白线，单元格之间 0.08 白的竖线。**没有外框，没有背景，没有圆角。**
- 默认 4 列；`.is-3` 三列；`.is-2` 两列。响应式：4 → 2（820px）→ 1（540px）；3 → 1（760px）；2 → 1（720px）。
- 单元格 `.qz-cell`：可选 `.qz-cell-num`（等宽 `01`）+ `h3` + `p`。
- **强调单元格** `.qz-cell.is-accent`：顶边换成 1.5px 冰蓝。一条栅格最多一个，放在代表"结果"的那一格（通常是最后一格）。
- 编号可着色：`.is-amber` 标记需要人参与的一步，`.is-ice` 标记完成的一步。
- 带状态的单元格：`.qz-cell-head` 内左 `h3` 右 `.qz-state`。
- **多行栅格** `.qz-rail.is-grid`：单元格数量不定、需要换行时使用（例如作品目录）。行与列之间都是 0.08 白线，最外圈的线被裁掉，只留容器上下两条。可与 `.is-2` / `.is-3` 组合决定列数，被隐藏的单元格不会留下断线。
- `.qz-rail-head`：栅格上方的标题行，`>` 琥珀提示符 + 名称 + 靠右的等宽元信息。

## 提示条 `.qz-prompt-rail` / `.qz-prompt-quote`

- `.qz-prompt-rail`：上下两条发丝线之间的一行示例文字，左侧 `.qz-caret`（琥珀 `>`），右侧一个描边复制按钮。
- `.qz-prompt-quote`：舞台内部的引用样式，左侧一条 0.30 白竖线，白字。
- 琥珀 `>` 的含义固定为"这是人说的话"。

## 信号

| 元素 | 类 | 含义 |
| --- | --- | --- |
| 6px 发光圆点 | `.qz-led` | 正在运行、实时 |
| 6px 圆点 | `.qz-dot` `.is-ice` / `.is-amber` | 状态标记 |
| 6px 空心环 | `.qz-ring` | 未选中的选项 |
| 5px 方刻度 | `.qz-tick`（`.is-ice` 为当前） | 里程碑 |
| 状态词 | `.qz-state.is-ice` / `.is-amber` | `● AUTO` / `● MANUAL`，等宽全大写 |
| 步骤编号 | `.qz-step-no` | 标题前的琥珀等宽数字 |
| 元信息 | `.qz-meta` | 等宽灰色小字 |

颜色不能是唯一信号：状态词必须有文字，圆点旁必须有标签。

## 展示舞台 `.qz-stage`

一块烟熏玻璃，用来展示产品界面的示意。

- 结构：`.qz-stage-wrap[data-qz-rim]` > `.qz-stage-rim` + `.qz-stage` > `.qz-stage-pane` · `.qz-stage-divider` · `.qz-stage-pane`。
- 只有顶部和左右三条边（0.10 / 0.06 白），顶部两角 10px，**没有底边**：底部用遮罩从 76% 处淡出到透明，溶进黑色。
- 顶沿叠一条 88% 宽的高光线，不透明度 `0.32 + --qz-rim × 0.68`。
- 两栏比例 1.05 : 1，中间 1px 的渐隐分隔线。≤900px 堆叠成单列，遮罩起点改到 88%。
- 内部可用 `.qz-prompt-quote`、`.qz-choices`（三选一，`.is-selected` 为 0.04 白填充）、`.qz-milestones`、`.qz-stage-label`。
- 舞台里的界面示意用线框 SVG 画，不放真实截图。

## 命令块 `.qz-cmd`

文档中可复制的命令或提示词。

- `.qz-cmd-frame`：`#0A0A0A` 底、0.09 白边、6px 圆角。可选 `.qz-cmd-head`（等宽标题栏，下方 0.07 白线）。
- `.qz-cmd-body`：文字 + 右上角 `.qz-btn-copy`。命令用 `.qz-cmd-text.is-mono`（0.9rem 等宽，LTR）；自然语言提示词不加 `.is-mono`（1rem Sora，随页面方向）。
- 上方可选 `.qz-cmd-label` 说明。
- 代码块不画假的 macOS 红黄绿圆点。

## 标注截图 `.qz-shot`

真实截图 + 编号标注框 + 图例。

- `.qz-shot-canvas`：`#0A0A0A` 底、0.09 白边、6px 圆角。手机截图加 `.is-mobile`（最宽 340px、14px 圆角）。
- `.qz-callout`：按百分比绝对定位的 1.5px 框，默认琥珀（需要用户操作的位置），`.is-ice` 为冰蓝（系统给出的结果）。填充为对应颜色的 0.06。
- `.qz-pin`：19px 圆形编号，黑字、等宽 600。默认压在框的左上角，可用 `.pin-top-right` / `.pin-bottom-left` / `.pin-bottom-right` 换角。
- `.qz-legend`：截图下方的图例，每项一个 `.qz-pin.is-small`（16px）+ 文字。标注框本身 `aria-hidden`，信息由图例承载。
- 截图容器始终 LTR。

## 侧栏导航 `.qz-sidenav` 与目录 `.qz-toc`

- 侧栏背景是**不透明**的 `#000000`，右侧一条发丝线。
- 分组标签 `.qz-sidenav-label`：0.79rem / 500 / 字距 +0.04em / `#666666`。分组之间 2rem。
- 链接：0.936rem、`#8F8F8F`、5px 圆角；悬停白字 + 0.035 白填充。
- 当前页 `aria-current="page"`：0.06 白填充、白字、500 字重、`inline-start` 一条 1.5px 白线。
- 目录链接 0.84rem、`#6E6E6E`，悬停或当前变白，没有背景。

## 长文 `.qz-prose`

- 正文 1.147rem / 1.7 / `#D4D4D4`，最宽 54rem。段落、列表、表格上方 2rem。
- `h1` 500 / -0.035em；`h2` 下方一条 0.07 白线，并叠一条随滚动点亮的高光线（`--qz-near`）；`h3` 无线。
- 链接：`#E5E5E5` + 低透明度下划线，悬停变白。**链接不使用冰蓝。**
- 行内代码 `#141414` 底 4px 圆角；代码块 `#0A0A0A` + 0.09 白边 + 6px 圆角，始终 LTR。
- 引用块：左侧 1.5px 的 0.28 白线，`#0A0A0A` 底，只有 `inline-end` 一侧两个 6px 圆角。
- 表格：只有行底发丝线，没有竖线和斑马纹；表头 500 白字。
- `.qz-seam`：页面标题块与正文之间的一条安静高光线。
- 教程步骤标题：`<h2><span class="qz-step-no">1</span> 标题</h2>`。

## 页脚 `.qz-footer`

顶部发丝线，上下 2.25rem，0.84rem `--qz-ink-secondary`。左侧一句版权或许可，右侧一排链接；悬停与当前项为白色。没有多列站点地图，没有 logo。

---

# 应用组件

以下组件为治理面（`docs/GOVERNANCE_SURFACE.md`）追加：一个只「看」和「签」的产品界面。它们全部取用既有 token，不引入新的颜色、阴影或动效；上文各组件的行为不变。

## 应用骨架 `.qz-app`

三栏，各有固定职责，从不互换。

```html
<div class="qz-page">
  <div class="qz-app">
    <a class="qz-skip-link" href="#main">跳到正文</a>
    <header class="qz-app-nav">
      <div class="qz-app-nav-inner">
        <div class="qz-app-status" role="status" hidden>…</div>
        <div class="qz-app-bar">
          <div class="qz-app-brand"><a class="qz-brand"><span class="qz-wordmark">Quetzalcoatl</span></a></div>
          <nav class="qz-sidenav"><ul class="qz-app-nav-list"><li><a aria-current="page">…</a></li></ul></nav>
        </div>
      </div>
    </header>
    <main class="qz-app-main">…</main>
    <aside class="qz-app-aside"><div class="qz-app-aside-inner">…</div></aside>
  </div>
</div>
```

- 左栏 `.qz-app-nav` 与右栏 `.qz-app-aside` 是不透明的 `--qz-void`，光学地平线只落在中间的 `.qz-app-main`。两栏内容各自 sticky。
- 导航入口沿用 `.qz-sidenav` 的链接样式；入口旁的 `.qz-nav-signal`（琥珀圆点加可选数字）只表示「这一页有事在等你」，必须带读屏文字。
- `.qz-app-status`：导航上方的一行，由琥珀状态词、一句下一步和一个紧凑描边按钮组成。只在后端联系不上时出现。
- `.qz-app-main` 是一个 `container`（名为 `qz-main`）：其中的 `.qz-rail.is-grid` 按这一栏的宽度换列（四格在 38rem 以下成对，三格在 30rem 以下直接单列，24rem 以下全部单列），而不是按视口。
- ≤ 900px：导航收成顶部一行，入口横向滚动、不折叠成汉堡菜单；右栏变成正文下方的一段。此时 `.qz-app` 上的 `--qz-app-layout` 为 `narrow`，脚本读它而不是重述断点。
- `.qz-app-aside.is-following`：窄屏下把右栏挪到选中条目的内部，紧跟在它下面；条目自己的文字不再重复。
- 骨架内的 `:disabled` 与 `[aria-disabled="true"]` 一律 0.38 不透明度。写操作在途时用 `aria-disabled` 而不是 `disabled`，以免键盘焦点丢失。

## 视图 `.qz-view`

- `.qz-view-head`：左侧 `h1.qz-title` 加一句 `.qz-view-lead`，右侧是这一页的状态词（可选）。
- `.qz-view-section`：视图内的区块。顶部一条发丝线，其上叠一条随滚动点亮的高光线（加 `data-qz-lit`）。标题用 `.qz-view-section-title`；紧随并从属于上一区块的用 `.is-minor`，字号小一级。
- `.qz-presence`：居中的 `.qz-display` 名字、一句 `.qz-lead` 和一行 `.qz-meta-line`。一个产品里只用一次。
- 单元格补充：`.qz-cell-title`（任意标题级别的单元格标题）、`.qz-cell-note`（等宽的日期或计数）、`.qz-cell-sub`（第二句更安静的话）。`.qz-rail-group` 把一条栅格和它的 `.qz-rail-head` 结成一组，组与组之间留 2.25rem；组里还没有东西可列时用一句 `.qz-rail-group-note`。

## 选取 `.qz-pick`

选中一个条目以查看它的来历。

- `.qz-pick` 是一个只带条目自身文字的 `<button>`，它的 `::after` 铺满所在容器，因此整个条目都可点，而标题层级与文字语义保持不变。容器是 `.qz-row`、`.qz-clause` 或 `.qz-cell.is-pickable`。
- 选中态：容器加 `.is-current`（0.06 白填充；行与条款另有 `inline-start` 一条 1.5px 白线），按钮加 `aria-current="true"`。不使用冰蓝。
- 焦点环画在整个容器上：1px 冰蓝，内收 1px。
- 条目内部其它可交互的内容放进 `.qz-row-detail` / `.qz-row-action`，它们位于点击区之上。
- 一组条目加 `data-roving` 后只占一个 Tab 停靠点，组内用方向键移动。

## 行列表 `.qz-list` / `.qz-row`

- `.qz-list` 顶部一条 0.10 白线，行与行之间是发丝线。没有外框。
- `.qz-row`：`.qz-pick > .qz-row-text` 加一行 `.qz-row-meta`（等宽元信息与状态词）。
- `.qz-row.has-action`：行末带一个紧凑描边按钮。`.qz-row.is-ledger`：一行里依次是等宽时间 `.qz-ledger-time`、动作 `.qz-ledger-kind`、对象（`.qz-pick`）与执行者。
- `.qz-list-foot`：列表底部的计数与「再看一些」。列表按页读取，不做无限滚动。
- `.qz-signals` / `.qz-signal`：一个标记、一句话、一个靠右的安静事实。用于格子里的短清单。

## 定义列表 `.qz-deflist`

两列的 `<dl>`：左是等宽的术语，右是值；行间发丝线。值是标识符时加 `.is-mono`。

## 时间线 `.qz-timeline`

- 一条 0.18 白的竖轨，节点是压在轨上的 5px 方刻度。节点默认中性；`.is-amber` 表示这一步由人亲手做出；`.is-current` 为白色。
- `.qz-timeline-day` 是按天分组的小标题（等宽）。条目里依次是 `.qz-timeline-time` 与 `.qz-timeline-text`。
- `.is-compact` 用于侧栏里的短历史。

## 主从 `.qz-split`

左侧 `.qz-split-list` 是结果，右侧 `.qz-split-detail` 是选中条目的全文与动作，中间一条发丝线；详情在滚动时保持可见。≤ 900px 改为钻取：没有选中时只显示列表，选中后（容器加 `.has-selection`）只显示详情和一个 `.qz-split-back`。

## 工具条与动作

- `.qz-toolbar`：一行里放输入框、分段控件和靠右的计数。
- `.qz-actions`：左对齐的一排按钮。
- `.qz-btn-outline.is-compact`：行内尺度的描边按钮。在 `.qz-actions` 里带 `aria-pressed="true"` 时显示为按下（0.10 白填充、0.42 白边）。
- `.qz-btn-text`：最安静的文字按钮（取消、返回、展开），带低透明度下划线。
- `.qz-state.is-quiet`：只陈述事实、不向人要什么的状态词，比冰蓝和琥珀都安静。
- `.qz-code-chip`：句子里的一条命令。

## 表单

- `.qz-field`：`.qz-field-label` + 控件 + `.qz-field-hint`。出错时提示加 `.is-amber`（需要人介入），并同时以文字说明原因。
- `.qz-input.is-multiline`：多行文本，容器与单行输入框同族，内部放 `<textarea>`。
- `.qz-input.is-secret`：口令。等宽、略放字距。
- 复选框、开关与下拉仍未定义。

## 条款 `.qz-clauses`

一份简短的编号文书：每条是 `.qz-clause-no`（等宽两位数）、`.qz-clause-title`、`.qz-clause-text`，行末是这一条的动作；编辑时这一行换成 `.qz-clause-form`。

## 签署条 `.qz-sign-bar`

上下各一条 0.10 白线。左侧说明签署意味着什么并放口令字段（`.qz-sign-bar-fields`），右侧是这一屏唯一的 `.qz-btn-white`。

## 刻度 `.qz-scale`

两端之间的一个标记，和一条它越不过去的线。

```html
<div class="qz-scale">            <!-- 经 CSSOM 设置 --qz-scale-limit: 0–100 -->
  <div class="qz-scale-ends"><span>甲</span><span>乙</span></div>
  <div class="qz-scale-track">
    <div class="qz-scale-ticks"></div>
    <div class="qz-scale-limit"></div>
    <input class="qz-scale-input" type="range" min="0" max="<limit>" />
  </div>
  <div class="qz-scale-legend">…</div>
</div>
```

- 底轨是一条 0.18 白线，每十分之一一个刻度；标记是一个白色圆点。
- `--qz-scale-limit` 之外是虚线，起点处一条 1.5px 的白色竖线。原生滑杆只覆盖允许的那一段，所以标记在物理上到不了线的另一边。
- 没有填充色、没有冰蓝；焦点环是标记外的 1px 冰蓝。一个产品里至多一根。

## 对话框 `.qz-dialog`

原生 `<dialog>` 的模态，用于不可撤回的动作之前的再次确认。

- `#070707` 底、0.14 白边、6px 圆角，带系统唯一的阴影；背景遮罩是 84% 的黑，不加模糊。出现与消失都没有动画。
- 自上而下：琥珀状态词、`.qz-dialog-title`、`.qz-dialog-body`（可含 `.qz-prompt-quote` 引出被操作的原文）、可选字段、`.qz-dialog-actions`（右对齐：`.qz-btn-text` 取消 + `.qz-btn-outline` 确认）。
- 对话框里不放 `.qz-btn-white`。没有字段时默认焦点在「取消」。

## 状态版面 `.qz-situation`

空、失败、未就绪、联系不上：说清现状和下一步，而不是一行灰字。

- 自上而下：状态词、`.qz-situation-title`、`.qz-situation-body`，然后是步骤（`.qz-rail.is-grid.is-3`）、事实（`.qz-deflist`）、命令（`.qz-cmd`）与一个动作，按需取用。
- `.is-compact`：页面只有一部分为空时，嵌在那一部分原本的位置。

## 无障碍

- `.qz-sr-only`：只给读屏的文字。`.qz-skip-link`：只在获得键盘焦点时可见的「跳到正文」。
