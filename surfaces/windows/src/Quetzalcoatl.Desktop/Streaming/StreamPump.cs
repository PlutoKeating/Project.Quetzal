namespace Quetzalcoatl.Desktop.Streaming;

using Quetzalcoatl.Desktop.Model;

/// <summary>
/// 拉模式事件源：唯一的读取入口。实现可以是真实 UniFFI <c>FfiViewStream</c>
/// （经 <c>Quetzalcoatl.Interop</c>）或确定性的合成源（演示与测试）。
/// </summary>
public interface IStreamSource : IDisposable
{
    /// <summary>
    /// 阻塞拉取至多 <paramref name="maxEvents"/> 个事件；返回 <c>false</c> 表示流已正常结束。
    /// 实现必须保证批次有界（绝不无界缓冲）。
    /// </summary>
    bool TryPull(int maxEvents, out IReadOnlyList<StreamEvent> events);
}

/// <summary>接收流批次的宿主（实现方负责在 UI 线程刷新绑定）。</summary>
public interface IStreamSink
{
    /// <summary>消费一个合并后的批次（可能多于一次拉取）。</summary>
    void OnBatch(IReadOnlyList<StreamEvent> events);

    /// <summary>流已正常结束。</summary>
    void OnCompleted();

    /// <summary>流异常中断（类型化错误文本已准备好）。</summary>
    void OnFaulted(Exception error);
}

/// <summary>UI 线程调度抽象：只允许非阻塞投递，绝不在后台线程直接改 UI。</summary>
public interface IUiDispatcher
{
    /// <summary>尝试投递一个回调；返回 <c>false</c> 表示 UI 已关闭。</summary>
    bool TryPost(Action callback);
}

/// <summary>流泵的可观测统计（快照，线程安全）。</summary>
public sealed record PumpStats(
    long PulledEvents,
    long AppliedBatches,
    long CoalescedPulls,
    double MaxDispatchLatencyMs,
    double LastDispatchLatencyMs,
    bool Completed,
    bool Faulted);

/// <summary>
/// 后台流泵：在专用线程拉取事件、合并高频更新，并**至多一个**待执行的 UI 回调，
/// 因此 UI 线程只做增量合并与绑定通知，永不阻塞在拉取或被事件洪峰淹没。
/// </summary>
public sealed class StreamPump : IDisposable
{
    private const int DefaultMaxEventsPerPull = 32;
    private const int MaxEventsPerDrain = 256;

    private readonly IStreamSource _source;
    private readonly IStreamSink _sink;
    private readonly IUiDispatcher _dispatcher;
    private readonly int _maxEventsPerPull;
    private readonly TimeSpan _idleDelay;
    private readonly Action<PumpStats>? _onStats;

    private readonly Lock _gate = new();
    private readonly List<StreamEvent> _pending = [];
    private readonly Thread _thread;

    private bool _postQueued;
    private long _postEnqueuedAt;
    private bool _stopRequested;
    private bool _disposed;
    private bool _sourceFinished;
    private bool _completionPosted;

    private long _pulledEvents;
    private long _appliedBatches;
    private long _coalescedPulls;
    private double _maxDispatchLatencyMs;
    private double _lastDispatchLatencyMs;
    private bool _completed;
    private bool _faulted;

    /// <summary>构造流泵（不启动线程）。</summary>
    public StreamPump(
        IStreamSource source,
        IStreamSink sink,
        IUiDispatcher dispatcher,
        int maxEventsPerPull = DefaultMaxEventsPerPull,
        TimeSpan? idleDelay = null,
        Action<PumpStats>? onStats = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(sink);
        ArgumentNullException.ThrowIfNull(dispatcher);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxEventsPerPull);

