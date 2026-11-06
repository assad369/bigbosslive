package com.bigbosslive.camera_filter

import android.util.Log
import com.cloudwebrtc.webrtc.FlutterWebRTCPlugin
import com.cloudwebrtc.webrtc.video.LocalVideoTrack
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * `bigboss/camera_filter`: attaches a [FilterProcessor] to a flutter_webrtc local camera track.
 *  - apply {trackId, matrix: Float64List(20), vignette, beauty?: {smoothing, whitening, redness}}:
 *    add the filter, or update it in place
 *  - clear {trackId}: remove it
 *
 * Every call first prunes processors whose track is gone (the camera restarted, or the live ended).
 * All calls arrive on the platform thread, so [attached] needs no lock.
 */
class CameraFilterPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private class Attached(val track: LocalVideoTrack, val processor: FilterProcessor)

    private val attached = HashMap<String, Attached>()
    private var channel: MethodChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        for (id in attached.keys.toList()) attached[id]?.let { detach(id, it) }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val webrtc = FlutterWebRTCPlugin.sharedSingleton
        if (webrtc == null) {
            result.error("UNAVAILABLE", "WebRTC is not initialised", null)
            return
        }
        prune(webrtc)
        val trackId = call.argument<String>("trackId")
        if (trackId == null) {
            result.error("BAD_ARGS", "trackId is required", null)
            return
        }
        when (call.method) {
            "apply" -> apply(webrtc, trackId, call, result)
            "clear" -> {
                attached[trackId]?.let { detach(trackId, it) }
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun apply(webrtc: FlutterWebRTCPlugin, trackId: String, call: MethodCall, result: MethodChannel.Result) {
        val matrix = call.argument<DoubleArray>("matrix")
        if (matrix == null || matrix.size != 20 || matrix.any { !it.isFinite() }) {
            result.error("BAD_ARGS", "matrix must have 20 finite values", null)
            return
        }
        val track = webrtc.getLocalTrack(trackId) as? LocalVideoTrack
        if (track == null) {
            result.error("NO_TRACK", "No local video track $trackId", null)
            return
        }
        val beauty = call.argument<Map<String, Any?>>("beauty")
        fun amount(value: Any?): Float {
            val f = (value as? Number)?.toFloat() ?: 0f
            return if (f.isFinite()) f.coerceIn(0f, 1f) else 0f
        }
        val params = FilterParams(
            matrix,
            amount(call.argument<Double>("vignette")),
            smoothing = amount(beauty?.get("smoothing")),
            whitening = amount(beauty?.get("whitening")),
            redness = amount(beauty?.get("redness")),
        )
        val existing = attached[trackId]
        if (existing != null && existing.track === track) {
            existing.processor.params = params
        } else {
            existing?.let { detach(trackId, it) }
            val processor = FilterProcessor(params)
            track.addProcessor(processor)
            attached[trackId] = Attached(track, processor)
        }
        result.success(null)
    }

    private fun prune(webrtc: FlutterWebRTCPlugin) {
        val stale = attached.filter { (id, a) -> webrtc.getLocalTrack(id) !== a.track }
        stale.forEach { (id, a) -> detach(id, a) }
    }

    private fun detach(trackId: String, a: Attached) {
        attached.remove(trackId)
        try {
            a.track.removeProcessor(a.processor)
        } catch (t: Throwable) {
            Log.w(TAG, "removeProcessor failed", t)
        }
        a.processor.release()
    }

    private companion object {
        const val CHANNEL = "bigboss/camera_filter"
        const val TAG = "CameraFilter"
    }
}
