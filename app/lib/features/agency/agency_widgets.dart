import 'dart:math' as math;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'agency_providers.dart';

/// Agency logo in a gold ring; the agency's initial when it has none.
class AgencyLogo extends StatelessWidget {
  const AgencyLogo({
    super.key,
    required this.agency,
    this.size = 48,
    this.ring,
  });
  final AgencySummary agency;
  final double size;

  /// Ring gradient; gold by default.
  final Gradient? ring;

  @override
  Widget build(BuildContext context) {
    final url = agency.logoUrl;
    final initial = agency.name.isEmpty
        ? '?'
        : agency.name.characters.first.toUpperCase();
    return Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(size >= 64 ? 3 : 2),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: ring ?? BBColors.goldGradient,
      ),
      child: ClipOval(
        child: url == null || url.isEmpty
            ? Container(
                color: BBColors.champagne,
                alignment: Alignment.center,
                child: Text(
                  initial,
                  style: TextStyle(
                    color: BBColors.bronzeDeep,
                    fontWeight: FontWeight.w800,
                    fontSize: size * 0.4,
                  ),
                ),
              )
            : CachedNetworkImage(
                imageUrl: url,
                fit: BoxFit.cover,
                errorWidget: (_, _, _) =>
                    const ColoredBox(color: BBColors.champagne),
              ),
      ),
    );
  }
}

/// Podium colours for the top three; the brand gold for everyone else.
abstract final class AgencyPodium {
  static const _silver = LinearGradient(
    colors: [BBColors.silverLight, BBColors.silver],
  );

  static Gradient gradient(int rank) => switch (rank) {
    1 => BBColors.goldGradient,
    2 => _silver,
    3 => BBColors.bronzeGradient,
    _ => BBColors.champagneGradient,
  };

  static Color accent(int rank) => switch (rank) {
    1 => BBColors.goldDeep,
    2 => BBColors.silverDeep,
    3 => BBColors.bronze,
    _ => BBColors.goldDeep,
  };
}

/// One card of the home "Top agencies" slider: a dark espresso card framed in the rank's
/// metal (gold, silver, bronze; champagne below the podium), glowing for the top three.
class AgencyRankCard extends StatelessWidget {
  const AgencyRankCard({super.key, required this.top, this.onTap});
  final TopAgency top;
  final VoidCallback? onTap;

  static const _radius = 20.0;
  static const _medals = ['🥇', '🥈', '🥉'];

