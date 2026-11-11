import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

final liveSummaryProvider = FutureProvider.autoDispose
    .family<LiveSummary, String>(
      (ref, roomId) => ref.watch(liveRepo).summary(roomId),
    );

final _dateTime = DateFormat('y-MM-dd HH:mm');

/// `1:05:09`, always with hours (`0:12:30`).
String _hms(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  String two(int n) => n.toString().padLeft(2, '0');
  return '${s ~/ 3600}:${two((s % 3600) ~/ 60)}:${two(s % 60)}';
}

final _time = DateFormat('HH:mm');

/// The host's post-live summary: streaming time, earnings, audience and top gifters. Opens
/// when the host ends a live, and from Broadcasting History.
class LiveSummaryScreen extends ConsumerStatefulWidget {
  const LiveSummaryScreen({super.key, required this.roomId});
  final String roomId;

  @override
  ConsumerState<LiveSummaryScreen> createState() => _LiveSummaryScreenState();
}

class _LiveSummaryScreenState extends ConsumerState<LiveSummaryScreen> {
  /// Gifts sent in the last moments still count for about a minute after the end: refetch
  /// until the server marks the summary final, a bounded number of times (pull-to-refresh
  /// still works after that).
  static const _refetchEvery = Duration(seconds: 15);
  static const _maxRefetches = 6;
  Timer? _refetch;
  int _refetches = 0;

  @override
  void dispose() {
    _refetch?.cancel();
    super.dispose();
  }

  /// Right after ending a live there may be nothing to pop back to.
  void _close() => context.canPop() ? context.pop() : context.go('/home');

  @override
  Widget build(BuildContext context) {
    final provider = liveSummaryProvider(widget.roomId);
    ref.listen(provider, (_, next) {
      if (next.isLoading ||
          next.value?.isFinal != false ||
          (_refetch?.isActive ?? false) ||
          _refetches >= _maxRefetches) {
        return;
      }
      _refetches++;
      _refetch = Timer(_refetchEvery, () {
        if (mounted) ref.invalidate(provider);
      });
    });
    final summary = ref.watch(provider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Live summary'),
        centerTitle: true,
        leading: IconButton(
          icon: const Icon(Icons.close_rounded),
          tooltip: 'Close',
          onPressed: _close,
        ),
      ),
      body: switch (summary) {
        AsyncValue(:final value?) => RefreshIndicator(
          onRefresh: () => ref.refresh(provider.future),
          child: _SummaryBody(summary: value, onDone: _close),
        ),
        AsyncValue(:final error?) => ErrorView(
          error: error,
          onRetry: () => ref.invalidate(provider),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _SummaryBody extends StatelessWidget {
  const _SummaryBody({required this.summary, required this.onDone});
  final LiveSummary summary;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final s = summary;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.fromLTRB(
        16,
        8,
        16,
        16 + MediaQuery.paddingOf(context).bottom,
      ),
      children: [
        _Header(summary: s),
        const SizedBox(height: 16),
        _EarningsCard(summary: s),
        const SizedBox(height: 20),
        const _SectionTitle('Audience'),
        _StatGrid(
          stats: [
            (Icons.groups_rounded, 'Peak viewers', s.peakViewers),
            (Icons.visibility_rounded, 'Viewers', s.uniqueViewers),
            (Icons.person_add_alt_1_rounded, 'New followers', s.newFollowers),
            (Icons.login_rounded, 'Joins', s.totalJoins),
            (Icons.chat_bubble_rounded, 'Comments', s.chatMessages),
            (Icons.favorite_rounded, 'Reactions', s.reactions),
          ],
        ),
        const SizedBox(height: 20),
        const _SectionTitle('Top gifters'),
        if (s.topGifters.isEmpty)
          const _Muted('No gifts this time. Keep going, your fans will come!')
        else
          for (final g in s.topGifters) _GifterRow(gifter: g),
        if (s.topGifts.isNotEmpty) ...[
          const SizedBox(height: 20),
          const _SectionTitle('Top gifts'),
          SizedBox(
            // Icon and padding are fixed; the three text lines grow with the text scale.
            height: 72 + MediaQuery.textScalerOf(context).scale(52),
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: s.topGifts.length,
              separatorBuilder: (_, _) => const SizedBox(width: 10),
              itemBuilder: (_, i) => _GiftTile(gift: s.topGifts[i]),
            ),
          ),
        ],
        const SizedBox(height: 28),
        GoldButton(label: 'Done', height: 48, onPressed: onDone),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.summary});
  final LiveSummary summary;

  /// Only unusual endings are called out; ending the live yourself is the normal case.
  static String? _reasonNote(String? reason) => switch (reason) {
    'admin' || 'moderator' => 'Ended by a moderator',
    'moderation' => 'Ended by content moderation',
    'banned' => 'Ended because the account was banned',
    'stale' || 'webhook' => 'Ended after the connection was lost',
    _ => null,
  };

  @override
  Widget build(BuildContext context) {
    final s = summary;
    final reason = _reasonNote(s.endReason);
    const soft = TextStyle(color: BBColors.bronzeDeep, fontSize: 12);
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: BBColors.goldGradient,
        borderRadius: BorderRadius.circular(18),
        boxShadow: const [
          BoxShadow(
            color: BBColors.goldShadow,
            blurRadius: 16,
            offset: Offset(0, 6),
          ),
        ],
      ),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                s.isAudio ? Icons.mic_rounded : Icons.videocam_rounded,
                size: 18,
                color: BBColors.bronzeDeep,
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  s.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: BBColors.bronzeDeep,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          const Text('Streaming time', style: soft),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              _hms(s.durationSec),
              style: const TextStyle(
                color: BBColors.ink,
                fontSize: 40,
                fontWeight: FontWeight.w800,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '${_dateTime.format(s.startedAt)} – ${_time.format(s.endedAt)}',
            style: soft,
          ),
          if (reason != null) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: BBColors.scrim,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(
                reason,
                style: const TextStyle(color: BBColors.ivory, fontSize: 12),
              ),
            ),
          ],
          if (!s.isFinal) ...[
            const SizedBox(height: 10),
            const Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                SizedBox.square(
                  dimension: 12,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: BBColors.bronzeDeep,
                  ),
                ),
                SizedBox(width: 8),
                Text('Updating the last gifts…', style: soft),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

BoxDecoration _card(double radius) => BoxDecoration(
  color: BBColors.surface,
  borderRadius: BorderRadius.circular(radius),
  border: Border.all(color: BBColors.border),
);

class _EarningsCard extends StatelessWidget {
  const _EarningsCard({required this.summary});
  final LiveSummary summary;

