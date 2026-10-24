import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show Color;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../../data/repositories.dart';

/// FCM registration and foreground display. Taps (foreground, background or cold start) are
/// delivered on [taps] as the message `data` map, which the router turns into a deep link.
class PushService {
  PushService(this._accounts);

  final AccountRepository _accounts;
  final _local = FlutterLocalNotificationsPlugin();
  final _taps = StreamController<Map<String, dynamic>>.broadcast();
  StreamSubscription<String>? _tokenSub;
  String? _token;

  Stream<Map<String, dynamic>> get taps => _taps.stream;

  static const _channel = AndroidNotificationChannel(
    'bigboss_default',
    'BigBoss Live',
    description: 'Lives, messages and account updates',
    importance: Importance.high,
  );

  Future<void> start() async {
    final messaging = FirebaseMessaging.instance;
    final settings = await messaging.requestPermission();
    if (settings.authorizationStatus == AuthorizationStatus.denied) return;

    await _local.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(),
      ),
      onDidReceiveNotificationResponse: (r) {
        if (r.payload != null) {
          _taps.add(jsonDecode(r.payload!) as Map<String, dynamic>);
        }
      },
    );
    await _local
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.createNotificationChannel(_channel);
    await messaging.setForegroundNotificationPresentationOptions(
      alert: false,
      badge: true,
      sound: true,
    );

    FirebaseMessaging.onMessage.listen(_showForeground);
    FirebaseMessaging.onMessageOpenedApp.listen((m) => _taps.add(m.data));
    final initial = await messaging.getInitialMessage();
    if (initial != null) _taps.add(initial.data);

    // The backend fans out with registration tokens (sendEachForMulticast). The newer
    // FID-based register()/onRegistered flow needs server-side direct-send support first.
    // ignore: deprecated_member_use
    await _register(await messaging.getToken());
    // ignore: deprecated_member_use
    _tokenSub = messaging.onTokenRefresh.listen(_register);
  }

  Future<void> _register(String? token) async {
    if (token == null || token == _token) return;
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
      id: m.hashCode,
      title: n.title,
      body: n.body,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          importance: Importance.high,
          priority: Priority.high,
          color: const Color(0xFFB8860B),
        ),
        iOS: const DarwinNotificationDetails(),
      ),
      payload: jsonEncode(m.data),
    );
  }

  /// Unregister this device on sign-out so the next account does not receive our pushes.
  Future<void> stop() async {
    await _tokenSub?.cancel();
    final token = _token;
    _token = null;
    if (token != null) {
      await _accounts.removePushToken(token).catchError((Object _) {});
    }
  }
}
