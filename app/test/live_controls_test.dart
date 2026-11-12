import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/live_controls.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/features/live/live_sheets.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeRepo implements LiveRepository {
  _FakeRepo({this.requests = const []});
  final List<SeatRequest> requests;
  var requestLoads = 0;

  @override
  Future<List<SeatRequest>> seatRequests(String roomId) async {
    requestLoads++;
    return requests;
  }

  @override
  Future<List<UserBrief>> viewers(String roomId) async => const [];

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

LiveRoomController _controller(
  String me, {
  List<String> mods = const [],
  String type = 'video',
  bool liveModerator = false,
  _FakeRepo? repo,
}) {
  final c = LiveRoomController(
    roomId: 'r1',
    myUid: me,
    repo: repo ?? _FakeRepo(),
    isLiveModerator: liveModerator,
  );
  c.detail = RoomDetail.fromJson({
    'id': 'r1',
    'type': type,
    'status': 'live',
    'title': 'Room',
    'host': {
      'id': 'host',
      'shortId': '100001',
      'displayName': 'A host with a rather long display name',
    },
    'viewerCount': 1200,
    'giftDiamonds': 0,
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
  onParticipants: () {},
  onStageAction: () {},
  onHeart: () {},
);

Widget _rail(LiveRoomController c) => _wrap(
  LiveSideRail(
    c: c,
    onPk: () {},
    onLock: () {},
    onShare: (_) {},
    onGames: () {},
    onFilters: () {},
    onMore: () {},
  ),
);

void main() {
  // LiveKit's Room starts a periodic timer, so controllers are built outside the
  // widget tests' fake-async zone.
  late LiveRoomController host, guest, viewer, railHost, barHost, foldHost;
  late LiveRoomController coHost, audioGuest, moderator;
  late LiveRoomController sheetHost, sheetViewer, hiddenMod;
  late _FakeRepo hiddenModRepo;
  final waiting = [
    for (final id in ['w1', 'w2'])
      SeatRequest(
        user: UserBrief(id: id, shortId: '3$id', displayName: 'Waiting $id'),
      ),
  ];
  setUpAll(() {
    moderator = _controller('pm', liveModerator: true);
    sheetHost = _controller('host', repo: _FakeRepo(requests: waiting));
    sheetViewer = _controller('viewer');
    hiddenModRepo = _FakeRepo(requests: waiting);
    hiddenMod = _controller('pm', liveModerator: true, repo: hiddenModRepo);
    coHost = _controller('guest');
    audioGuest = _controller('guest', type: 'audio');
    host = _controller('host')..cameraOn = true;
    guest = _controller('guest', mods: ['guest'])..cameraOn = true;
    viewer = _controller('viewer');
    railHost = _controller('host');
    barHost = _controller('host');
    foldHost = _controller('host');
  });

  Future<void> width(WidgetTester tester, double w) async {
    tester.view.physicalSize = Size(w, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  bool shown(String tooltip) => find.byTooltip(tooltip).evaluate().isNotEmpty;

  testWidgets('a viewer keeps the chat field, gift, phone and heart only', (
    tester,
  ) async {
    await _narrow(tester);
    await tester.pumpWidget(_wrap(_bottomBar(viewer)));
    expect(tester.takeException(), isNull);
    expect(find.text('Say something…'), findsOneWidget);
    expect(find.byTooltip('Send a gift'), findsOneWidget);
    expect(find.byTooltip('Send hearts'), findsOneWidget);
    expect(find.byTooltip('Ask to join the stage'), findsOneWidget);
    for (final media in ['Mute', 'Unmute', 'Camera off', 'Camera on']) {
      expect(find.byTooltip(media), findsNothing);
    }
    expect(find.byTooltip('Flip camera'), findsNothing);
  });

  testWidgets('the host and video guests get mic, camera and flip in the bar', (
    tester,
  ) async {
    for (final w in [320.0, 360.0, 390.0, 430.0]) {
      await width(tester, w);
      for (final (c, phone) in [
        (host, 'Guests & requests'),
        // A seated room admin opens the queue too; leaving is in that sheet.
        (guest, 'Guests & requests'),
        (coHost, 'Leave the stage'),
      ]) {
        await tester.pumpWidget(_wrap(_bottomBar(c)));
        expect(tester.takeException(), isNull, reason: 'overflow at $w');
        expect(shown('Mute') || shown('Unmute'), isTrue);
        expect(shown('Camera off') || shown('Camera on'), isTrue);
        expect(find.byTooltip('Flip camera'), findsOneWidget);
        expect(find.byTooltip('Send a gift'), findsOneWidget);
        expect(find.byTooltip(phone), findsOneWidget);
        // The chat is always reachable: the field, or a round button when it's tight.
        expect(
          shown('Write a message') ||
              find.text('Say something…').evaluate().isNotEmpty,
          isTrue,
        );
      }
    }
    // Wide enough, the field stays a field and the heart stays.
    await width(tester, 430);
    await tester.pumpWidget(_wrap(_bottomBar(host)));
    expect(find.text('Say something…'), findsOneWidget);
    expect(find.byTooltip('Send hearts'), findsOneWidget);
    // On the narrowest phone the field becomes a button and the heart gives way.
    await width(tester, 320);
    await tester.pumpWidget(_wrap(_bottomBar(host)));
    expect(find.text('Say something…'), findsNothing);
    expect(find.byTooltip('Write a message'), findsOneWidget);
    expect(find.byTooltip('Send hearts'), findsNothing);
  });

  testWidgets('a platform moderator in the audience gets the queue phone', (
    tester,
  ) async {
    await _narrow(tester);
    await tester.pumpWidget(_wrap(_bottomBar(moderator)));
    expect(tester.takeException(), isNull);
    expect(find.byTooltip('Guests & requests'), findsOneWidget);
    expect(find.byTooltip('Ask to join the stage'), findsNothing);
  });

  Widget sheet(
    LiveRoomController c, {
    ParticipantsTab tab = ParticipantsTab.viewers,
    Future<void> Function()? onStageAction,
  }) => ProviderScope(
    overrides: [liveRepo.overrideWithValue(_FakeRepo())],
    child: MaterialApp(
      home: Scaffold(
        body: ParticipantsSheet(
          c: c,
          onTapUser: (_) {},
          onStageAction: onStageAction ?? () async {},
          initialTab: tab,
        ),
      ),
    ),
  );

  testWidgets('the host\'s sheet opens on the numbered seat queue', (
    tester,
  ) async {
    await tester.pumpWidget(sheet(sheetHost, tab: ParticipantsTab.waiting));
    await tester.pumpAndSettle();
    for (final t in ['VIEWS 1200', 'WAITING 2', 'ADMINS 0']) {
      expect(find.text(t), findsOneWidget);
    }
    // Who is on stage counts only connected guests, and this controller isn't connected.
    expect(find.textContaining('STAGE'), findsOneWidget);
    expect(find.text('Waiting w1'), findsOneWidget);
    expect(find.text('1'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    expect(find.byTooltip('Approve'), findsNWidgets(2));
    expect(find.byTooltip('Decline'), findsNWidgets(2));
    // The host has no seat of their own to ask for.
    expect(find.text('Join'), findsNothing);
  });

  testWidgets('a viewer sees no queue, and gets the Join pill', (tester) async {
    var asked = 0;
    await tester.pumpWidget(
      sheet(
        sheetViewer,
        tab: ParticipantsTab.waiting,
        onStageAction: () async => asked++,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('WAITING'), findsNothing);
    expect(find.text('VIEWS 1200'), findsOneWidget);
    await tester.tap(find.text('Join'));
    await tester.pump();
    expect(asked, 1);
  });

  testWidgets('a hidden moderator\'s sheet polls the queue', (tester) async {
    await tester.pumpWidget(sheet(hiddenMod, tab: ParticipantsTab.waiting));
    await tester.pumpAndSettle();
    expect(find.text('WAITING 2'), findsOneWidget);
    final loads = hiddenModRepo.requestLoads;
    await tester.pump(ParticipantsSheet.pollEvery);
    expect(hiddenModRepo.requestLoads, greaterThan(loads));
    // Closing the sheet stops the polling.
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('the bar\'s media buttons act, and flip explains itself', (
    tester,
  ) async {
    await width(tester, 390);
    var composed = 0;
    await tester.pumpWidget(
      _wrap(
        LiveBottomBar(
          c: coHost,
          onCompose: () => composed++,
          onGift: () {},
          onParticipants: () {},
          onStageAction: () {},
          onHeart: () {},
        ),
      ),
    );
    // Not connected: the camera is off, so flipping explains instead of acting.
    expect(find.byTooltip('Camera on'), findsOneWidget);
    await tester.tap(find.byTooltip('Flip camera'));
    await tester.pump();
    expect(find.text('Turn your camera on to flip it'), findsOneWidget);
    await tester.tap(
      shown('Write a message')
          ? find.byTooltip('Write a message')
          : find.text('Say something…'),
    );
    expect(composed, 1);
  });

  testWidgets('a guest in an audio live gets the mic but no camera tools', (
    tester,
  ) async {
    await _narrow(tester);
    await tester.pumpWidget(_wrap(_bottomBar(audioGuest)));
    expect(tester.takeException(), isNull);
    expect(shown('Mute') || shown('Unmute'), isTrue);
    expect(find.byTooltip('Camera on'), findsNothing);
    expect(find.byTooltip('Flip camera'), findsNothing);
    // Fewer buttons: the heart stays even on the narrowest phone, and the field is back
    // on a common one.
    expect(find.byTooltip('Send hearts'), findsOneWidget);
    await width(tester, 360);
    await tester.pumpWidget(_wrap(_bottomBar(audioGuest)));
    expect(find.text('Say something…'), findsOneWidget);
    await tester.pumpWidget(_rail(audioGuest));
    expect(find.byTooltip('Beauty & filters'), findsNothing);
  });

  testWidgets('the side rail keeps the host tools but no mic, camera or flip', (
    tester,
  ) async {
    final c = railHost;
    await tester.pumpWidget(_rail(c));
    expect(find.byTooltip('Share'), findsOneWidget);
    expect(find.byTooltip('More'), findsOneWidget);
    expect(find.byTooltip('Lock live'), findsOneWidget);
    // Beauty & filters can be set with the camera off; it applies when it comes on.
    expect(find.byTooltip('Beauty & filters'), findsOneWidget);
    for (final media in ['Mute', 'Unmute', 'Camera on', 'Camera off']) {
      expect(find.byTooltip(media), findsNothing);
    }
    expect(find.byTooltip('Flip camera'), findsNothing);

    await tester.tap(find.byTooltip('Hide chat'));
    expect(c.chatVisible, isFalse);
    await tester.pumpWidget(_rail(c));
    expect(find.byTooltip('Show chat'), findsOneWidget);
  });

  testWidgets('the chevron folds the rail controls', (tester) async {
    await tester.pumpWidget(_rail(foldHost));
    await tester.tap(find.byTooltip('Hide controls'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Share'), findsNothing);
    await tester.tap(find.byTooltip('Show controls'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Share'), findsOneWidget);
  });

  testWidgets('a guest on stage keeps filters on the rail', (tester) async {
    await tester.pumpWidget(_rail(coHost));
    // Filters apply to the guest's own camera, so they work in any host's room.
    expect(find.byTooltip('Beauty & filters'), findsOneWidget);
    expect(find.byTooltip('Flip camera'), findsNothing);
    // Host-only controls stay hidden.
    expect(find.byTooltip('Lock live'), findsNothing);
  });

  testWidgets('a viewer gets no stage tools on the rail', (tester) async {
    await tester.pumpWidget(_rail(viewer));
    expect(find.byTooltip('Share'), findsOneWidget);
    expect(find.byTooltip('Mute'), findsNothing);
    expect(find.byTooltip('Flip camera'), findsNothing);
    expect(find.byTooltip('Beauty & filters'), findsNothing);
    expect(find.byTooltip('Lock live'), findsNothing);
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
    Widget bar() => _wrap(
      LiveTopBar(
        c: c,
        onClose: () => closed++,
        onViewers: () {},
        onTapUser: (_) {},
      ),
    );
    await tester.pumpWidget(bar());
    expect(tester.takeException(), isNull);
    final close = find.byTooltip('End live');
    expect(tester.getTopRight(close).dx, closeTo(320 - 8, 1));
    await tester.tap(close);
    expect(closed, 1);

    await tester.tap(find.byTooltip('Mute room audio'));
    expect(c.roomAudioOn, isFalse);
    await tester.pumpWidget(bar());
    expect(find.byTooltip('Unmute room audio'), findsOneWidget);
  });
}
