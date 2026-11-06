import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'camera_filters.dart';

/// Applies a [CameraFilter] to a local camera track at the capture source, through the
/// `bb_camera_filter` plugin (Android: a GL processor, iOS: a Core Image processor).
/// Because it runs before the encoder, the local preview, every viewer and PK-forwarded
/// video all show the same filtered picture.
///
/// A camera track gets a new native id whenever capture restarts (publish, camera off then
/// on, flip), so callers re-apply after each. Applying to the same track again only updates
/// the parameters natively.
abstract final class CameraFilterChannel {
  @visibleForTesting
  static const channel = MethodChannel('bigboss/camera_filter');

  /// Native processors exist on Android and iOS only; the filter UI is hidden elsewhere.
  static bool get isSupported =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  /// Applies [filter] to [track]. For the beauty tile, [beauty] (the user's sliders)
  /// replaces the catalogue default. "None" detaches the processor.
  static Future<void> apply(
    LocalVideoTrack? track,
    CameraFilter filter, {
    BeautyParams? beauty,
  }) => applyToTrackId(_idOf(track), filter, beauty: beauty);

  /// Detaches any filter from [track]. Call before the camera stops, while the native
  /// capture thread can still free its GPU resources.
  static Future<void> clear(LocalVideoTrack? track) =>
      clearTrackId(_idOf(track));

  /// [apply] by native track id; tests drive this without a WebRTC track.
  @visibleForTesting
  static Future<void> applyToTrackId(
    String? id,
    CameraFilter filter, {
    BeautyParams? beauty,
  }) async {
    if (!isSupported || id == null) return;
    if (filter.isNone) return clearTrackId(id);
    final params = filter.hasBeauty ? (beauty ?? filter.beauty) : null;
    await _invoke('apply', {
      'trackId': id,
      'matrix': Float64List.fromList(filter.matrix.values),
      'vignette': filter.vignette,
      'beauty': params?.toMap(),
    });
  }

  /// [clear] by native track id.
  @visibleForTesting
  static Future<void> clearTrackId(String? id) async {
    if (!isSupported || id == null) return;
    await _invoke('clear', {'trackId': id});
  }

  static String? _idOf(LocalVideoTrack? track) {
    try {
      return track?.mediaStreamTrack.id;
    } catch (_) {
      return null; // already disposed
    }
  }

  static Future<void> _invoke(String method, Map<String, Object?> args) async {
    try {
      await channel.invokeMethod<void>(method, args);
    } on PlatformException catch (e) {
      // Filters are cosmetic: a failure must never break the camera or the live.
      debugPrint('camera filter $method failed: ${e.code} ${e.message}');
    } on MissingPluginException {
      debugPrint('camera filter plugin not registered');
    }
  }
}

/// The last filter and beauty settings the user picked, on this device.
///
/// Nothing is stored until they pick, so [CameraFilters.defaultFilter] (beauty) applies until
/// then, while an explicit "None" is kept. Values are cached in memory, so a choice made on
/// the go-live screen is what the live room reads next, with no wait for the disk write.
abstract final class CameraFilterPrefs {
  static const _filterKey = 'bb.camera_filter';
  static const _beautyKey = 'bb.camera_beauty';

  static String? _filterId;
  static BeautyParams? _beauty;

  static Future<({String filterId, BeautyParams beauty})> load() async {
    if (_filterId == null || _beauty == null) {
      try {
        final prefs = await SharedPreferences.getInstance();
        _filterId ??= CameraFilters.byId(prefs.getString(_filterKey)).id;
        _beauty ??= _decode(prefs.getString(_beautyKey));
      } catch (e) {
        debugPrint('camera filter prefs unreadable: $e');
      }
    }
    return (
      filterId: _filterId ?? CameraFilters.defaultFilter.id,
      beauty: _beauty ?? BeautyParams.preset,
    );
  }

  static Future<void> saveFilter(String id) async {
    _filterId = CameraFilters.byId(id).id;
    await _write((p) => p.setString(_filterKey, _filterId!));
  }

  static Future<void> saveBeauty(BeautyParams beauty) async {
    _beauty = beauty;
    await _write((p) => p.setString(_beautyKey, jsonEncode(beauty.toMap())));
  }

  static BeautyParams _decode(String? raw) {
    if (raw == null) return BeautyParams.preset;
    try {
      final map = jsonDecode(raw);
      if (map is Map<String, Object?>) return BeautyParams.fromMap(map);
    } on FormatException {
      // Corrupt value: fall back to the preset.
    }
    return BeautyParams.preset;
  }

  static Future<void> _write(
    Future<bool> Function(SharedPreferences prefs) write,
  ) async {
    try {
      await write(await SharedPreferences.getInstance());
    } catch (e) {
      debugPrint(
        'camera filter prefs not saved: $e',
      ); // a preference, not critical
    }
  }

  /// Forgets the in-memory cache, so tests start from what is on disk.
  @visibleForTesting
  static void resetCache() {
    _filterId = null;
    _beauty = null;
  }
}
