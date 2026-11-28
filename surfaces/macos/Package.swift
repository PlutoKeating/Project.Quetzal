// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "QuetzalcoatlMac",
    defaultLocalization: "zh-Hans",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "QuetzalcoatlMac", targets: ["QuetzalcoatlMac"]),
    ],
    targets: [
        // 最小治理外壳：一个说明窗口 + 打开本机治理面的按钮，没有对话、输入框或流。
        .executableTarget(
            name: "QuetzalcoatlMac",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
