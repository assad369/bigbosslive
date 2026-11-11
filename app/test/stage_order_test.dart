import 'package:bigboss_live/core/widgets/wallet_balance.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/features/live/live_stage.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeRepo implements LiveRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

final _t0 = DateTime.utc(2026, 11, 11, 10);

Map<String, dynamic> _seat(
  int index,
  String? uid, {
  int? satAfterSec,
  int diamonds = 0,
}) => {
  'index': index,
  'userId': uid,
  'muted': false,
  'videoMuted': false,
  'locked': false,
  'user': uid == null ? null : {'id': uid, 'displayName': 'User $uid'},
  'diamonds': diamonds,
  'seatedAt': satAfterSec == null
      ? null
      : _t0.add(Duration(seconds: satAfterSec)).toIso8601String(),
};

Map<String, dynamic> _room(
  List<Map<String, dynamic>> seats, {
  List<String> mods = const [],
  String? swapped,
}) => {
  'id': 'r1',
  'type': 'video',
  'status': 'live',
  'title': 'Room',
  'host': {'id': 'host', 'displayName': 'User host'},
  'viewerCount': 1,
  'giftDiamonds': 0,
  'livekitRoom': 'bb_host_1',
  'moderatorIds': mods,
  'seats': seats,
  'swappedUid': swapped,
};

LiveRoomController _controller({
  String me = 'me',
  bool isLiveModerator = false,
  UserBrief? brief,
}) => LiveRoomController(
  roomId: 'r1',
  myUid: me,
  repo: _FakeRepo(),
  isLiveModerator: isLiveModerator,
  me: brief,
)..debugConnected = (_) => true;

