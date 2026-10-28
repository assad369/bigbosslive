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
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 14, 16, 0),
              child: Row(
                children: [
                  Icon(Icons.emoji_events, size: 18, color: BBColors.goldDeep),
                  SizedBox(width: 6),
                  Text(
                    'Top agencies',
                    style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
                  ),
                  SizedBox(width: 6),
                  Text(
                    'this month',
                    style: TextStyle(color: BBColors.inkSubtle, fontSize: 12),
                  ),
                ],
              ),
            ),
            BBCarousel(
              height: 100,
              padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
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

class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 22, 16, 0),
    child: Container(
      height: 84,
      decoration: BoxDecoration(
        color: BBColors.surfaceMuted,
        borderRadius: BorderRadius.circular(18),
      ),
    ),
  );
}
