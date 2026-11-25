namespace Quetzalcoatl.Desktop.Tests;

using System.Collections.Concurrent;
using System.Diagnostics;
using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.Streaming;
using Quetzalcoatl.Desktop.ViewModels;

/// <summary>
/// 模拟 UI 线程：单线程消息循环 + 间隔看门狗。真实 WinUI 也遵循同一模式
/// （DispatcherQueue.TryEnqueue 投递，回调在 UI 线程执行），因此这里测到的
/// 「主线程从不被拉取阻塞」对真实宿主同样成立。
/// </summary>
internal sealed class UiThreadHarness : IUiDispatcher, IDisposable
{
    private readonly ConcurrentQueue<Action> _queue = new();
    private readonly ManualResetEventSlim _stop = new(false);
    private readonly Thread _thread;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private long _lastIterationMs;
    private long _maxGapMs;
    private long _maxCallbackMs;
    private long _callbacks;
    private long _faults;

    public UiThreadHarness()
    {
        _thread = new Thread(Loop)
        {
            IsBackground = true,
            Name = "test-ui-thread",
        };
        _thread.Start();
    }

    public int PendingCallbacks => _queue.Count;

    public long MaxGapMs => Interlocked.Read(ref _maxGapMs);

    public long MaxCallbackMs => Interlocked.Read(ref _maxCallbackMs);

    public long Callbacks => Interlocked.Read(ref _callbacks);

    public long Faults => Interlocked.Read(ref _faults);

    public bool TryPost(Action callback)
    {
        if (_stop.IsSet)
        {
            return false;
        }

        _queue.Enqueue(callback);
        return true;
    }

    public void Dispose()
    {
        _stop.Set();
        _thread.Join(TimeSpan.FromSeconds(5));
    }

    private void Loop()
    {
        _lastIterationMs = _clock.ElapsedMilliseconds;
        while (!_stop.IsSet)
        {
            var now = _clock.ElapsedMilliseconds;
            Track(ref _maxGapMs, now - _lastIterationMs);
            _lastIterationMs = now;

            while (_queue.TryDequeue(out var callback))
            {
                var started = _clock.ElapsedMilliseconds;
                try
                {
                    callback();
                }
                catch (Exception)
                {
                    Interlocked.Increment(ref _faults);
                }

                Track(ref _maxCallbackMs, _clock.ElapsedMilliseconds - started);
                Interlocked.Increment(ref _callbacks);
            }

            Thread.Sleep(1);
        }
    }

    private static void Track(ref long target, long value)
    {
        long current;
        do
        {
            current = Interlocked.Read(ref target);
            if (value <= current)
            {
                return;
            }
        }
        while (Interlocked.CompareExchange(ref target, value, current) != current);
    }
}

/// <summary>5,000 事件高频流回归：UI 线程不掉帧、不重复、不丢事件。</summary>
public sealed class StreamPumpTests
{
    private static void WaitUntil(Func<bool> predicate, TimeSpan timeout, string what)
    {
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed < timeout)
        {
            if (predicate())
            {
                return;
            }

            Thread.Sleep(5);
        }

