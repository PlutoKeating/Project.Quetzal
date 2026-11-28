#![forbid(unsafe_code)]

//! 治理面的原生构件：状态词、发丝线栅格、定义列表、状态版面……
//!
//! 全部只挂 `style/governance.css` 里的类名；这里不出现任何颜色或字号。
//! 没有「发送」类构件：唯一可编辑的控件是搜索框、改一条的文本框、写一条底线的两个框与口令框。

use gtk::prelude::*;
use gtk4 as gtk;
use gtk4::pango;

use crate::a11y;
use crate::timefmt::ordinal;

/// 信号的语气：冰蓝 = 已生效、通；琥珀 = 需要你、你说的、不通；其余只陈述事实。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Ice,
    Amber,
    Quiet,
}

impl Tone {
    const fn class(self) -> &'static str {
        match self {
            Self::Ice => "is-ice",
            Self::Amber => "is-amber",
            Self::Quiet => "is-quiet",
        }
    }

    /// 给读屏与测试用的稳定名字。
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Ice => "ice",
            Self::Amber => "amber",
            Self::Quiet => "quiet",
        }
    }
}

/// 纵向盒子。
#[must_use]
pub fn vbox(spacing: i32) -> gtk::Box {
    gtk::Box::new(gtk::Orientation::Vertical, spacing)
}

/// 横向盒子。
#[must_use]
pub fn hbox(spacing: i32) -> gtk::Box {
    gtk::Box::new(gtk::Orientation::Horizontal, spacing)
}

/// 清空一个盒子的全部子控件。
pub fn clear(container: &gtk::Box) {
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }
}

/// 一段会换行的文字（靠左，按词或字折行）。
#[must_use]
pub fn text(content: &str, classes: &[&str]) -> gtk::Label {
    let label = gtk::Label::new(Some(content));
    label.set_wrap(true);
    label.set_wrap_mode(pango::WrapMode::WordChar);
    label.set_xalign(0.0);
    label.set_halign(gtk::Align::Fill);
    label.set_max_width_chars(60);
    for class in classes {
        label.add_css_class(class);
    }
    label
}

/// 一行不换行的文字（等宽元信息等）。
#[must_use]
pub fn line(content: &str, classes: &[&str]) -> gtk::Label {
    let label = gtk::Label::new(Some(content));
    label.set_xalign(0.0);
    label.set_ellipsize(pango::EllipsizeMode::End);
    for class in classes {
        label.add_css_class(class);
    }
    label
}

/// 页内标题：读屏用标题语义（`label` 的无障碍角色是文本，这里补上名字）。
#[must_use]
pub fn heading(content: &str, classes: &[&str]) -> gtk::Label {
    let label = text(content, classes);
    a11y::set_label(&label, content);
    label
}

/// 6px 圆点；`Quiet` 是空心环（没有发生、没有选中）。
#[must_use]
pub fn dot(tone: Tone) -> gtk::Box {
    let mark = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    mark.set_valign(gtk::Align::Center);
    mark.set_halign(gtk::Align::Start);
    mark.add_css_class(if tone == Tone::Quiet {
        "qz-ring"
    } else {
        "qz-dot"
    });
    mark.add_css_class(tone.class());
    mark
}

/// 状态词：一个圆点加一句话。颜色从不单独承担含义。
#[must_use]
pub fn state_word(tone: Tone, word: &str) -> gtk::Box {
    let holder = hbox(8);
    holder.set_valign(gtk::Align::Center);
    holder.add_css_class("qz-state-word");
    holder.append(&dot(tone));
    let label = gtk::Label::new(Some(word));
    label.set_xalign(0.0);
    label.set_wrap(true);
    label.set_wrap_mode(pango::WrapMode::WordChar);
    label.add_css_class("qz-state");
    label.add_css_class(tone.class());
    holder.append(&label);
    a11y::set_label(&holder, word);
    holder
}

/// 一条横向发丝线。
#[must_use]
pub fn hairline() -> gtk::Box {
    let rule = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    rule.add_css_class("qz-hairline-h");
    rule
}

/// 一条纵向发丝线。
#[must_use]
pub fn vline() -> gtk::Box {
    let rule = gtk::Box::new(gtk::Orientation::Vertical, 0);
    rule.add_css_class("qz-hairline-v");
    rule.set_hexpand(false);
    rule.set_halign(gtk::Align::Center);
    rule
}

