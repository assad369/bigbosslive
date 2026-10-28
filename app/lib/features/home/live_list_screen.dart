import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/router/app_router.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/carousel.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import '../agency/agency_providers.dart';
import '../live/live_dialogs.dart';
import '../live/live_room_screen.dart';
import 'top_agency_slider.dart';

final _liveTabProvider = FutureProvider.family<List<LiveRoom>, String>((
  ref,
  tab,
) async {
  final socket = ref.watch(socketProvider);
  socket.subscribeRooms();
  // Re-fetch when rooms open or close anywhere (debounced by Riverpod's single in-flight load).
  final sub = socket.events
      .where((e) => e.name == 'rooms:upserted' || e.name == 'rooms:ended')
      .listen((_) => ref.invalidateSelf());
  ref.onDispose(sub.cancel);
  final type = tab == 'audio' ? 'audio' : null;
  final realTab = tab == 'audio' ? 'popular' : tab;
  return (await ref.watch(liveRepo).list(tab: realTab, type: type)).items;
});

final _bannersProvider = FutureProvider(
  (ref) => ref.watch(contentRepo).banners('home'),
);

class LiveListScreen extends ConsumerWidget {
  const LiveListScreen({super.key});

  static const tabs = [
    ('popular', 'Popular'),
    ('new', 'New'),
    ('following', 'Following'),
    ('nearby', 'Nearby'),
    ('audio', 'Party'),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) => DefaultTabController(
    length: tabs.length,
    child: Scaffold(
      appBar: AppBar(
        title: GradientText(
          'BigBoss Live',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        actions: [
          IconButton(
            tooltip: 'Search',
            onPressed: () => context.push('/search'),
            icon: const Icon(Icons.search_rounded),
          ),
          IconButton(
            tooltip: 'Rankings',
            onPressed: () => context.push('/leaderboard'),
            icon: const Icon(Icons.emoji_events_outlined),
          ),
          IconButton(
            tooltip: 'Games',
            onPressed: () => context.push('/games'),
            icon: const Icon(Icons.casino_outlined),
          ),
        ],
        bottom: TabBar(
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          tabs: [for (final t in tabs) Tab(text: t.$2)],
        ),
      ),
      body: TabBarView(children: [for (final t in tabs) _LiveGrid(tab: t.$1)]),
    ),
  );
}

class _LiveGrid extends ConsumerWidget {
  const _LiveGrid({required this.tab});
  final String tab;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rooms = ref.watch(_liveTabProvider(tab));
    return RefreshIndicator(
      onRefresh: () {
        if (tab == 'popular') {
          ref
            ..invalidate(_bannersProvider)
            ..invalidate(topAgenciesProvider);
        }
        return ref.refresh(_liveTabProvider(tab).future);
      },
      child: CustomScrollView(
        slivers: [
          if (tab == 'popular') ...[
            const SliverToBoxAdapter(child: _BannerCarousel()),
            const SliverToBoxAdapter(child: TopAgencySlider()),
          ],
          ...rooms.when(
            loading: () => [
              const SliverFillRemaining(
                child: Center(child: CircularProgressIndicator()),
              ),
            ],
            error: (e, _) => [
              SliverFillRemaining(
                child: ErrorView(
                  error: e,
                  onRetry: () => ref.invalidate(_liveTabProvider(tab)),
                ),
              ),
            ],
            data: (items) => items.isEmpty
                ? [
                    SliverFillRemaining(
                      hasScrollBody: false,
                      child: EmptyState(
                        icon: Icons.videocam_off_outlined,
                        title: tab == 'following'
                            ? 'Nobody you follow is live'
                            : 'No lives right now',
                        message:
                            'Be the first to go live and light up the room.',
                        action: GoldButton(
                          label: 'Go live',
                          icon: Icons.videocam_rounded,
                          onPressed: () => context.push('/go-live'),
                        ),
                      ),
                    ),
                  ]
                : [
                    SliverPadding(
                      padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
                      sliver: SliverGrid.builder(
                        itemCount: items.length,
                        gridDelegate:
                            const SliverGridDelegateWithFixedCrossAxisCount(
                              crossAxisCount: 2,
                              mainAxisSpacing: 10,
                              crossAxisSpacing: 10,
                              childAspectRatio: 0.78,
                            ),
                        itemBuilder: (_, i) => LiveCard(room: items[i]),
                      ),
                    ),
                  ],
          ),
        ],
      ),
    );
  }
}

