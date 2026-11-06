package com.bigbosslive.camera_filter

import android.graphics.Matrix
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cloudwebrtc.webrtc.video.LocalVideoTrack
import org.webrtc.GlShader
import org.webrtc.GlTextureFrameBuffer
import org.webrtc.GlUtil
import org.webrtc.RendererCommon
import org.webrtc.TextureBufferImpl
import org.webrtc.VideoFrame
import org.webrtc.YuvConverter
import java.nio.FloatBuffer
import java.util.ArrayDeque
import kotlin.math.ln

/**
 * A colour matrix in Flutter's 4×5 layout (offsets 0–255) plus a vignette strength, from the Dart
 * catalogue (lib/features/live/camera_filters.dart), and optional face beautification amounts
 * (0–1 each; all zero means a plain colour look).
 */
class FilterParams(
    values: DoubleArray,
    val vignette: Float,
    val smoothing: Float = 0f,
    val whitening: Float = 0f,
    val redness: Float = 0f,
) {
    /** Column-major mat4 for GLSL. */
    val matrix = FloatArray(16)
    val offset = FloatArray(4)

    val hasBeauty get() = smoothing > 0f || whitening > 0f || redness > 0f

    /** Whitening log curve `ln(1 + x·k) / ln(1 + k)`: (k, 1 / ln(1 + k), on/off). */
    val white = FloatArray(3)

    init {
        require(values.size == 20) { "matrix must have 20 values" }
        for (row in 0 until 4) {
            for (col in 0 until 4) matrix[col * 4 + row] = values[row * 5 + col].toFloat()
            offset[row] = values[row * 5 + 4].toFloat() / 255f
        }
        if (whitening > 0f) {
            val k = WHITENING_GAIN * whitening
            white[0] = k
            white[1] = 1f / ln(1f + k)
            white[2] = 1f
        }
    }

    private companion object {
        /** Curve strength at whitening = 1 (kept in step with the iOS processor). */
        const val WHITENING_GAIN = 5f
    }
}

/**
 * Applies beautification, a colour matrix and a vignette to camera frames on the GPU, before they
 * reach the local preview and the encoder. Runs on the camera's SurfaceTextureHelper thread, where
 * the shared EGL context is current.
 *
 * Beauty is one pass, compiled in only when a filter uses it: a 17-tap bilateral blur, which keeps
 * edges such as eyes, lips and the jaw line, blended in through a soft YCbCr skin mask, then a
 * log-curve whitening and a rosy tint on skin.
 *
 * Only texture frames (Camera2, the default) are processed. Anything else passes through
 * untouched, and any GL failure permanently degrades to pass-through, so a filter can never break
 * a live.
 *
 * Frame ownership: flutter_webrtc's [LocalVideoTrack] releases a frame a processor returns once it
 * has been delivered (third_party/flutter_webrtc, video/LocalVideoTrack.java). This class must
 * never release its own output; the release callback recycles the framebuffer.
 */
class FilterProcessor(@Volatile var params: FilterParams) : LocalVideoTrack.ExternalVideoFrameProcessing {
    private val lock = Any()
    private var handler: Handler? = null

    /** Indexed by [shaderIndex]: (OES | RGB) × (plain | beauty). */
    private val shaders = arrayOfNulls<GlShader>(4)
    private var yuvConverter: YuvConverter? = null
    private val pool = ArrayDeque<GlTextureFrameBuffer>()
    private var outstanding = 0
    private var released = false
    private var failed = false

    override fun onFrame(frame: VideoFrame): VideoFrame {
        val buffer = frame.buffer as? VideoFrame.TextureBuffer ?: return frame
        val looper = Looper.myLooper() ?: return frame
        synchronized(lock) {
            if (failed || released) return frame
            return try {
                render(frame, buffer, looper) ?: frame
            } catch (t: Throwable) {
                Log.w(TAG, "camera filter disabled after GL error", t)
                failed = true
                frame
            }
        }
    }