/// 白色主按钮：一屏至多一个。
#[must_use]
pub fn button_white(label: &str) -> gtk::Button {
    let button = gtk::Button::with_label(label);
    button.add_css_class("qz-btn-white");
    button
}

/// 描边按钮（次操作）。
#[must_use]
pub fn button_outline(label: &str, compact: bool) -> gtk::Button {
    let button = gtk::Button::with_label(label);
    button.add_css_class("qz-btn-outline");
    if compact {
        button.add_css_class("is-compact");
    }
    button
}

/// 最安静的文字按钮（取消、返回、展开）。
#[must_use]
pub fn button_text(label: &str) -> gtk::Button {
    let button = gtk::Button::with_label(label);
    button.add_css_class("qz-btn-text");
    button
}

/// 第三级：跳转到别的页（带方向箭头）。
#[must_use]
pub fn link_arrow(label: &str) -> gtk::Button {
    let button = gtk::Button::new();
    button.add_css_class("qz-link-arrow");
    button.set_halign(gtk::Align::Start);
    let row = hbox(8);
    row.append(&gtk::Label::new(Some(label)));
    row.append(&gtk::Image::from_icon_name("go-next-symbolic"));
    button.set_child(Some(&row));
    a11y::set_label(&button, label);
    button
}

/// 一整个可点的条目：只带条目自己的内容，选中是一层浅填充。
#[must_use]
pub fn pick(content: &impl IsA<gtk::Widget>, current: bool, line_mark: bool) -> gtk::Button {
    let button = gtk::Button::new();
    button.add_css_class("qz-pick");
    if line_mark {
        button.add_css_class("is-line");
    }
    if current {
        button.add_css_class("is-current");
    }
    button.set_child(Some(content));
    button.set_halign(gtk::Align::Fill);
    button.set_hexpand(true);
    button
}

/// 单元格的内容盒（发丝线栅格里的一格）。
#[must_use]
pub fn cell() -> gtk::Box {
    let holder = vbox(8);
    holder.add_css_class("qz-cell");
    holder.set_hexpand(true);
    holder.set_valign(gtk::Align::Fill);
    holder
}

/// 栅格按它自己的宽度（而不是窗口宽度）决定这一刻分几列：与 Web 版的容器查询同构。
/// 四格：宽则四列，中等成对，窄则单列；三格与两格：宽则并排，窄则单列。
#[must_use]
pub fn rail_columns(columns: u32, width: i32) -> u32 {
    match columns {
        0 | 1 => 1,
        2 => {
            if width >= 500 {
                2
            } else {
                1
            }
        }
        3 => {
            if width >= 560 {
                3
            } else {
                1
            }
        }
        _ => {
            if width >= 700 {
                columns
            } else if width >= 380 {
                2
            } else {
                1
            }
        }
    }
}

/// 发丝线栅格：卡片的替代品。`columns` 是宽屏时的列数；容器窄了自己换行。
#[must_use]
pub fn rail(cells: &[gtk::Widget], columns: u32) -> gtk::Box {
    let holder = gtk::Box::new(gtk::Orientation::Vertical, 0);
    holder.add_css_class("qz-rail");
    holder.set_hexpand(true);
    // 单元格左侧的发丝线画在格子外一像素：栅格把越界的部分裁掉，只留格与格之间的线。
    holder.set_overflow(gtk::Overflow::Hidden);
    let grid = gtk::Grid::new();
    grid.set_column_homogeneous(true);
    grid.set_hexpand(true);
    holder.append(&grid);
    let cells: Vec<gtk::Widget> = cells.to_vec();
    let current = std::rc::Rc::new(std::cell::Cell::new(0u32));
    let arrange = {
        let grid = grid.clone();
        let current = current.clone();
        move |count: u32| {
            if current.get() == count {
                return;
            }
            current.set(count);
            for cell in &cells {
                if cell.parent().is_some() {
                    grid.remove(cell);
                }
            }
            let count = i32::try_from(count.max(1)).unwrap_or(1);
            for (index, cell) in cells.iter().enumerate() {
                let index = i32::try_from(index).unwrap_or(0);
                grid.attach(cell, index % count, index / count, 1, 1);
            }
        }
    };
    arrange(columns);
    holder.add_tick_callback(move |widget, _| {
        let width = widget.width();
        if width > 0 {
            arrange(rail_columns(columns, width));
        }
        gtk::glib::ControlFlow::Continue
    });
    holder
}

