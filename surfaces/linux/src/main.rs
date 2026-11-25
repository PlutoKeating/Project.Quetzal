#![forbid(unsafe_code)]

//! `quetzalcoatl-desktop` 可执行入口：解析参数后交给 GTK4 主循环。
//!
//! `quetzalcoatld` 在线时本进程只做本地认证 IPC 薄客户端；不可达时展示类型化离线视图。

use std::process::ExitCode;

use quetzalcoatl_desktop::app;
use quetzalcoatl_desktop::cli::{Cli, HELP, VERSION_BANNER, parse};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse(&args) {
        Cli::Help => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Cli::Version => {
            println!("{VERSION_BANNER}");
            ExitCode::SUCCESS
        }
        Cli::Invalid(reason) => {
            eprintln!("{reason}\n{HELP}");
            ExitCode::from(2)
        }
        Cli::Run(options) => ExitCode::from(app::run(options).get()),
    }
}
