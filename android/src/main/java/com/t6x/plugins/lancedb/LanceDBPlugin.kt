package com.t6x.plugins.lancedb

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.lancedb_ffi.LanceDbHandle

@CapacitorPlugin(name = "LanceDB")
class LanceDBPlugin : Plugin() {

    private var handle: LanceDbHandle? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @PluginMethod
    fun open(call: PluginCall) {
        val rawPath = call.getString("dbPath")
            ?: return call.reject("dbPath is required")
        val embeddingDim = call.getInt("embeddingDim")
            ?: return call.reject("embeddingDim is required")

        // Resolve "files://<rel>" to the app's private files directory
        val dbPath = if (rawPath.startsWith("files://")) {
            val rel = rawPath.removePrefix("files://")
            "${context.filesDir.absolutePath}/$rel"
        } else {
            rawPath
        }

        scope.launch {
            try {
                handle = LanceDbHandle.open(dbPath, embeddingDim)
                call.resolve()
            } catch (e: Exception) {
                call.reject("Failed to open LanceDB: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun memoryStore(call: PluginCall) {
        val h = handle ?: return call.reject("LanceDB not initialized — call open() first")
        val key = call.getString("key") ?: return call.reject("key is required")
        val agentId = call.getString("agentId") ?: return call.reject("agentId is required")
        val text = call.getString("text") ?: return call.reject("text is required")
        val embeddingArr = call.getArray("embedding")
            ?: return call.reject("embedding is required")
        val metadata = call.getString("metadata")

        val embedding = jsonArrayToFloatList(embeddingArr)

        scope.launch {
            try {
                h.store(key, agentId, text, embedding, metadata)
                call.resolve()
            } catch (e: Exception) {
                call.reject("memoryStore failed: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun memorySearch(call: PluginCall) {
        val h = handle ?: return call.reject("LanceDB not initialized — call open() first")
        val queryVectorArr = call.getArray("queryVector")
            ?: return call.reject("queryVector is required")
        val limit = call.getInt("limit", 5) ?: 5
        val filter = call.getString("filter")

        val queryVector = jsonArrayToFloatList(queryVectorArr)

        scope.launch {
            try {
                val results = h.search(queryVector, limit.toUInt(), filter)
                val arr = JSArray()
                for (r in results) {
                    val obj = JSObject()
                    obj.put("key", r.key)
                    obj.put("text", r.text)
                    obj.put("score", r.score)
                    if (r.metadata != null) {
                        obj.put("metadata", r.metadata)
                    }
                    arr.put(obj)
                }
                val ret = JSObject()
                ret.put("results", arr)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject("memorySearch failed: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun memoryDelete(call: PluginCall) {
        val h = handle ?: return call.reject("LanceDB not initialized — call open() first")
        val key = call.getString("key") ?: return call.reject("key is required")

        scope.launch {
            try {
                h.delete(key)
                call.resolve()
            } catch (e: Exception) {
                call.reject("memoryDelete failed: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun memoryList(call: PluginCall) {
        val h = handle ?: return call.reject("LanceDB not initialized — call open() first")
        val prefix = call.getString("prefix")
        val limit = call.getInt("limit")

        scope.launch {
            try {
                val keys = h.list(prefix, limit?.toUInt())
                val arr = JSArray()
                for (k in keys) {
                    arr.put(k)
                }
                val ret = JSObject()
                ret.put("keys", arr)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject("memoryList failed: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun memoryClear(call: PluginCall) {
        val h = handle ?: return call.reject("LanceDB not initialized — call open() first")
        val collection = call.getString("collection")

        scope.launch {
            try {
                h.clear(collection)
                call.resolve()
            } catch (e: Exception) {
                call.reject("memoryClear failed: ${e.message}", e)
            }
        }
    }

    override fun handleOnDestroy() {
        scope.cancel()
        handle?.close()
        handle = null
    }

    private fun jsonArrayToFloatList(arr: JSArray): List<Float> {
        val list = mutableListOf<Float>()
        for (i in 0 until arr.length()) {
            list.add(arr.getDouble(i).toFloat())
        }
        return list
    }
}
