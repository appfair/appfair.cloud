// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// Licenses through Apple's App License Delivery SDK ("Licensing alternative distribution apps").
// Stateless: each request carries what it needs. The API Worker adds, beside iOS's own encrypted
// request, the key blob of each variant iOS asked for and the license id to issue it under; a
// renewal first asks which license ids iOS wants renewed (they are inside the encrypted request).

import ALD
import Crypto
import _CryptoExtras
import Foundation

public enum LicensingError: Error, CustomStringConvertible {
    case asset(String)
    case request(String)

    public var description: String {
        switch self {
        case .asset(let s): return "license assets: \(s)"
        case .request(let s): return "license request: \(s)"
        }
    }
}

/// Bytes from a key or certificate in whatever form it was saved: PEM, a JSON file with an
/// `authorizationKey` (the PASK as downloaded), base64 text, or raw DER.
public func assetBytes(_ data: Data) -> [UInt8] {
    if let text = String(data: data, encoding: .utf8) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("-----BEGIN") {
            let body = trimmed.split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
            if let der = Data(base64Encoded: body) { return [UInt8](der) }
        }
        if trimmed.hasPrefix("{"),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let key = json["authorizationKey"] as? String,
           let raw = Data(base64Encoded: key) {
            return [UInt8](raw)
        }
        let compact = trimmed.components(separatedBy: .whitespacesAndNewlines).joined()
        if !compact.isEmpty, compact.allSatisfy({ $0.isLetter || $0.isNumber || "+/=".contains($0) }),
           let raw = Data(base64Encoded: compact) {
            return [UInt8](raw)
        }
    }
    return [UInt8](data)
}

/// The App License Delivery assets.
public struct Assets: @unchecked Sendable {
    let signingCertificate: [UInt8]
    let signingKey: [UInt8]
    let encryptionCertificate: [UInt8]
    let pask: [UInt8]
    let encryptionKey: _RSA.Encryption.PrivateKey

    /// From the environment: each variable is the base64 of the file Apple issued (a certificate,
    /// a key, or the PASK).
    public init(environment env: [String: String] = ProcessInfo.processInfo.environment) throws {
        func file(_ name: String) throws -> Data {
            guard let v = env[name], let d = Data(base64Encoded: v.trimmingCharacters(in: .whitespacesAndNewlines))
            else { throw LicensingError.asset("\(name) is not set to a base64 file") }
            return d
        }
        signingCertificate = assetBytes(try file("ALD_SIGNING_CERT"))
        signingKey = assetBytes(try file("ALD_SIGNING_KEY"))
        encryptionCertificate = assetBytes(try file("ALD_ENCRYPTION_CERT"))
        pask = assetBytes(try file("ALD_PASK"))
        let pem = String(decoding: try file("ALD_ENCRYPTION_KEY"), as: UTF8.self)
        do {
            encryptionKey = try _RSA.Encryption.PrivateKey(pemRepresentation: pem)
        } catch {
            throw LicensingError.asset("ALD_ENCRYPTION_KEY is not an RSA private key in PEM: \(error)")
        }
    }

    init(encryptionKey: _RSA.Encryption.PrivateKey) {
        self.encryptionKey = encryptionKey
        signingCertificate = []
        signingKey = []
        encryptionCertificate = []
        pask = []
    }

    /// Undo iOS's encryption: an RSA-OAEP-SHA256 wrapped AES-128 key and IV, then AES-CBC.
    public func decrypt(request: String, key: String) throws -> [UInt8] {
        guard let wrapped = Data(base64Encoded: key), wrapped.count == 384 else {
            throw LicensingError.request("the license key is not an RSA-3072 block")
        }
        guard let sealed = Data(base64Encoded: request) else {
            throw LicensingError.request("the request is not base64")
        }
        let keyAndIV = [UInt8](try encryptionKey.decrypt(wrapped, padding: .PKCS1_OAEP_SHA256))
        guard keyAndIV.count >= 32 else { throw LicensingError.request("the AES key is short") }
        return [UInt8](try AES._CBC.decrypt(sealed, using: SymmetricKey(data: keyAndIV[0..<16]),
                                            iv: try AES._CBC.IV(ivBytes: keyAndIV[16..<32])))
    }

