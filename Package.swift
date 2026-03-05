// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorLanceDB",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "CapacitorLancedb",
            targets: ["LanceDBPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .binaryTarget(
            name: "LanceDBFFI",
            path: "ios/Frameworks/LanceDBFFI.xcframework"
        ),
        .target(
            name: "LanceDBPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "LanceDBFFI"
            ],
            path: "ios/Sources/LanceDBPlugin",
            exclude: [
                "Generated/lancedb_ffiFFI.modulemap",
                "Generated/lancedb_ffiFFI.h"
            ]
        )
    ]
)