  @override
  Widget build(BuildContext context) {
    final a = top.agency;
    final podium = top.rank <= 3;
    final accent = AgencyPodium.accent(top.rank);
    final metal = AgencyPodium.gradient(top.rank);
    // Fixed-height card: very large text stops growing at 1.2×.
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.2,
      child: Semantics(
        button: onTap != null,
        label:
            'Rank ${top.rank}, ${a.name}, ${Fmt.diamonds(top.periodDiamonds)} '
            'diamonds this month, ${a.memberCount} hosts',
        excludeSemantics: true,
        child: DecoratedBox(
          // The metal frame: a gradient behind the card, showing as a 1.5 px border.
          decoration: BoxDecoration(
            gradient: metal,
            borderRadius: BorderRadius.circular(_radius),
            boxShadow: [
              BoxShadow(
                color: podium
                    ? accent.withValues(alpha: 0.45)
                    : BBColors.goldShadow,
                blurRadius: podium ? 14 : 8,
                offset: const Offset(0, 3),
              ),
            ],
          ),
          child: Padding(
            padding: const EdgeInsets.all(1.5),
            child: Material(
              color: BBColors.espresso,
              borderRadius: BorderRadius.circular(_radius - 1.5),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: onTap == null
                    ? null
                    : () {
                        HapticFeedback.selectionClick();
                        onTap!();
                      },
                child: Ink(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        BBColors.espressoGlow,
                        BBColors.espresso,
                        BBColors.umberDeep,
                      ],
                      stops: [0, 0.6, 1],
                    ),
                  ),
                  child: Stack(
                    children: [
                      // A faint oversized diamond and a diagonal sheen give the card depth.
                      const Positioned(
                        right: -14,
                        bottom: -26,
                        child: Icon(
                          Icons.diamond_rounded,
                          size: 112,
                          color: BBColors.goldTint,
                        ),
                      ),
                      Positioned(
                        left: -40,
                        top: -60,
                        child: Transform.rotate(
                          angle: -math.pi / 7,
                          child: Container(
                            width: 70,
                            height: 220,
                            decoration: const BoxDecoration(
                              gradient: LinearGradient(
                                colors: [
                                  BBColors.champagneTint,
                                  BBColors.champagneVeil,
                                  BBColors.champagneTint,
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
                        child: Row(
                          children: [
                            Stack(
                              clipBehavior: Clip.none,
                              children: [
                                DecoratedBox(
                                  decoration: BoxDecoration(
                                    shape: BoxShape.circle,
                                    boxShadow: [
                                      BoxShadow(
                                        color: accent.withValues(alpha: 0.55),
                                        blurRadius: 12,
                                      ),
                                    ],
                                  ),
                                  child: AgencyLogo(
                                    agency: a,
                                    size: 64,
                                    ring: metal,
                                  ),
                                ),
                                if (podium)
                                  Positioned(
                                    right: -4,
                                    bottom: -4,
                                    child: Text(
                                      _medals[top.rank - 1],
                                      style: const TextStyle(fontSize: 20),
                                    ),
                                  ),
                              ],
                            ),
                            const SizedBox(width: 14),
                            Expanded(
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  _RankRibbon(rank: top.rank, metal: metal),
                                  const SizedBox(height: 4),
                                  Text(
                                    a.name,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      color: BBColors.ivory,
                                      fontWeight: FontWeight.w800,
                                      fontSize: 16,
                                      height: 1.2,
                                      letterSpacing: 0.2,
                                    ),
                                  ),
                                  const SizedBox(height: 5),
                                  Row(
                                    children: [
                                      Flexible(
                                        child: _DiamondPill(top.periodDiamonds),
                                      ),
                                      const SizedBox(width: 8),
                                      Flexible(
                                        child: Text(
                                          '${a.memberCount} hosts · ${a.code}',
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                            color: BBColors.champagneDeep,
                                            fontSize: 11,
                                            height: 1.2,
                                            fontWeight: FontWeight.w600,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            Container(
                              width: 30,
                              height: 30,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: BBColors.goldTint,
                                border: Border.all(color: BBColors.goldOutline),
                              ),
                              child: const Icon(
                                Icons.chevron_right_rounded,
                                size: 20,
                                color: BBColors.goldLight,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// "👑 NO.1" on gold, "NO.2" on silver, "NO.3" on bronze, "#n" in champagne below.
class _RankRibbon extends StatelessWidget {
  const _RankRibbon({required this.rank, required this.metal});
  final int rank;
  final Gradient metal;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      gradient: metal,
      borderRadius: const BorderRadius.only(
        topLeft: Radius.circular(8),
        bottomRight: Radius.circular(8),
        topRight: Radius.circular(3),
        bottomLeft: Radius.circular(3),
      ),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (rank == 1) ...[
          const Icon(
            Icons.workspace_premium_rounded,
            size: 12,
            color: BBColors.onAccent,
          ),
          const SizedBox(width: 3),
        ],
        Text(
          rank <= 3 ? 'NO.$rank' : '#$rank',
          style: TextStyle(
            color: rank <= 3 ? BBColors.onAccent : BBColors.bronzeDeep,
            fontWeight: FontWeight.w900,
            fontSize: 10,
            height: 1.2,
            letterSpacing: 0.8,
          ),
        ),
      ],
    ),
  );
}

/// This month's diamonds in a gold pill.
class _DiamondPill extends StatelessWidget {
  const _DiamondPill(this.diamonds);
  final int diamonds;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
    decoration: BoxDecoration(
      color: BBColors.goldTint,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: BBColors.goldOutline),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text('💎', style: TextStyle(fontSize: 11, height: 1.2)),
        const SizedBox(width: 3),
        Flexible(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              Fmt.diamonds(diamonds),
              maxLines: 1,
              style: const TextStyle(
                color: BBColors.goldLight,
                fontWeight: FontWeight.w800,
                fontSize: 12,
                height: 1.2,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

/// A labelled number in a dashboard grid.
/// Two-column grid of [AgencyStat]s or [AgencyActionTile]s. Row height follows the content
/// at the user's text size; a fixed aspect ratio squashed the tiles on narrow phones and
/// overflowed them with larger text.
class AgencyStatGrid extends StatelessWidget {
  const AgencyStatGrid({
    super.key,
    required this.children,
    this.actions = false,
  });
  final List<Widget> children;

  /// [AgencyActionTile]s (icon + up to two lines) rather than [AgencyStat]s.
  final bool actions;

  @override
  Widget build(BuildContext context) {
    final text = MediaQuery.textScalerOf(context);
    // Padding and border, plus the content: a 38 px icon beside two label lines, or a
    // 12 px label over an 18 px value.
    final extent = actions
        ? 30.0 + math.max(38.0, text.scale(40))
        : 28.0 + text.scale(44);
    return GridView(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        mainAxisExtent: extent,
      ),
      children: children,
    );
  }
}

class AgencyStat extends StatelessWidget {
  const AgencyStat({
    super.key,
    required this.label,
    required this.value,
    this.icon,
  });
  final String label;
  final String value;
  final IconData? icon;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
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
            if (icon != null) ...[
              Icon(icon, size: 14, color: BBColors.goldDeep),
              const SizedBox(width: 4),
            ],
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: BBColors.inkSubtle, fontSize: 12),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        // Full numbers can be long: shrink to fit rather than cut the value off.
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            value,
            maxLines: 1,
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
          ),
        ),
      ],
    ),
  );
}

/// A tile in the dashboard's action grid, with an optional count badge.
class AgencyActionTile extends StatelessWidget {
  const AgencyActionTile({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.badge = 0,
  });
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final int badge;

  @override
  Widget build(BuildContext context) => Material(
    color: BBColors.surface,
    borderRadius: BorderRadius.circular(16),
    child: InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: BBColors.border),
        ),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                gradient: BBColors.goldGradient,
                borderRadius: BorderRadius.circular(11),
              ),
              child: Icon(icon, color: BBColors.onAccent, size: 20),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            if (badge > 0)
              Badge(
                label: Text(badge > 99 ? '99+' : '$badge'),
                backgroundColor: BBColors.danger,
              ),
          ],
        ),
      ),
    ),
  );
}

/// Public view of an agency (from the home slider or search), with an Apply button for
/// users who have no agency yet.
Future<void> showAgencySheet(BuildContext context, AgencySummary agency) =>
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => _AgencySheet(agency: agency),
    );

/// What joining an agency means, asked before an application or accepting an invitation:
/// members are locked to the agency and can't send gifts (the server enforces both).
Future<bool> confirmAgencyJoin(
  BuildContext context, {
  required String agencyName,
  required String action,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Join $agencyName?'),
        content: const Text(agencyJoinTerms),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(action),
          ),
        ],
      ),
    ) ??
    false;

const agencyJoinTerms =
    'As an agency host your membership is locked to this agency: only BigBoss '
    'support can release it. Agency hosts receive gifts but can’t send them.';

class _AgencySheet extends ConsumerStatefulWidget {
  const _AgencySheet({required this.agency});
  final AgencySummary agency;
  @override
  ConsumerState<_AgencySheet> createState() => _AgencySheetState();
}

class _AgencySheetState extends ConsumerState<_AgencySheet> {
  bool _busy = false;

  Future<void> _apply() async {
    if (!await confirmAgencyJoin(
      context,
      agencyName: widget.agency.name,
      action: 'Apply',
    )) {
      return;
    }
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(agencyRepo).apply(widget.agency.id);
      if (!mounted) return;
      Navigator.of(context).pop();
      showMessage(context, 'Application sent to ${widget.agency.name}');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.agency;
    final membership = ref.watch(agencyMembershipProvider);
    final inAgency = membership.value != null;
    final mine = membership.value?.agency.id == a.id;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AgencyLogo(agency: a, size: 76),
            const SizedBox(height: 10),
            Text(a.name, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 2),
            Text(
              '${a.code} · ${a.memberCount} hosts',
              style: const TextStyle(color: BBColors.inkSubtle),
            ),
            const SizedBox(height: 18),
            if (mine)
              const Text(
                'You are a host in this agency',
                style: TextStyle(fontWeight: FontWeight.w700),
              )
            else
              GoldButton(
                label: inAgency
                    ? 'You already have an agency'
                    : 'Apply to join',
                loading: _busy,
                onPressed: inAgency || membership.isLoading ? null : _apply,
              ),
          ],
        ),
      ),
    );
  }
}
