namespace Quetzalcoatl.Desktop.Model;

/// <summary>
/// 确定性合成数据（零真实个人数据）：供无守护进程的 UI 冒烟与演示渲染审批/工作流/工具/审计区。
/// </summary>
public static class DemoData
{
    /// <summary>把一组合成视图行幂等写入模型（修订号 +1）。</summary>
    public static void Apply(UiModel model)
    {
        ArgumentNullException.ThrowIfNull(model);
        var rev = model.View.Rev;
        var patch = new ViewPatch(
            rev,
            rev + 1,
            model.Density,
            [
                new ViewOp.Upsert(new ViewRow(
                    "session/demo",
                    UiModel.KindSession,
                    "合成会话：温室灌溉计划",
                    "下午三点检查土壤湿度",
                    "{\"thread\":\"demo\"}",
                    rev + 1)),
                new ViewOp.Upsert(new ViewRow(
                    "workflow/demo",
                    UiModel.KindWorkflow,
                    "整理本周浇水记录",
                    "已完成 2 / 3 步",
                    null,
                    rev + 1)),
                new ViewOp.Upsert(new ViewRow(
                    "approval/demo",
                    UiModel.KindApproval,
                    "是否把「今晚浇水」写进日程？",
                    "写回脊柱前需要你确认",
                    null,
                    rev + 1)),
                new ViewOp.Upsert(new ViewRow(
                    "tool/demo",
                    UiModel.KindTool,
                    "读取温室传感器",
                    "soil_moisture=18%",
                    "{\"sensor\":\"soil\"}",
                    rev + 1)),
                new ViewOp.Upsert(new ViewRow(
                    "audit/demo",
                    UiModel.KindAudit,
                    "合成审计事件：演示视图加载",
                    null,
                    "{\"seq\":1}",
                    rev + 1)),
                new ViewOp.Upsert(new ViewRow(
                    "status/demo",
                    UiModel.KindStatus,
                    "睡眠相位：清醒",
                    "脊柱水位：0",
                    null,
                    rev + 1)),
            ]);
        model.ApplyPatch(patch);
        model.ConscienceBody =
            "ROOT (100)：不做伤害用户长期利益的事。\n"
            + "OPERATOR (80)：遵守本机用户的明确指令。\n"
            + "（以上为合成演示文本，不来自任何真实用户。）";
    }
}
