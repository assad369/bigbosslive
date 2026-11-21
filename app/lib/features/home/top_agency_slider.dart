import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/bb_colors.dart';
import '../../core/widgets/carousel.dart';
import '../agency/agency_providers.dart';
import '../agency/agency_widgets.dart';

/// "Top agencies" on the Popular tab: this month's ranking, auto-advancing. Hidden while
/// there are no active agencies; a newly created agency appears on the next refresh.
class TopAgencySlider extends ConsumerWidget {
  const TopAgencySlider({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final top = ref.watch(topAgenciesProvider);
    return top.when(
      loading: () => const _Skeleton(),
      // A failed slider never blocks the live list; pull-to-refresh retries it.
      error: (_, _) => const SizedBox.shrink(),
      data: (items) {
        if (items.isEmpty) return const SizedBox.shrink();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const _Header(),
            BBCarousel(
              height: 120,
              // Room around each card for its glow.
              padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
              itemCount: items.length,
              itemBuilder: (context, i) => AgencyRankCard(
                top: items[i],
                onTap: () => showAgencySheet(context, items[i].agency),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// "🏆 Top agencies · THIS MONTH", the trophy in gold foil.
class _Header extends StatelessWidget {
  const _Header();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 14, 16, 0),
    child: Row(
      children: [
        Container(
          width: 26,
          height: 26,
          decoration: const BoxDecoration(
            shape: BoxShape.circle,
            gradient: BBColors.goldGradient,
            boxShadow: [BoxShadow(color: BBColors.goldShadow, blurRadius: 6)],
          ),
          child: const Icon(
            Icons.emoji_events_rounded,
            size: 16,
            color: BBColors.onAccent,
          ),
        ),
        const SizedBox(width: 8),
        const Flexible(
          child: Text(
            'Top agencies',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17),
          ),
        ),
        const SizedBox(width: 8),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(
            color: BBColors.champagne,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: BBColors.champagneDeep),
          ),
          child: const Text(
            'THIS MONTH',
            style: TextStyle(
              color: BBColors.bronzeDeep,
              fontSize: 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
            ),
          ),
        ),
      ],
    ),
  );
}

class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 50, 16, 8),
    child: Container(
      height: 104,
      decoration: BoxDecoration(
        color: BBColors.surfaceMuted,
        borderRadius: BorderRadius.circular(20),
      ),
    ),
  );
}
