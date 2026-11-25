#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

fn main() -> std::process::ExitCode {
    uniffi::uniffi_bindgen_main();
    std::process::ExitCode::SUCCESS
}
