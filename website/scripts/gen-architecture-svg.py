#!/usr/bin/env python3
"""生成 README 用的架构图 ../docs/assets/readme/architecture.{zh,en}.svg（1600×820）。
颜色取自 designSystem.ts 深色方案（手动同步）。琥珀只给心脏——那是「活着」的地方。
用法：python3 scripts/gen-architecture-svg.py"""
BG, PANEL, BOX, BORDER, FG, MUTED, ACCENT, SEC = "#0e0f11", "#131417", "#17181c", "#2a2b30", "#e8e4dd", "#a9a49c", "#f0a35e", "#7d8f8a"
FONT = 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'

L = {
 "zh": dict(body="身体 · 任意设备，经适配器接入", sample=("感官采样", "电量 · 体温 · 光照 · 运动"), twin=("身体数字孪生", "镜像为内部模型"), feel=("身体感受", "精力 · 冷热 · 明暗 · 被拿起"),
            core="Windler 运行基座 · 单进程 Node.js", heart=("心脏", "内驱力 + 生物钟 → 何时醒来"), mind=("大脑", "内省 → 行动 → 反思"), mem=("记忆", "人格 · 常驻记忆 · 日记 · 笔记"), model=("模型层", "任意供应商 · 顺序 · 故障转移"), guard=("闸门", "授权 · 审批 · 预算 · 急停 · 审计"), tools=("工具与动作", "经适配器作用于身体"),
            soul="灵魂 · 私有 git 仓库", repo=("灵魂仓库", "身份 · 人格 · 记忆"), others=("其他身体", "Hermes Agent / OpenClaw"), bridge="soul-bridge", gitsync="git · 全自动同步",
            gw=("本地网关", "127.0.0.1"), app=("Windler App", "控制台 + 安装器"), feishu=("飞书", "对话 + 交互卡片"), change="显著变化", wake="醒来"),
 "en": dict(body="Body · any device", sample=("Sensor samples", "battery · heat · light · motion"), twin=("Digital twin", "mirrored into an internal model"), feel=("Feelings", "energy · warmth · light · picked up"),
            core="Windler runtime · one Node.js process", heart=("Heart", "drives + clock → when to wake"), mind=("Mind", "introspect → act → reflect"), mem=("Memory", "personality · notes · journal"), model=("Model layer", "any provider · order · failover"), guard=("Guard", "permissions · approvals · stop"), tools=("Tools & actions", "act through the adapter"),
            soul="Soul · private git repo", repo=("Soul repository", "identity · memory"), others=("Other bodies", "Hermes Agent / OpenClaw"), bridge="soul-bridge", gitsync="git · automatic sync",
            gw=("Local gateway", "127.0.0.1"), app=("Windler app", "console + installer"), feishu=("Feishu", "chat + interactive cards"), change="significant change", wake="wake"),
}