    private fun render(frame: VideoFrame, buffer: VideoFrame.TextureBuffer, looper: Looper): VideoFrame? {
        val h = handler ?: Handler(looper).also { handler = it }
        if (h.looper != looper) return null
        if (outstanding >= MAX_IN_FLIGHT) return null // the encoder is behind: skip filtering rather than stall

        val width = buffer.width
        val height = buffer.height
        var fb = pool.pollFirst()
        while (fb != null && (fb.width != width || fb.height != height)) {
            fb.release()
            fb = pool.pollFirst()
        }
        val target = fb ?: GlTextureFrameBuffer(GLES20.GL_RGBA).apply { setSize(width, height) }

        val oes = buffer.type == VideoFrame.TextureBuffer.Type.OES
        val p = params
        val beauty = p.hasBeauty
        val index = shaderIndex(oes, beauty)
        val shader = shaders[index] ?: GlShader(vertex(beauty), fragment(oes, beauty)).also { shaders[index] = it }

        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, target.frameBufferId)
        GLES20.glViewport(0, 0, width, height)
        shader.useProgram()
        shader.setVertexAttribArray("in_pos", 2, FULL_RECT)
        shader.setVertexAttribArray("in_tc", 2, FULL_TEX)
        GLES20.glUniformMatrix4fv(
            shader.getUniformLocation("tex_mat"), 1, false,
            RendererCommon.convertMatrixFromAndroidGraphicsMatrix(buffer.transformMatrix), 0,
        )
        GLES20.glUniformMatrix4fv(shader.getUniformLocation("color_mat"), 1, false, p.matrix, 0)
        GLES20.glUniform4fv(shader.getUniformLocation("color_off"), 1, p.offset, 0)
        GLES20.glUniform1f(shader.getUniformLocation("vignette"), p.vignette)
        GLES20.glUniform1i(shader.getUniformLocation("tex"), 0)
        if (beauty) {
            // Outer sampling ring: ~1.2% of the short side at full smoothing (≈ 9 px at 720p).
            val radius = minOf(width, height) * 0.012f * (0.5f + 0.5f * p.smoothing)
            GLES20.glUniform2f(shader.getUniformLocation("texel"), radius / width, radius / height)
            GLES20.glUniform1f(shader.getUniformLocation("smoothing"), p.smoothing)
            GLES20.glUniform3fv(shader.getUniformLocation("white"), 1, p.white, 0)
            GLES20.glUniform1f(shader.getUniformLocation("redness"), p.redness)
        }
        val textureTarget = if (oes) GLES11Ext.GL_TEXTURE_EXTERNAL_OES else GLES20.GL_TEXTURE_2D
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(textureTarget, buffer.textureId)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glBindTexture(textureTarget, 0)
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        // Renderers and the encoder read the texture from other (shared) contexts.
        GLES20.glFinish()
        GlUtil.checkNoGLES2Error("FilterProcessor.render")

