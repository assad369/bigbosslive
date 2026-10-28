import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../config/env.dart';

/// One Socket.IO connection to the app namespace for the signed-in user.
///
/// Personal events (chat, notifications, wallet) arrive here; the server addresses them to
/// `user:<uid>`. Auth runs on every (re)connect with a fresh Firebase ID token.
class SocketService {
  SocketService();

  io.Socket? _socket;
  final _events = StreamController<SocketEvent>.broadcast();
  Timer? _retry;
  int _failures = 0;
  bool _roomsWanted = false;

  Stream<SocketEvent> get events => _events.stream;
  Stream<Map<String, dynamic>> on(String name) =>
      _events.stream.where((e) => e.name == name).map((e) => e.data);

  bool get connected => _socket?.connected ?? false;

  static const forwarded = [
    'chat:message',
    'chat:read',
    'chat:typing',
    'notification:new',
    'wallet:updated',
    'rooms:upserted',
    'rooms:ended',
  ];

  void connect() {
    if (_socket != null) return;
    final socket = io.io(
      Env.apiUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setPath('/socket.io')
          .disableAutoConnect()
          .enableReconnection()
          .setReconnectionDelay(1000)
          .setReconnectionDelayMax(10000)
          .setAuthFn((cb) {
            final user = FirebaseAuth.instance.currentUser;
            if (user == null) return cb({});
            user
                .getIdToken()
                .then((t) => cb({'token': t}))
                .catchError((Object _) => cb({}));
          })
          .build(),
    );
    for (final name in forwarded) {
      socket.on(name, (data) {
        if (data is Map) {
          _events.add(SocketEvent(name, Map<String, dynamic>.from(data)));
        }
      });
    }
    socket.onConnect((_) {
      _failures = 0;
      // Server-side room membership is per connection; restore it after every reconnect.
      if (_roomsWanted) socket.emit('rooms:subscribe');
    });
    socket.onConnectError((e) {
      debugPrint('socket connect error: $e');
      // A handshake the server rejects (e.g. a token that failed to verify) destroys the
      // socket and the client stops reconnecting. Retry it ourselves with backoff.
      if (socket.active || !identical(_socket, socket)) return;
      _retry?.cancel();
      final delay = Duration(seconds: 1 << _failures.clamp(0, 5));
      _failures++;
      _retry = Timer(delay, () {
        if (identical(_socket, socket)) socket.connect();
      });
    });
    _socket = socket;
    socket.connect();
  }

  void emit(String event, [Object? data]) => _socket?.emit(event, data);

  /// Follow the live directory (`rooms:*`). Kept across reconnects.
  void subscribeRooms() {
    if (_roomsWanted) return;
    _roomsWanted = true;
    emit('rooms:subscribe');
  }

  void unsubscribeRooms() {
    if (!_roomsWanted) return;
    _roomsWanted = false;
    emit('rooms:unsubscribe');
  }

  void disconnect() {
    _retry?.cancel();
    _retry = null;
    _failures = 0;
    _roomsWanted = false;
    final socket = _socket;
    _socket = null;
    socket?.dispose();
  }

  Future<void> dispose() async {
    disconnect();
    await _events.close();
  }
}

class SocketEvent {
  const SocketEvent(this.name, this.data);
  final String name;
  final Map<String, dynamic> data;
}
