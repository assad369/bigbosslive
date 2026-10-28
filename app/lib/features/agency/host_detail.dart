import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'agency_providers.dart';
import 'agency_widgets.dart';
import 'owner_dashboard.dart';

/// One host as their agency sees them: today's target, the last 30 days, and their gifts
/// and live sessions since joining.
class HostDetailScreen extends ConsumerWidget {
  const HostDetailScreen({super.key, required this.uid, required this.initial});
  final String uid;
  final AgencyMember initial;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final analytics = ref.watch(agencyHostAnalyticsProvider(uid));
    final m = analytics.value?.member ?? initial;
    final u = m.user;
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(title: Text(u?.displayName ?? 'Host')),
        body: NestedScrollView(
          headerSliverBuilder: (_, _) => [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (u != null) Card(child: UserTile(user: u)),
                    const SizedBox(height: 8),
                    _TargetCard(m: m),
                    const SizedBox(height: 12),
                    analytics.when(
                      loading: () => const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                      error: (e, _) => ErrorView(
                        error: e,
                        onRetry: () =>
                            ref.invalidate(agencyHostAnalyticsProvider(uid)),
                      ),
                      data: (a) => _Summary(a: a, m: m),
                    ),
                  ],
                ),
              ),
            ),
            const SliverPersistentHeader(pinned: true, delegate: _TabsHeader()),
          ],
          body: TabBarView(
            children: [
              PagedList<AgencyGiftRow>(
                separator: true,
                load: (cursor) =>
                    ref.read(agencyRepo).hostGifts(uid, cursor: cursor),
                empty: const EmptyState(
                  icon: Icons.card_giftcard,
                  title: 'No gifts yet',
                ),
                itemBuilder: (_, g) => ListTile(
                  leading: BBAvatar.user(g.sender, size: 40, fallbackName: '?'),
                  title: Text(
                    '${g.sender?.displayName ?? 'Someone'} · ${g.giftName} ×${g.quantity}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    g.createdAt == null ? '' : Fmt.dateTime(g.createdAt!),
                  ),
                  trailing: Text(
                    '+🫘 ${Fmt.full(g.beans)}',
                    style: const TextStyle(
                      color: BBColors.success,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
              PagedList<AgencySessionRow>(
                separator: true,
                load: (cursor) =>
                    ref.read(agencyRepo).hostSessions(uid, cursor: cursor),
                empty: const EmptyState(
                  icon: Icons.videocam_off_outlined,
                  title: 'No live sessions yet',
                ),
                itemBuilder: (_, s) => ListTile(
                  leading: CircleAvatar(
                    backgroundColor: BBColors.champagne,
                    child: Icon(
                      s.type == 'audio' ? Icons.mic : Icons.videocam,
                      color: BBColors.bronze,
                    ),
                  ),
                  title: Text(
                    s.title.isEmpty ? 'Live' : s.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    '${s.startedAt == null ? '' : Fmt.dateTime(s.startedAt!)}'
                    '${s.endedAt == null ? ' · live now' : ''} · '
                    '${s.peakViewers} peak viewers',
                  ),
                  trailing: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        Fmt.duration(s.durationSec),
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      Text(
                        '🫘 ${Fmt.compact(s.giftBeans)}',
                        style: const TextStyle(
                          color: BBColors.inkSubtle,
                          fontSize: 11,
                        ),
                      ),
                    ],
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

class _TabsHeader extends SliverPersistentHeaderDelegate {
  const _TabsHeader();

  @override
  double get minExtent => 48;
  @override
  double get maxExtent => 48;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlaps) =>
      const ColoredBox(
        color: BBColors.ivory,
        child: TabBar(
          tabs: [
            Tab(text: 'Gifts'),
            Tab(text: 'Sessions'),
          ],
        ),
      );

  @override
  bool shouldRebuild(covariant SliverPersistentHeaderDelegate old) => false;
}

class _TargetCard extends StatelessWidget {
  const _TargetCard({required this.m});
  final AgencyMember m;

  @override
  Widget build(BuildContext context) {
    final progress = m.targetProgress;
    final minutes = m.todayLiveSeconds ~/ 60;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: BBColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: BBColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.flag, size: 16, color: BBColors.goldDeep),
              const SizedBox(width: 6),
              const Text(
                'Today',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              const Spacer(),
              if (m.isLive)
                const Text(
                  '● LIVE',
                  style: TextStyle(
                    color: BBColors.danger,
                    fontWeight: FontWeight.w800,
                    fontSize: 12,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            progress == null
                ? '$minutes min live · 🫘 ${Fmt.compact(m.todayBeans)} · no daily target'
                : '$minutes / ${m.dailyTargetMinutes} min live · 🫘 ${Fmt.compact(m.todayBeans)}',
            style: const TextStyle(color: BBColors.inkMuted),
          ),
          if (progress != null) ...[
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: progress,
                minHeight: 8,
                backgroundColor: BBColors.surfaceMuted,
                color: progress >= 1 ? BBColors.success : BBColors.gold,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.a, required this.m});
  final AgencyAnalytics a;
  final AgencyMember m;

  @override
  Widget build(BuildContext context) {
    final last14 = a.daily.length > 14
        ? a.daily.sublist(a.daily.length - 14)
        : a.daily;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Last ${a.days} days',
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 8),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 2.1,
          children: [
            AgencyStat(
              label: 'Beans',
              value: '🫘 ${Fmt.compact(a.totals.beans)}',
            ),
            AgencyStat(label: 'Gifts', value: Fmt.compact(a.totals.gifts)),
            AgencyStat(
              label: 'Live time',
              value: Fmt.duration(a.totals.liveSeconds),
            ),
            AgencyStat(label: 'Sessions', value: '${a.sessions ?? 0}'),
            AgencyStat(
              label: 'This month',
              value: '🫘 ${Fmt.compact(m.periodBeans)}',
            ),
            AgencyStat(
              label: 'Since joining',
              value: '🫘 ${Fmt.compact(m.lifetimeBeans)}',
            ),
          ],
        ),
        const SizedBox(height: 14),
        const Text(
          'Live minutes, last 14 days',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 8),
        DailyBars(days: last14, value: (d) => d.liveSeconds ~/ 60, height: 70),
      ],
    );
  }
}
