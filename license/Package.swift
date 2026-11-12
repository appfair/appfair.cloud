// swift-tools-version: 5.9
// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// App Fair's license service: the one part of the marketplace that cannot run in a Cloudflare
// Worker, because Apple's App License Delivery SDK is a native library. It runs as a Cloudflare
// Container the API Worker (../api) calls; it stores nothing (README.md).
//
// The SDK is not redistributable: `scripts/setup-ald-sdk.sh <aldsdk1.0.1.tgz>` unpacks it into
// vendor/aldsdk (git-ignored).

import Foundation
import PackageDescription

let aldPath = Context.environment["ALD_SDK_PATH"] ?? "vendor/aldsdk"
let aldPackage = URL(fileURLWithPath: aldPath).lastPathComponent.lowercased()

let package = Package(
    name: "AppFairLicenseService",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "appfair-license", targets: ["LicenseService"])],
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.100.0"),
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.2.0"),
        .package(path: aldPath),
    ],
    targets: [
        .target(
            name: "Licensing",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto"),
                .product(name: "_CryptoExtras", package: "swift-crypto"),
                .product(name: "ALD", package: aldPackage),
            ]
        ),
        .executableTarget(
            name: "LicenseService",
            dependencies: ["Licensing", .product(name: "Vapor", package: "vapor")]
        ),
        .testTarget(name: "LicensingTests", dependencies: ["Licensing"]),
    ]
)
