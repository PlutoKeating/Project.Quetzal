#![forbid(unsafe_code)]

//! 拉模式 LLM 流桥（防坑规范 #14）。
//!
//! 全面禁用外语回调接口：宿主（Swift / Kotlin / C# / GTK4 / Web）只调用
//! [`ViewStream::next_events`] 主动拉取**有界批次**。生产者线程严格按需生产：
//! 未拉取时阻塞在命令通道上，因此不存在无界缓冲；`cancel()` 与 `Drop` 都会立即
//! 唤醒并 `join` 生产者线程，做到取消即时、零线程/零 fd 泄漏。

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 单次 `next_events` 允许返回的最大事件数（有界批次硬上界）。
pub const MAX_BATCH_EVENTS: usize = 64;

/// 默认拉取等待上限；超时返回 [`StreamError::Timeout`] 而不是永久阻塞宿主 UI 线程。
pub const DEFAULT_PULL_TIMEOUT: Duration = Duration::from_secs(5);

/// 全进程存活的流生产者线程数（用于泄漏断言与可观测性）。
static LIVE_PRODUCERS: AtomicUsize = AtomicUsize::new(0);

#[must_use]
pub fn live_producer_threads() -> usize {
    LIVE_PRODUCERS.load(Ordering::SeqCst)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamEventKind {
    /// 增量正文 token。
    Delta,
    /// 推理/思考增量。
    Reasoning,
    /// 工具调用片段。
    ToolCall,
    /// 本轮结束（携带终止原因文本）。
    Done,
    /// 上游错误（携带机器可读错误码/文本）。
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamEvent {
    pub seq: u64,
    pub kind: StreamEventKind,
    pub text: String,
}

/// 事件源：宿主无关的拉取式生成器（真实场景由回环网关的 SSE/HTTP 解析器驱动）。
pub trait EventSource: Send + 'static {
    /// 返回下一个事件；`None` 表示源已正常结束。
    fn next_event(&mut self) -> Option<StreamEvent>;
}

/// 确定性脚本源：测试与本地回放用。
pub struct ScriptedSource {
    events: std::vec::IntoIter<StreamEvent>,
}

impl ScriptedSource {
    #[must_use]
    pub fn new(events: Vec<StreamEvent>) -> Self {
        Self {
            events: events.into_iter(),
        }
    }
}

impl EventSource for ScriptedSource {
    fn next_event(&mut self) -> Option<StreamEvent> {
        self.events.next()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum StreamError {
    #[error("流已取消")]
    Cancelled,

    #[error("流源已结束")]
    Finished,

    #[error("拉取事件批次超时 ({timeout_ms} ms)")]
    Timeout { timeout_ms: u64 },

    #[error("流生产者通道已断开")]
    ProducerGone,

    #[error("流内部状态锁中毒")]
    Poisoned,
}

enum Command {
    Pull {
        max: usize,
        reply: SyncSender<Batch>,
    },
    Cancel,
}

struct Batch {
    events: Vec<StreamEvent>,
    finished: bool,
}

struct ProducerHandle {
    commands: Option<Sender<Command>>,
    join: Option<thread::JoinHandle<()>>,
}

struct LiveProducerGuard;

impl LiveProducerGuard {
    fn enter() -> Self {
        LIVE_PRODUCERS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for LiveProducerGuard {
    fn drop(&mut self) {
        LIVE_PRODUCERS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 拉模式视图流。`Send + Sync`，可被 UniFFI 作为 `Object` 暴露给三语言宿主。
pub struct ViewStream {
    producer: Mutex<ProducerHandle>,
    /// 串行化并发拉取，保证每个 `Pull` 的应答与调用者一一对应。
    pull_gate: Mutex<()>,
    cancelled: AtomicBool,
    finished: AtomicBool,
    pull_timeout: Duration,
}

impl ViewStream {
    #[must_use]
    pub fn spawn<S: EventSource>(source: S) -> Self {
        Self::spawn_with_timeout(source, DEFAULT_PULL_TIMEOUT)
    }

    #[must_use]
    pub fn spawn_with_timeout<S: EventSource>(mut source: S, pull_timeout: Duration) -> Self {
        let (command_tx, command_rx) = mpsc::channel::<Command>();
        let cancelled = AtomicBool::new(false);
        let join = thread::Builder::new()
            .name(String::from("qz-view-stream"))
            .spawn(move || {
                let _live = LiveProducerGuard::enter();
                producer_loop(&mut source, &command_rx);
            })
            .ok();

        Self {
            producer: Mutex::new(ProducerHandle {
                commands: if join.is_some() {
                    Some(command_tx)
                } else {
                    None
                },
                join,
            }),
            pull_gate: Mutex::new(()),
            cancelled,
            finished: AtomicBool::new(false),
            pull_timeout,
        }
    }

    /// 主动拉取至多 `max_events` 个事件（内部硬夹在 `1..=MAX_BATCH_EVENTS`）。
    pub fn next_events(&self, max_events: usize) -> Result<Vec<StreamEvent>, StreamError> {
        let max = max_events.clamp(1, MAX_BATCH_EVENTS);
        let _gate = self.lock_pull_gate()?;

        if self.cancelled.load(Ordering::SeqCst) {
            return Err(StreamError::Cancelled);
        }
        if self.finished.load(Ordering::SeqCst) {
            return Err(StreamError::Finished);
        }

        let command_tx = {
            let guard = self.lock_producer()?;
            guard
                .commands
                .as_ref()
                .cloned()
                .ok_or(StreamError::ProducerGone)?
        };

        let (reply_tx, reply_rx) = mpsc::sync_channel::<Batch>(1);
        if command_tx
            .send(Command::Pull {
                max,
                reply: reply_tx,
            })
            .is_err()
        {
            return Err(self.transport_error());
        }

        match reply_rx.recv_timeout(self.pull_timeout) {
            Ok(batch) => {
                if batch.finished {
                    self.finished.store(true, Ordering::SeqCst);
                }
                if batch.events.is_empty() {
                    return Err(self.transport_error());
                }
                Ok(batch.events)
            }
            Err(RecvTimeoutError::Timeout) => Err(StreamError::Timeout {
                timeout_ms: u64::try_from(self.pull_timeout.as_millis()).unwrap_or(u64::MAX),
            }),
            Err(RecvTimeoutError::Disconnected) => Err(self.transport_error()),
        }
    }

    /// 立即取消并回收生产者线程（幂等）。
    pub fn cancel(&self) -> Result<(), StreamError> {
        self.cancelled.store(true, Ordering::SeqCst);
        let (commands, join) = {
            let mut guard = self.lock_producer()?;
            (guard.commands.take(), guard.join.take())
        };
        if let Some(tx) = commands {
            let _ = tx.send(Command::Cancel);
            // 显式 drop：通道关闭后生产者会在下一个 recv 立即退出。
            drop(tx);
        }
        if let Some(handle) = join {
            let _ = handle.join();
        }
        Ok(())
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    fn transport_error(&self) -> StreamError {
        if self.cancelled.load(Ordering::SeqCst) {
            StreamError::Cancelled
        } else if self.finished.load(Ordering::SeqCst) {
            StreamError::Finished
        } else {
            StreamError::ProducerGone
        }
    }

    fn lock_producer(&self) -> Result<MutexGuard<'_, ProducerHandle>, StreamError> {
        self.producer.lock().map_err(|_| StreamError::Poisoned)
    }

    fn lock_pull_gate(&self) -> Result<MutexGuard<'_, ()>, StreamError> {
        self.pull_gate.lock().map_err(|_| StreamError::Poisoned)
    }
}

impl Drop for ViewStream {
    fn drop(&mut self) {
        let _ = self.cancel();
    }
}

fn producer_loop<S: EventSource>(source: &mut S, commands: &Receiver<Command>) {
    loop {
        let Ok(command) = commands.recv() else {
            return;
        };
        match command {
            Command::Cancel => return,
            Command::Pull { max, reply } => {
                let mut events = Vec::with_capacity(max.min(16));
                let mut finished = false;
                while events.len() < max {
                    match source.next_event() {
                        Some(event) => events.push(event),
                        None => {
                            finished = true;
                            break;
                        }
                    }
                }
                if reply.send(Batch { events, finished }).is_err() {
                    return;
                }
                if finished {
                    return;
                }
            }
        }
    }
}
