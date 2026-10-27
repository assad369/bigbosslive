package com.bigbosslive.bigboss_live

import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.util.Rational
import androidx.lifecycle.Lifecycle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Hosts Flutter and implements picture-in-picture for live rooms (`bigboss/pip`).
 *
 * Dart arms auto-enter while a live is active; leaving the app (Home, recents) then
 * shrinks the activity into the PiP window. API 31+ uses the system's auto-enter for
 * the smooth gesture animation; API 26–30 enters from [onUserLeaveHint].
 */
class MainActivity : FlutterActivity() {
    private var pipChannel: MethodChannel? = null
    private var autoEnter = false
    private var aspect = Rational(9, 16)

    private val pipSupported: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        pipChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "bigboss/pip").apply {
            setMethodCallHandler { call, result ->
                when (call.method) {
                    "isSupported" -> result.success(pipSupported)
                    "setAutoEnter" -> {
                        autoEnter = call.argument<Boolean>("enabled") ?: false
                        aspect = clampAspect(
                            call.argument<Int>("numerator") ?: 9,
                            call.argument<Int>("denominator") ?: 16,
                        )
                        applyParams()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        pipChannel?.setMethodCallHandler(null)
        pipChannel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (autoEnter && pipSupported && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            try {
                enterPictureInPictureMode(buildParams())
            } catch (e: IllegalStateException) {
                // Activity not in a state that allows PiP (e.g. finishing); nothing to do.
            }
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        pipChannel?.invokeMethod("changed", isInPictureInPictureMode)
        // Leaving PiP without coming back to the foreground means the window was closed.
        if (!isInPictureInPictureMode && !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            pipChannel?.invokeMethod("dismissed", null)
        }
    }

    private fun applyParams() {
        if (!pipSupported) return
        try {
            setPictureInPictureParams(buildParams())
        } catch (e: IllegalStateException) {
            // Activity is finishing; params will be applied on the next call.
        }
    }

    private fun buildParams(): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder().setAspectRatio(aspect)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(autoEnter).setSeamlessResizeEnabled(false)
        }
        return builder.build()
    }

    /** Android rejects ratios outside 1:2.39 … 2.39:1. */
    private fun clampAspect(num: Int, den: Int): Rational {
        val r = num.toDouble() / den.coerceAtLeast(1)
        return when {
            r < 1 / 2.39 -> Rational(100, 239)
            r > 2.39 -> Rational(239, 100)
            else -> Rational(num, den)
        }
    }
}