  @override
  Widget build(BuildContext context) {
    final s = summary;
    // Guests on stage can be gifted too; the room total shows only when it differs.
    final guestDiamonds = s.roomDiamonds - s.hostDiamonds;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: _card(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Gifts received',
            style: TextStyle(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _BigFigure(
                  icon: Icons.savings_rounded,
                  value: s.hostEarnings,
                  label: 'Diamonds earned',
                ),
              ),
              Container(width: 1, height: 44, color: BBColors.border),
              Expanded(
                child: _BigFigure(
                  icon: Icons.diamond_rounded,
                  value: s.hostDiamonds,
                  label: 'Diamonds received',
                ),
              ),
            ],
          ),
          const Divider(height: 24, color: BBColors.border),
          Row(
            children: [
              _SmallFigure(label: 'Gifts', value: Fmt.full(s.giftCount)),
              _SmallFigure(label: 'Gifters', value: Fmt.full(s.gifters)),
              if (guestDiamonds > 0)
                _SmallFigure(
                  label: 'Room total 💎',
                  value: Fmt.compact(s.roomDiamonds),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _BigFigure extends StatelessWidget {
  const _BigFigure({
    required this.icon,
    required this.value,
    required this.label,
  });
  final IconData icon;
  final int value;
  final String label;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '$label ${Fmt.full(value)}',
    excludeSemantics: true,
    child: Column(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: BBColors.goldDeep, size: 22),
            const SizedBox(width: 6),
            Flexible(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  Fmt.full(value),
                  style: const TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.w800,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: const TextStyle(color: BBColors.inkMuted, fontSize: 12),
        ),
      ],
    ),
  );
}

class _SmallFigure extends StatelessWidget {
  const _SmallFigure({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Column(
      children: [
        Text(
          value,
          style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
        ),
        Text(
          label,
          style: const TextStyle(fontSize: 11, color: BBColors.inkMuted),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    ),
  );
}

class _StatGrid extends StatelessWidget {
  const _StatGrid({required this.stats});

  /// A null value is unknown (a live from before the counter) and shows as "—".
  final List<(IconData, String, int?)> stats;

  static const _perRow = 3;

  /// Rows size to their content, so large text never clips on a small phone.
  @override
  Widget build(BuildContext context) => Column(
    children: [
      for (var i = 0; i < stats.length; i += _perRow)
        Padding(
          padding: EdgeInsets.only(top: i == 0 ? 0 : 10),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var j = i; j < i + _perRow; j++) ...[
                  if (j > i) const SizedBox(width: 10),
                  Expanded(
                    child: j < stats.length
                        ? _StatTile(stat: stats[j])
                        : const SizedBox.shrink(),
                  ),
                ],
              ],
            ),
          ),
        ),
    ],
  );
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.stat});
  final (IconData, String, int?) stat;

  @override
  Widget build(BuildContext context) {
    final (icon, label, value) = stat;
    final shown = value == null ? '—' : Fmt.compact(value);
    return Semantics(
      label: '$label $shown',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 12),
        decoration: _card(14),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 20, color: BBColors.gold),
            const SizedBox(height: 6),
            Text(
              shown,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
            ),
            Text(
              label,
              style: const TextStyle(fontSize: 11, color: BBColors.inkMuted),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }
}

