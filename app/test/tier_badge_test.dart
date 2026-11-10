import 'package:bigboss_live/core/widgets/tier_badge.dart';
import 'package:bigboss_live/core/widgets/widgets.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svga/flutter_svga.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(Widget child) => MaterialApp(
  home: Scaffold(body: Center(child: child)),
);

const _image = TierBadge(imageUrl: 'https://cdn.test/badge.png');

UserBrief _user(TierBadge? badge) => UserBrief(
  id: 'u',
  shortId: '200',
  displayName: 'Rosa',
  vipTier: badge == null ? 0 : 3,
  badge: badge,
);

void main() {
  tearDown(VideoBadgeBudget.instance.reset);

  test('TierBadge parses renditions and treats an empty one as none', () {
    expect(TierBadge.fromJsonOrNull(null), isNull);
    expect(
      TierBadge.fromJsonOrNull({'imageUrl': null, 'blendMode': 'normal'}),
      isNull,
    );
    final b = TierBadge.fromJsonOrNull({
      'svgaUrl': 'https://cdn.test/a.svga',
      'blendMode': 'additive',
    })!;
    expect(b.svgaUrl, 'https://cdn.test/a.svga');
    expect(b.additive, isTrue);
  });

  test('badge size is a little over a third of the avatar, within bounds', () {
    expect(AvatarBadgeSlot.sizeFor(100), 36);
    expect(AvatarBadgeSlot.sizeFor(20), 12);
    expect(AvatarBadgeSlot.sizeFor(300), 44);
  });

  testWidgets('the badge sits at the bottom-right of the photo circle', (
    tester,
  ) async {
    await tester.pumpWidget(_wrap(BBAvatar.user(_user(_image), size: 92)));
    final view = find.byType(TierBadgeView);
    expect(view, findsOneWidget);
    final avatar = tester.getRect(find.byType(BBAvatar));
    final badge = tester.getRect(view);
    // Inside the slot's 1.5px ring, flush with the avatar's bottom-right corner.
    expect(badge.right, closeTo(avatar.right - 1.5, 0.5));
    expect(badge.bottom, closeTo(avatar.bottom - 1.5, 0.5));
    expect(badge.width, closeTo(AvatarBadgeSlot.sizeFor(92) - 3, 0.5));
  });

  testWidgets('no badge on tiny avatars, when turned off, or without a tier', (
    tester,
  ) async {
    await tester.pumpWidget(_wrap(BBAvatar.user(_user(_image), size: 20)));
    expect(find.byType(TierBadgeView), findsNothing);

    await tester.pumpWidget(
      _wrap(BBAvatar.user(_user(_image), size: 60, showBadge: false)),
    );
    expect(find.byType(TierBadgeView), findsNothing);

    await tester.pumpWidget(_wrap(BBAvatar.user(_user(null), size: 60)));
    expect(find.byType(TierBadgeView), findsNothing);
  });

  testWidgets('an image-only badge draws the image', (tester) async {
    await tester.pumpWidget(
      _wrap(const TierBadgeView(badge: _image, size: 40)),
    );
    expect(find.byType(CachedNetworkImage), findsOneWidget);
    expect(find.byType(SVGAImage), findsNothing);
  });

  testWidgets('without animation an image wins over SVGA', (tester) async {
    const both = TierBadge(
      imageUrl: 'https://cdn.test/b.png',
      svgaUrl: 'https://cdn.test/b.svga',
    );
    await tester.pumpWidget(
      _wrap(const TierBadgeView(badge: both, size: 40, animate: false)),
    );
    expect(find.byType(CachedNetworkImage), findsOneWidget);
  });

  testWidgets('an MP4 refused a decoder lease falls back to the image', (
    tester,
  ) async {
    final budget = VideoBadgeBudget.instance..inLiveRoom = true;
    while (budget.tryAcquire()) {}
    const mp4 = TierBadge(
      imageUrl: 'https://cdn.test/b.png',
      mp4Url: 'https://cdn.test/b.mp4',
    );
    await tester.pumpWidget(_wrap(const TierBadgeView(badge: mp4, size: 40)));
    expect(find.byType(CachedNetworkImage), findsOneWidget);
    expect(budget.active, budget.maxConcurrent);
  });

  test('the decoder budget shrinks in a live room and frees on release', () {
    final budget = VideoBadgeBudget.instance;
    expect(budget.maxConcurrent, 6);
    budget.inLiveRoom = true;
    expect(budget.maxConcurrent, 3);
    for (var i = 0; i < 3; i++) {
      expect(budget.tryAcquire(), isTrue);
    }
    expect(budget.tryAcquire(), isFalse);
    budget.release();
    expect(budget.tryAcquire(), isTrue);
  });
}
