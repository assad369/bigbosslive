import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/core/utils/json.dart';
import 'package:bigboss_live/features/live/active_live.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Stands in for a LiveKit-backed controller: only what [ActiveLiveNotifier] touches.
class _FakeController extends ChangeNotifier implements LiveRoomController {
  _FakeController(this.roomId, {this.hosting = false});

  @override
  final String roomId;
  final bool hosting;
  bool started = false;
  bool disposed = false;

  @override
  LiveStatus status = LiveStatus.live;
  @override
  PkBattle? pk;

  @override
  bool get isHost => hosting;

  @override
  Future<void> start() async => started = true;

  @override
  Future<Json?> end() async {
    status = LiveStatus.ended;
    notifyListeners();
    return {'durationSec': 60};
  }

  void emit(LiveStatus s) {
    status = s;
    notifyListeners();
  }

  @override
  void dispose() {
    disposed = true;
    super.dispose();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeSession extends SessionController {
  @override
  Future<MeUser?> build() async => MeUser.fromJson({
    'id': 'me',
    'shortId': '1',
    'displayName': 'Me',
    'wallet': {'diamonds': 0, 'beans': 0, 'agentStock': 0},
    'levelProgress': {
      'level': 1,
      'points': 0,
      'currentLevelPoints': 0,
      'nextLevelPoints': 10,
      'isMaxLevel': false,
    },
  });

  void signOutNow() => state = const AsyncData(null);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ProviderContainer container;
  late List<_FakeController> made;
  late Set<String> hostRooms;

  ActiveLiveNotifier notifier() => container.read(activeLiveProvider.notifier);

  setUp(() async {
    // Listener errors are reported, not thrown; make them fail the test.
    final previous = FlutterError.onError;
    FlutterError.onError = (d) => fail(d.toString());
    addTearDown(() => FlutterError.onError = previous);
    made = [];
    hostRooms = {};
    container = ProviderContainer(
      overrides: [
        sessionProvider.overrideWith(_FakeSession.new),
        liveControllerFactoryProvider.overrideWithValue(({
          required roomId,
          hostSession,
        }) {
          final c = _FakeController(
            roomId,
            hosting: hostRooms.contains(roomId),
          );
          made.add(c);
          return c;
        }),
      ],
    );
    await container.read(sessionProvider.future);
    container.listen(activeLiveProvider, (_, _) {});
  });

  tearDown(() => container.dispose());

  test('re-opening the same room reuses and restores the session', () async {
    final a = notifier().attach('r1')!;
    expect((a as _FakeController).started, isTrue);
    notifier().minimizeOrClose(a);
    await pumpEventQueue();
    expect(container.read(activeLiveProvider)?.minimized, isTrue);

    expect(notifier().attach('r1'), same(a));
    await pumpEventQueue();
    expect(made, hasLength(1));
    expect(container.read(activeLiveProvider)?.minimized, isFalse);
  });

  test('opening another room replaces a viewer session', () {
    final a = notifier().attach('r1')! as _FakeController;
    final b = notifier().attach('r2');
    expect(a.disposed, isTrue);
    expect(notifier().current?.controller, same(b));
  });

  test('a host cannot open another room while live', () {
    hostRooms.add('mine');
    final mine = notifier().attach('mine')! as _FakeController;
    expect(notifier().attach('other'), isNull);
    expect(mine.disposed, isFalse);
    expect(notifier().current?.roomId, 'mine');
  });

  test('back on an ended live closes it instead of minimizing', () {
    final a = notifier().attach('r1')! as _FakeController;
    a.status = LiveStatus.ended;
    notifier().minimizeOrClose(a);
    expect(notifier().current, isNull);
    expect(a.disposed, isTrue);
  });

  test('a kicked viewer drops out of the mini-player', () async {
    final a = notifier().attach('r1')! as _FakeController;
    notifier().minimizeOrClose(a);
    a.emit(LiveStatus.kicked);
    await pumpEventQueue();
    expect(container.read(activeLiveProvider), isNull);
    expect(a.disposed, isTrue);
  });

  test('a screen going away ends the session unless it was minimized', () {
    final a = notifier().attach('r1')! as _FakeController;
    notifier().minimizeOrClose(a);
    notifier().detach(a);
    expect(a.disposed, isFalse);

    notifier().attach('r1');
    notifier().detach(a);
    expect(a.disposed, isTrue);
  });

  test('ending a hosted live closes the session', () async {
    hostRooms.add('mine');
    final mine = notifier().attach('mine')! as _FakeController;
    final summary = await notifier().endHosting();
    expect(summary, {'durationSec': 60});
    expect(mine.disposed, isTrue);
    expect(notifier().current, isNull);
  });

  test('signing out closes the session', () async {
    final a = notifier().attach('r1')! as _FakeController;
    (container.read(sessionProvider.notifier) as _FakeSession).signOutNow();
    await pumpEventQueue();
    expect(a.disposed, isTrue);
    expect(container.read(activeLiveProvider), isNull);
  });
}
