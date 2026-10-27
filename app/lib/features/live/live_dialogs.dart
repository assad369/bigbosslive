import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/widgets.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';

/// Dialogs shared by the full live screen and the mini-player. They take a plain
/// [BuildContext] so the mini-player can pass the router's navigator context.

Future<bool> confirmEndLive(BuildContext context) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('End your live?'),
        actions: [
          TextButton(
            onPressed: () => ctx.pop(false),
            child: const Text('Keep going'),
          ),
          FilledButton(
            onPressed: () => ctx.pop(true),
            child: const Text('End live'),
          ),
        ],
      ),
    ) ??
    false;

Future<void> showLiveSummary(BuildContext context, Json? s) => showDialog<void>(
  context: context,
  builder: (ctx) => AlertDialog(
    title: const Text('Live ended'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _SummaryRow('Duration', Fmt.duration(s?.integer('durationSec') ?? 0)),
        _SummaryRow('Peak viewers', Fmt.full(s?.integer('peakViewers') ?? 0)),
        _SummaryRow('Gifts', Fmt.full(s?.integer('giftCount') ?? 0)),
        _SummaryRow(
          'Beans earned',
          '🫘 ${Fmt.full(s?.integer('giftBeans') ?? 0)}',
        ),
      ],
    ),
    actions: [
      FilledButton(onPressed: () => ctx.pop(), child: const Text('Done')),
    ],
  ),
);

/// Asks the host to accept or decline a PK challenge and sends the answer.
Future<void> showPkInviteDialog(
  BuildContext context,
  LiveRepository repo,
  PkBattle battle,
) async {
  final from = battle.hosts.first;
  final accept = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('PK challenge!'),
      content: Text(
        '${from.displayName} challenges you to a ${battle.durationSec ~/ 60}-minute PK.',
      ),
      actions: [
        TextButton(
          onPressed: () => ctx.pop(false),
          child: const Text('Decline'),
        ),
        FilledButton(
          onPressed: () => ctx.pop(true),
          child: const Text('Accept'),
        ),
      ],
    ),
  );
  try {
    await repo.pkRespond(battle.id, accept ?? false);
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Text(label, style: const TextStyle(color: BBColors.inkMuted)),
        const Spacer(),
        Text(value, style: const TextStyle(fontWeight: FontWeight.w700)),
      ],
    ),
  );
}
