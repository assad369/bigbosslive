// swift-tools-version: 5.9
import PackageDescription

// Mirrors livekit_client's manifest: the Flutter tool lays plugins out side by side, so
// "../flutter_webrtc" resolves to the (vendored) flutter_webrtc plugin package.
let package = Package(
    name: "bb_camera_filter",
    platforms: [
        .iOS("13.0")
    ],
    products: [
        .library(name: "bb-camera-filter", targets: ["bb_camera_filter"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework"),
        .package(name: "flutter_webrtc", path: "../flutter_webrtc")
    ],
    targets: [
        .target(
            name: "bb_camera_filter",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework"),
                .product(name: "flutter-webrtc", package: "flutter_webrtc"),
                .product(name: "WebRTC", package: "flutter_webrtc")
            ],
            linkerSettings: [
                .linkedFramework("CoreImage"),
                .linkedFramework("Metal")
            ]
        )
    ]
)
