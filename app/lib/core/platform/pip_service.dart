import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Android picture-in-picture, backed by the `bigboss/pip` channel in `MainActivity.kt`.
///
/// The app never enters PiP directly: it arms *auto-enter* while a live is active, and
/// Android shrinks the activity when the user leaves (Home, recents, gesture). Everywhere
/// else (iOS, tests) this is a no-op and [inPip] stays false.
class PipService {
  PipService() {
    if (_enabled) _channel.setMethodCallHandler(_onCall);
  }

  static const _channel = MethodChannel('bigboss/pip');
  static final bool _enabled = !kIsWeb && Platform.isAndroid;

  /// True while the activity is shown in the system PiP window.
  final ValueNotifier<bool> inPip = ValueNotifier(false);

  final _dismissed = StreamController<void>.broadcast();

  /// The user closed the PiP window (as opposed to expanding it back to the app).
  Stream<void> get dismissed => _dismissed.stream;

  ({bool enabled, int numerator, int denominator})? _armed;

  /// Arms or disarms auto-enter. Repeated calls with the same arguments are dropped,
  /// so callers can sync on every state change.
  Future<void> setAutoEnter(
    bool enabled, {
    int numerator = 9,
    int denominator = 16,
  }) async {
    if (!_enabled) return;
    final next = (
      enabled: enabled,
      numerator: numerator,
      denominator: denominator,
    );
    if (next == _armed) return;
    _armed = next;
    try {
      await _channel.invokeMethod<void>('setAutoEnter', {
        'enabled': enabled,
        'numerator': numerator,
        'denominator': denominator,
      });
    } on PlatformException catch (e) {
      // Forget the state so the next sync tries again instead of being deduped.
      if (_armed == next) _armed = null;
      debugPrint('pip setAutoEnter failed: $e');
    } on MissingPluginException {
      /* engine without MainActivity (e.g. add-to-app) */
    }
  }

  Future<dynamic> _onCall(MethodCall call) async {
    switch (call.method) {
      case 'changed':
        inPip.value = call.arguments == true;
      case 'dismissed':
        inPip.value = false;
        _dismissed.add(null);
    }
  }

  void dispose() {
    if (_enabled) _channel.setMethodCallHandler(null);
    inPip.dispose();
    unawaited(_dismissed.close());
  }
}

final pipServiceProvider = Provider<PipService>((ref) {
  final pip = PipService();
  ref.onDispose(pip.dispose);
  return pip;
});
