import Foundation
import Testing
@testable import QuetzalcoatlCore

@Suite("偏好持久化")
struct PreferencesTests {
    private func temporaryStore() -> PreferencesStore {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("qz-mac-pref-\(UUID().uuidString)")
        return PreferencesStore(path: directory.appendingPathComponent("desktop.json").path)
    }

    @Test("密度与尺寸往返一致且无临时文件残留")
    func roundTripsDensityAndSize() throws {
        let store = temporaryStore()
        defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: store.path).deletingLastPathComponent()) }

        var prefs = DesktopPreferences()
        prefs.density = .inspector
        prefs.width = 1440
        prefs.height = 900
        prefs.maximized = true
        prefs.closeToMenuBar = false
        prefs.startAtLogin = true
        try store.save(prefs)

        let loaded = store.load()
        #expect(loaded.density == .inspector)
        #expect(loaded.width == 1440)
        #expect(loaded.height == 900)
        #expect(loaded.maximized)
        #expect(!loaded.closeToMenuBar)
        #expect(loaded.startAtLogin)

        let siblings = try FileManager.default.contentsOfDirectory(
            at: URL(fileURLWithPath: store.path).deletingLastPathComponent(),
            includingPropertiesForKeys: nil)
        #expect(siblings.count == 1, "原子写入不得留下临时文件: \(siblings)")
    }

    @Test("损坏文件整体回退默认值")
    func corruptFileFallsBackToDefaults() throws {
        let store = temporaryStore()
        let directory = URL(fileURLWithPath: store.path).deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: URL(fileURLWithPath: store.path))

        #expect(store.load() == DesktopPreferences())
    }

    @Test("尺寸收敛到可用范围")
    func sizesAreClamped() {
        var prefs = DesktopPreferences()
        prefs.width = 10
        prefs.height = 100_000
        let sanitized = prefs.sanitized()
        #expect(sanitized.width == 320)
        #expect(sanitized.height == 8192)
    }
}

@Suite("launchd 生命周期")
struct LaunchdSupportTests {
    @Test("LaunchAgent plist 可解析且含生命周期键")
    func agentPlistIsValidAndHasLifecycleKeys() throws {
        let plist = LaunchdSupport.agentPlist(
            executablePath: "/Applications/Quetzalcoatl.app/Contents/MacOS/QuetzalcoatlMac",
            home: "/Users/lab/.quetzalcoatl")

        let data = try #require(plist.data(using: .utf8))
        let parsed = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dictionary = try #require(parsed as? [String: Any])

        #expect(dictionary["Label"] as? String == "org.quetzalcoatl.macos")
        #expect(dictionary["RunAtLoad"] as? Bool == true)
        #expect(dictionary["KeepAlive"] != nil)
        #expect(dictionary["ThrottleInterval"] as? Int == 10)
        let arguments = try #require(dictionary["ProgramArguments"] as? [String])
        #expect(arguments.count == 2)
        #expect(arguments[1] == "--menu-bar-only")
        let environment = try #require(dictionary["EnvironmentVariables"] as? [String: String])
        #expect(environment["QUETZALCOATL_HOME"] == "/Users/lab/.quetzalcoatl")
    }

    @Test("plist 转义 XML 敏感字符")
    func agentPlistEscapesXMLSensitiveCharacters() throws {
        let plist = LaunchdSupport.agentPlist(
            executablePath: "/tmp/a&b/QuetzalcoatlMac",
            home: "/tmp/<home>")
        #expect(plist.contains("a&amp;b"))
        #expect(plist.contains("&lt;home&gt;"))
        let data = try #require(plist.data(using: .utf8))
        _ = try PropertyListSerialization.propertyList(from: data, format: nil)
    }

    @Test("安装提示包含 launchctl 命令")
    func installHintContainsLaunchctlCommand() {
        let hint = LaunchdSupport.installHint(executablePath: "/Applications/Quetzalcoatl.app/Contents/MacOS/QuetzalcoatlMac")
        #expect(hint.contains("launchctl bootstrap"))
        #expect(hint.contains("LaunchAgents"))
    }
}