class _GifterRow extends StatelessWidget {
  const _GifterRow({required this.gifter});
  final LiveSummaryGifter gifter;

  static const _medals = ['🥇', '🥈', '🥉'];

  @override
  Widget build(BuildContext context) {
    final g = gifter;
    final u = g.user;
    final gifts = '${Fmt.full(g.gifts)} ${g.gifts == 1 ? 'gift' : 'gifts'}';
    return ListTile(
      contentPadding: EdgeInsets.zero,
      onTap: u == null ? null : () => context.push('/user/${u.id}'),
      leading: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 28,
            child: g.rank >= 1 && g.rank <= _medals.length
                ? Text(
                    _medals[g.rank - 1],
                    style: const TextStyle(fontSize: 20),
                  )
                : Text(
                    '${g.rank}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      color: BBColors.inkMuted,
                    ),
                  ),
          ),
          const SizedBox(width: 4),
          if (u == null)
            const CircleAvatar(
              radius: 20,
              backgroundColor: BBColors.surfaceMuted,
              child: Icon(Icons.person_rounded, color: BBColors.inkSubtle),
            )
          else
            BBAvatar.user(u, size: 40),
        ],
      ),
      title: Text(
        u?.displayName ?? 'Deleted account',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        u == null ? gifts : 'ID ${u.shortId} · $gifts',
        style: const TextStyle(color: BBColors.inkMuted),
      ),
      trailing: Text(
        '💎 ${Fmt.compact(g.diamonds)}',
        style: const TextStyle(fontWeight: FontWeight.w700),
      ),
    );
  }
}

class _GiftTile extends StatelessWidget {
  const _GiftTile({required this.gift});
  final LiveSummaryGift gift;

  @override
  Widget build(BuildContext context) {
    const fallback = Icon(
      Icons.card_giftcard_rounded,
      size: 40,
      color: BBColors.inkSubtle,
    );
    final icon = gift.iconUrl;
    return Container(
      width: 92,
      padding: const EdgeInsets.all(8),
      decoration: _card(14),
      child: Column(
        children: [
          SizedBox.square(
            dimension: 44,
            child: icon == null || icon.isEmpty
                ? fallback
                : CachedNetworkImage(
                    imageUrl: icon,
                    memCacheWidth: 132,
                    errorWidget: (_, _, _) => fallback,
                  ),
          ),
          const SizedBox(height: 4),
          Text(
            gift.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 12),
          ),
          Text(
            '×${Fmt.compact(gift.count)}',
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
          ),
          Text(
            '💎 ${Fmt.compact(gift.diamonds)}',
            style: const TextStyle(fontSize: 11, color: BBColors.inkMuted),
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      text,
      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
    ),
  );
}

class _Muted extends StatelessWidget {
  const _Muted(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: const TextStyle(color: BBColors.inkMuted),
    ),
  );
}
