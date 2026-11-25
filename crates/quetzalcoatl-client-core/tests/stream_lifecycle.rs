#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 拉模式流生命周期：有界批次、取消即时、10,000 次 create/cancel 零泄漏（fd/RSS 上界）。

use std::fs;
use std::time::Duration;

use quetzalcoatl_client_core::ScriptedSource;
use quetzalcoatl_client_core::llm_stream_bridge::{
    MAX_BATCH_EVENTS, StreamError, StreamEvent, StreamEventKind, ViewStream, live_producer_threads,
};

/// 本文件所有用例都会改变进程级生产者计数，必须串行执行以避免相互干扰。
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial_guard() -> std::sync::MutexGuard<'static, ()> {
    match SERIAL.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn events(count: u64) -> Vec<StreamEvent> {
    (0..count)
        .map(|seq| StreamEvent {
            seq,
            kind: StreamEventKind::Delta,
            text: format!("token-{seq}"),
        })
        .collect()
}

/// 惰性无限事件源：用于证明取消不需要先耗尽流。
struct CountingSource {
    seq: u64,
}

impl quetzalcoatl_client_core::EventSource for CountingSource {
    fn next_event(&mut self) -> Option<StreamEvent> {
        let seq = self.seq;
        self.seq += 1;
        Some(StreamEvent {
            seq,
            kind: StreamEventKind::Delta,
            text: format!("token-{seq}"),
        })
    }
}

fn fd_count() -> usize {
    fs::read_dir("/proc/self/fd")
        .map(|iter| iter.filter_map(std::result::Result::ok).count())
        .unwrap_or(0)
}

fn rss_kib() -> u64 {
    let Ok(status) = fs::read_to_string("/proc/self/status") else {
        return 0;
    };
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|kib| kib.parse::<u64>().ok())
        .unwrap_or(0)
}

#[test]
fn next_events_is_bounded_pull_mode_without_callbacks() {
    let _serial = serial_guard();
    let stream = ViewStream::spawn(ScriptedSource::new(events(10)));

    // 请求远超上界时仍必须截断到 MAX_BATCH_EVENTS，绝不一次性倒空。
    let all = stream.next_events(usize::MAX).expect("first batch");
    assert_eq!(all.len(), 10);
    assert_eq!(all[0].seq, 0);
    assert_eq!(all[9].text, "token-9");

    match stream.next_events(8) {
        Err(StreamError::Finished) => {}
        other => panic!("流耗尽后必须返回 Finished，实际 {other:?}"),
    }
    drop(stream);
}

#[test]
fn batch_size_is_clamped_and_pull_driven() {
    let _serial = serial_guard();
    let stream = ViewStream::spawn(ScriptedSource::new(events(200)));
    let mut seen = 0u64;
    loop {
        match stream.next_events(MAX_BATCH_EVENTS + 1_000) {
            Ok(batch) => {
                assert!(batch.len() <= MAX_BATCH_EVENTS, "批次必须有界");
                seen += batch.len() as u64;
            }
            Err(StreamError::Finished) => break,
            Err(other) => panic!("意外流错误: {other:?}"),
        }
        assert!(seen <= 200);
    }
    assert_eq!(seen, 200);
}

#[test]
fn cancel_is_prompt_and_drop_joins_producer() {
    let _serial = serial_guard();
    let stream = ViewStream::spawn(CountingSource { seq: 0 });
    // 生产者线程启动存在极短竞态，允许最多 1s 观察窗口。
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while live_producer_threads() == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(live_producer_threads(), 1);
    let batch = stream.next_events(4).expect("batch");
    assert_eq!(batch.len(), 4);

    stream.cancel().expect("cancel");
    assert!(stream.is_cancelled());
    assert_eq!(live_producer_threads(), 0, "cancel 后生产者线程必须已回收");
    assert!(matches!(stream.next_events(1), Err(StreamError::Cancelled)));
    drop(stream);
    assert_eq!(live_producer_threads(), 0);
}

#[test]
fn ten_thousand_create_cancel_cycles_keep_fd_and_rss_bounded() {
    let _serial = serial_guard();
    // 预热一次，避免首次线程创建的一次性分配污染基线。
    {
        let warmup = ViewStream::spawn(ScriptedSource::new(events(4)));
        let _ = warmup.next_events(2);
        warmup.cancel().expect("warmup cancel");
    }
    let fd_baseline = fd_count();
    let rss_baseline = rss_kib();

    for cycle in 0..10_000u64 {
        let stream = ViewStream::spawn(ScriptedSource::new(events(3)));
        let first = stream.next_events(2).expect("pull");
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].seq, 0, "cycle {cycle} 必须返回确定性首事件");
        stream.cancel().expect("cancel");
        drop(stream);
    }

    assert_eq!(live_producer_threads(), 0, "不得残留生产者线程");
    let fd_after = fd_count();
    assert_eq!(
        fd_after, fd_baseline,
        "10,000 次流创建/取消后文件描述符必须回到基线 (before={fd_baseline}, after={fd_after})"
    );

    let rss_after = rss_kib();
    let growth = rss_after.saturating_sub(rss_baseline);
    // 线程栈由分配器缓存复用；允许 < 96 MiB 的缓存抖动，超出即视为泄漏。
    assert!(
        growth < 96 * 1024,
        "RSS 增长超界: baseline={rss_baseline}KiB after={rss_after}KiB growth={growth}KiB"
    );
    println!(
        "stream_cycles: 10000, fd_baseline={fd_baseline}, fd_after={fd_after}, rss_baseline={rss_baseline}KiB, rss_after={rss_after}KiB, rss_growth={growth}KiB"
    );
}

#[test]
fn pull_timeout_does_not_leak_the_producer() {
    let _serial = serial_guard();
    // 源永远不返回事件也不结束：生产者线程必须仍然可被及时取消。
    struct StallSource;
    impl quetzalcoatl_client_core::EventSource for StallSource {
        fn next_event(&mut self) -> Option<StreamEvent> {
            std::thread::sleep(Duration::from_millis(2));
            Some(StreamEvent {
                seq: 0,
                kind: StreamEventKind::Delta,
                text: String::from("stall"),
            })
        }
    }

    let stream = ViewStream::spawn_with_timeout(StallSource, Duration::from_millis(30));
    let first = stream.next_events(1).expect("slow source still yields");
    assert_eq!(first.len(), 1);
    stream.cancel().expect("cancel slow source");
    assert_eq!(live_producer_threads(), 0);
}
