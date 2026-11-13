import 'dart:async';
import 'dart:convert';

import 'package:bigboss_live/features/games/game_host_bridge.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter_test/flutter_test.dart';

/// Timers the test fires by hand.
class _Timers {
  final List<(Duration, void Function(), _FakeTimer)> pending = [];

  Timer create(Duration d, void Function() fn) {
    final t = _FakeTimer();
    pending.add((d, fn, t));
    return t;
  }

  /// Fires every live timer of [d].
  void fire(Duration d) {
    for (final (dur, fn, t) in [...pending]) {
      if (dur == d && t.isActive) {
        t.cancel();
        fn();
      }
    }
  }
}

class _FakeTimer implements Timer {
  bool _active = true;
  @override
  void cancel() => _active = false;
  @override
  bool get isActive => _active;
  @override
  int get tick => 0;
}

String _event(Map<String, Object?> m) =>
    jsonEncode({'source': 'asadsoft-game', ...m});

void main() {
  group('GameEvent.parse', () {
    test('reads the game\'s own messages only', () {
      final e = GameEvent.parse(
        _event({'type': 'EXIT_GAME', 'reason': 'player'}),
      );
      expect(e?.type, 'EXIT_GAME');
      expect(e?.str('reason'), 'player');
      expect(GameEvent.parse(jsonEncode({'type': 'EXIT_GAME'})), isNull);
      expect(GameEvent.parse(_event({'type': 7})), isNull);
      expect(GameEvent.parse('not json'), isNull);
      expect(GameEvent.parse('[1,2]'), isNull);
    });
  });

  group('actionFor', () {
    GameEventAction of(Map<String, Object?> m) =>
        actionFor(GameEvent.parse(_event(m))!);

    test('maps each event', () {
      expect(of({'type': 'EXIT_GAME'}), GameEventAction.close);
      expect(of({'type': 'SESSION_INVALID'}), GameEventAction.fail);
      expect(of({'type': 'BOOT_ERROR'}), GameEventAction.fail);
      expect(of({'type': 'OPEN_RECHARGE'}), GameEventAction.recharge);
      expect(of({'type': 'INSUFFICIENT_BALANCE'}), GameEventAction.recharge);
      expect(of({'type': 'ROUND_COMPLETE'}), GameEventAction.refreshBalance);
      expect(of({'type': 'CASHBACK'}), GameEventAction.refreshBalance);
      expect(
        of({'type': 'EXIT_REQUEST_ACK', 'state': 'leaving'}),
        GameEventAction.exitAck,
      );
      expect(of({'type': 'GAME_READY'}), GameEventAction.ignore);
    });

    test('SESSION_ENDED fails only on an error that is not our own end', () {
      expect(
        of({'type': 'SESSION_ENDED', 'reason': 'host'}),
        GameEventAction.ignore,
      );
      expect(
        of({'type': 'SESSION_ENDED', 'reason': 'host', 'error': 'x'}),
        GameEventAction.ignore,
      );
      expect(
        of({'type': 'SESSION_ENDED', 'reason': 'player'}),
        GameEventAction.refreshBalance,
      );
      expect(
        of({'type': 'SESSION_ENDED', 'error': 'gone'}),
        GameEventAction.fail,
      );
      expect(of({'type': 'SESSION_ENDED'}), GameEventAction.refreshBalance);
    });
  });

  group('GameHostScripts', () {
    test('posts objects, never strings, to the page', () {
      expect(
        GameHostScripts.requestExit,
        'window.postMessage({"type":"REQUEST_EXIT"}, "*");',
      );
      expect(GameHostScripts.install, contains('BBGameHost.postMessage'));
      expect(GameHostScripts.install, contains("d.source !== 'asadsoft-game'"));
      expect(GameHostScripts.install, contains('window.__bbGameHost'));
    });
  });

  group('GameExitController', () {
    late _Timers timers;
    late List<String> sent;
    late int hardCloses;
    late int closes;
    late GameExitController exit;

    setUp(() {
      timers = _Timers();
      sent = [];
      hardCloses = 0;
      closes = 0;
      exit = GameExitController(
        send: sent.add,
        hardClose: () async => hardCloses++,
        close: () => closes++,
        timer: timers.create,
      );
    });

    test('leaving: waits for EXIT_GAME, which closes once', () {
      exit.requestExit();
      expect(sent, [GameHostScripts.requestExit]);
      exit.onAck('leaving');
      timers.fire(
        const Duration(milliseconds: 800),
      ); // the ack already cancelled it
      expect(hardCloses, 0);
      exit.onExitGame();
      exit.onExitGame();
      expect(closes, 1);
      timers.fire(const Duration(seconds: 4));
      expect(hardCloses, 0);
    });

    test('leaving without EXIT_GAME: the failsafe hard-closes', () {
      exit.requestExit();
      exit.onAck('busy');
      timers.fire(const Duration(seconds: 4));
      expect(hardCloses, 1);
      expect(exit.done, isTrue);
    });

    test('no ack: hard close', () {
      exit.requestExit();
      exit.requestExit(); // a second back while waiting sends nothing more
      expect(sent, hasLength(1));
      timers.fire(const Duration(milliseconds: 800));
      expect(hardCloses, 1);
    });

    test(
      'confirming and dismissed keep the game open; another back asks again',
      () {
        exit.requestExit();
        exit.onAck('confirming');
        timers.fire(const Duration(milliseconds: 800));
        timers.fire(const Duration(seconds: 4));
        expect(hardCloses + closes, 0);
        exit.requestExit();
        exit.onAck('dismissed');
        expect(sent, hasLength(2));
        expect(exit.done, isFalse);
      },
    );

    test('nothing happens after it is done', () {
      exit.forceClose();
      exit.requestExit();
      exit.onExitGame();
      expect(hardCloses, 1);
      expect(closes, 0);
      expect(sent, isEmpty);
    });
  });

  group('GameInfo', () {
    test('reads a locked game', () {
      final g = GameInfo.fromJson({
        'gameId': 'royal-teen-patti',
        'name': 'Royal Teen Patti',
        'category': 'card',
        'iconUrl': null,
        'lock': {'reason': 'level', 'minLevel': 5},
      });
      expect(g.lock?.message, 'Reach level 5 to play this game');
      expect(
        GameInfo.fromJson({'gameId': 'x', 'name': 'X', 'lock': null}).lock,
        isNull,
      );
      expect(
        const GameLock(reason: 'blocked').message,
        'Games are not available for your account',
      );
    });
  });
}