        Assert.Fail($"等待超时：{what}");
    }

    [Fact]
    public void FiveThousandEventsNeverBlockTheUiThread()
    {
        var model = UiModel.Offline("test");
        var announcements = new RecordingAnnouncementSink();
        var viewModel = new DesktopViewModel(model, announcements);
        using var harness = new UiThreadHarness();
        using var source = new SyntheticStreamSource(5_000, chunkSize: 16);
        using var pump = new StreamPump(source, viewModel, harness, maxEventsPerPull: 16);

        pump.Start();
        WaitUntil(
            () => pump.Stats.Completed && harness.PendingCallbacks == 0,
            TimeSpan.FromSeconds(30),
            "5,000 事件全部消费完成");

        var stats = pump.Stats;
        Console.WriteLine(
            $"PUMP_STATS events={stats.PulledEvents} batches={stats.AppliedBatches} "
            + $"coalesced={stats.CoalescedPulls} max_dispatch_latency_ms={stats.MaxDispatchLatencyMs:F2} "
            + $"ui_max_gap_ms={harness.MaxGapMs} ui_max_callback_ms={harness.MaxCallbackMs} "
            + $"ui_callbacks={harness.Callbacks} announcements={announcements.Texts.Count}");
        Assert.Equal(5_001, stats.PulledEvents); // 5,000 个 delta + 1 个 done
        Assert.False(stats.Faulted);
        Assert.Equal(5_000UL, model.Session.LastSeq);
        var transcript = viewModel.Transcript;
        Assert.Contains("delta-4999", transcript, StringComparison.Ordinal);
        Assert.Equal(1, transcript.Split("delta-0", StringSplitOptions.None).Length - 1);

        Assert.True(
            harness.MaxGapMs < 150,
            $"UI 线程出现 {harness.MaxGapMs}ms 停顿（阈值 150ms）");
        Assert.True(
            harness.MaxCallbackMs < 150,
            $"单次 UI 批次回调耗时 {harness.MaxCallbackMs}ms（阈值 150ms）");
        Assert.True(
            stats.MaxDispatchLatencyMs < 300,
            $"调度队列延迟 {stats.MaxDispatchLatencyMs:F1}ms（阈值 300ms）");

        Assert.True(announcements.Texts.Count > 0, "流式批次必须产生播报");
        Assert.True(
            announcements.Texts.Count <= stats.AppliedBatches,
            $"播报次数 {announcements.Texts.Count} 不得超过批次 {stats.AppliedBatches}");
        Assert.True(harness.Callbacks >= stats.AppliedBatches);
        Assert.Equal(0, harness.Faults);
    }

    [Fact]
    public void PumpReportsStatsOnTheUiThread()
    {
        var viewModel = new DesktopViewModel(UiModel.Offline("test"), new RecordingAnnouncementSink());
        using var harness = new UiThreadHarness();
        using var source = new SyntheticStreamSource(64, chunkSize: 16);
        using var pump = new StreamPump(
            source,
            viewModel,
            harness,
            maxEventsPerPull: 16,
            onStats: stats => viewModel.SetPumpStats(stats));

        pump.Start();
        WaitUntil(
            () => pump.Stats.Completed && harness.PendingCallbacks == 0,
            TimeSpan.FromSeconds(5),
            "统计回调");
        Thread.Sleep(20);

        Assert.Contains("合并批次", viewModel.PumpSummary, StringComparison.Ordinal);
        Assert.Contains("事件 65", viewModel.PumpSummary, StringComparison.Ordinal);
    }

    [Fact]
    public void PumpDisposeIsIdempotentAndStopsTheProducer()
    {
        var viewModel = new DesktopViewModel(UiModel.Offline("test"), new RecordingAnnouncementSink());
        using var harness = new UiThreadHarness();
        var pump = new StreamPump(new SyntheticStreamSource(10_000, delayPerPull: TimeSpan.FromMilliseconds(2)), viewModel, harness, 8);
        pump.Start();
        pump.Stop();
        pump.Dispose();
        pump.Dispose();

        var seen = pump.Stats.PulledEvents;
        Thread.Sleep(50);
        Assert.Equal(seen, pump.Stats.PulledEvents);
        Assert.True(seen < 10_000, "停止后不得继续拉取全部事件");
    }

    [Fact]
    public void FaultedSourceSurfacesTypedErrorOnUiThread()
    {
        var viewModel = new DesktopViewModel(UiModel.Offline("test"), new RecordingAnnouncementSink());
        using var harness = new UiThreadHarness();
        using var pump = new StreamPump(new ThrowingSource(), viewModel, harness, 8);

        pump.Start();
        // 只等 `Stats.Faulted` 会有窗口期：pump 先置位再投递 UI 回调，
        // 轮询线程可能正好卡在两者之间，于是断言到空的 TechnicalLog。
        // 这里改为等待可观察结果本身落地（CI 上曾因此单点失败）。
        WaitUntil(
            () => pump.Stats.Faulted
                && harness.PendingCallbacks == 0
                && viewModel.TechnicalLog.Any(line => line.Contains("NativeFailure", StringComparison.Ordinal)),
            TimeSpan.FromSeconds(5),
            "故障回调");

        Assert.Contains(viewModel.TechnicalLog, line => line.Contains("NativeFailure", StringComparison.Ordinal));
        Assert.Contains("这次没有收到回复，请稍后重试。", viewModel.Notices);
        Assert.Equal(0, harness.Faults);
    }

    private sealed class ThrowingSource : IStreamSource
    {
        public bool TryPull(int maxEvents, out IReadOnlyList<StreamEvent> events)
        {
            _ = maxEvents;
            events = Array.Empty<StreamEvent>();
            throw new NativeFailureException();
        }

        public void Dispose()
        {
        }
    }

    private sealed class NativeFailureException : Exception
    {
        public NativeFailureException()
            : base("native stream broken")
        {
        }
    }
}
