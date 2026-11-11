import 'package:bigboss_live/core/providers.dart';
import 'package:bigboss_live/core/theme/bb_theme.dart';
import 'package:bigboss_live/core/utils/json.dart';
import 'package:bigboss_live/data/repositories.dart';
import 'package:bigboss_live/features/live/live_room_controller.dart';
import 'package:bigboss_live/features/moderation/ban_sheet.dart';
import 'package:bigboss_live/features/moderation/moderation_screen.dart';
import 'package:bigboss_live/models/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Json _meJson({Json? moderation, String? adminRole}) => {
  'id': 'me',
  'shortId': '200',
  'displayName': 'Me',
  'level': 3,
  'followers': 0,
  'following': 0,
  'wallet': {'diamonds': 10, 'agentStock': 0},
  'levelProgress': {'level': 3, 'points': 30},
  'isAgent': false,
  'adminRole': adminRole,
  'maintenanceAccess': true,
  'moderation': moderation,
};

Json _row(String id, {String status = 'active', bool mod = false}) => {
  'user': {'id': id, 'shortId': '9$id', 'displayName': 'User $id'},
  'status': status,
  'ban': status == 'banned'
      ? {'reason': 'Spam', 'until': null, 'at': '2026-11-01T00:00:00Z'}
      : null,
  'isPlatformModerator': mod,
  'isAgent': false,
  'isStaff': false,
  'createdAt': '2026-11-01T00:00:00Z',
};

/// Records searches; answers with one row per query.
class _FakeModeration implements ModerationRepository {
  final queries = <String>[];

