// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CasmKit",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [.library(name: "CasmKit", targets: ["CasmKit"])],
    targets: [
        .target(name: "CasmKit"),
        .testTarget(name: "CasmKitTests", dependencies: ["CasmKit"], resources: [.copy("Fixtures")]),
    ],
    swiftLanguageModes: [.v6]
)
