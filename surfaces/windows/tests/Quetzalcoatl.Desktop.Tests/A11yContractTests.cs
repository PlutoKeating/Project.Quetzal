namespace Quetzalcoatl.Desktop.Tests;

using System.Xml.Linq;
using Quetzalcoatl.Desktop.A11y;
using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.ViewModels;

/// <summary>
/// 无障碍属性完整性：契约清单、真实 XAML 标记与 UI Automation 校验器三者的静态一致性。
/// </summary>
public sealed class A11yContractTests
{
    private static readonly string[] XamlFiles =
    [
        "src/Quetzalcoatl.App/MainWindow.xaml",
        "src/Quetzalcoatl.App/Views/CompanionView.xaml",
        "src/Quetzalcoatl.App/Views/WorkbenchView.xaml",
        "src/Quetzalcoatl.App/Views/InspectorView.xaml",
    ];

    private static XDocument Load(string relative) => XDocument.Load(RepoPaths.XamlPath(relative));

    private static IEnumerable<XElement> AllElements(XDocument document) =>
        document.Descendants().Prepend(document.Root!);

    [Fact]
    public void CatalogIsStructurallyComplete()
    {
        var issues = DesktopControlCatalog.ValidateStructure();
        Assert.Empty(issues);
        Assert.True(DesktopControlCatalog.ForSurface(ControlSurface.MainWindow).Count >= 20);
        Assert.All(
            DesktopControlCatalog.ForSurface(ControlSurface.MainWindow)
                .Where(contract => contract.AutomationId.StartsWith("companion.", StringComparison.Ordinal))
                .Where(contract => contract.IsInteractive),
            contract => Assert.True(contract.MinTargetPx >= 64, $"{contract.AutomationId} 触点不足 64px"));
    }