void main() {
  // LiveKit's Room starts a periodic timer: build controllers outside fake async.
  late LiveRoomController c;
  setUp(() => c = _controller());

  group('stage order', () {
    test('guests keep the order they sat down in, not the seat index', () {
      // B sat first on seat 2; C came later and took the freed seat 1.
      c.detail = RoomDetail.fromJson(
        _room([
          _seat(0, 'host'),
          _seat(1, 'c', satAfterSec: 30),
          _seat(2, 'b', satAfterSec: 10),
          _seat(3, null),
        ]),
      );
      expect(c.stage.map((s) => s.user!.id), ['host', 'b', 'c']);
      expect(c.spotOf('b'), 1);
      expect(c.spotOf('c'), 2);
      expect(c.spotOf('host'), isNull);
      expect(c.spotOf('nobody'), isNull);
    });

    test('a guest who drops out and reconnects keeps their place', () {
      c.detail = RoomDetail.fromJson(
        _room([
          _seat(0, 'host'),
          _seat(1, 'a', satAfterSec: 5),
          _seat(2, 'b', satAfterSec: 10),
        ]),
      );
      c.debugConnected = (uid) => uid != 'a';
      expect(c.stage.map((s) => s.user!.id), ['host', 'b']);
      expect(c.spotOf('b'), 1);
      c.debugConnected = (_) => true;
      expect(c.stage.map((s) => s.user!.id), ['host', 'a', 'b']);
    });

    test('older servers without seatedAt fall back to the seat index', () {
      c.detail = RoomDetail.fromJson(
        _room([_seat(0, 'host'), _seat(2, 'y'), _seat(1, 'x')]),
      );
      expect(c.stage.map((s) => s.user!.id), ['host', 'x', 'y']);
    });

    test(
      'a swap moves the guest into the host spot but keeps their number',
      () {
        c.detail = RoomDetail.fromJson(
          _room([
            _seat(0, 'host'),
            _seat(1, 'a', satAfterSec: 5),
            _seat(2, 'b', satAfterSec: 10),
          ], swapped: 'b'),
        );
        expect(c.stage.map((s) => s.user!.id), ['b', 'a', 'host']);
        expect(c.spotOf('b'), 2);
      },
    );

    test('a seats packet re-reads seatedAt', () {
      c.detail = RoomDetail.fromJson(_room([_seat(0, 'host')]));
      c.handleServerPacket('bb.seats', {
        'kind': 'seats',
        'seats': [
          _seat(0, 'host'),
          _seat(1, 'late', satAfterSec: 60),
          _seat(2, 'early', satAfterSec: 1),
        ],
      });
      expect(c.stage.map((s) => s.user!.id), ['host', 'early', 'late']);
    });
  });

  group('remove from stage (the tile ✕)', () {
    RoomDetail detail({List<String> mods = const []}) => RoomDetail.fromJson(
      _room([
        _seat(0, 'host'),
        _seat(1, 'guest', satAfterSec: 1),
        _seat(2, 'admin', satAfterSec: 2),
        _seat(3, 'me', satAfterSec: 3),
      ], mods: mods),
    );
    Seat seatOf(LiveRoomController c, String uid) =>
        c.detail!.seats.firstWhere((s) => s.user?.id == uid);

    test('the host can remove any guest, never the host seat', () {
      final host = _controller(me: 'host')..detail = detail();
      expect(host.canRemoveFromStage(seatOf(host, 'guest')), isTrue);
      expect(host.canRemoveFromStage(seatOf(host, 'me')), isTrue);
      expect(host.canRemoveFromStage(seatOf(host, 'host')), isFalse);
    });

    test('a room admin removes guests but not another admin', () {
      final admin = _controller(me: 'me')
        ..detail = detail(mods: ['me', 'admin']);
      expect(admin.canRemoveFromStage(seatOf(admin, 'guest')), isTrue);
      expect(admin.canRemoveFromStage(seatOf(admin, 'admin')), isFalse);
      expect(admin.canRemoveFromStage(seatOf(admin, 'me')), isFalse);
    });

    test('platform moderators may; viewers and guests may not', () {
      final staff = _controller(me: 'staff', isLiveModerator: true)
        ..detail = detail(mods: ['admin']);
      expect(staff.canRemoveFromStage(seatOf(staff, 'admin')), isTrue);
      final guest = _controller(me: 'me')..detail = detail();
      expect(guest.canRemoveFromStage(seatOf(guest, 'guest')), isFalse);
    });
  });

  group('my own join line', () {
    const me = UserBrief(
      id: 'me',
      shortId: '201',
      displayName: 'Me',
      level: 1,
      vipTier: 0,
    );

    test('the server echo of my join shows once, and others never bump it', () {
      final c = _controller(brief: me)
        ..detail = RoomDetail.fromJson(_room([_seat(0, 'host')]));
      void joined(String id) => c.handleServerPacket('bb.system', {
        'kind': 'viewers',
        'count': 2,
        'top': const <Object>[],
        'joined': {'uid': id, 'displayName': 'User $id'},
      });
      joined('me');
      joined('me'); // redelivered
      joined('a');
      joined('b');
      final joins = c.chat.where((l) => l.kind == ChatKind.join).toList();
      expect(joins.map((l) => l.user!.id), ['me', 'b']);
    });
  });

  test('stars are whole multiples of the rate', () {
    expect(starsFor(0, 100000), 0);
    expect(starsFor(99999, 100000), 0);
    expect(starsFor(100000, 100000), 1);
    expect(starsFor(1250000, 100000), 12);
    expect(starsFor(-5, 100000), 0);
    expect(starsFor(500, 0), 0);
  });

  test('host wallet reads seat 0 and follows balance packets', () {
    c.detail = RoomDetail.fromJson(
      _room([_seat(0, 'host', diamonds: 250000), _seat(1, null)]),
    );
    expect(c.hostDiamonds, 250000);
    c.handleServerPacket('bb.seats', {
      'kind': 'balances',
      'users': [
        {'uid': 'host', 'diamonds': 300000, 'level': 5},
      ],
    });
    expect(c.hostDiamonds, 300000);
  });

  group('stage tiles', () {
    late LiveRoomController host, viewer;
    setUpAll(() {
      final seats = [
        _seat(0, 'host'),
        _seat(1, 'late', satAfterSec: 30),
        _seat(2, 'early', satAfterSec: 10),
      ];
      host = _controller(me: 'host')
        ..detail = RoomDetail.fromJson(_room(seats));
      viewer = _controller(me: 'v')..detail = RoomDetail.fromJson(_room(seats));
    });

    Widget stage(LiveRoomController c, void Function(Seat) onRemove) =>
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(size: Size(390, 844)),
            child: Scaffold(
              body: LiveStage(
                c: c,
                onTapUser: (_) {},
                onTapEmptySeat: (_) {},
                onRemoveFromStage: onRemove,
              ),
            ),
          ),
        );

    testWidgets('guests show their spot; the host gets a ✕ on each guest', (
      tester,
    ) async {
      final removed = <String>[];
      await tester.pumpWidget(stage(host, (s) => removed.add(s.user!.id)));
      expect(tester.takeException(), isNull);
      final tiles = tester.widgetList<StageTile>(find.byType(StageTile));
      expect(tiles.map((t) => t.seat.user!.id), ['host', 'early', 'late']);
      final spots = tester.widgetList<SpotBadge>(find.byType(SpotBadge));
      expect(spots.map((b) => b.spot), [1, 2]);
      expect(find.byType(StageCloseButton), findsNWidgets(2));
      await tester.tap(find.bySemanticsLabel('Remove User late from stage'));
      expect(removed, ['late']);
    });

    testWidgets('viewers see the spots but no ✕', (tester) async {
      await tester.pumpWidget(stage(viewer, (_) {}));
      expect(find.byType(SpotBadge), findsNWidgets(2));
      expect(find.byType(StageCloseButton), findsNothing);
    });
  });
}
