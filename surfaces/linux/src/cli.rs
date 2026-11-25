#![forbid(unsafe_code)]

//! 极简命令行解析：`--self-test`、`--home <dir>`、`--help`、`--version`。
//!
//! 刻意不引入 `clap`：桌面端只有 4 个参数，手写解析保持零额外依赖与零歧义。

use std::path::PathBuf;

use quetzalcoatl_client_core::resolve_client_home;

use crate::app::DesktopOptions;

/// 帮助文本。
pub const HELP: &str = "\
Usage:
  quetzalcoatl-desktop [OPTIONS]

Options:
  --home <dir>      Quetzalcoatl home directory (or QUETZALCOATL_HOME)
  --self-test       Render the window headlessly, print SELF_TEST_OK, then exit
  -V, --version     Print version
  -h, --help        Print this help
";

/// 版本横幅。
pub const VERSION_BANNER: &str = concat!("quetzalcoatl-desktop ", env!("CARGO_PKG_VERSION"));

/// 解析结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cli {
    /// 正常启动。
    Run(DesktopOptions),
    /// 打印帮助。
    Help,
    /// 打印版本。
    Version,
    /// 非法参数（附原因）。
    Invalid(String),
}

/// 解析参数（不含 argv[0]）。
#[must_use]
pub fn parse(args: &[String]) -> Cli {
    let mut home: Option<PathBuf> = None;
    let mut self_test = false;
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "-h" | "--help" => return Cli::Help,
            "-V" | "--version" => return Cli::Version,
            "--self-test" => self_test = true,
            "--home" => {
                let Some(value) = args.get(index + 1) else {
                    return Cli::Invalid(String::from("--home 需要一个目录参数"));
                };
                if value.trim().is_empty() {
                    return Cli::Invalid(String::from("--home 不能为空"));
                }
                home = Some(PathBuf::from(value));
                index += 1;
            }
            other => {
                return Cli::Invalid(format!(
                    "未知参数 `{other}`（支持 --home / --self-test / --version / --help）"
                ));
            }
        }
        index += 1;
    }

    Cli::Run(DesktopOptions {
        home: resolve_client_home(home),
        config_path: crate::config::DesktopConfig::default_path(),
        self_test,
    })
}
