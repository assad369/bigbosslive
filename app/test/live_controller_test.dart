import 'dart:async';

import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter_test/flutter_test.dart';

/// Server events are applied without any API calls; nothing here should reach the network.
/// The few calls a test drives are answered by the completers it sets.
class _FakeRepo implements LiveRepository {
  Completer<LiveSession>? joining;
  Completer<RoomDetail>? polling;

  @override
  Future<LiveSession> join(String roomId, {String? password}) =>
      joining!.future;

  @override
  Future<RoomDetail> detail(String roomId) => polling!.future;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

Map<String, dynamic> _brief(String id, {String role = 'audience'}) => {
  'uid': id,
  'shortId': '1$id',
  'displayName': 'User $id',
  'level': 3,
  'vipTier': 0,
  'role': role,
};

Map<String, dynamic> _seat(int index, String? uid, {bool muted = false}) => {
  'index': index,
  'userId': uid,
  'muted': muted,
  'videoMuted': false,
  'locked': false,
  'user': uid == null ? null : {'id': uid, 'displayName': 'User $uid'},
};

Map<String, dynamic> _battle(
  String id, {
  String status = 'active',
  String roundState = 'live',
  int round = 1,
  List<Map<String, dynamic>> rounds = const [],
  String? winner,
}) => {
  'id': id,
  'status': status,
  'invitedBy': 'host',
  'hosts': [
    {
      'uid': 'host',
      'roomId': 'r1',
      'score': 50,
      'roundScore': 20,
      'roundsWon': 1,
      'displayName': 'Host',
    },
    {
      'uid': 'rival',
      'roomId': 'r2',
      'score': 30,
      'roundScore': 30,
      'roundsWon': 0,
      'displayName': 'Rival',
    },
  ],
  'durationSec': 180,
  'round': round,
  'maxRounds': 3,
  'roundState': roundState,
  'rounds': rounds,
  'winnerUid': winner,
  'isDraw': false,
  'serverTime': DateTime.now().toUtc().toIso8601String(),
};

Map<String, dynamic> _roomJson({
  List<String> mods = const [],
  String title = 'Room',
  String? guest,
  String? serverTime,
}) => {
  'id': 'r1',
  'type': 'video',
  'status': 'live',
  'title': title,
  'host': {'id': 'host', 'displayName': 'Host'},
  'viewerCount': 1,
  'giftBeans': 0,
  'livekitRoom': 'bb_host_1',
  'moderatorIds': mods,
  'seats': [_seat(0, 'host'), _seat(1, guest), _seat(2, null)],
  'serverTime': ?serverTime,
};

LiveRoomController _controller({
  String me = 'me',
  List<String> mods = const [],
  _FakeRepo? repo,
}) {
  final c = LiveRoomController(
    roomId: 'r1',
    myUid: me,
    repo: repo ?? _FakeRepo(),
  );
  c.detail = RoomDetail.fromJson(_roomJson(mods: mods));
  return c;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('server chat carries role, reply and voice', () {
    final c = _controller();
    c.handleServerPacket('bb.chat', {
      'id': 'm1',
      'text': 'hi',
      'voice': null,
      'replyTo': {
        'id': 'm0',
        'userId': 'host',
        'displayName': 'Host',
        'text': 'welcome',
      },
      'user': _brief('host', role: 'host'),
    });
    c.handleServerPacket('bb.chat', {
      'id': 'm2',
      'text': '',
      'voice': {'url': 'https://cdn/voice/a.m4a', 'durationSec': 7},
      'user': _brief('v'),
    });
    expect(c.chat.map((l) => l.id), ['m1', 'm2']);
    expect(c.chat[0].role, RoomRole.host);
    expect(c.chat[0].replyTo!.text, 'welcome');
    expect(c.chat[1].kind, ChatKind.voice);
    expect(c.chat[1].voiceSec, 7);

    // Moderator delete removes it for everyone; a packet without an id is dropped.
    c.handleServerPacket('bb.system', {'kind': 'chat_deleted', 'id': 'm1'});
    c.handleServerPacket('bb.chat', {
      'id': '',
      'text': 'x',
      'user': _brief('v'),
    });
    expect(c.chat.map((l) => l.id), ['m2']);
  });

  test('viewer updates set the count, top viewers and collapse join lines', () {
    final c = _controller();
    for (final id in ['a', 'b']) {
      c.handleServerPacket('bb.system', {
        'kind': 'viewers',
        'count': 2,
        'top': [_brief('a')],
        'joined': _brief(id),
      });
    }
    expect(c.viewerCount, 2);
    expect(c.topViewers.single.id, 'a');
    final joins = c.chat.where((l) => l.kind == ChatKind.join).toList();
    expect(joins.single.user!.id, 'b');
  });

  test('seat updates, admin changes and the lock update room state', () {
    final c = _controller(me: 'me');
    c.handleServerPacket('bb.seats', {
      'kind': 'seats',
      'seats': [_seat(0, 'host'), _seat(1, 'me', muted: true), _seat(2, null)],
    });
    expect(c.onSeat, isTrue);
    expect(c.mySeat!.muted, isTrue);
    expect(c.roleOf('me'), RoomRole.guest);
    expect(c.stage.length, 2);

    c.handleServerPacket('bb.system', {
      'kind': 'moderator',
      'uid': 'x',
      'enabled': true,
      'user': {'id': 'x', 'displayName': 'X'},
    });
    expect(c.roleOf('x'), RoomRole.admin);
    expect(c.detail!.moderators.single.id, 'x');
    c.handleServerPacket('bb.system', {
      'kind': 'moderator',
      'uid': 'x',
      'enabled': false,
    });
    expect(c.roleOf('x'), RoomRole.viewer);

    c.handleServerPacket('bb.system', {
      'kind': 'lock',
      'locked': true,
      'hasPassword': true,
    });
    expect(c.locked, isTrue);
    expect(c.detail!.room.hasPassword, isTrue);
  });

  test('seat requests reach only the host and admins', () {
    final viewer = _controller(me: 'v');
    viewer.handleServerPacket('bb.seats', {
      'kind': 'request',
      'user': _brief('q'),
    });
    expect(viewer.seatRequests, isEmpty);

    final host = _controller(me: 'host');
    host.handleServerPacket('bb.seats', {
      'kind': 'request',
      'user': _brief('q'),
    });
    host.handleServerPacket('bb.seats', {
      'kind': 'request',
      'user': _brief('q'),
    });
    expect(host.seatRequests.single.user.id, 'q');
    host.handleServerPacket('bb.seats', {
      'kind': 'request_resolved',
      'uid': 'q',
      'accepted': true,
    });
    expect(host.seatRequests, isEmpty);
  });

  test(
    'a declined request clears the pending state and tells the viewer',
    () async {
      final c = _controller(me: 'v');
      c.seatRequestPending = true;
      final notice = c.notices.first;
      c.handleServerPacket('bb.seats', {
        'kind': 'request_resolved',
        'uid': 'v',
        'accepted': false,
      });
      expect(c.seatRequestPending, isFalse);
      expect(await notice, contains('declined'));
    },
  );

  test('stage invites are surfaced with the inviter', () async {
    final c = _controller(me: 'v');
    final invite = c.seatInvites.first;
    c.handleServerPacket('bb.seats', {
      'kind': 'invite',
      'from': _brief('host', role: 'host'),
    });
    expect((await invite).from.id, 'host');
  });

  test(
    'PK rounds: start, round result, and only this room’s battle is applied',
    () {
      final c = _controller(me: 'host');
      c.handleServerPacket('bb.pk.started', {'battle': _battle('b1')});
      expect(c.pk!.round, 1);
      expect(c.pkOpponent!.uid, 'rival');

      c.handleServerPacket('bb.pk.round_ended', {
        'battle': _battle(
          'b1',
          roundState: 'paused',
          rounds: [
            {
              'round': 1,
              'scores': [20, 30],
              'winnerUid': 'rival',
            },
          ],
        ),
        'contributors': {
          'host': [
            {
              'user': {'id': 'fan'},
              'score': 20,
            },
          ],
        },
      });
      expect(c.pk!.isPaused, isTrue);
      expect(c.pkContributors['host']!.single.score, 20);
      expect(c.chat.last.text, contains('Round 1 goes to Rival'));

      // Someone else's battle is ignored.
      c.handleServerPacket('bb.pk.cancelled', {
        'battle': _battle('other', status: 'cancelled'),
      });
      expect(c.pk!.id, 'b1');

      c.handleServerPacket('bb.pk.ended', {
        'battle': _battle('b1', status: 'ended', winner: 'host'),
      });
      expect(c.pk!.isEnded, isTrue);
      expect(c.chat.last.text, contains('wins the PK'));
    },
  );

  test('a declined PK challenge clears the waiting state', () {
    final c = _controller(me: 'host');
    c.pkOutgoing = PkBattle.fromJson(_battle('b2', status: 'pending'));
    c.handleServerPacket('bb.pk.rejected', {
      'battle': _battle('b2', status: 'rejected'),
    });
    expect(c.pkOutgoing, isNull);
    expect(c.pk, isNull);
  });

  group('lifecycle', () {
    test('closing while joining never connects or starts anything', () async {
      // Regression: a controller disposed mid-join went on to connect, take the wakelock
      // and start the heartbeat and poll timers, keeping a host room alive forever.
      final repo = _FakeRepo()..joining = Completer();
      final c = LiveRoomController(roomId: 'r1', myUid: 'me', repo: repo);
      final started = c.start();
      c.dispose();
      repo.joining!.complete(
        LiveSession.fromJson({
          'room': _roomJson(),
          'credentials': {
            'token': 't',
            'url': 'wss://lk.test',
            'identity': 'me',
            'role': 'viewer',
          },
        }),
      );
      await started;
      expect(c.detail, isNull);
      expect(c.status, LiveStatus.connecting);
    });

    test(
      'a poll answer older than a seats event keeps the newer seats',
      () async {
        final repo = _FakeRepo()..polling = Completer();
        final c = _controller(repo: repo);
        final poll = c.refreshDetail();
        // While the poll is in flight, a guest takes seat 1.
        c.handleServerPacket('bb.seats', {
          'kind': 'seats',
          'seats': [_seat(0, 'host'), _seat(1, 'g'), _seat(2, null)],
        });
        // The poll was answered before that, so it has seat 1 empty (and a new title).
        repo.polling!.complete(RoomDetail.fromJson(_roomJson(title: 'New')));
        await poll;
        expect(c.detail!.seats[1].user?.id, 'g');
        expect(c.detail!.room.title, 'New');
      },
    );

    test('a poll with no seat event in between applies in full', () async {
      final repo = _FakeRepo()..polling = Completer();
      final c = _controller(repo: repo);
      final poll = c.refreshDetail();
      repo.polling!.complete(RoomDetail.fromJson(_roomJson(guest: 'g')));
      await poll;
      expect(c.detail!.seats[1].user?.id, 'g');
    });

    test('stream-only events do not rebuild the room', () {
      final c = _controller();
      var notified = 0;
      c.addListener(() => notified++);
      c.handleServerPacket('bb.reaction', {'uid': 'v', 'count': 3});
      c.handleServerPacket('bb.entry', {'user': _brief('v')});
      expect(notified, 0);
      c.handleServerPacket('bb.chat', {
        'id': 'm1',
        'text': 'hi',
        'user': _brief('v'),
      });
      expect(notified, 1);
    });

    test('packets after dispose are ignored', () {
      final c = _controller()..dispose();
      expect(
        () => c.handleServerPacket('bb.reaction', {'uid': 'v', 'count': 1}),
        returnsNormally,
      );
    });

    test('seat invites count down on the device clock', () async {
      // A server 10 minutes ahead of this phone: the raw expiry would already be "past".
      final c = _controller();
      c.detail = RoomDetail.fromJson(
        _roomJson(
          serverTime: DateTime.now()
              .add(const Duration(minutes: 10))
              .toUtc()
              .toIso8601String(),
        ),
      );
      final invite = c.seatInvites.first;
      final serverExpiry = DateTime.now().add(
        const Duration(minutes: 10, seconds: 30),
      );
      c.handleServerPacket('bb.seats', {
        'kind': 'invite',
        'from': _brief('host'),
        'expiresAt': serverExpiry.toUtc().toIso8601String(),
      });
      final left = (await invite).expiresAt!.difference(DateTime.now());
      expect(left.inSeconds, inInclusiveRange(25, 31));
    });
  });
}