class _BannerCarousel extends ConsumerWidget {
  const _BannerCarousel();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final banners = ref.watch(_bannersProvider).value ?? const <BannerItem>[];
    if (banners.isEmpty) return const SizedBox.shrink();
    return BBCarousel(
      height: 120,
      itemCount: banners.length,
      itemBuilder: (context, i) {
        final b = banners[i];
        return InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: b.linkUrl == null
              ? null
              : () {
                  final route = routeForLink({'url': b.linkUrl});
                  if (route != null) unawaited(context.push(route));
                },
          child: ClipRRect(
            borderRadius: BorderRadius.circular(18),
            child: CachedNetworkImage(imageUrl: b.imageUrl, fit: BoxFit.cover),
          ),
        );
      },
    );
  }
}

class LiveCard extends ConsumerWidget {
  const LiveCard({super.key, required this.room});
  final LiveRoom room;

  /// Locked rooms ask for the password when there is one. Without one, staff go straight in
  /// and everyone else is told it's locked — room admins can still try, and the server decides.
  Future<void> _open(BuildContext context, WidgetRef ref) async {
    if (!room.locked) {
      await context.push('/live/${room.id}');
      return;
    }
    if (room.hasPassword) {
      final pw = await showRoomPasswordDialog(context);
      if (pw != null && context.mounted) {
        await context.push('/live/${room.id}', extra: RoomPassword(pw));
      }
      return;
    }
    if (ref.read(sessionProvider).value?.adminRole != null) {
      await context.push('/live/${room.id}');
      return;
    }
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: const Text('This live is locked'),
          action: SnackBarAction(
            label: 'Try anyway',
            onPressed: () => context.push('/live/${room.id}'),
          ),
        ),
      );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => InkWell(
    borderRadius: BorderRadius.circular(18),
    onTap: () => _open(context, ref),
    child: ClipRRect(
      borderRadius: BorderRadius.circular(18),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (room.coverUrl != null)
            CachedNetworkImage(
              imageUrl: room.coverUrl!,
              fit: BoxFit.cover,
              errorWidget: (_, _, _) =>
                  const ColoredBox(color: BBColors.champagneDeep),
            )
          else
            const DecoratedBox(
              decoration: BoxDecoration(gradient: BBColors.champagneGradient),
            ),
          const DecoratedBox(
            decoration: BoxDecoration(gradient: BBColors.videoScrim),
          ),
          Positioned(
            top: 8,
            left: 8,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: BBColors.scrim,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    room.isAudio ? Icons.mic_rounded : Icons.circle,
                    size: room.isAudio ? 12 : 8,
                    color: room.isAudio ? BBColors.goldLight : BBColors.danger,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    Fmt.compact(room.viewerCount),
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (room.locked)
            Center(
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: BBColors.scrim,
                  shape: BoxShape.circle,
                  border: Border.all(color: BBColors.goldOutline, width: 1.5),
                ),
                child: Icon(
                  room.hasPassword
                      ? Icons.lock_rounded
                      : Icons.lock_outline_rounded,
                  color: BBColors.goldLight,
                  size: 30,
                ),
              ),
            ),
          if (room.pkBattleId != null)
            Positioned(
              top: 8,
              right: 8,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  gradient: BBColors.goldGradient,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Text(
                  'PK',
                  style: TextStyle(
                    color: BBColors.ink,
                    fontSize: 11,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ),
          Positioned(
            left: 10,
            right: 10,
            bottom: 10,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  room.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    BBAvatar.user(room.host, size: 20),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        room.host.displayName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: BBColors.champagne,
                          fontSize: 12,
                        ),
                      ),
                    ),
                    if (room.host.vipTier > 0) ...[
                      VipTag(room.host.vipTier),
                      const SizedBox(width: 3),
                    ],
                    LevelBadge(room.host.level, dense: true),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
