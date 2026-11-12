// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// The license container's HTTP face, reachable only through the API Worker's container binding:
//
//   POST /issue         {licenseRequest, licenseKey, keys: {<item>: {blob, licenseId}}}
//   POST /renewal-ids   {renewalRequest, licenseKey} → {licenseIds}
//   POST /renew         {renewalRequest, licenseKey, keys: {<licenseId>: {item, blob}}}
//   GET  /health

import Licensing
import Vapor

var env = try Environment.detect()
try LoggingSystem.bootstrap(from: &env)
let app = try await Application.make(env)
app.http.server.configuration.hostname = "0.0.0.0"
app.http.server.configuration.port = Int(Environment.get("PORT") ?? "8080") ?? 8080
app.routes.defaultMaxBodySize = "1mb"

let licenser: Licenser?
do {
    licenser = Licenser(assets: try Assets(),
                        duration: UInt64(Environment.get("LICENSE_DURATION") ?? "0") ?? 0)
} catch {
    app.logger.error("licensing disabled: \(error)")
    licenser = nil
}

func encoded<T: Encodable>(_ value: T) throws -> Response {
    let r = Response(status: .ok)
    try r.content.encode(value, as: .json)
    return r
}

func refuse(_ status: HTTPStatus, _ message: String) -> Response {
    let r = Response(status: status)
    try? r.content.encode(["error": message], as: .json)
    return r
}

app.get("health") { _ in licenser == nil ? refuse(.serviceUnavailable, "not configured") : Response(status: .ok) }

app.post("issue") { req -> Response in
    guard let licenser else { return refuse(.serviceUnavailable, "licensing is not configured") }
    do { return try encoded(try licenser.issue(try req.content.decode(IssueRequest.self))) }
    catch { req.logger.error("issue: \(error)"); return refuse(.badRequest, "\(error)") }
}

app.post("renewal-ids") { req -> Response in
    guard let licenser else { return refuse(.serviceUnavailable, "licensing is not configured") }
    do { return try encoded(["licenseIds": try licenser.renewalIDs(try req.content.decode(RenewalIDsRequest.self))]) }
    catch { req.logger.error("renewal-ids: \(error)"); return refuse(.badRequest, "\(error)") }
}

app.post("renew") { req -> Response in
    guard let licenser else { return refuse(.serviceUnavailable, "licensing is not configured") }
    do { return try encoded(try licenser.renew(try req.content.decode(RenewRequest.self))) }
    catch { req.logger.error("renew: \(error)"); return refuse(.badRequest, "\(error)") }
}

do {
    try await app.execute()
} catch {
    app.logger.report(error: error)
    try? await app.asyncShutdown()
    throw error
}
try await app.asyncShutdown()