/// 区块：顶部一条发丝线 + 标题 + 一句说明，其下是内容。
#[must_use]
pub fn section(
    title: &str,
    minor: bool,
    note: Option<&str>,
    content: &impl IsA<gtk::Widget>,
) -> gtk::Box {
    let block = vbox(14);
    block.add_css_class("qz-view-section");
    block.set_margin_top(32);
    let head = vbox(4);
    let title_label = heading(
        title,
        if minor {
            &["qz-section-title", "is-minor"]
        } else {
            &["qz-section-title"]
        },
    );
    head.append(&title_label);
    if let Some(note) = note {
        head.append(&text(note, &["qz-section-note"]));
    }
    block.append(&head);
    block.append(content);
    block
}

/// 栅格上方的标题行：名称 + 靠右的元信息。
#[must_use]
pub fn rail_head(title: &str, trailing: &[gtk::Widget]) -> gtk::Box {
    let row = hbox(12);
    row.set_margin_bottom(12);
    let name = heading(title, &["qz-rail-title"]);
    name.set_hexpand(false);
    row.append(&name);
    for widget in trailing {
        row.append(widget);
    }
    row
}

/// 页首：左侧标题加一句话，右侧是这一页的状态词（可选）。
pub struct PageHead {
    pub root: gtk::Box,
    state: gtk::Box,
}

impl PageHead {
    #[must_use]
    pub fn new(title: &str, lead: &str) -> Self {
        let root = hbox(24);
        root.set_margin_bottom(8);
        let left = vbox(8);
        left.set_hexpand(true);
        left.append(&heading(title, &["qz-title"]));
        left.append(&text(lead, &["qz-view-lead"]));
        root.append(&left);
        let state = vbox(0);
        state.set_valign(gtk::Align::End);
        state.set_halign(gtk::Align::End);
        state.set_margin_bottom(6);
        root.append(&state);
        Self { root, state }
    }

    /// 换这一页的状态词；`None` 清掉。
    pub fn set_state(&self, state: Option<(Tone, String)>) {
        clear(&self.state);
        if let Some((tone, word)) = state {
            self.state.append(&state_word(tone, &word));
        }
    }
}

/// 一对术语与值（定义列表的一行）。
#[derive(Clone, Debug)]
pub struct Fact {
    pub term: String,
    pub value: String,
    pub mono: bool,
}

impl Fact {
    #[must_use]
    pub fn new(term: &str, value: impl Into<String>) -> Self {
        Self {
            term: term.to_owned(),
            value: value.into(),
            mono: false,
        }
    }

    /// 值是标识符时用等宽。
    #[must_use]
    pub fn mono(term: &str, value: impl Into<String>) -> Self {
        Self {
            mono: true,
            ..Self::new(term, value)
        }
    }
}

/// 两列定义列表：左是等宽的术语，右是值；行间发丝线。
#[must_use]
pub fn deflist(rows: &[Fact]) -> gtk::Box {
    let list = vbox(0);
    for fact in rows {
        let row = hbox(16);
        row.add_css_class("qz-deflist-row");
        let term = line(&fact.term, &["qz-deflist-term"]);
        term.set_width_chars(8);
        term.set_valign(gtk::Align::Start);
        row.append(&term);
        let value = text(
            &fact.value,
            if fact.mono {
                &["qz-deflist-value", "is-mono"]
            } else {
                &["qz-deflist-value"]
            },
        );
        value.set_hexpand(true);
        row.append(&value);
        list.append(&row);
    }
    list
}

/// 句子里的一条命令：等宽。
#[must_use]
pub fn code_chip(command: &str) -> gtk::Label {
    let chip = gtk::Label::new(Some(command));
    chip.add_css_class("qz-code-chip");
    chip.set_selectable(true);
    chip
}

/// 可复制的终端命令。
#[must_use]
pub fn command_block(label: &str, command: &str) -> gtk::Box {
    let block = vbox(8);
    block.append(&text(label, &["qz-body"]));
    let frame = hbox(12);
    frame.add_css_class("qz-cmd");
    let body = gtk::Label::new(Some(command));
    body.add_css_class("qz-cmd-text");
    body.set_xalign(0.0);
    body.set_hexpand(true);
    body.set_selectable(true);
    frame.append(&body);
    let copy = button_outline("复制", true);
    let command = command.to_owned();
    copy.connect_clicked(move |button| {
        button.display().clipboard().set_text(&command);
        button.set_label("已复制");
        let weak = button.downgrade();
        gtk::glib::timeout_add_local_once(std::time::Duration::from_millis(1800), move || {
            if let Some(button) = weak.upgrade() {
                button.set_label("复制");
            }
        });
    });
    frame.append(&copy);
    block.append(&frame);
    block
}

