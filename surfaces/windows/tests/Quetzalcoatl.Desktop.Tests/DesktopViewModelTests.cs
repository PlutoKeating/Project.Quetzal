namespace Quetzalcoatl.Desktop.Tests;

using System.ComponentModel;
using Quetzalcoatl.Desktop.A11y;
using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.ViewModels;

internal sealed class RecordingAnnouncementSink : IAnnouncementSink
{
    public List<string> Texts { get; } = [];

    public void Announce(string text) => Texts.Add(text);
}

/// <summary>视图模型绑定、三档切换、降级文案与「每批恰好一次」播报。</summary>
public sealed class DesktopViewModelTests
{
    private static StreamEvent Delta(ulong seq, string text) => new(seq, StreamEventKind.Delta, text);

    private static DesktopViewModel OfflineViewModel(out RecordingAnnouncementSink sink)
    {
        sink = new RecordingAnnouncementSink();
        return new DesktopViewModel(UiModel.Offline("test: daemon.json 缺失"), sink);
    }

    [Fact]
    public void DegradedModelBindsTypedOfflineCopyWithoutJargon()
    {
        var viewModel = OfflineViewModel(out _);

        Assert.True(viewModel.IsDegraded);
        Assert.False(viewModel.IsOnline);
        Assert.False(viewModel.IsInputEnabled);
        Assert.True(viewModel.ShowRetry);
        Assert.True(viewModel.ShowHint);
        Assert.Equal(CompanionCopy.HeadingOffline, viewModel.Heading);
        Assert.Equal(CompanionCopy.EmptyOffline, viewModel.Transcript);
        Assert.Equal(CompanionCopy.StatusOffline, viewModel.StatusText);
        Assert.Contains("暂时联系不上本机的助手", viewModel.DegradedDetail, StringComparison.Ordinal);

        var jargon = ZeroJargon.Audit(
        [
            viewModel.Heading,
            viewModel.Transcript,
            viewModel.StatusText,
            viewModel.DegradedTitle,
            viewModel.DegradedDetail,
        ]);
        Assert.Empty(jargon);
    }

    [Fact]
    public void OfflineComposerKeepsTextLocalAndSaysSo()
    {
        var viewModel = OfflineViewModel(out _);
        viewModel.PushUserMessage("今晚给花浇水");

        Assert.Single(viewModel.Model.Session.Messages);
        Assert.Contains(CompanionCopy.OfflineSendNotice, viewModel.Notices);
    }

    [Fact]
    public void DensitySwitchPreservesRowsAndSession()
    {
        var model = UiModel.Online(42, "127.0.0.1:4711", 3, CognitionDensity.Workbench);
        var viewModel = new DesktopViewModel(model, new RecordingAnnouncementSink());
        model.ApplyPatch(new ViewPatch(
            0,
            1,
            CognitionDensity.Workbench,
            [
                new ViewOp.Upsert(new ViewRow("session/a", UiModel.KindSession, "会话 A", "细节 A", "{\"a\":1}", 1)),
                new ViewOp.Upsert(new ViewRow("approval/x", UiModel.KindApproval, "待批准", null, null, 1)),
            ]));
        viewModel.OnBatch([Delta(1, "你好")]);

        var announcementsBefore = viewModel.AnnouncementCount;
        var changed = new List<string>();
        ((INotifyPropertyChanged)viewModel).PropertyChanged += (_, args) => changed.Add(args.PropertyName ?? string.Empty);

        viewModel.ApplyDensity(CognitionDensity.Inspector);

        Assert.Equal(CognitionDensity.Inspector, viewModel.Density);
        Assert.Equal("Quetzalcoatl · 检视", viewModel.WindowTitle);
        Assert.Contains(nameof(viewModel.Density), changed);
        Assert.Single(viewModel.Model.Session.Messages);
        Assert.Contains("你好", viewModel.Transcript, StringComparison.Ordinal);
        Assert.Single(viewModel.Sessions);
        Assert.Single(viewModel.Approvals);
        Assert.Equal(announcementsBefore, viewModel.AnnouncementCount);

        viewModel.ApplyDensity(CognitionDensity.Companion);

        var companionRow = model.View.ProjectedRows(CognitionDensity.Companion).Single(row => row.Key == "session/a");
        Assert.Null(companionRow.Detail);
        Assert.Null(companionRow.RawJson);
        var inspectorRow = model.View.ProjectedRows(CognitionDensity.Inspector).Single(row => row.Key == "session/a");
        Assert.Equal("细节 A", inspectorRow.Detail);
        Assert.Single(viewModel.Model.Session.Messages);
        Assert.Equal(announcementsBefore, viewModel.AnnouncementCount);
    }