        _source = source;
        _sink = sink;
        _dispatcher = dispatcher;
        _maxEventsPerPull = Math.Min(maxEventsPerPull, 64);
        _idleDelay = idleDelay ?? TimeSpan.FromMilliseconds(15);
        _onStats = onStats;
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "qz-win-stream-pump",
        };
    }

    /// <summary>当前统计快照。</summary>
    public PumpStats Stats
    {
        get
        {
            lock (_gate)
            {
                return new PumpStats(
                    _pulledEvents,
                    _appliedBatches,
                    _coalescedPulls,
                    _maxDispatchLatencyMs,
                    _lastDispatchLatencyMs,
                    _completed,
                    _faulted);
            }
        }
    }

    /// <summary>启动后台拉取线程（幂等）。</summary>
    public void Start()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_thread.IsAlive)
        {
            return;
        }

        _thread.Start();
    }

    /// <summary>请求停止并等待线程收束（幂等）。</summary>
    public void Stop()
    {
        lock (_gate)
        {
            _stopRequested = true;
        }

        if (_thread.IsAlive && Thread.CurrentThread != _thread)
        {
            _ = _thread.Join(TimeSpan.FromSeconds(5));
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        Stop();
        _source.Dispose();
        _disposed = true;
    }

    private void Run()
    {
        try
        {
            while (true)
            {
                lock (_gate)
                {
                    if (_stopRequested)
                    {
                        return;
                    }
                }

                IReadOnlyList<StreamEvent> events;
                bool more;
                try
                {
                    more = _source.TryPull(_maxEventsPerPull, out events);
                }
                catch (Exception ex)
                {
                    Fault(ex);
                    return;
                }

                if (events.Count > 0)
                {
                    Enqueue(events);
                }

                if (!more)
                {
                    MarkSourceFinished();
                    return;
                }

                if (events.Count == 0)
                {
                    Thread.Sleep(_idleDelay);
                }
            }
        }
        catch (Exception ex)
        {
            Fault(ex);
        }
    }

    private void Enqueue(IReadOnlyList<StreamEvent> events)
    {
        var post = false;
        lock (_gate)
        {
            _pulledEvents += events.Count;
            _pending.AddRange(events);
            if (_postQueued)
            {
                _coalescedPulls++;
            }
            else
            {
                _postQueued = true;
                _postEnqueuedAt = System.Diagnostics.Stopwatch.GetTimestamp();
                post = true;
            }
        }

        if (post && !_dispatcher.TryPost(Drain))
        {
            lock (_gate)
            {
                _postQueued = false;
            }
        }
    }

    private void Drain()
    {
        List<StreamEvent> batch;
        lock (_gate)
        {
            var now = System.Diagnostics.Stopwatch.GetTimestamp();
            var latencyMs = (now - _postEnqueuedAt) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
            _lastDispatchLatencyMs = latencyMs;
            _maxDispatchLatencyMs = Math.Max(_maxDispatchLatencyMs, latencyMs);

            var take = Math.Min(_pending.Count, MaxEventsPerDrain);
            batch = _pending.GetRange(0, take);
            _pending.RemoveRange(0, take);
            _appliedBatches++;
        }

        // 关键次序：先在 UI 线程把本批事件真正落到模型，再决定是否还有下一批/是否完成。
        try
        {
            if (batch.Count > 0)
            {
                _sink.OnBatch(batch);
            }
        }
        catch (Exception ex)
        {
            Fault(ex);
            return;
        }

        bool more;
        var complete = false;
        lock (_gate)
        {
            more = _pending.Count > 0;
            if (more)
            {
                // 保持“至多一个待执行回调”，并为下一批重新计时。
                _postQueued = true;
                _postEnqueuedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            }
            else
            {
                _postQueued = false;
                if (_sourceFinished && !_completionPosted)
                {
                    _completionPosted = true;
                    _completed = true;
                    complete = true;
                }
            }
        }

        if (more)
        {
            if (!_dispatcher.TryPost(Drain))
            {
                lock (_gate)
                {
                    _postQueued = false;
                }
            }
        }
        else if (complete)
        {
            PostCompleted();
        }

        // 统计回调始终在 UI 线程上（检视态直接绑定，无需跨线程）。
        _onStats?.Invoke(Stats);
    }

    private void MarkSourceFinished()
    {
        var postComplete = false;
        lock (_gate)
        {
            _sourceFinished = true;
            if (_pending.Count == 0 && !_postQueued && !_completionPosted)
            {
                _completionPosted = true;
                _completed = true;
                postComplete = true;
            }
        }

        if (postComplete)
        {
            PostCompleted();
        }
    }

    private void PostCompleted()
    {
        try
        {
            _dispatcher.TryPost(_sink.OnCompleted);
        }
        catch (Exception)
        {
            // UI 已关闭：正常结束路径不再升级为错误。
        }
    }

    private void Fault(Exception error)
    {
        lock (_gate)
        {
            _faulted = true;
        }

        try
        {
            _dispatcher.TryPost(() => _sink.OnFaulted(error));
        }
        catch (Exception)
        {
            // UI 已关闭：无可投递的宿主。
        }
    }
}

/// <summary>
/// 确定性合成源：产生 <paramref name="eventCount"/> 个 <c>Delta</c> 事件后以 <c>Done</c> 收束。
/// 用于无守护进程的演示、UI 冒烟与 5,000 事件高频回归测试。
/// </summary>
public sealed class SyntheticStreamSource : IStreamSource
{
    private readonly int _eventCount;
    private readonly int _chunkSize;
    private readonly TimeSpan _delayPerPull;
    private int _nextSeq;

    /// <summary>构造合成源。</summary>
    public SyntheticStreamSource(int eventCount, int chunkSize = 32, TimeSpan? delayPerPull = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(eventCount);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(chunkSize);
        _eventCount = eventCount;
        _chunkSize = chunkSize;
        _delayPerPull = delayPerPull ?? TimeSpan.Zero;
    }

    /// <inheritdoc />
    public bool TryPull(int maxEvents, out IReadOnlyList<StreamEvent> events)
    {
        if (_delayPerPull > TimeSpan.Zero)
        {
            Thread.Sleep(_delayPerPull);
        }

        var limit = Math.Max(1, Math.Min(maxEvents, _chunkSize));
        var produced = new List<StreamEvent>(Math.Min(limit, 1 + _eventCount - _nextSeq));
        while (produced.Count < limit)
        {
            if (_nextSeq < _eventCount)
            {
                var seq = (ulong)_nextSeq;
                _nextSeq++;
                produced.Add(new StreamEvent(seq, StreamEventKind.Delta, $"delta-{seq}"));
                continue;
            }

            if (_nextSeq == _eventCount)
            {
                _nextSeq++;
                produced.Add(new StreamEvent((ulong)_eventCount, StreamEventKind.Done, "done"));
            }

            break;
        }

        events = produced;
        return _nextSeq <= _eventCount;
    }

    /// <inheritdoc />
    public void Dispose()
    {
    }
}
