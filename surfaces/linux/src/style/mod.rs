#![forbid(unsafe_code)]

//! 样式层：把 `packages/design-system` 的 token 落到 GTK。
//!
//! 全部颜色、字号与间距集中在 `governance.css` 一处，视图代码只挂类名。
//! 字体（Sora、JetBrains Mono，均为 SIL OFL 1.1）随包携带：首次启动时落到用户缓存目录，
//! 再经 Pango 加入字体表，不污染系统字体。

use std::fs;
use std::path::PathBuf;

use gtk::prelude::*;
use gtk4 as gtk;
use libadwaita as adw;
use pango::prelude::FontMapExt;

/// 治理面的 GTK CSS（token → GTK）。
pub const GOVERNANCE_CSS: &str = include_str!("governance.css");

const FONTS: [(&str, &[u8]); 5] = [
    (
        "sora-latin-400-normal.ttf",
        include_bytes!("../../resources/fonts/sora-latin-400-normal.ttf"),
    ),
    (
        "sora-latin-500-normal.ttf",
        include_bytes!("../../resources/fonts/sora-latin-500-normal.ttf"),
    ),
    (
        "sora-latin-600-normal.ttf",
        include_bytes!("../../resources/fonts/sora-latin-600-normal.ttf"),
    ),
    (
        "jetbrains-mono-latin-400-normal.ttf",
        include_bytes!("../../resources/fonts/jetbrains-mono-latin-400-normal.ttf"),
    ),
    (
        "jetbrains-mono-latin-500-normal.ttf",
        include_bytes!("../../resources/fonts/jetbrains-mono-latin-500-normal.ttf"),
    ),
];

fn font_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join(".cache"))
        })?;
    Some(
        base.join("quetzalcoatl-desktop")
            .join(format!("fonts-{}", env!("CARGO_PKG_VERSION"))),
    )
}

/// 把随包字体登记进 Pango 字体表；返回成功登记的字体个数（失败静默回退系统字体）。
pub fn register_fonts() -> usize {
    let Some(dir) = font_dir() else {
        return 0;
    };
    if fs::create_dir_all(&dir).is_err() {
        return 0;
    }
    let Some(map) = gtk::Label::new(None).pango_context().font_map() else {
        return 0;
    };
    let mut loaded = 0;
    for (name, bytes) in FONTS {
        let path = dir.join(name);
        let present = fs::metadata(&path).is_ok_and(|meta| meta.len() == bytes.len() as u64);
        if !present && fs::write(&path, bytes).is_err() {
            continue;
        }
        if map.add_font_file(&path).is_ok() {
            loaded += 1;
        }
    }
    loaded
}

/// 安装样式：强制深色、登记字体、加载 CSS。幂等。
pub fn install() {
    adw::StyleManager::default().set_color_scheme(adw::ColorScheme::ForceDark);
    let Some(display) = gtk::gdk::Display::default() else {
        return;
    };
    thread_local! {
        static INSTALLED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    if INSTALLED.with(std::cell::Cell::get) {
        return;
    }
    INSTALLED.with(|flag| flag.set(true));
    register_fonts();
    let provider = gtk::CssProvider::new();
    provider.load_from_string(GOVERNANCE_CSS);
    gtk::style_context_add_provider_for_display(
        &display,
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION + 10,
    );
}
