/// 确定性合成数据（零真实个人数据）：供无守护进程的演示与 UI 渲染审批/工作流/工具/审计区。
public enum DemoData {
    /// 把一组合成视图行幂等写入模型（修订号 +1）。
    public static func apply(to model: inout UiModel) throws {
        let rev = model.view.rev
        let patch = ViewPatch(
            fromRev: rev,
            toRev: rev + 1,
            density: model.density,
            ops: [
                .upsert(ViewRow(
                    key: "session/demo",
                    kind: UiModel.kindSession,
                    summary: "合成会话：温室灌溉计划",
                    detail: "下午三点检查土壤湿度",
                    rawJSON: #"{"thread":"demo"}"#,
                    updatedRev: rev + 1)),
                .upsert(ViewRow(
                    key: "workflow/demo",
                    kind: UiModel.kindWorkflow,
                    summary: "整理本周浇水记录",
                    detail: "已完成 2 / 3 步",
                    updatedRev: rev + 1)),
                .upsert(ViewRow(
                    key: "approval/demo",
                    kind: UiModel.kindApproval,
                    summary: "是否把「今晚浇水」写进日程？",
                    detail: "写回脊柱前需要你确认",
                    updatedRev: rev + 1)),
                .upsert(ViewRow(
                    key: "tool/demo",
                    kind: UiModel.kindTool,
                    summary: "读取温室传感器",
                    detail: "soil_moisture=18%",
                    rawJSON: #"{"sensor":"soil"}"#,
                    updatedRev: rev + 1)),
                .upsert(ViewRow(
                    key: "audit/demo",
                    kind: UiModel.kindAudit,
                    summary: "合成审计事件：演示视图加载",
                    rawJSON: #"{"seq":1}"#,
                    updatedRev: rev + 1)),
                .upsert(ViewRow(
                    key: "status/demo",
                    kind: UiModel.kindStatus,
                    summary: "睡眠相位：清醒",
                    detail: "脊柱水位：0",
                    updatedRev: rev + 1)),
            ])
        try model.applyPatch(patch)
        model.conscienceBody = """
        ROOT (100)：不做伤害用户长期利益的事。
        OPERATOR (80)：遵守本机用户的明确指令。
        （以上为合成演示文本，不来自任何真实用户。）
        """
    }
}
