import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../../data/repositories.dart';
import '../theme/bb_colors.dart';

/// FCM registration and foreground display. Taps (foreground, background or cold start) are
/// delivered on [taps] as the message `data` map, which the router turns into a deep link.
class PushService {
  PushService(this._accounts);

  final AccountRepository _accounts;
  final _local = FlutterLocalNotificationsPlugin();
  final _taps = StreamController<Map<String, dynamic>>.broadcast();
  final _subs = <StreamSubscription<Object?>>[];
  bool _started = false;
  bool _localReady = false;
  bool _launchHandled = false;
  String? _token;

  Stream<Map<String, dynamic>> get taps => _taps.stream;

  static const _channel = AndroidNotificationChannel(
    'bigboss_default',
    'BigBoss Live',
    description: 'Lives, messages and account updates',
    importance: Importance.high,
  );

  /// Idempotent per signed-in session; [stop] undoes it.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      final messaging = FirebaseMessaging.instance;
      final settings = await messaging.requestPermission();
      if (!_started) return;
      if (settings.authorizationStatus == AuthorizationStatus.denied) return;

      await _initLocal();
      await messaging.setForegroundNotificationPresentationOptions(
        alert: false,
        badge: true,
        sound: true,
      );
      if (!_started) return;

      _subs
        ..add(FirebaseMessaging.onMessage.listen(_showForeground))
        ..add(
          FirebaseMessaging.onMessageOpenedApp.listen((m) => _taps.add(m.data)),
        )
        // The backend fans out with registration tokens (sendEachForMulticast). The newer
        // FID-based register()/onRegistered flow needs server-side direct-send support first.
        // ignore: deprecated_member_use
        ..add(messaging.onTokenRefresh.listen(_register));

      // A tap that cold-started the app is delivered once per process, not per sign-in.
      if (!_launchHandled) {
        _launchHandled = true;
        final initial = await messaging.getInitialMessage();
        if (initial != null) _taps.add(initial.data);
        final launch = await _local.getNotificationAppLaunchDetails();
        final payload = launch?.notificationResponse?.payload;
        if ((launch?.didNotificationLaunchApp ?? false) && payload != null) {
          _emitPayload(payload);
        }
      }

      // ignore: deprecated_member_use
      await _register(await messaging.getToken());
    } catch (e) {
      // getToken() throws on iOS until APNs has issued a token; onTokenRefresh covers it.
      debugPrint('push start failed: $e');
    }
  }

  Future<void> _initLocal() async {
    if (_localReady) return;
    await _local.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(),
      ),
      onDidReceiveNotificationResponse: (r) {
        if (r.payload != null) _emitPayload(r.payload!);
      },
    );
    await _local
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.createNotificationChannel(_channel);
    _localReady = true;
  }

  void _emitPayload(String payload) {
    try {
      final data = jsonDecode(payload);
      if (data is Map<String, dynamic>) _taps.add(data);
    } catch (_) {
      /* not ours */
    }
  }

  Future<void> _register(String? token) async {
    if (!_started || token == null || token == _token) return;
    _token = token;
    try {
      await _accounts.registerPushToken(
        token,
        Platform.isIOS ? 'ios' : 'android',
      );
    } catch (e) {
      debugPrint('push token registration failed: $e');
    }
  }

  Future<void> _showForeground(RemoteMessage m) async {
    final n = m.notification;
    if (n == null) return;
    // Chat pushes are suppressed while the app is open; the in-app socket already showed them.
    if (m.data['type'] == 'chat') return;
    await _local.show(
      // Notification ids are 32-bit; the message id keeps re-deliveries from stacking.
      id: (m.messageId ?? '${m.sentTime}').hashCode & 0x7fffffff,
      title: n.title,
      body: n.body,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          importance: Importance.high,
          priority: Priority.high,
          color: BBColors.goldDeep,
        ),
        iOS: const DarwinNotificationDetails(),
      ),
      payload: jsonEncode(m.data),
    );
  }

  /// Unregister this device on sign-out so the next account does not receive our pushes.
  Future<void> stop() async {
    _started = false;
    final subs = List.of(_subs);
    _subs.clear();
    for (final sub in subs) {
      await sub.cancel();
    }
    final token = _token;
    _token = null;
    if (token != null) {
      await _accounts.removePushToken(token).catchError((Object _) {});
    }
  }
}
