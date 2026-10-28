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

/// One card of the home "Top agencies" slider.
class AgencyRankCard extends StatelessWidget {
  const AgencyRankCard({super.key, required this.top, this.onTap});
  final TopAgency top;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final a = top.agency;
    final podium = top.rank <= 3;
    final accent = AgencyPodium.accent(top.rank);
    return Material(
      color: BBColors.surface,
      borderRadius: BorderRadius.circular(18),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap == null
            ? null
            : () {
                HapticFeedback.selectionClick();
                onTap!();
              },
        child: Ink(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(
              color: podium ? accent : BBColors.border,
              width: podium ? 1.4 : 1,
            ),
            gradient: LinearGradient(
              colors: [
                accent.withValues(alpha: podium ? 0.16 : 0.06),
                BBColors.surface,
              ],
              stops: const [0, 0.55],
            ),
          ),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Row(
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  AgencyLogo(
                    agency: a,
                    size: 56,
                    ring: AgencyPodium.gradient(top.rank),
                  ),
                  if (podium)
                    Positioned(
                      right: -2,
                      bottom: -2,
                      child: Text(
                        const ['🥇', '🥈', '🥉'][top.rank - 1],
                        style: const TextStyle(fontSize: 18),
                      ),
                    ),
                ],
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      a.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 15,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '🫘 ${Fmt.compact(top.periodBeans)} this month',
                      style: TextStyle(
                        color: accent,
                        fontWeight: FontWeight.w700,
                        fontSize: 12,
                      ),
                    ),
                    Text(
                      '${a.memberCount} hosts · ${a.code}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: BBColors.inkSubtle,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),
              ),
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  gradient: AgencyPodium.gradient(top.rank),
                  borderRadius: BorderRadius.circular(12),
                ),
                alignment: Alignment.center,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.workspace_premium,
                      size: 16,
                      color: podium ? BBColors.onAccent : BBColors.goldDeep,
                    ),
                    Text(
                      '#${top.rank}',
                      style: TextStyle(
                        color: podium ? BBColors.onAccent : BBColors.goldDeep,
                        fontWeight: FontWeight.w900,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
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
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
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

class _AgencySheet extends ConsumerStatefulWidget {
  const _AgencySheet({required this.agency});
  final AgencySummary agency;
  @override
  ConsumerState<_AgencySheet> createState() => _AgencySheetState();
}

class _AgencySheetState extends ConsumerState<_AgencySheet> {
  bool _busy = false;

  Future<void> _apply() async {
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
