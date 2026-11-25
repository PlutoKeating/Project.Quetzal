// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QuetzalcoatlMac",
    defaultLocalization: "zh-Hans",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "QuetzalcoatlMac", targets: ["QuetzalcoatlMac"]),
        .library(name: "QuetzalcoatlCore", targets: ["QuetzalcoatlCore"]),
    ],
    targets: [
        // 平台中立核心：三档密度差分视图、类型化降级、拉模式流泵、无障碍契约与偏好。
        .target(
            name: "QuetzalcoatlCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // 本机连接薄层：真实 UniFFI 绑定存在时启用 `QuetzalcoatlBindings` 适配器，
        // 缺失时保留文件系统探测与类型化降级（绝不伪造在线）。
        .target(
            name: "QuetzalcoatlInterop",
            dependencies: ["QuetzalcoatlCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // SwiftUI 纯原生 App（菜单栏 + 三档窗口）。
        .executableTarget(
            name: "QuetzalcoatlMac",
            dependencies: ["QuetzalcoatlCore", "QuetzalcoatlInterop"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "QuetzalcoatlCoreTests",
            dependencies: ["QuetzalcoatlCore", "QuetzalcoatlInterop"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
