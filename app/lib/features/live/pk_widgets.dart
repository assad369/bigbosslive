import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

/// PK score tug-of-war bar with a server-time countdown and top supporters.
class PkScoreBar extends StatefulWidget {
  const PkScoreBar({
    super.key,
    required this.battle,
    required this.hostUid,
    required this.contributors,
  });
  final PkBattle battle;
  final String hostUid;
  final Map<String, List<({UserBrief? user, int score})>> contributors;

  @override
  State<PkScoreBar> createState() => _PkScoreBarState();
}

class _PkScoreBarState extends State<PkScoreBar> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final b = widget.battle;
    if (b.hosts.length < 2) return const SizedBox.shrink();
    // Our host on the left, the opponent on the right.
    final ours = b.hosts.firstWhere(
      (h) => h.uid == widget.hostUid,
      orElse: () => b.hosts.first,
    );
    final theirs = b.hosts.firstWhere((h) => h.uid != ours.uid);
    final total = ours.score + theirs.score;
    final share = total == 0 ? 0.5 : (ours.score / total).clamp(0.08, 0.92);
    final left = b.endsAt == null
        ? 0
        : b.endsAt!.difference(DateTime.now()).inSeconds.clamp(0, 99999);
    final ended = b.status == 'ended';

    Widget supporters(String uid) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final c in (widget.contributors[uid] ?? const []).take(3))
          Padding(
            padding: const EdgeInsets.only(right: 2),
            child: BBAvatar(
              url: c.user?.avatarUrl,
              name: c.user?.displayName ?? '',
              size: 20,
            ),
          ),
      ],
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
            decoration: BoxDecoration(
              gradient: BBColors.goldGradient,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              ended
                  ? (b.isDraw
                        ? 'DRAW'
                        : (b.winnerUid == ours.uid ? 'VICTORY' : 'DEFEAT'))
                  : 'PK  ${Fmt.duration(left)}',
              style: const TextStyle(
                color: BBColors.ink,
                fontWeight: FontWeight.w900,
                fontSize: 12,
                letterSpacing: 1,
              ),
            ),
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: SizedBox(
              height: 22,
              child: LayoutBuilder(
                builder: (_, box) => Stack(
                  children: [
                    Container(color: BBColors.bronze),
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 400),
                      curve: Curves.easeOut,
                      width: box.maxWidth * share,
                      decoration: const BoxDecoration(
                        gradient: BBColors.goldGradient,
                      ),
                    ),
                    Positioned.fill(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        child: Row(
                          children: [
                            Text(
                              Fmt.compact(ours.score),
                              style: const TextStyle(
                                color: BBColors.ink,
                                fontWeight: FontWeight.w900,
                                fontSize: 12,
                              ),
                            ),
                            const Spacer(),
                            Text(
                              Fmt.compact(theirs.score),
                              style: const TextStyle(
                                color: BBColors.ivory,
                                fontWeight: FontWeight.w900,
                                fontSize: 12,
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
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              supporters(ours.uid),
              const Spacer(),
              Text(
                theirs.displayName,
                style: const TextStyle(color: BBColors.champagne, fontSize: 11),
              ),
              const SizedBox(width: 6),
              supporters(theirs.uid),
            ],
          ),
        ],
      ),
    );
  }
}

/// Host flow to pick a PK duration and find a random opponent.
abstract final class PkLauncher {
  static Future<void> start(
    BuildContext context,
    WidgetRef ref,
    List<int> durations,
  ) async {
    final duration = await showModalBottomSheet<int>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text(
                'Choose PK length',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
              ),
            ),
            for (final d in durations)
              ListTile(
                leading: const Icon(Icons.timer_outlined),
                title: Text('${d ~/ 60} minutes'),
                onTap: () => ctx.pop(d),
              ),
          ],
        ),
      ),
    );
    if (duration == null) return;
    try {
      await ref.read(liveRepo).pkRandom(duration);
      if (context.mounted) {
        showMessage(
          context,
          'Invitation sent — waiting for an opponent to accept',
        );
      }
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }
}