    [Fact]
    public void MixedBatchAnnouncesErrorExactlyOnceAndPrefersIt()
    {
        var viewModel = OfflineViewModel(out var sink);

        viewModel.OnBatch(
        [
            Delta(1, "土壤湿度偏低，"),
            new StreamEvent(2, StreamEventKind.Error, "上游连接中断"),
            Delta(3, "我建议今晚浇水。"),
        ]);

        Assert.Single(sink.Texts);
        Assert.Contains("上游连接中断", sink.Texts[0], StringComparison.Ordinal);
        Assert.Equal(1, viewModel.AnnouncementCount);
        Assert.Contains("上游连接中断", viewModel.Transcript, StringComparison.Ordinal);
    }

    [Fact]
    public void StoredInspectorDensitySurvivesLaunchSelectionGuard()
    {
        var store = new Quetzalcoatl.Desktop.Settings.PreferencesStore(
            Path.Combine(Path.GetTempPath(), $"qz-density-{Guid.NewGuid():N}", "desktop.json"));
        var directory = Path.GetDirectoryName(store.Path)!;
        try
        {
            store.Save(new Quetzalcoatl.Desktop.Settings.DesktopPreferences
            {
                Density = CognitionDensity.Inspector,
            });

            // 启动期：加载布局触发的默认索引选择必须被忽略。
            var guard = new DensitySelectionGuard();
            Assert.True(guard.IsInitializing);
            Assert.False(guard.ShouldApplySelection);

            var restored = store.Load();
            Assert.Equal(CognitionDensity.Inspector, restored.Density);

            guard.CompleteInitialization();
            Assert.True(guard.ShouldApplySelection);
        }
        finally
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
    }

    [Fact]
    public void SequenceZeroIsNotExemptFromDeduplication()
    {
        var viewModel = OfflineViewModel(out var sink);
        var batch = new[] { Delta(0, "第一句"), Delta(1, "第二句") };

        viewModel.OnBatch(batch);
        viewModel.OnBatch(batch);

        Assert.Single(sink.Texts);
        Assert.Equal(1, viewModel.AnnouncementCount);
        Assert.Equal(1, viewModel.Transcript.Split("第一句").Length - 1);
    }

    [Fact]
    public void DuplicateBatchDoesNotDuplicateTextOrAnnouncement()
    {
        var viewModel = OfflineViewModel(out var sink);
        var batch = new[] { Delta(1, "今晚"), Delta(2, "补一次透水。") };

        viewModel.OnBatch(batch);
        viewModel.OnBatch(batch);

        Assert.Single(sink.Texts);
        Assert.Equal(1, viewModel.AnnouncementCount);
        var occurrences = viewModel.Transcript.Split("今晚").Length - 1;
        Assert.Equal(1, occurrences);
    }

    [Fact]
    public void DoneEventStopsStreamingAndRaisesStatusText()
    {
        var viewModel = OfflineViewModel(out _);
        viewModel.OnBatch([Delta(1, "好的。"), new StreamEvent(2, StreamEventKind.Done, "stop")]);

        Assert.False(viewModel.IsStreaming);
        Assert.Equal(CompanionCopy.StatusOffline, viewModel.StatusText);
    }

    [Fact]
    public void FaultedStreamSurfacesNoticeAndTechnicalDetail()
    {
        var viewModel = OfflineViewModel(out _);
        viewModel.OnFaulted(new InvalidOperationException("native stream broken"));

        Assert.Contains("这次没有收到回复，请稍后重试。", viewModel.Notices);
        Assert.Contains(viewModel.TechnicalLog, line => line.Contains("native stream broken", StringComparison.Ordinal));
        Assert.All(ZeroJargon.Audit(viewModel.Notices), issue => Assert.Fail(issue));
    }

    [Fact]
    public void OnlineModelExposesConnectedCopyAndEnablesComposer()
    {
        var viewModel = new DesktopViewModel(
            UiModel.Online(7, "127.0.0.1:9", 5, CognitionDensity.Workbench),
            new RecordingAnnouncementSink());

        Assert.True(viewModel.IsOnline);
        Assert.True(viewModel.IsInputEnabled);
        Assert.False(viewModel.ShowRetry);
        Assert.Equal(CompanionCopy.HeadingOnline, viewModel.Heading);
        Assert.Equal(CompanionCopy.StatusOnline, viewModel.StatusText);
    }
}