    func session(_ clear: [UInt8]) throws -> ALDSession {
        try ALDProvider(encryptionCert: encryptionCertificate, signingCert: signingCertificate,
                        PASK: pask, signingKey: signingKey).createSession(clientRequest: clear)
    }
}

// MARK: - The wire format with the API Worker

public struct IssueRequest: Codable, Sendable {
    public struct Key: Codable, Sendable {
        public var blob: String
        public var licenseId: UInt64
    }
    public var licenseRequest: String
    public var licenseKey: String
    /// By Apple item id: the variant's key blob (base64) and the license id to issue.
    public var keys: [String: Key]
}

public struct RenewalIDsRequest: Codable, Sendable {
    public var renewalRequest: String
    public var licenseKey: String
}

public struct RenewRequest: Codable, Sendable {
    public struct Key: Codable, Sendable {
        public var item: String
        public var blob: String
    }
    public var renewalRequest: String
    public var licenseKey: String
    /// By license id: the app and its variant's key blob (base64).
    public var keys: [String: Key]
}

public struct LicenseResponse: Codable, Sendable, Equatable {
    public var license: String
    public var unlicensedApps: [String]
}

public struct RenewalResponse: Codable, Sendable, Equatable {
    public var license: String
    public var ineligibleLicenses: [String]
}

public struct Licenser: Sendable {
    let assets: Assets
    /// Seconds a license is valid; 0 is permanent.
    let duration: UInt64

    public init(assets: Assets, duration: UInt64) {
        self.assets = assets
        self.duration = duration
    }

    private func generate(_ session: ALDSession, id: UInt64, item: UInt64, blob: String) throws {
        guard let raw = Data(base64Encoded: blob) else { throw LicensingError.request("a key blob is not base64") }
        var attribute = ALDLicenseAttribute(licenseID: id)
        attribute.issuedTime = UInt64(Date().timeIntervalSince1970)
        attribute.duration = duration
        try attribute.addAppKey(ALDAppKey(appleItemID: item, appKeyBlob: [UInt8](raw)))
        try session.generateLicense(attr: attribute)
    }

    private func finish(_ session: ALDSession) throws -> String {
        let response = try session.generateLicenseResponse()
        return Data(try session.finalizeLicenseResponse(licenseResponse: response)).base64EncodedString()
    }

    public func issue(_ req: IssueRequest) throws -> LicenseResponse {
        let session = try assets.session(try assets.decrypt(request: req.licenseRequest, key: req.licenseKey))
        var unlicensed: [String] = []
        var issued = 0
        for item in session.requestedAppleItemIDList {
            guard let key = req.keys[String(item)] else {
                unlicensed.append(String(item))
                continue
            }
            try generate(session, id: key.licenseId, item: item, blob: key.blob)
            issued += 1
        }
        return LicenseResponse(license: issued > 0 ? try finish(session) : "", unlicensedApps: unlicensed)
    }

    public func renewalIDs(_ req: RenewalIDsRequest) throws -> [UInt64] {
        try assets.session(try assets.decrypt(request: req.renewalRequest, key: req.licenseKey))
            .requestedLicenseIDList
    }

    public func renew(_ req: RenewRequest) throws -> RenewalResponse {
        let session = try assets.session(try assets.decrypt(request: req.renewalRequest, key: req.licenseKey))
        var ineligible: [String] = []
        var issued = 0
        for id in session.requestedLicenseIDList {
            guard let key = req.keys[String(id)], let item = UInt64(key.item) else {
                ineligible.append(String(id))
                continue
            }
            try generate(session, id: id, item: item, blob: key.blob)
            issued += 1
        }
        return RenewalResponse(license: issued > 0 ? try finish(session) : "", ineligibleLicenses: ineligible)
    }
}
