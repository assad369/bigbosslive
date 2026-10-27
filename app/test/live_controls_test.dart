import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/live_controls.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeRepo implements LiveRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

Map<String, dynamic> _seat(int index, String? uid) => {
  'index': index,
  'userId': uid,
  'muted': false,
  'videoMuted': false,
  'locked': false,
  'user': uid == null ? null : {'id': uid, 'displayName': 'User $uid'},
};

LiveRoomController _controller(String me, {List<String> mods = const []}) {
  final c = LiveRoomController(roomId: 'r1', myUid: me, repo: _FakeRepo());
  c.detail = RoomDetail.fromJson({
    'id': 'r1',
    'type': 'video',
    'status': 'live',
    'title': 'Room',
    'host': {
      'id': 'host',
      'shortId': '100001',
      'displayName': 'A host with a rather long display name',
    },
    'viewerCount': 1200,
    'giftBeans': 0,
    'livekitRoom': 'bb_host_1',
    'moderatorIds': mods,
    'seats': [_seat(0, 'host'), _seat(1, 'guest'), _seat(2, null)],
  });
  return c;
}

/// The narrowest phones the app supports.
Future<void> _narrow(WidgetTester tester) async {
  tester.view.physicalSize = const Size(320, 640);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Widget _wrap(Widget child) => ProviderScope(
  child: MaterialApp(
    home: Scaffold(body: Column(children: [child])),
  ),
);

LiveBottomBar _bottomBar(LiveRoomController c) => LiveBottomBar(
  c: c,
  onCompose: () {},
  onGift: () {},
  onRequests: () {},
  onStageAction: () {},
);

void main() {
  // LiveKit's Room starts a periodic timer, so controllers are built outside the
  // widget tests' fake-async zone.
  late LiveRoomController host, guest, viewer, railHost, barHost;
  setUpAll(() {
    host = _controller('host')..cameraOn = true;
    guest = _controller('guest', mods: ['guest'])..cameraOn = true;
    viewer = _controller('viewer');
    railHost = _controller('host');
    barHost = _controller('host');
  });

  testWidgets('host and seated guests get the chat field without overflow', (
    tester,
  ) async {
    await _narrow(tester);
    for (final c in [host, guest, viewer]) {
      await tester.pumpWidget(_wrap(_bottomBar(c)));
      expect(find.text('Say something…'), findsOneWidget);
      expect(find.byTooltip('Chat'), findsNothing);
      // Flip camera lives on the side rail now.
      expect(find.byTooltip('Flip camera'), findsNothing);
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('the side rail offers flip camera only with the camera on', (
    tester,
  ) async {
    final c = railHost;
    Widget rail() =>
        _wrap(LiveSideRail(c: c, onPk: () {}, onLock: () {}, onHeart: () {}));
    await tester.pumpWidget(rail());
    expect(find.byTooltip('Flip camera'), findsNothing);
    c.cameraOn = true;
    await tester.pumpWidget(rail());
    expect(find.byTooltip('Flip camera'), findsOneWidget);
  });

  testWidgets('top bar keeps close in the corner with a full viewer strip', (
    tester,
  ) async {
    await _narrow(tester);
    final c = barHost
      ..topViewers = [
        for (var i = 0; i < 4; i++)
          UserBrief(id: 'v$i', shortId: '2$i', displayName: 'V$i', vipTier: i),
      ];
    var closed = 0;
    await tester.pumpWidget(
      _wrap(
        LiveTopBar(
          c: c,
          onClose: () => closed++,
          onViewers: () {},
          onTapUser: (_) {},
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    final close = find.byTooltip('End live');
    expect(tester.getTopRight(close).dx, closeTo(320 - 10, 1));
    await tester.tap(close);
    expect(closed, 1);
  });
}