def esc(s): return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def render(t):
    o = []
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 820" width="1600" height="820" font-family=\'{FONT}\'>')
    o.append(f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="{MUTED}"/></marker>'
             f'<radialGradient id="g"><stop offset="0" stop-color="{ACCENT}" stop-opacity=".35"/><stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/></radialGradient></defs>')
    o.append(f'<rect width="1600" height="820" rx="24" fill="{BG}"/>')
    def panel(x, y, w, h, title):
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="{PANEL}" stroke="{BORDER}"/>')
        o.append(f'<text x="{x+24}" y="{y+38}" font-size="20" font-weight="600" fill="{MUTED}" letter-spacing="1">{esc(title)}</text>')
    def box(x, y, w, h, title, sub, accent=False, cyl=False):
        stroke = ACCENT if accent else BORDER
        if cyl:
            o.append(f'<path d="M{x} {y+16} a{w/2} 16 0 0 1 {w} 0 v{h-32} a{w/2} 16 0 0 1 -{w} 0 z" fill="{BOX}" stroke="{stroke}" stroke-width="1.5"/><ellipse cx="{x+w/2}" cy="{y+16}" rx="{w/2}" ry="16" fill="{BOX}" stroke="{stroke}" stroke-width="1.5"/>')
            ty = y + 34
        else:
            o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{BOX}" stroke="{stroke}" stroke-width="{2 if accent else 1.5}"/>')
            ty = y
        if accent:
            o.append(f'<circle cx="{x+w/2}" cy="{y+h/2}" r="{w*0.7}" fill="url(#g)"/><circle cx="{x+26}" cy="{ty+36}" r="6" fill="{ACCENT}"/>')
        o.append(f'<text x="{x+w/2}" y="{ty+40}" text-anchor="middle" font-size="26" font-weight="600" fill="{FG}">{esc(title)}</text>')
        o.append(f'<text x="{x+w/2}" y="{ty+70}" text-anchor="middle" font-size="17" fill="{MUTED}">{esc(sub)}</text>')
    def arrow(x1, y1, x2, y2, label=None, both=False, lx=None, ly=None):
        o.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{MUTED}" stroke-width="2" marker-end="url(#a)"{" marker-start=\"url(#a)\"" if both else ""}/>')
        if label:
            o.append(f'<text x="{lx if lx is not None else (x1+x2)/2}" y="{ly if ly is not None else (y1+y2)/2 - 10}" text-anchor="middle" font-size="17" fill="{SEC}">{esc(label)}</text>')

    panel(60, 90, 400, 470, t["body"]); panel(520, 60, 650, 540, t["core"]); panel(1220, 60, 320, 540, t["soul"])
    box(100, 150, 320, 96, *t["sample"]); box(100, 290, 320, 96, *t["twin"]); box(100, 430, 320, 96, *t["feel"])
    arrow(260, 246, 260, 290); arrow(260, 386, 260, 430)
    # 行 1：心脏 → 大脑；行 2：模型层 · 记忆；行 3：工具 ← 闸门
    box(560, 130, 260, 100, *t["heart"], accent=True); box(870, 130, 260, 100, *t["mind"])
    box(560, 290, 260, 100, *t["model"]); box(870, 290, 260, 100, *t["mem"])
    box(560, 450, 260, 100, *t["tools"]); box(870, 450, 260, 100, *t["guard"])
    # 身体 → 心脏：折线，从数字孪生右侧出，沿两块面板之间上行
    o.append(f'<path d="M420 338 H490 V180 H556" fill="none" stroke="{MUTED}" stroke-width="2" marker-end="url(#a)"/>')
    o.append(f'<text x="490" y="118" text-anchor="middle" font-size="17" fill="{SEC}">{esc(t["change"])}</text>')
    o.append(f'<line x1="490" y1="124" x2="490" y2="180" stroke="{MUTED}" stroke-width="2" stroke-dasharray="3 5"/>')
    arrow(820, 180, 870, 180, t["wake"], ly=168)
    arrow(1000, 230, 1000, 290, both=True)                      # 大脑 ↔ 记忆
    arrow(880, 230, 800, 290, both=True)                        # 大脑 ↔ 模型层
    o.append(f'<path d="M1130 190 H1150 V500 H1132" fill="none" stroke="{MUTED}" stroke-width="2" marker-end="url(#a)"/>')  # 大脑 → 闸门
    arrow(870, 500, 820, 500)                                   # 闸门 → 工具
    box(1260, 130, 240, 120, *t["repo"], cyl=True); box(1260, 430, 240, 100, *t["others"])
    arrow(1130, 330, 1260, 215, t["gitsync"], both=True, lx=1195, ly=250)
    arrow(1380, 250, 1380, 430, t["bridge"], both=True, lx=1425, ly=345)
    box(560, 670, 240, 96, *t["gw"]); box(880, 670, 240, 96, *t["app"]); box(1260, 670, 240, 96, *t["feishu"])
    arrow(680, 600, 680, 670, both=True); arrow(800, 718, 880, 718, both=True); arrow(1120, 600, 1300, 670, both=True)
    o.append('</svg>')
    return "\n".join(o)

for lang, t in L.items():
    p = f"../docs/assets/readme/architecture.{lang}.svg"
    open(p, "w", encoding="utf8").write(render(t)); print(p)