  @override
  Future<Paged<ModeratedUser>> search({
    String query = '',
    String status = 'all',
    String? cursor,
  }) async {
    queries.add(query);
    return Paged(items: [ModeratedUser.fromJson(_row('u-$query'))]);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

class _NoopLive implements LiveRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('${invocation.memberName}');
}

void main() {
  group('models', () {
    test('/me.moderation parses and survives every copy', () {
      final me = MeUser.fromJson(
        _meJson(
          moderation: {
            'isPlatformModerator': true,
            'canModerateLive': true,
            'stealthEnabled': true,
            'selfStageEnabled': false,
          },
        ),
      );
      expect(me.isPlatformModerator, isTrue);
      expect(me.canModerateLive, isTrue);
      expect(me.moderation!.stealthEnabled, isTrue);
      expect(me.withDiamonds(5).isPlatformModerator, isTrue);
      expect(me.withoutMaintenanceAccess().canModerateLive, isTrue);

      final plain = MeUser.fromJson(_meJson());
      expect(plain.moderation, isNull);
      expect(plain.isPlatformModerator, isFalse);
      expect(plain.canModerateLive, isFalse);
    });

    test('moderated rows, device previews and live sessions parse', () {
      final banned = ModeratedUser.fromJson(_row('x', status: 'banned'));
      expect(banned.isBanned, isTrue);
      expect(banned.banReason, 'Spam');
      expect(banned.bannedUntil, isNull);
      expect(ModeratedUser.fromJson(_row('m', mod: true)).isProtected, isTrue);

      final preview = DeviceBanPreview.fromJson({
        'devices': 2,
        'accounts': 3,
        'alreadyBanned': 1,
        'skipped': [
          {'uid': 'mod', 'reason': 'Platform moderator', 'user': null},
        ],
      });
      expect(preview.skipped.single.reason, 'Platform moderator');

      final session = LiveSession.fromJson({
        'room': <String, dynamic>{},
        'credentials': <String, dynamic>{},
        'stealth': true,
      });
      expect(session.stealth, isTrue);
      expect(session.entry, isNull);
    });

    test('a hidden moderator’s chat line carries the MOD flag', () {
      final line = ChatLine.fromServer({
        'id': 'm1',
        'text': 'Keep it friendly',
        'user': {'uid': 'mod', 'displayName': 'Mod', 'role': 'audience'},
        'mod': true,
      });
      expect(line.mod, isTrue);
      expect(
        ChatLine.fromServer({'id': 'm2', 'text': 'hi', 'user': {}}).mod,
        isFalse,
      );
    });

    test('store items carry the caller’s own state', () {
      final item = StoreItem.fromJson({
        'id': 'i1',
        'type': 'room_background',
        'name': 'Night',
        'assetUrl': 'https://cdn.test/a.png',
        'priceDiamonds': 10,
        'durationDays': 7,
        'vipTierRequired': 0,
        'owned': true,
        'ownedUntil': '2026-12-01T00:00:00Z',
        'equipped': true,
      });
      expect(item.owned && item.equipped, isTrue);
      expect(item.ownedUntil, isNotNull);
      expect(item.wearable, isTrue);
      expect(
        StoreItem.fromJson({'type': 'chat_bubble', 'id': 'b'}).wearable,
        isFalse,
      );
    });
  });

  test('ban reasons follow the server’s bounds', () {
    expect(validBanReason('no'), isFalse);
    expect(validBanReason('   ab  '), isFalse);
    expect(validBanReason('Spam'), isTrue);
    expect(validBanReason('x' * 200), isTrue);
    expect(validBanReason('x' * 201), isFalse);
  });

  testWidgets('the ban button waits for a valid reason', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          theme: BBTheme.light(),
          home: const Scaffold(
            body: BanSheet(
              user: UserBrief(id: 'u', shortId: '1', displayName: 'Rowdy'),
            ),
          ),
        ),
      ),
    );
    FilledButton submit() =>
        tester.widget<FilledButton>(find.byKey(const Key('ban-submit')));
    expect(submit().onPressed, isNull);
    await tester.enterText(find.byKey(const Key('ban-reason')), 'ok');
    await tester.pump();
    expect(submit().onPressed, isNull);
    await tester.enterText(find.byKey(const Key('ban-reason')), 'Spamming');
    await tester.pump();
    expect(submit().onPressed, isNotNull);
    expect(find.text('Permanent'), findsOneWidget);
  });

  testWidgets('search waits for typing to stop and asks once', (tester) async {
    final repo = _FakeModeration();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          moderationRepo.overrideWithValue(repo),
          meProvider.overrideWithValue(
            MeUser.fromJson(
              _meJson(
                moderation: {
                  'isPlatformModerator': true,
                  'canModerateLive': true,
                },
              ),
            ),
          ),
        ],
        child: MaterialApp(
          theme: BBTheme.light(),
          home: const ModerationScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(repo.queries, ['']);
    final field = find.byKey(const Key('moderation-search'));
    await tester.enterText(field, 'a');
    await tester.pump(const Duration(milliseconds: 100));
    await tester.enterText(field, 'as');
    await tester.pump(const Duration(milliseconds: 100));
    await tester.enterText(field, 'asad');
    await tester.pump(const Duration(milliseconds: 100));
    expect(repo.queries, ['']);
    await tester.pump(ModerationScreen.debounce);
    await tester.pumpAndSettle();
    expect(repo.queries, ['', 'asad']);
    expect(find.text('User u-asad'), findsOneWidget);
  });

  group('live room', () {
    LiveRoomController controller({bool selfStage = false}) =>
        LiveRoomController(
          roomId: 'r1',
          myUid: 'me',
          repo: _NoopLive(),
          isLiveModerator: true,
          selfStageEnabled: selfStage,
          me: const UserBrief(id: 'me', shortId: '200', displayName: 'Me'),
        );

    test('my own entrance reaches widgets that subscribe after it', () async {
      final c = controller();
      c.debugAnnounceMyJoin({
        'user': {'uid': 'me', 'displayName': 'Me', 'vipTier': 2},
        'effect': {'url': 'https://cdn.test/e.svga', 'format': 'svga'},
      });
      // The overlay mounts after the join: it still gets the entrance.
      final late = await c.entries.first.timeout(const Duration(seconds: 1));
      expect(late.effectUrl, 'https://cdn.test/e.svga');
      expect(c.chat.where((l) => l.kind == ChatKind.join), hasLength(1));
      c.dispose();
    });

    test('a hidden moderator arrives unannounced', () {
      final c = controller()..stealth = true;
      c.debugAnnounceMyJoin({
        'user': {'uid': 'me', 'displayName': 'Me', 'vipTier': 2},
      });
      expect(c.chat.where((l) => l.kind == ChatKind.join), isEmpty);
      c.dispose();
    });

    test('moderator powers come from the server flag', () {
      final c = controller(selfStage: true);
      expect(c.canModerateLive, isTrue);
      expect(c.canControlYouTube, isTrue);
      expect(c.canSelfStage, isTrue);
      c.dispose();
      final viewer = LiveRoomController(
        roomId: 'r1',
        myUid: 'v',
        repo: _NoopLive(),
        isStaff: true,
      );
      // A support or finance role alone moderates nothing.
      expect(viewer.canModerateLive, isFalse);
      expect(viewer.canControlYouTube, isFalse);
      expect(viewer.canSelfStage, isFalse);
      viewer.dispose();
    });
  });
}