        val converter = yuvConverter ?: YuvConverter().also { yuvConverter = it }
        outstanding++
        val out = TextureBufferImpl(width, height, VideoFrame.TextureBuffer.Type.RGB, target.textureId, Matrix(), h, converter) {
            // Runs when the last reference is gone, on whichever thread dropped it.
            if (!h.post { recycle(target) }) dropped()
        }
        return VideoFrame(out, frame.rotation, frame.timestampNs)
    }

    /** Runs on the capture thread when a filtered frame is no longer referenced. */
    private fun recycle(fb: GlTextureFrameBuffer) {
        synchronized(lock) {
            outstanding--
            if (released) {
                fb.release()
                if (outstanding == 0) releaseConverter()
            } else {
                pool.addLast(fb)
            }
        }
    }

    /** The capture thread is gone, and its EGL context with it: only the bookkeeping is left. */
    private fun dropped() {
        synchronized(lock) { outstanding-- }
    }

    /**
     * Detached from its track: free GL resources on the capture thread once in-flight frames are
     * done. Callers detach before the camera stops, so the thread is normally still alive; if it
     * isn't, its EGL context, and every GL object made in it, has already been destroyed.
     */
    fun release() {
        val h: Handler
        synchronized(lock) {
            if (released) return
            released = true
            h = handler ?: return
        }
        val posted = h.post {
            synchronized(lock) {
                for (i in shaders.indices) {
                    shaders[i]?.release()
                    shaders[i] = null
                }
                while (pool.isNotEmpty()) pool.pollFirst()?.release()
                if (outstanding == 0) releaseConverter()
            }
        }
        if (!posted) Log.i(TAG, "capture thread already stopped; GL resources went with its context")
    }

    private fun releaseConverter() {
        yuvConverter?.release()
        yuvConverter = null
    }

    private companion object {
        const val TAG = "CameraFilter"
        const val MAX_IN_FLIGHT = 6

        val FULL_RECT: FloatBuffer = GlUtil.createFloatBuffer(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
        val FULL_TEX: FloatBuffer = GlUtil.createFloatBuffer(floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f))

        fun shaderIndex(oes: Boolean, beauty: Boolean) = (if (oes) 1 else 0) + (if (beauty) 2 else 0)

        fun vertex(beauty: Boolean) = """
${if (beauty) "#define BEAUTY" else ""}
attribute vec4 in_pos;
attribute vec4 in_tc;
uniform mat4 tex_mat;
varying vec2 tc;
varying vec2 pos;
#ifdef BEAUTY
// Sampling radius in frame space (x, y), mapped through the texture transform so taps stay round
// under rotation and crop.
uniform vec2 texel;
varying vec2 step_x;
varying vec2 step_y;
#endif
void main() {
  gl_Position = in_pos;
  tc = (tex_mat * in_tc).xy;
  pos = in_tc.xy;
#ifdef BEAUTY
  step_x = (tex_mat * vec4(texel.x, 0.0, 0.0, 0.0)).xy;
  step_y = (tex_mat * vec4(0.0, texel.y, 0.0, 0.0)).xy;
#endif
}
"""

        fun fragment(oes: Boolean, beauty: Boolean) = """
${if (oes) "#extension GL_OES_EGL_image_external : require" else ""}
${if (beauty) "#define BEAUTY" else ""}
#if defined(BEAUTY) && defined(GL_FRAGMENT_PRECISION_HIGH)
// Beauty sums many taps and needs sub-texel offsets: use highp where available.
precision highp float;
#else
precision mediump float;
#endif
varying vec2 tc;
varying vec2 pos;
uniform ${if (oes) "samplerExternalOES" else "sampler2D"} tex;
uniform mat4 color_mat;
uniform vec4 color_off;
uniform float vignette;
#ifdef BEAUTY
varying vec2 step_x;
varying vec2 step_y;
uniform float smoothing;
uniform vec3 white; // k, 1 / ln(1 + k), enabled
uniform float redness;

// Soft skin classifier on BT.601 chroma (8-bit Cb 77–127, Cr 133–173), ignoring near-black pixels.
float skin(vec3 c) {
  float cb = 0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5));
  float cr = 0.5 + dot(c, vec3(0.5, -0.418688, -0.081312));
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return smoothstep(0.27, 0.32, cb) * (1.0 - smoothstep(0.49, 0.54, cb))
       * smoothstep(0.50, 0.545, cr) * (1.0 - smoothstep(0.67, 0.72, cr))
       * smoothstep(0.08, 0.2, y);
}

// Bilateral tap: the range weight drops fast with colour distance, so edges are not blurred across.
#define TAP(dx, dy, ws) { vec3 s = texture2D(tex, tc + step_x * (dx) + step_y * (dy)).rgb; vec3 d = s - c; float w = (ws) * exp(-dot(d, d) * 40.0); sum += s * w; wsum += w; }
#endif
void main() {
  vec3 c = texture2D(tex, tc).rgb;
#ifdef BEAUTY
  float mask = skin(c);
  if (smoothing > 0.0 && mask > 0.0) {
    vec3 sum = c;
    float wsum = 1.0;
    TAP(0.5, 0.0, 1.0) TAP(-0.5, 0.0, 1.0) TAP(0.0, 0.5, 1.0) TAP(0.0, -0.5, 1.0)
    TAP(0.354, 0.354, 1.0) TAP(-0.354, 0.354, 1.0) TAP(0.354, -0.354, 1.0) TAP(-0.354, -0.354, 1.0)
    TAP(0.924, 0.383, 0.6) TAP(0.383, 0.924, 0.6) TAP(-0.383, 0.924, 0.6) TAP(-0.924, 0.383, 0.6)
    TAP(-0.924, -0.383, 0.6) TAP(-0.383, -0.924, 0.6) TAP(0.383, -0.924, 0.6) TAP(0.924, -0.383, 0.6)
    // Keep ~15% of the fine detail so skin does not look plastic.
    c = mix(c, sum / wsum, 0.85 * smoothing * mask);
  }
  if (white.z > 0.0) {
    vec3 lifted = log(vec3(1.0) + c * white.x) * white.y;
    c = mix(c, lifted, mix(0.3, 1.0, mask));
  }
  c = mix(c, clamp(c * vec3(1.12, 0.95, 1.02), 0.0, 1.0), redness * mask);
#endif
  vec4 o = clamp(color_mat * vec4(c, 1.0) + color_off, 0.0, 1.0);
  float edge = smoothstep(0.35, 0.85, length(pos - 0.5) * 1.414);
  gl_FragColor = vec4(o.rgb * (1.0 - vignette * edge), 1.0);
}
"""
    }
}
