import Foundation
import Capacitor

@objc(LanceDBPlugin)
public class LanceDBPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LanceDBPlugin"
    public let jsName = "LanceDB"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "memoryStore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "memorySearch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "memoryDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "memoryList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "memoryClear", returnType: CAPPluginReturnPromise),
    ]

    private var handle: LanceDBHandle?
    private let queue = DispatchQueue(label: "com.t6x.lancedb", qos: .userInitiated, attributes: .concurrent)

    @objc func open(_ call: CAPPluginCall) {
        guard let dbPath = call.getString("dbPath") else {
            return call.reject("dbPath is required")
        }
        guard let embeddingDim = call.getInt("embeddingDim") else {
            return call.reject("embeddingDim is required")
        }

        Task {
            do {
                self.handle = try await LanceDBHandle.open(dbPath: dbPath, embeddingDim: Int32(embeddingDim))
                call.resolve()
            } catch {
                call.reject("Failed to open LanceDB: \(error.localizedDescription)")
            }
        }
    }

    @objc func memoryStore(_ call: CAPPluginCall) {
        guard let handle else { return call.reject("LanceDB not initialized — call open() first") }
        guard let key = call.getString("key") else { return call.reject("key is required") }
        guard let agentId = call.getString("agentId") else { return call.reject("agentId is required") }
        guard let text = call.getString("text") else { return call.reject("text is required") }
        guard let embeddingArr = call.getArray("embedding") as? [NSNumber] else {
            return call.reject("embedding is required")
        }

        let embedding = embeddingArr.map { $0.floatValue }
        let metadata = call.getString("metadata")

        Task {
            do {
                try await handle.store(key: key, agentId: agentId, text: text, embedding: embedding, metadata: metadata)
                call.resolve()
            } catch {
                call.reject("memoryStore failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func memorySearch(_ call: CAPPluginCall) {
        guard let handle else { return call.reject("LanceDB not initialized — call open() first") }
        guard let queryArr = call.getArray("queryVector") as? [NSNumber] else {
            return call.reject("queryVector is required")
        }

        let queryVector = queryArr.map { $0.floatValue }
        let limit = UInt32(call.getInt("limit") ?? 5)
        let filter = call.getString("filter")

        Task {
            do {
                let results = try await handle.search(queryVector: queryVector, limit: limit, filter: filter)
                var arr: [[String: Any]] = []
                for r in results {
                    var obj: [String: Any] = [
                        "key": r.key,
                        "text": r.text,
                        "score": r.score
                    ]
                    if let meta = r.metadata {
                        obj["metadata"] = meta
                    }
                    arr.append(obj)
                }
                call.resolve(["results": arr])
            } catch {
                call.reject("memorySearch failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func memoryDelete(_ call: CAPPluginCall) {
        guard let handle else { return call.reject("LanceDB not initialized — call open() first") }
        guard let key = call.getString("key") else { return call.reject("key is required") }

        Task {
            do {
                try await handle.delete(key: key)
                call.resolve()
            } catch {
                call.reject("memoryDelete failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func memoryList(_ call: CAPPluginCall) {
        guard let handle else { return call.reject("LanceDB not initialized — call open() first") }

        let prefix = call.getString("prefix")
        let limit = call.getInt("limit").map { UInt32($0) }

        Task {
            do {
                let keys = try await handle.list(prefix: prefix, limit: limit)
                call.resolve(["keys": keys])
            } catch {
                call.reject("memoryList failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func memoryClear(_ call: CAPPluginCall) {
        guard let handle else { return call.reject("LanceDB not initialized — call open() first") }

        let collection = call.getString("collection")

        Task {
            do {
                try await handle.clear(collection: collection)
                call.resolve()
            } catch {
                call.reject("memoryClear failed: \(error.localizedDescription)")
            }
        }
    }
}
