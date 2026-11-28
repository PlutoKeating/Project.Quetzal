using System;
using Quetzalcoatl.Bindings;

// 极简 .NET 9+/10 消费方冒烟测试：验证生成的 C# 绑定可以真实编译、跨 FFI 调用并释放。
// 由 `scripts/uniffi-bindings.sh smoke-csharp` 或 `cargo test -p quetzalcoatl-uniffi` 驱动。
internal static class Program
{
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

            session.ApplyPatch(session.DensityPatch(FfiCognitionDensity.Companion));
            var projected = session.ProjectedRows();
            if (projected.Length != 1 || projected[0].Detail != null || projected[0].RawJson != null)
            {
                Console.Error.WriteLine("CSHARP_SMOKE_FAIL companion projection leaked hidden layers");
                return 4;
            }

            Console.WriteLine("CSHARP_SMOKE_OK rev=1 rows=1 companion_hidden=true");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"CSHARP_SMOKE_FAIL {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
    }
}
