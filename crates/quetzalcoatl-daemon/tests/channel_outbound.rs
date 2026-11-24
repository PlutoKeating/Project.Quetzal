#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 出站发送商品化路径：真实 HTTP(S) 传输、凭据 URL/Header 模板、last_delivery 健康状态。

use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use quetzalcoatl_daemon::ChannelRuntime;
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

fn home(tag: &str) -> Result<PathBuf, Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("qz_ch_out_{tag}_{}", Uuid::new_v4().simple()));
    fs::create_dir_all(dir.join("secrets"))?;
    Ok(dir)
}

fn write_secret(
    home: &Path,
    channel: &str,
    value: serde_json::Value,
) -> Result<(), Box<dyn Error>> {
    let path = home.join("secrets").join(format!("{channel}.json"));
    fs::write(path, value.to_string())?;
    Ok(())
}

type HookServer = (u16, thread::JoinHandle<Vec<u8>>);

/// 单次 HTTP 200 测试服务器。
fn start_http_ok_server() -> Result<HookServer, Box<dyn Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let handle = thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return Vec::new();
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = Vec::new();
        let mut chunk = [0u8; 2048];
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        buf
    });
    Ok((port, handle))
}

#[test]
fn channel_deliver_uses_credentials_real_http_and_records_health() -> TestResult {
    let home = home("ok")?;
    let (port, server) = start_http_ok_server()?;
    write_secret(
        &home,
        "webhook",
        serde_json::json!({"url": format!("http://127.0.0.1:{port}/hook"), "token": "synthetic-token", "secret": "synthetic-secret"}),
    )?;
    let mut runtime = ChannelRuntime::load(&home)?;
    runtime.enable("webhook")?;
    let report = runtime.deliver("webhook", "", "CANARY-SEND-BODY-998877")?;
    assert_eq!(report.channel, "webhook");
    assert_eq!(report.parts, 1);
    let request = server.join().map_err(|_| "server join")?;
    let text = String::from_utf8_lossy(&request);
    assert!(text.contains("Authorization: Bearer synthetic-token"));
    assert!(text.contains("X-QZ-Signature: sha256="));
    assert!(text.contains("CANARY-SEND-BODY-998877"));

    let health = runtime
        .health()
        .into_iter()
        .find(|h| h.channel == "webhook")
        .ok_or("missing health")?;
    let delivery = health.last_delivery.ok_or("missing last_delivery")?;
    assert!(delivery.ok);
    assert!(delivery.error.is_none());
    Ok(())
}

#[test]
fn channel_deliver_records_last_error_without_echoing_body() -> TestResult {
    let home = home("err")?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    write_secret(
        &home,
        "webhook",
        serde_json::json!({"url": format!("http://127.0.0.1:{port}/hook")}),
    )?;
    let mut runtime = ChannelRuntime::load(&home)?;
    runtime.enable("webhook")?;
    let err = runtime
        .deliver("webhook", "", "CANARY-ERROR-BODY-998877")
        .err()
        .ok_or("connection refused must fail")?;
    assert!(!err.to_string().contains("CANARY-ERROR-BODY-998877"));
    let health = runtime
        .health()
        .into_iter()
        .find(|h| h.channel == "webhook")
        .ok_or("missing health")?;
    let delivery = health.last_delivery.ok_or("missing last_delivery")?;
    assert!(!delivery.ok);
    let recorded = delivery.error.ok_or("missing error")?;
    assert!(!recorded.contains("CANARY-ERROR-BODY-998877"));
    Ok(())
}

#[test]
fn channel_deliver_attempts_https_destination() -> TestResult {
    let home = home("https")?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let attempted = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&attempted);
    let handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
            let mut first = [0u8; 1];
            if stream.read(&mut first).is_ok() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    });
    write_secret(
        &home,
        "webhook",
        serde_json::json!({"url": format!("https://127.0.0.1:{port}/hook")}),
    )?;
    let mut runtime = ChannelRuntime::load(&home)?;
    runtime.enable("webhook")?;
    let _ = runtime.deliver("webhook", "", "https-attempt");
    handle.join().map_err(|_| "https server join")?;
    assert!(
        attempted.load(Ordering::SeqCst),
        "https:// destination must attempt a real TLS connection"
    );
    Ok(())
}

#[test]
fn channel_runtime_skips_stale_state_entry_without_failing_startup() -> TestResult {
    let home = home("stale")?;
    fs::create_dir_all(home.join("channels"))?;
    fs::write(
        home.join("channels/state.json"),
        r#"{"enabled":["not-a-real-channel","webhook"]}"#,
    )?;
    let runtime = ChannelRuntime::load(&home)?;
    assert!(runtime.is_enabled("webhook"));
    assert!(!runtime.is_enabled("not-a-real-channel"));
    Ok(())
}
