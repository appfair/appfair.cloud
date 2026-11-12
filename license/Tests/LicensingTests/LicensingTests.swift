// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

import Crypto
import _CryptoExtras
import Foundation
import XCTest
@testable import Licensing

final class LicensingTests: XCTestCase {
    func testRequestsDecryptAsAppleDescribes() throws {
        let rsa = try _RSA.Encryption.PrivateKey(keySize: .bits3072)
        let assets = Assets(encryptionKey: rsa)
        let aes = SymmetricKey(size: .bits128)
        let iv = (0..<16).map { _ in UInt8.random(in: 0...255) }
        let secret = Data("the license request".utf8)
        let sealed = try AES._CBC.encrypt(secret, using: aes, iv: try AES._CBC.IV(ivBytes: iv))
        let wrapped = try rsa.publicKey.encrypt(aes.withUnsafeBytes { Data($0) } + Data(iv),
                                                padding: .PKCS1_OAEP_SHA256)
        XCTAssertEqual(Data(try assets.decrypt(request: sealed.base64EncodedString(),
                                                key: wrapped.base64EncodedString())), secret)
        XCTAssertThrowsError(try assets.decrypt(request: sealed.base64EncodedString(), key: "AAAA"))
    }

    func testAssetsLoadFromBase64EnvironmentInEveryForm() throws {
        let raw = Data([0x30, 0x82, 0x01, 0x0A])
        let pem = "-----BEGIN PRIVATE KEY-----\n\(raw.base64EncodedString())\n-----END PRIVATE KEY-----\n"
        XCTAssertEqual(assetBytes(Data(pem.utf8)), [UInt8](raw))
        XCTAssertEqual(assetBytes(Data(#"{"authorizationKey":"\#(raw.base64EncodedString())"}"#.utf8)), [UInt8](raw))
        XCTAssertEqual(assetBytes(Data([0xFF, 0x00, 0x7F])), [0xFF, 0x00, 0x7F])
        XCTAssertThrowsError(try Assets(environment: [:]))
    }

    func testTheWorkerWireFormatDecodes() throws {
        let issue = try JSONDecoder().decode(IssueRequest.self, from: Data(#"""
        {"licenseRequest":"A","licenseKey":"B","appsById":{"1":{"assetPublicId":"p"}},
         "keys":{"1640618584":{"blob":"S0VZ","licenseId":7}}}
        """#.utf8))
        XCTAssertEqual(issue.keys["1640618584"]?.licenseId, 7)
        let renew = try JSONDecoder().decode(RenewRequest.self, from: Data(#"""
        {"renewalRequest":"A","licenseKey":"B","keys":{"7":{"item":"1640618584","blob":"S0VZ"}}}
        """#.utf8))
        XCTAssertEqual(renew.keys["7"]?.item, "1640618584")
    }
}
