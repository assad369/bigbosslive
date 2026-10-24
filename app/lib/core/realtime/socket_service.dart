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
            FirebaseAuth.instance.currentUser
                ?.getIdToken()
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
    socket.onConnectError((e) => debugPrint('socket connect error: $e'));
    socket.connect();
    _socket = socket;
  }

  void emit(String event, [Object? data]) => _socket?.emit(event, data);

  void subscribeRooms() => emit('rooms:subscribe');
  void unsubscribeRooms() => emit('rooms:unsubscribe');

  void disconnect() {
    _socket?.dispose();
    _socket = null;
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
