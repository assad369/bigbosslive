import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/models.dart';
import '../providers.dart';
import '../theme/bb_colors.dart';
import '../utils/format.dart';

/// Diamonds per star (`app.diamondsPerStar`, one lakh by default) from the remote config.
final diamondsPerStarProvider = Provider<int>(
  (ref) =>
      ref.watch(appConfigProvider).value?.diamondsPerStar ??
      AppConfig.defaultDiamondsPerStar,
);

/// Whole stars a [diamonds] balance is worth: one per [perStar] diamonds.
int starsFor(int diamonds, int perStar) =>
    perStar <= 0 || diamonds <= 0 ? 0 : diamonds ~/ perStar;

/// A star and its count, e.g. "★ 12".
class StarCount extends StatelessWidget {
  const StarCount(this.stars, {super.key, this.size = 14, this.color});
  final int stars;
  final double size;

  /// The count's colour; the star itself is always gold.
  final Color? color;

  @override
  Widget build(BuildContext context) => Semantics(
    label: '$stars ${stars == 1 ? 'star' : 'stars'}',
    excludeSemantics: true,
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.star_rounded, size: size + 2, color: BBColors.gold),
        const SizedBox(width: 2),
        Text(
          Fmt.full(stars),
          style: TextStyle(
            color: color,
            fontSize: size,
            fontWeight: FontWeight.w700,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ],
    ),
  );
}

/// A user's wallet: "💎 1,234,567  ★ 12". Stars follow [diamondsPerStarProvider].
/// [onDark] is for the live room's dark overlays; [compact] abbreviates big balances.
class WalletBalance extends ConsumerWidget {
  const WalletBalance(
    this.diamonds, {
    super.key,
    this.onDark = false,
    this.compact = false,
    this.size = 14,
  });
  final int diamonds;
  final bool onDark;
  final bool compact;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stars = starsFor(diamonds, ref.watch(diamondsPerStarProvider));
    final color = onDark ? BBColors.ivory : BBColors.ink;
    final amount = compact ? Fmt.compact(diamonds) : Fmt.full(diamonds);
    return Semantics(
      label: 'Wallet $amount diamonds, $stars ${stars == 1 ? 'star' : 'stars'}',
      excludeSemantics: true,
      child: Wrap(
        spacing: 10,
        runSpacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('💎', style: TextStyle(fontSize: size * 0.95)),
              const SizedBox(width: 4),
              Text(
                amount,
                style: TextStyle(
                  color: color,
                  fontSize: size,
                  fontWeight: FontWeight.w700,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          StarCount(stars, size: size, color: color),
        ],
      ),
    );
  }
}
