import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/features/live/mini_live_player.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeController extends ChangeNotifier implements LiveRoomController {
  @override
  String get roomId => 'r1';
  @override
  LiveStatus status = LiveStatus.live;
  @override
  RoomDetail? get detail => null;
  @override
  bool get isHost => false;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  testWidgets('mini player snaps to the nearest side and forwards taps', (
    tester,
  ) async {
    var expanded = 0;
    var closed = 0;
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          home: Stack(
            children: [
              MiniLivePlayer(
                c: _FakeController(),
                onExpand: () => expanded++,
                onClose: () => closed++,
              ),
            ],
          ),
        ),
      ),
    );
    final player = find.byType(MiniLivePlayer);
    final screen = tester.view.physicalSize / tester.view.devicePixelRatio;
    // Starts bottom-right, clear of the bottom navigation.
    expect(tester.getTopRight(player).dx, screen.width - 12);
    expect(
      tester.getBottomLeft(player).dy,
      lessThanOrEqualTo(screen.height - kBottomNavigationBarHeight),
    );

    await tester.drag(player, const Offset(-500, -100));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(player).dx, 12);

    await tester.tap(player);
    expect(expanded, 1);

    await tester.tap(find.byIcon(Icons.close_rounded));
    expect(closed, 1);
    expect(expanded, 1);
  });
}