/// 状态版面的一格步骤。
pub struct Step {
    pub title: &'static str,
    pub text: &'static str,
}

/// 状态版面：空、失败、未就绪、联系不上——说清现状和下一步，而不是一行灰字。
pub struct Situation<'a> {
    pub kind: &'a str,
    pub tone: Tone,
    pub word: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub steps: &'a [Step],
    pub command: Option<(&'a str, &'a str)>,
    pub facts: Vec<Fact>,
    pub compact: bool,
}

impl Situation<'_> {
    /// 画出来；动作由调用方追加到返回的盒子里。
    #[must_use]
    pub fn build(&self) -> gtk::Box {
        let block = vbox(if self.compact { 10 } else { 16 });
        block.set_widget_name(&format!("situation-{}", self.kind));
        block.add_css_class("qz-situation");
        if self.compact {
            block.add_css_class("is-compact");
        }
        block.set_margin_top(if self.compact { 4 } else { 8 });
        block.set_margin_bottom(if self.compact { 4 } else { 8 });
        block.append(&state_word(self.tone, self.word));
        block.append(&heading(self.title, &["qz-situation-title"]));
        block.append(&text(self.body, &["qz-situation-body"]));
        if !self.steps.is_empty() {
            let cells: Vec<gtk::Widget> = self
                .steps
                .iter()
                .enumerate()
                .map(|(index, step)| {
                    let step_cell = cell();
                    step_cell.append(&line(&ordinal(index), &["qz-cell-num"]));
                    step_cell.append(&text(step.title, &["qz-cell-title"]));
                    step_cell.append(&text(step.text, &["qz-body"]));
                    step_cell.upcast::<gtk::Widget>()
                })
                .collect();
            block.append(&rail(&cells, 3));
        }
        if !self.facts.is_empty() {
            block.append(&deflist(&self.facts));
        }
        if let Some((label, command)) = self.command {
            block.append(&command_block(label, command));
        }
        block
    }
}

/// 一排动作按钮，靠左。
#[must_use]
pub fn actions() -> gtk::Box {
    let row = hbox(8);
    row.set_halign(gtk::Align::Start);
    row
}

/// 分段控件：`options` 是 `(键, 标签)`，`on_select` 收到被点的键。
#[must_use]
pub fn segmented(
    options: &[(&'static str, &'static str)],
    active: &str,
    on_select: impl Fn(&'static str) + 'static,
) -> gtk::Box {
    let tray = hbox(2);
    tray.add_css_class("qz-segmented");
    tray.set_halign(gtk::Align::Start);
    let on_select = std::rc::Rc::new(on_select);
    for (key, label) in options.iter().copied() {
        let segment = gtk::Button::with_label(label);
        segment.add_css_class("qz-segment");
        if key == active {
            segment.add_css_class("is-active");
        }
        let handler = on_select.clone();
        segment.connect_clicked(move |_| handler(key));
        tray.append(&segment);
    }
    tray
}

/// 一行带标签的字段：`label` + 控件 + 可选提示。
#[must_use]
pub fn field(label: &str, control: &impl IsA<gtk::Widget>, hint: Option<&str>) -> gtk::Box {
    let block = vbox(6);
    block.append(&text(label, &["qz-field-label"]));
    block.append(control);
    if let Some(hint) = hint {
        block.append(&text(hint, &["qz-field-hint"]));
    }
    block
}

/// 单行输入的外壳（边框与底色由样式层给）。
#[must_use]
pub fn input_shell(inner: &impl IsA<gtk::Widget>, secret: bool) -> gtk::Box {
    let shell = hbox(0);
    shell.add_css_class("qz-input");
    if secret {
        shell.add_css_class("is-secret");
    }
    inner.set_hexpand(true);
    shell.append(inner);
    shell
}

/// 一行出错或提示的文字（琥珀）；出错总同时说明原因。
#[must_use]
pub fn amber_hint(message: &str) -> gtk::Label {
    let hint = text(message, &["qz-field-hint", "is-amber"]);
    a11y::set_label(&hint, message);
    hint
}

/// 时间线节点的色调：默认中性；琥珀表示这一步由人亲手做出；白色是当前。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickTone {
    Neutral,
    Amber,
    Current,
}

