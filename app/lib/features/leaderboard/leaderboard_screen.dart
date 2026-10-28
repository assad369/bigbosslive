import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

final _boardProvider = FutureProvider.autoDispose
    .family<List<LeaderboardEntry>, (String, String)>(
      (ref, args) => ref.watch(contentRepo).leaderboard(args.$1, args.$2),
    );

class LeaderboardScreen extends StatefulWidget {
  const LeaderboardScreen({super.key});
  @override
  State<LeaderboardScreen> createState() => _LeaderboardScreenState();
}

class _LeaderboardScreenState extends State<LeaderboardScreen> {
  String _period = 'day';

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    child: Scaffold(
      appBar: AppBar(
        title: const Text('Rankings'),
        bottom: const TabBar(
          tabs: [
            Tab(text: 'Rich 💎'),
            Tab(text: 'Charm 🌹'),
          ],
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'day', label: Text('Today')),
                ButtonSegment(value: 'week', label: Text('Week')),
                ButtonSegment(value: 'month', label: Text('Month')),
              ],
              selected: {_period},
              onSelectionChanged: (s) => setState(() => _period = s.first),
            ),
          ),
          Expanded(
            child: TabBarView(
              children: [
                _Board(kind: 'rich', period: _period),
                _Board(kind: 'charm', period: _period),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _Board extends ConsumerWidget {
  const _Board({required this.kind, required this.period});
  final String kind;
  final String period;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.watch(_boardProvider((kind, period)));
    return AsyncView(
      value: board,
      onRetry: () => ref.invalidate(_boardProvider((kind, period))),
      data: (rows) {
        final entries = rows.where((r) => r.user != null).toList();
        if (entries.isEmpty) {
          return const EmptyState(
            icon: Icons.emoji_events_outlined,
            title: 'No rankings yet',
            message: 'Send or receive gifts to get on the board.',
          );
        }
        final top = entries.take(3).toList();
        return ListView(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  for (final i in [1, 0, 2])
                    if (i < top.length)
                      Expanded(
                        child: _Podium(
                          entry: top[i],
                          height: [130.0, 100.0, 84.0][i],
                        ),
                      ),
                ],
              ),
            ),
            for (final e in entries.skip(3))
              UserTile(
                user: e.user!,
                onTap: () => context.push('/user/${e.user!.id}'),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    DiamondAmount(e.diamonds, compact: true),
                    const SizedBox(width: 12),
                    Text(
                      '#${e.rank}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        color: BBColors.inkSubtle,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}

class _Podium extends StatelessWidget {
  const _Podium({required this.entry, required this.height});
  final LeaderboardEntry entry;
  final double height;

  @override
  Widget build(BuildContext context) {
    final u = entry.user!;
    final gradient = entry.rank == 1
        ? BBColors.goldGradient
        : entry.rank == 2
        ? const LinearGradient(colors: [Color(0xFFE3E3E3), Color(0xFFA9A9A9)])
        : BBColors.bronzeGradient;
    return GestureDetector(
      onTap: () => context.push('/user/${u.id}'),
      child: Column(
        children: [
          if (entry.rank == 1) const Text('👑', style: TextStyle(fontSize: 26)),
          BBAvatar.user(u, size: entry.rank == 1 ? 72 : 58, ring: true),
          const SizedBox(height: 6),
          Text(
            u.displayName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          if (u.vipTier > 0) VipBadge(u.vipTier, dense: true),
          DiamondAmount(
            entry.diamonds,
            compact: true,
            style: const TextStyle(fontSize: 12),
          ),
          const SizedBox(height: 6),
          Container(
            height: height,
            margin: const EdgeInsets.symmetric(horizontal: 6),
            decoration: BoxDecoration(
              gradient: gradient,
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(14),
              ),
            ),
            alignment: Alignment.center,
            child: Text(
              '${entry.rank}',
              style: Theme.of(context).textTheme.headlineMedium
                  ?.copyWith(color: BBColors.ivory),
            ),
          ),
        ],
      ),
    );
  }
}