    [Fact]
    public void XamlAutomationIdsMatchCatalogExactly()
    {
        var declared = new Dictionary<string, XElement>(StringComparer.Ordinal);
        var source = string.Empty;
        foreach (var file in XamlFiles)
        {
            var document = Load(file);
            source += document.ToString();
            foreach (var element in AllElements(document))
            {
                var id = element.Attribute("AutomationProperties.AutomationId")?.Value;
                if (string.IsNullOrEmpty(id) || id.StartsWith('{'))
                {
                    continue;
                }

                Assert.True(declared.TryAdd(id, element), $"{file}: AutomationId 重复 `{id}`");
            }
        }

        var contracts = DesktopControlCatalog.ForSurface(ControlSurface.MainWindow);
        var staticIds = contracts
            .Where(contract => !contract.IsDynamicId)
            .Select(contract => contract.AutomationId)
            .ToHashSet(StringComparer.Ordinal);

        Assert.Equal(
            staticIds.OrderBy(id => id, StringComparer.Ordinal),
            declared.Keys.OrderBy(id => id, StringComparer.Ordinal));

        // 行内按钮的 ID 由转换器生成：XAML 必须以字面量声明前缀，真实树里再断言唯一性。
        foreach (var dynamicContract in contracts.Where(contract => contract.IsDynamicId))
        {
            Assert.Contains($"ConverterParameter={dynamicContract.AutomationId}", source, StringComparison.Ordinal);
            // 名称必须是显式静态文案（不能从动态 key 派生），所以模板里必须出现该名称。
            Assert.Contains($"AutomationProperties.Name=\"{dynamicContract.AccessibleName}\"", source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void EveryXamlControlDeclaresNameAndContentConsistentWithCatalog()
    {
        foreach (var file in XamlFiles)
        {
            var document = Load(file);
            foreach (var element in AllElements(document))
            {
                var id = element.Attribute("AutomationProperties.AutomationId")?.Value;
                if (string.IsNullOrEmpty(id) || id.StartsWith('{'))
                {
                    continue;
                }

                var contract = DesktopControlCatalog.Find(id);
                Assert.True(contract is not null, $"{file}: `{id}` 不在契约清单中");

                if (contract!.HasStaticName)
                {
                    Assert.Equal(contract.AccessibleName, element.Attribute("AutomationProperties.Name")?.Value);
                }
                else
                {
                    // 内容承载控件：绝不把区块标签塞进 Name，屏幕阅读器要朗读真实内容。
                    Assert.Null(element.Attribute("AutomationProperties.Name"));
                }

                // 唯一允许的 live region 是连接状态：它只反映连接变化，不随每批回复变化。
                var liveSetting = element.Attribute("AutomationProperties.LiveSetting")?.Value;
                if (id == "status.connection")
                {
                    Assert.Equal("Polite", liveSetting);
                }
                else
                {
                    Assert.Null(liveSetting);
                }

                if ((contract.Traits & ControlTraits.ValuePattern) != 0)
                {
                    Assert.Contains(element.Name.LocalName, new[] { "TextBox", "PasswordBox" });
                }
            }
        }
    }

    [Fact]
    public void ValidatorAcceptsCompleteObservationAndRejectsRegressions()
    {
        var observed = DesktopControlCatalog.ForSurface(ControlSurface.MainWindow)
            .Select(contract => new ObservedControl(
                contract.IsDynamicId ? $"{contract.AutomationId}/row-1" : contract.AutomationId,
                contract.NameIsContent ? "真实内容" : contract.AccessibleName,
                contract.Kind,
                IsKeyboardFocusable: (contract.Traits & ControlTraits.KeyboardFocusable) != 0,
                IsInvokeAvailable: (contract.Traits & ControlTraits.Invoke) != 0,
                IsValueAvailable: (contract.Traits & ControlTraits.ValuePattern) != 0,
                Width: Math.Max(contract.MinTargetPx, 120),
                Height: Math.Max(contract.MinTargetPx, 48)))
            .ToArray();

        Assert.Empty(A11yContractValidator.Validate(observed));

        var broken = observed
            .Select(item => item.AutomationId == "companion.transcript"
                ? item with { Name = "对话内容" }
                : item)
            .Where(item => item.AutomationId != "companion.send")
            .ToArray();

        var issues = A11yContractValidator.Validate(broken);
        Assert.Contains(issues, issue => issue.Contains("companion.transcript", StringComparison.Ordinal));
        Assert.Contains(issues, issue => issue.Contains("companion.send", StringComparison.Ordinal));

        // 行内按钮：同名前缀但 ID 重复必须被抓住。
        var duplicated = observed
            .Append(observed.First(item => item.AutomationId.StartsWith("workbench.approve/", StringComparison.Ordinal)))
            .ToArray();
        var dynamicIssues = A11yContractValidator.Validate(duplicated);
        Assert.Contains(dynamicIssues, issue => issue.Contains("必须唯一", StringComparison.Ordinal));
    }

    [Fact]
    public void ConditionalControlsAreOnlyValidatedInTheirState()
    {
        var observed = DesktopControlCatalog.ForSurface(ControlSurface.MainWindow)
            .Where(contract => contract.Availability == ControlAvailability.Always)
            .Select(contract => new ObservedControl(
                contract.IsDynamicId ? $"{contract.AutomationId}/row-1" : contract.AutomationId,
                contract.NameIsContent ? "真实内容" : contract.AccessibleName,
                contract.Kind,
                IsKeyboardFocusable: (contract.Traits & ControlTraits.KeyboardFocusable) != 0,
                IsInvokeAvailable: (contract.Traits & ControlTraits.Invoke) != 0,
                IsValueAvailable: (contract.Traits & ControlTraits.ValuePattern) != 0,
                Width: Math.Max(contract.MinTargetPx, 120),
                Height: Math.Max(contract.MinTargetPx, 48)))
            .ToArray();

        // 非对应状态下，条件可见控件不应被判为缺失（否则离线/在线切换时冒烟必然失败）。
        Assert.Empty(A11yContractValidator.Validate(observed));

        var streaming = new HashSet<ControlAvailability> { ControlAvailability.WhileStreaming };
        Assert.Contains(
            A11yContractValidator.Validate(observed, activeStates: streaming),
            issue => issue.Contains("companion.streaming", StringComparison.Ordinal));

        var degraded = new HashSet<ControlAvailability> { ControlAvailability.WhileDegraded };
        var degradedIssues = A11yContractValidator.Validate(observed, activeStates: degraded);
        Assert.Contains(degradedIssues, issue => issue.Contains("companion.retry", StringComparison.Ordinal));
        Assert.Contains(degradedIssues, issue => issue.Contains("status.degraded", StringComparison.Ordinal));
    }

    [Fact]
    public void CompanionCopyIsZeroJargon()
    {
        var issues = ZeroJargon.AuditCompanionCopy();
        Assert.Empty(issues);
    }

    [Fact]
    public void DegradedCopyStaysZeroJargonForEveryReason()
    {
        foreach (var reason in Enum.GetValues<DegradedReason>())
        {
            var view = DegradedCopy.For(reason, "technical detail");
            var issues = ZeroJargon.Audit([view.Title, view.Detail, view.Hint]);
            Assert.Empty(issues);
            Assert.False(string.IsNullOrWhiteSpace(view.Title));
            Assert.False(string.IsNullOrWhiteSpace(view.Detail));
            Assert.False(string.IsNullOrWhiteSpace(view.Hint));
        }
    }

    [Fact]
    public void CompanionCopyIsTheOnlySourceForHeadingAndStatus()
    {
        var offline = new DesktopViewModel(UiModel.Offline("test"), new RecordingAnnouncementSink());
        var online = new DesktopViewModel(
            UiModel.Online(1, "127.0.0.1:1", 0, CognitionDensity.Workbench),
            new RecordingAnnouncementSink());

        Assert.Contains(offline.Heading, CompanionCopy.All);
        Assert.Contains(offline.StatusText, CompanionCopy.All);
        Assert.Contains(online.Heading, CompanionCopy.All);
        Assert.Contains(online.StatusText, CompanionCopy.All);
    }
}
