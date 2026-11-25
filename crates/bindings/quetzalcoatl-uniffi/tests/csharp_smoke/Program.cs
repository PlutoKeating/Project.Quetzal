using System;
using System.Diagnostics;
using System.IO;
using Quetzalcoatl.Bindings;

// 极简 .NET 9+/10 消费方冒烟测试：验证生成的 C# 绑定可以真实编译、跨 FFI 调用并释放。
// 由 `scripts/uniffi-bindings.sh smoke-csharp` 或 `cargo test -p quetzalcoatl-uniffi` 驱动。
internal static class Program
{
    private static int CountFds()
    {
        try
        {
            return Directory.GetFiles("/proc/self/fd").Length;
        }
        catch (Exception)
        {
            return -1;
        }
    }

    private static int Main()
    {
        try
        {
            using var session = new FfiViewSession(FfiCognitionDensity.Workbench);
            var row = new FfiViewRow(
                Key: "agent/status",
                Kind: "agent",
                Summary: "在线",
                Detail: "pid=42",
                RawJson: "{\"pid\":42}",
                UpdatedRev: 0UL);
            var patch = new FfiViewPatch(
                FromRev: 0UL,
                ToRev: 1UL,
                Density: FfiCognitionDensity.Workbench,
                Ops: new FfiViewOp[] { new FfiViewOp.Upsert(row) });

            session.ApplyPatch(patch);
            session.ApplyPatch(patch); // 幂等重放
            if (session.Rev() != 1UL)
            {
                Console.Error.WriteLine($"CSHARP_SMOKE_FAIL rev={session.Rev()}");
                return 2;
            }

            var snapshot = session.Snapshot();
            if (snapshot.Rows.Length != 1 || snapshot.Rows[0].Key != "agent/status")
            {
                Console.Error.WriteLine("CSHARP_SMOKE_FAIL snapshot mismatch");
                return 3;
            }

            session.ApplyPatch(session.SwitchDensity(FfiCognitionDensity.Companion));
            var projected = session.ProjectedRows();
            if (projected.Length != 1 || projected[0].Detail != null || projected[0].RawJson != null)
            {
                Console.Error.WriteLine("CSHARP_SMOKE_FAIL companion projection leaked hidden layers");
                return 4;
            }

            // 拉模式流：无任何回调注册，宿主主动拉取有界批次。
            using (var stream = new FfiViewStream(5u))
            {
                var batch = stream.NextEvents(3u);
                if (batch.Length != 3 || batch[0].Seq != 0UL || batch[0].Text != "delta-0")
                {
                    Console.Error.WriteLine("CSHARP_SMOKE_FAIL stream batch mismatch");
                    return 5;
                }
                stream.Cancel();
                if (!stream.IsCancelled())
                {
                    Console.Error.WriteLine("CSHARP_SMOKE_FAIL stream not cancelled");
                    return 6;
                }
            }

            // 10,000 次 create/pull/cancel：跨 FFI 边界必须零 fd/线程泄漏。
            int fdBefore = CountFds();
            long rssBefore = Process.GetCurrentProcess().WorkingSet64;
            for (int i = 0; i < 10_000; i++)
            {
                using var stream = new FfiViewStream(2u);
                var batch = stream.NextEvents(1u);
                if (batch.Length != 1 || batch[0].Seq != 0UL)
                {
                    Console.Error.WriteLine($"CSHARP_SMOKE_FAIL cycle={i} batch mismatch");
                    return 7;
                }
                stream.Cancel();
            }
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            int fdAfter = CountFds();
            long rssAfter = Process.GetCurrentProcess().WorkingSet64;
            long rssGrowthKiB = (rssAfter - rssBefore) / 1024;

            if (fdBefore >= 0 && fdAfter > fdBefore + 16)
            {
                Console.Error.WriteLine(
                    $"CSHARP_SMOKE_FAIL fd leak: before={fdBefore} after={fdAfter}");
                return 8;
            }
            if (rssAfter > rssBefore + 96L * 1024 * 1024)
            {
                Console.Error.WriteLine(
                    $"CSHARP_SMOKE_FAIL rss growth: {rssGrowthKiB} KiB");
                return 9;
            }

            Console.WriteLine(
                "CSHARP_SMOKE_OK rev=1 rows=1 companion_hidden=true events=3 cancelled=true " +
                $"cancel_cycles=10000 fd_before={fdBefore} fd_after={fdAfter} rss_growth_kib={rssGrowthKiB}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"CSHARP_SMOKE_FAIL {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
    }
}
