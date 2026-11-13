import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'game_sheet.dart';

/// AsadSoft games with my lock on each. `true`: the live room's list.
final gamesProvider = FutureProvider.autoDispose.family<List<GameInfo>, bool>(
  (ref, inLive) => ref.watch(economyRepo).games(inLive: inLive),
);

const _responsibleNote =
    'Games use diamonds, which have no cash value. Play responsibly — 18+ only.';

/// The Games screen (home and profile). A game opens in a [GameSheet] over it.
class GamesScreen extends ConsumerWidget {
  const GamesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final games = ref.watch(gamesProvider(false));
    return Scaffold(
      appBar: AppBar(title: const Text('Games')),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(gamesProvider(false).future),
        child: AsyncView(
          value: games,
          onRetry: () => ref.invalidate(gamesProvider(false)),
          data: (items) => items.isEmpty
              ? ListView(
                  children: const [
                    SizedBox(height: 80),
                    EmptyState(
                      icon: Icons.casino_outlined,
                      title: 'Games are resting',
                      message: 'Check back soon.',
                    ),
                  ],
                )
              : CustomScrollView(
                  slivers: [
                    SliverPadding(
                      padding: const EdgeInsets.all(16),
                      sliver: SliverGrid.extent(
                        maxCrossAxisExtent: 180,
                        mainAxisSpacing: 14,
                        crossAxisSpacing: 14,
                        childAspectRatio: 0.82,
                        children: [
                          for (final g in items)
                            GameTile(
                              game: g,
                              onTap: () => unawaited(
                                GameSheet.show(context, g, inLive: false).then(
                                  // A lock may have changed while playing (a level up).
                                  (_) => ref.invalidate(gamesProvider(false)),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SliverToBoxAdapter(
                      child: Padding(
                        padding: EdgeInsets.fromLTRB(24, 0, 24, 32),
                        child: Text(
                          _responsibleNote,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: BBColors.inkSubtle,
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

/// The live room's Games button: the live room's games in a picker. A game then opens in a
/// [GameSheet] over the live, which keeps playing above it.
class LiveGamesSheet extends ConsumerWidget {
  const LiveGamesSheet({super.key});

  static Future<void> show(BuildContext context) async {
    final picked = await showModalBottomSheet<GameInfo>(
      context: context,
      showDragHandle: true,
      builder: (_) => const LiveGamesSheet(),
    );
    if (picked != null && context.mounted) {
      await GameSheet.show(context, picked, inLive: true);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final games = ref.watch(gamesProvider(true));
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Games',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            AsyncView(
              value: games,
              onRetry: () => ref.invalidate(gamesProvider(true)),
              data: (items) => items.isEmpty
                  ? const EmptyState(
                      icon: Icons.casino_outlined,
                      title: 'Games are resting',
                      message: 'Check back soon.',
                    )
                  : GridView.extent(
                      shrinkWrap: true,
                      maxCrossAxisExtent: 96,
                      mainAxisSpacing: 10,
                      crossAxisSpacing: 10,
                      childAspectRatio: 0.78,
                      children: [
                        for (final g in items)
                          GameTile(
                            game: g,
                            dense: true,
                            onTap: () => g.lock == null
                                ? Navigator.pop(context, g)
                                : showMessage(context, g.lock!.message),
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A game's icon and name; locked games are dimmed with what unlocks them.
class GameTile extends StatelessWidget {
  const GameTile({
    super.key,
    required this.game,
    required this.onTap,
    this.dense = false,
  });
  final GameInfo game;
  final VoidCallback onTap;
  final bool dense;

  static Gradient gradientFor(String category) => switch (category) {
    'card' => const LinearGradient(
      colors: [BBColors.feltGreen, BBColors.feltGreenDeep],
      begin: Alignment.topLeft,
      end: Alignment.bottomRight,
    ),
    'table' => BBColors.umberGradient,
    'slots' => BBColors.bronzeGradient,
    _ => BBColors.goldGradient,
  };

  static IconData iconFor(String category) => switch (category) {
    'card' => Icons.style_rounded,
    'table' => Icons.casino_rounded,
    'slots' => Icons.attach_money_rounded,
    _ => Icons.sports_esports_rounded,
  };

  @override
  Widget build(BuildContext context) {
    final lock = game.lock;
    final radius = BorderRadius.circular(dense ? 16 : 22);
    final art = Container(
      decoration: BoxDecoration(
        gradient: gradientFor(game.category),
        borderRadius: radius,
      ),
      clipBehavior: Clip.antiAlias,
      child: game.iconUrl == null
          ? Center(
              child: Icon(
                iconFor(game.category),
                color: BBColors.ivory,
                size: dense ? 32 : 56,
              ),
            )
          : CachedNetworkImage(
              imageUrl: game.iconUrl!,
              fit: BoxFit.cover,
              errorWidget: (_, _, _) => Center(
                child: Icon(
                  iconFor(game.category),
                  color: BBColors.ivory,
                  size: dense ? 32 : 56,
                ),
              ),
            ),
    );
    return Semantics(
      button: true,
      label: lock == null ? game.name : '${game.name}. ${lock.message}',
      excludeSemantics: true,
      child: InkWell(
        borderRadius: radius,
        onTap: onTap,
        child: Column(
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Opacity(opacity: lock == null ? 1 : 0.45, child: art),
                  if (lock != null)
                    Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: BBColors.espressoShade,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.lock_rounded,
                              color: BBColors.goldLight,
                              size: dense ? 12 : 14,
                            ),
                            if (lock.reason == 'level') ...[
                              const SizedBox(width: 4),
                              Text(
                                'Lv ${lock.minLevel ?? 0}',
                                style: TextStyle(
                                  color: BBColors.goldLight,
                                  fontSize: dense ? 10 : 12,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
            SizedBox(height: dense ? 6 : 8),
            Text(
              game.name,
              maxLines: dense ? 2 : 1,
              textAlign: TextAlign.center,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: dense ? 12 : 14,
                fontWeight: dense ? FontWeight.w500 : FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