/// 时间线上的一项：一条竖轨，节点是压在轨上的 5px 方刻度。
#[must_use]
pub fn timeline_item(
    time: Option<&str>,
    content: &impl IsA<gtk::Widget>,
    tone: TickTone,
    compact: bool,
) -> gtk::Overlay {
    let body = vbox(4);
    body.add_css_class("qz-timeline-item");
    if compact {
        body.add_css_class("is-compact");
    }
    if let Some(time) = time {
        body.append(&line(time, &["qz-timeline-time"]));
    }
    body.append(content);
    let tick = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    tick.add_css_class("qz-tick");
    match tone {
        TickTone::Neutral => {}
        TickTone::Amber => tick.add_css_class("is-amber"),
        TickTone::Current => tick.add_css_class("is-current"),
    }
    tick.set_halign(gtk::Align::Start);
    tick.set_valign(gtk::Align::Start);
    tick.set_margin_top(6);
    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(&body));
    overlay.add_overlay(&tick);
    overlay
}

/// 把一棵控件树里所有文字的折行宽度收窄（出处栏等窄栏用，避免文字把整栏撑宽）。
pub fn cap_label_width(root: &impl IsA<gtk::Widget>, chars: i32) {
    let mut stack = vec![root.as_ref().clone()];
    while let Some(widget) = stack.pop() {
        if let Some(label) = widget.downcast_ref::<gtk::Label>()
            && label.wraps()
        {
            label.set_max_width_chars(chars);
        }
        let mut child = widget.first_child();
        while let Some(node) = child {
            child = node.next_sibling();
            stack.push(node);
        }
    }
}

/// 设计系统的六色字标（`.qz-wordmark`）：自上而下六条色带，裁进字形里。
/// GTK 的样式表做不到「背景裁进文字」，这里用快照逐条裁剪、按带着色画同一段文字，
/// 结果是矢量的渲染节点，放大缩小都清晰。数值与 `tokens/colors.css` 的 `--qz-spectrum-*`
/// 及 `components.css` 的 `--qz-wm-top`、`--qz-wm-band` 一致。
#[must_use]
pub fn spectrum_wordmark(text: &str, size_px: f64) -> gtk::Picture {
    const SPECTRUM: [(f32, f32, f32); 6] = [
        (0x69 as f32, 0xdd as f32, 0x4a as f32),
        (0xf9 as f32, 0xd3 as f32, 0x43 as f32),
        (0xff as f32, 0xac as f32, 0x61 as f32),
        (0xff as f32, 0x8d as f32, 0x88 as f32),
        (0xde as f32, 0x87 as f32, 0xfe as f32),
        (0x2f as f32, 0xc4 as f32, 0xff as f32),
    ];
    const TOP_EM: f64 = 0.3;
    const BAND_EM: f64 = 0.118;
    let probe = gtk::Label::new(None);
    let layout = probe.create_pango_layout(Some(text));
    let mut font = pango::FontDescription::from_string("Sora");
    font.set_absolute_size(size_px * f64::from(pango::SCALE));
    font.set_weight(pango::Weight::Semibold);
    layout.set_font_description(Some(&font));
    let spacing = pango::AttrInt::new_letter_spacing((-0.4 * f64::from(pango::SCALE)) as i32);
    let attrs = pango::AttrList::new();
    attrs.insert(spacing);
    layout.set_attributes(Some(&attrs));
    let (width, height) = layout.pixel_size();
    let (width, height) = (width as f32, height as f32);
    let edge = |k: usize| ((TOP_EM + k as f64 * BAND_EM) * size_px) as f32;
    let snapshot = gtk::Snapshot::new();
    for (index, (r, g, b)) in SPECTRUM.iter().enumerate() {
        let top = if index == 0 { 0.0 } else { edge(index) };
        let bottom = if index == SPECTRUM.len() - 1 {
            height
        } else {
            edge(index + 1)
        };
        snapshot.push_clip(&gtk::graphene::Rect::new(
            0.0,
            top,
            width,
            (bottom - top).max(0.0),
        ));
        snapshot.append_layout(
            &layout,
            &gtk::gdk::RGBA::new(r / 255.0, g / 255.0, b / 255.0, 1.0),
        );
        snapshot.pop();
    }
    let picture = gtk::Picture::new();
    if let Some(paintable) = snapshot.to_paintable(Some(&gtk::graphene::Size::new(width, height))) {
        picture.set_paintable(Some(&paintable));
    }
    picture.set_can_shrink(false);
    picture.set_halign(gtk::Align::Start);
    picture.set_alternative_text(Some(text));
    picture.update_property(&[gtk::accessible::Property::Label(text)]);
    picture
}
