import 'package:bigboss_live/core/widgets/carousel.dart';
import 'package:bigboss_live/core/widgets/frame_view.dart';
import 'package:bigboss_live/core/widgets/widgets.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svga/flutter_svga.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child) => MaterialApp(
  home: Scaffold(body: Center(child: child)),
);

void main() {
  group('MediaFormat.resolve', () {
    test('trusts the declared format', () {
      expect(MediaFormat.resolve('svga', 'https://x/f.png'), MediaFormat.svga);
      expect(MediaFormat.resolve('mp4', 'https://x/e'), MediaFormat.mp4);
    });

    test('falls back to the extension, ignoring query strings', () {
      expect(
        MediaFormat.resolve('none', 'https://x/frame.svga?v=3'),
        MediaFormat.svga,
      );
      expect(MediaFormat.resolve(null, 'https://x/a.json'), MediaFormat.lottie);
      expect(MediaFormat.resolve('none', 'https://x/a.webp'), MediaFormat.none);
      expect(MediaFormat.resolve('bogus', 'https://x/a.png'), MediaFormat.none);
    });
  });

  testWidgets('VipBadge names the VIP ladder', (tester) async {
    await tester.pumpWidget(
      _wrap(
        const Column(
          mainAxisSize: MainAxisSize.min,
          children: [VipBadge(1), VipBadge(2), VipBadge(3), VipBadge(0)],
        ),
      ),
    );
    expect(find.text('VIP'), findsOneWidget);
    expect(find.text('VVIP'), findsOneWidget);
    expect(find.text('King'), findsOneWidget);
    expect(VipBadge.labelFor(0), isNull);
  });

  testWidgets('BBAvatar draws the frame in any format, SVGA only when large', (
    tester,
  ) async {
    const user = UserBrief(
      id: 'u',
      shortId: '200',
      displayName: 'Queen',
      vipTier: 3,
      frameUrl: 'https://cdn.test/king.svga',
      frameFormat: 'svga',
    );
    await tester.pumpWidget(_wrap(BBAvatar.user(user, size: 20)));
    expect(find.byType(FrameView), findsOneWidget);
    // 20px plus overhang is below the SVGA minimum: no player is built.
    expect(find.byType(SVGAImage), findsNothing);

    await tester.pumpWidget(_wrap(BBAvatar.user(user, size: 72)));
    expect(find.byType(SVGAImage), findsOneWidget);

    await tester.pumpWidget(
      _wrap(
        BBAvatar.user(
          const UserBrief(id: 'p', shortId: '201', displayName: 'Plain'),
        ),
      ),
    );
    expect(find.byType(FrameView), findsNothing);
  });

  testWidgets('BBCarousel advances on its own and loops', (tester) async {
    await tester.pumpWidget(
      _wrap(
        BBCarousel(
          height: 80,
          itemCount: 3,
          interval: const Duration(seconds: 2),
          itemBuilder: (_, i) => Text('item $i'),
        ),
      ),
    );
    final controller = tester
        .widget<PageView>(find.byType(PageView))
        .controller!;
    final start = controller.page!;
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(controller.page, start + 1);
  });

  group('agency and entrance models', () {
    test('AgencyMember target progress is capped and optional', () {
      final m = AgencyMember.fromJson({
        'user': {'id': 'h', 'shortId': '202', 'displayName': 'Host'},
        'role': 'admin',
        'dailyTargetMinutes': 60,
        'todayLiveSeconds': 5400,
      });
      expect(m.isAdmin, isTrue);
      expect(m.targetProgress, 1);
      expect(AgencyMember.fromJson(const {}).targetProgress, isNull);
    });

    test('AgencyDashboard and TopAgency parse the wire shape', () {
      final d = AgencyDashboard.fromJson({
        'agency': {
          'id': 'a1',
          'code': 'HA-ABCDEFGH',
          'name': 'Crown',
          'ownerId': 'boss',
          'commissionRate': 0.05,
          'status': 'active',
          'memberCount': 4,
        },
        'role': 'admin',
        'rank': 2,
        'periodKey': '2026-10',
        'totals': {'periodBeans': 1200},
        'pendingRequests': 3,
      });
      expect(d.isOwner, isFalse);
      expect(d.agency.code, 'HA-ABCDEFGH');
      expect(d.total('periodBeans'), 1200);
      expect(d.pendingRequests, 3);

      final t = TopAgency.fromJson({
        'id': 'a1',
        'code': 'HA-X',
        'name': 'Crown',
        'rank': 1,
        'periodBeans': 99,
      });
      expect((t.rank, t.periodBeans, t.agency.name), (1, 99, 'Crown'));
    });

    test('EntryEvent reads the effect, or the legacy cosmetic', () {
      final user = {'uid': 'k', 'shortId': '203', 'displayName': 'K'};
      final now = EntryEvent.fromJson({
        'user': user,
        'effect': {'url': 'https://cdn.test/e.mp4', 'format': 'mp4'},
      });
      expect(
        (now.user.id, now.effectUrl, now.effectFormat),
        ('k', 'https://cdn.test/e.mp4', 'mp4'),
      );
      final legacy = EntryEvent.fromJson(<String, dynamic>{
        'user': user,
        'animation': {
          'assetUrl': 'https://cdn.test/a.svga',
          'animationFormat': 'svga',
        },
      });
      expect(legacy.effectFormat, 'svga');
      final none = EntryEvent.fromJson(<String, dynamic>{'user': user});
      expect(none.effectUrl, isNull);
    });
  });
}
