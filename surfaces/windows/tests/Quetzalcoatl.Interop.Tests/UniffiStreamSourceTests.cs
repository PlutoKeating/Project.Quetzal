namespace Quetzalcoatl.Interop.Tests;

using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.Streaming;
using Quetzalcoatl.Interop;

/// <summary>
/// 原生流结束语义：最后一批恰好等于批大小时，下一次拉取会抛 <c>StreamFinished</c>；
/// 只有 <c>IsFinished/IsCancelled</c> 为真的抛错才算正常结束，真实故障必须继续上抛。
/// </summary>
public sealed class UniffiStreamSourceTests
{
    private sealed class FakeNativeStream : INativeEventStream
    {
        private readonly int _batchSize;
        private readonly bool _faultAfterFirstPull;
        private int _pulls;

        public FakeNativeStream(int batchSize, bool faultAfterFirstPull)
        {
            _batchSize = batchSize;
            _faultAfterFirstPull = faultAfterFirstPull;
        }

        public int CancelCalls { get; private set; }

        public bool IsFinished { get; private set; }

        public bool IsCancelled => false;

        public IReadOnlyList<StreamEvent> NextEvents(int maxEvents)
        {
            _ = maxEvents;
            _pulls++;
            if (_pulls == 1)
            {
                return Enumerable.Range(0, _batchSize)
                    .Select(index => new StreamEvent((ulong)index, StreamEventKind.Delta, $"e{index}"))
                    .ToArray();
            }

            if (_faultAfterFirstPull)
            {
                throw new IOException("transport broken");
            }

            // 模拟 Rust 侧耗尽：先置结束位，再返回 StreamFinished 错误。
            IsFinished = true;
            throw new InvalidOperationException("StreamFinished");
        }

        public void Cancel() => CancelCalls++;

        public void Dispose()
        {
        }
    }

    [Fact]
    public void ExactlyBatchSizedFinalBatchIsACleanEnd()
    {
        var native = new FakeNativeStream(batchSize: 5, faultAfterFirstPull: false);
        using var source = new UniffiStreamSource(native);

        Assert.True(source.TryPull(5, out var first));
        Assert.Equal(5, first.Count);
        Assert.Equal("e4", first[4].Text);

        // 第二次拉取抛 StreamFinished，但 IsFinished 为真 → 正常结束，而不是故障。
        Assert.False(source.TryPull(5, out var second));
        Assert.Empty(second);
    }

    [Fact]
    public void GenuineFaultStillSurfaces()
    {
        var native = new FakeNativeStream(batchSize: 5, faultAfterFirstPull: true);
        using var source = new UniffiStreamSource(native);

        Assert.True(source.TryPull(5, out _));
        var error = Assert.Throws<IOException>(() => source.TryPull(5, out _));
        Assert.Contains("transport broken", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DisposeCancelsTheNativeStreamOnce()
    {
        var native = new FakeNativeStream(batchSize: 1, faultAfterFirstPull: false);
        var source = new UniffiStreamSource(native);
        source.Dispose();
        source.Dispose();
        Assert.Equal(1, native.CancelCalls);
    }
}
