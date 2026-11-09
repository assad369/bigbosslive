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
  'giftDiamonds': 0,
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

  test('balances events update stage diamonds and levels in place', () {
    final c = _controller(me: 'me');
    c.handleServerPacket('bb.seats', {
      'kind': 'seats',
      'seats': [
        {..._seat(0, 'host'), 'diamonds': 500},
        {..._seat(1, 'me'), 'diamonds': 40},
        _seat(2, null),
      ],
    });
    expect(c.stage.map((s) => s.diamonds), [500, 40]);

    c.handleServerPacket('bb.seats', {
      'kind': 'balances',
      'users': [
        {'uid': 'me', 'diamonds': 110, 'level': 4},
        {'uid': 'nobody', 'diamonds': 1, 'level': 1},
      ],
    });
    final mine = c.mySeat!;
    expect(mine.diamonds, 110);
    expect(mine.user!.level, 4);
    expect(c.stage.first.diamonds, 500); // the host is untouched
    expect(mine.user!.displayName, 'User me');
  });

  test('a seated guest who left LiveKit drops off the stage at once', () {
    // Nobody is connected in a unit test: the host and this user are always shown, any
    // other guest only while LiveKit reports them.
    final c = _controller(me: 'me');
    c.handleServerPacket('bb.seats', {
      'kind': 'seats',
      'seats': [_seat(0, 'host'), _seat(1, 'gone'), _seat(2, 'me')],
    });
    expect(c.stage.map((s) => s.user!.id), ['host', 'me']);
    final shown = c.displaySeats;
    expect(shown[1].user, isNull);
    expect(shown[1].index, 1);
    expect(shown[2].user!.id, 'me');
    // Role checks still see the server's seat list.
    expect(c.roleOf('gone'), RoomRole.guest);
  });

  test('a gift sets the room total the server committed', () {
    final c = _controller();
    c.handleServerPacket('bb.gift', {
      'transactionId': 't1',
      'sender': _brief('fan'),
      'gift': {'id': 'g', 'name': 'Rose', 'price': 10},
      'quantity': 1,
      'receivers': [_brief('host')],
      'roomGiftDiamonds': 1234,
    });
    expect(c.detail!.room.giftDiamonds, 1234);
  });

  Map<String, dynamic> giftPacket({Map<String, dynamic>? message}) => {
    'transactionId': 't1',
    'sender': _brief('fan'),
    'gift': {
      'id': 'g',
      'name': 'Rose',
      'price': 10,
      'iconUrl': 'https://cdn.test/rose.png',
    },
    'quantity': 10,
    'receivers': [_brief('host'), _brief('guest')],
    'roomGiftDiamonds': 70,
    'message': ?message,
  };

  test('a gift shows the chat message the server saved', () {
    final c = _controller();
    c.handleServerPacket(
      'bb.gift',
      giftPacket(
        message: {
          'id': 't1',
          'type': 'gift',
          'text': 'sent Rose ×10 to User host, User guest',
          'voice': null,
          'replyTo': null,
          'gift': {
            'transactionId': 't1',
            'giftId': 'g',
            'name': 'Rose',
            'iconUrl': 'https://cdn.test/rose.png',
            'quantity': 10,
            'totalCost': 200,
            'receivers': [
              {'id': 'host', 'displayName': 'User host'},
              {'id': 'guest', 'displayName': 'User guest'},
            ],
          },
          'user': _brief('fan', role: 'moderator'),
          'at': '2026-11-09T10:00:00.000Z',
        },
      ),
    );
    final gifts = c.chat.where((l) => l.kind == ChatKind.gift).toList();
    expect(gifts, hasLength(1));
    final line = gifts.single;
    expect(line.id, 't1');
    expect(line.isMessage, isTrue); // can be replied to, reported and deleted
    expect(line.user!.id, 'fan');
    expect(line.role, RoomRole.admin);
    expect(line.gift!.name, 'Rose');
    expect(line.gift!.iconUrl, 'https://cdn.test/rose.png');
    expect(line.gift!.quantity, 10);
    expect(line.gift!.receiverNames, ['User host', 'User guest']);
    expect(line.preview, '🎁 Rose ×10');

    // The same gift again (a redelivered packet) adds nothing.
    c.handleServerPacket('bb.gift', giftPacket());
    expect(c.chat.where((l) => l.kind == ChatKind.gift), hasLength(1));
  });

  test('without a saved message the app writes its own gift line', () {
    final c = _controller();
    c.handleServerPacket('bb.gift', giftPacket());
    final line = c.chat.singleWhere((l) => l.kind == ChatKind.gift);
    expect(line.id, 't1');
    expect(line.isMessage, isFalse); // nothing on the server to reply to
    expect(line.gift!.name, 'Rose');
    expect(line.gift!.receiverNames, ['User host', 'User guest']);
    expect(line.text, 'sent Rose ×10 to User host, User guest');
  });

  test('automated moderation notices reach the participant', () async {
    final c = _controller(me: 'guest');
    final warned = c.notices.first;
    c.handleServerPacket('bb.system', {'kind': 'moderation', 'action': 'warn'});
    expect(await warned, contains('community guidelines'));
    final muted = c.notices.first;
    c.handleServerPacket('bb.system', {
      'kind': 'moderation',
      'action': 'muted',
      'media': 'video',
    });
    expect(await muted, contains('camera was turned off'));
  });

  test('a moderation end and a system kick keep why it happened', () async {
    final viewer = _controller(me: 'v');
    viewer.status = LiveStatus.live;
    viewer.handleServerPacket('bb.room.ended', {
      'roomId': 'r1',
      'reason': 'moderation',
    });
    expect(viewer.status, LiveStatus.ended);
    expect(viewer.endReason, 'moderation');

    final kicked = _controller(me: 'v');
    kicked.status = LiveStatus.live;
    kicked.handleServerPacket('bb.kick', {'uid': 'v', 'by': 'system'});
    expect(kicked.status, LiveStatus.kicked);
    expect(kicked.removedByModeration, isTrue);

    final byHost = _controller(me: 'v');
    byHost.status = LiveStatus.live;
    byHost.handleServerPacket('bb.kick', {'uid': 'v', 'by': 'host'});
    expect(byHost.removedByModeration, isFalse);
  });

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
