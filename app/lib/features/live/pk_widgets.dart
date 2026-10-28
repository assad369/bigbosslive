import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:livekit_client/livekit_client.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';

/// Rebuilds every [period] while mounted, for countdowns.
class _Ticker extends StatefulWidget {
  const _Ticker({
    required this.builder,
    this.period = const Duration(milliseconds: 500),
  });
  final WidgetBuilder builder;
  final Duration period;
  @override
  State<_Ticker> createState() => _TickerState();
}

class _TickerState extends State<_Ticker> {
  // Started in initState: a `late final` initializer would only run on first read, which
  // was dispose(), so the countdowns never ticked on their own.
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(widget.period, (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context);
}

int _secondsUntil(PkBattle b, DateTime? at) =>
    at == null ? 0 : (at.difference(b.serverNow).inMilliseconds / 1000).ceil();

/// The PK split screen: this room's host on the left (red), the opponent on the right (blue).
/// Shows the round bar, a 3-2-1 lead-in, per-round scores with top supporters, and the round
/// or battle result. Hosts get End and Next-round controls.
class PkArena extends StatelessWidget {
  const PkArena({super.key, required this.c, required this.battle});
  final LiveRoomController c;
  final PkBattle battle;

  @override
  Widget build(BuildContext context) {
    final hostId = c.detail?.room.host.id;
    final ours = battle.host(hostId ?? '') ?? battle.hosts.firstOrNull;
    // A battle without both hosts can't be drawn; it is never a valid server state.
    if (ours == null || battle.hosts.length < 2) return const SizedBox.shrink();
    final theirs = battle.hosts.firstWhere(
      (h) => h.uid != ours.uid,
      orElse: () => battle.hosts.last,
    );
    final width = MediaQuery.sizeOf(context).width;
    return _Ticker(
      builder: (context) {
        final b = battle;
        final leadIn = b.isActive && !b.isPaused
            ? _secondsUntil(b, b.scoringOpensAt)
            : 0;
        return Column(
          children: [
            _RoundBar(c: c, battle: b, ours: ours, theirs: theirs),
            SizedBox(
              height: width / 2 * 1.3,
              child: Stack(
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: _PkPanel(
                          c: c,
                          battle: b,
                          host: ours,
                          color: BBColors.pkRed,
                          track: c.hostVideo,
                          mirror: c.isHost && c.frontCamera,
                        ),
                      ),
                      const SizedBox(width: 2),
                      Expanded(
                        child: _PkPanel(
                          c: c,
                          battle: b,
                          host: theirs,
                          color: BBColors.pkBlue,
                          track: c.opponentVideo,
                        ),
                      ),
                    ],
                  ),
                  const Align(
                    alignment: Alignment.topCenter,
                    child: _VsBadge(),
                  ),
                  if (leadIn > 0)
                    Center(
                      child: Text(
                        '$leadIn',
                        style: const TextStyle(
                          color: BBColors.ivory,
                          fontSize: 72,
                          fontWeight: FontWeight.w900,
                          shadows: [Shadow(blurRadius: 16)],
                        ),
                      ),
                    ),
                  if (b.isPaused)
                    Center(
                      child: _BetweenRounds(c: c, battle: b),
                    ),
                ],
              ),
            ),
            _ScoreMeter(ours: ours, theirs: theirs),
          ],
        );
      },
    );
  }
}

class _RoundBar extends StatelessWidget {
  const _RoundBar({
    required this.c,
    required this.battle,
    required this.ours,
    required this.theirs,
  });
  final LiveRoomController c;
  final PkBattle battle;
  final PkHost ours;
  final PkHost theirs;

  @override
  Widget build(BuildContext context) {
    final b = battle;
    final left = _secondsUntil(b, b.endsAt);
    final String clock;
    var urgent = false;
    if (b.isEnded) {
      clock = 'FINAL';
    } else if (b.isPaused) {
      clock = 'PAUSED';
    } else {
      clock = Fmt.clock(left);
      urgent = left <= 30;
    }
    final participant = c.isHost;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 4),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: BBColors.scrim,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text.rich(
              TextSpan(
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                ),
                children: [
                  TextSpan(
                    text: 'R${b.round}/${b.maxRounds}  ',
                    style: const TextStyle(color: BBColors.ivory),
                  ),
                  TextSpan(
                    text: '${ours.roundsWon}',
                    style: const TextStyle(color: BBColors.pkRed),
                  ),
                  const TextSpan(
                    text: ' – ',
                    style: TextStyle(color: BBColors.ivory),
                  ),
                  TextSpan(
                    text: '${theirs.roundsWon}',
                    style: const TextStyle(color: BBColors.pkBlue),
                  ),
                ],
              ),
            ),
          ),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
            decoration: BoxDecoration(
              gradient: urgent ? null : BBColors.goldGradient,
              color: urgent ? BBColors.danger : null,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              'PK  $clock',
              style: TextStyle(
                color: urgent ? BBColors.ivory : BBColors.ink,
                fontWeight: FontWeight.w900,
                fontSize: 12,
                letterSpacing: 1,
              ),
            ),
          ),
          const Spacer(),
          if (participant && !b.isEnded)
            InkWell(
              onTap: () => _confirmEnd(context, c, b),
              borderRadius: BorderRadius.circular(10),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 3,
                ),
                decoration: BoxDecoration(
                  color: BBColors.scrim,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: BBColors.danger),
                ),
                child: const Text(
                  'End',
                  style: TextStyle(
                    color: BBColors.ivory,
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            )
          else
            const SizedBox(width: 44),
        ],
      ),
    );
  }

  static Future<void> _confirmEnd(
    BuildContext context,
    LiveRoomController c,
    PkBattle b,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('End the PK?'),
        content: Text(
          b.isPaused
              ? 'The battle will be decided on rounds won so far.'
              : 'Leaving during a round forfeits the battle.',
        ),
        actions: [
          TextButton(
            onPressed: () => ctx.pop(false),
            child: const Text('Keep battling'),
          ),
          FilledButton(
            onPressed: () => ctx.pop(true),
            child: const Text('End PK'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await c.endPk();
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }
}

class _PkPanel extends StatelessWidget {
  const _PkPanel({
    required this.c,
    required this.battle,
    required this.host,
    required this.color,
    required this.track,
    this.mirror = false,
  });
  final LiveRoomController c;
  final PkBattle battle;
  final PkHost host;
  final Color color;
  final VideoTrack? track;
  final bool mirror;

  @override
  Widget build(BuildContext context) {
    final supporters = (c.pkContributors[host.uid] ?? const []).take(3);
    final ended = battle.isEnded;
    final won = ended && battle.winnerUid == host.uid;
    final lastRound = battle.rounds.lastOrNull;
    final roundResult = battle.isPaused && lastRound != null
        ? (lastRound.winnerUid == null
              ? 'DRAW'
              : lastRound.winnerUid == host.uid
              ? 'ROUND WON'
              : 'ROUND LOST')
        : null;
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: color, width: 3)),
      ),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (track != null)
            VideoTrackRenderer(
              track!,
              fit: VideoViewFit.cover,
              mirrorMode: mirror
                  ? VideoViewMirrorMode.mirror
                  : VideoViewMirrorMode.off,
            )
          else
            ColoredBox(
              color: BBColors.espresso,
              child: Center(child: BBAvatar.user(host.brief, size: 64)),
            ),
          if (ended && !won && !battle.isDraw)
            const ColoredBox(color: BBColors.scrim),
          Positioned(
            top: 6,
            left: 6,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                Fmt.compact(host.roundScore),
                style: const TextStyle(
                  color: BBColors.ivory,
                  fontWeight: FontWeight.w900,
                  fontSize: 13,
                ),
              ),
            ),
          ),
          Positioned(
            left: 6,
            bottom: 6,
            right: 6,
            child: Row(
              children: [
                Flexible(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: BBColors.scrim,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      host.displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: BBColors.ivory,
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                for (final s in supporters)
                  Padding(
                    padding: const EdgeInsets.only(left: 2),
                    child: BBAvatar.user(s.user, size: 20),
                  ),
              ],
            ),
          ),
          if (roundResult != null || ended)
            Center(
              child: _ResultPill(
                text: ended
                    ? (battle.isDraw ? 'DRAW' : (won ? 'WINNER' : 'LOSE'))
                    : roundResult!,
                highlight: ended ? won : roundResult == 'ROUND WON',
              ),
            ),
        ],
      ),
    );
  }
}

class _ResultPill extends StatelessWidget {
  const _ResultPill({required this.text, required this.highlight});
  final String text;
  final bool highlight;
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
    tween: Tween(begin: 0.4, end: 1),
    duration: const Duration(milliseconds: 450),
    curve: Curves.elasticOut,
    builder: (_, scale, child) => Transform.scale(scale: scale, child: child),
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      decoration: BoxDecoration(
        gradient: highlight ? BBColors.goldGradient : null,
        color: highlight ? null : BBColors.scrim,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        highlight && text == 'WINNER' ? '👑 $text' : text,
        style: TextStyle(
          color: highlight ? BBColors.ink : BBColors.ivory,
          fontWeight: FontWeight.w900,
          letterSpacing: 1,
        ),
      ),
    ),
  );
}

class _VsBadge extends StatelessWidget {
  const _VsBadge();
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(top: 6),
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      gradient: BBColors.goldGradient,
      borderRadius: BorderRadius.circular(8),
    ),
    child: const Text(
      'VS',
      style: TextStyle(
        color: BBColors.ink,
        fontWeight: FontWeight.w900,
        fontStyle: FontStyle.italic,
      ),
    ),
  );
}

/// Between rounds: a host starts the next round; everyone sees the auto-end countdown.
class _BetweenRounds extends StatefulWidget {
  const _BetweenRounds({required this.c, required this.battle});
  final LiveRoomController c;
  final PkBattle battle;
  @override
  State<_BetweenRounds> createState() => _BetweenRoundsState();
}

class _BetweenRoundsState extends State<_BetweenRounds> {
  bool _busy = false;

  Future<void> _next() async {
    setState(() => _busy = true);
    try {
      await widget.c.nextPkRound();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final b = widget.battle;
    final left = _secondsUntil(b, b.pausedUntil);
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: BBColors.scrim,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Round ${b.round + 1} of ${b.maxRounds}',
            style: const TextStyle(
              color: BBColors.ivory,
              fontWeight: FontWeight.w800,
            ),
          ),
          if (widget.c.isHost) ...[
            const SizedBox(height: 6),
            SizedBox(
              height: 36,
              child: FilledButton.icon(
                onPressed: _busy ? null : _next,
                icon: const Icon(Icons.bolt_rounded, size: 18),
                label: const Text('Next round'),
              ),
            ),
          ],
          const SizedBox(height: 4),
          Text(
            'Ends in ${Fmt.clock(left)} if no one continues',
            style: const TextStyle(color: BBColors.champagne, fontSize: 10),
          ),
        ],
      ),
    );
  }
}

class _ScoreMeter extends StatelessWidget {
  const _ScoreMeter({required this.ours, required this.theirs});
  final PkHost ours;
  final PkHost theirs;

  @override
  Widget build(BuildContext context) {
    final total = ours.roundScore + theirs.roundScore;
    final share = total == 0
        ? 0.5
        : (ours.roundScore / total).clamp(0.06, 0.94);
    return SizedBox(
      height: 16,
      child: LayoutBuilder(
        builder: (_, box) => Stack(
          children: [
            Container(color: BBColors.pkBlue),
            AnimatedContainer(
              duration: const Duration(milliseconds: 400),
              curve: Curves.easeOut,
              width: box.maxWidth * share,
              color: BBColors.pkRed,
            ),
            Positioned.fill(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Row(
                  children: [
                    Text(
                      Fmt.compact(ours.roundScore),
                      style: const TextStyle(
                        color: BBColors.ivory,
                        fontWeight: FontWeight.w900,
                        fontSize: 11,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      Fmt.compact(theirs.roundScore),
                      style: const TextStyle(
                        color: BBColors.ivory,
                        fontWeight: FontWeight.w900,
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
    );
  }
}

/// "Waiting for X to accept" with a countdown and Cancel, while this host's challenge is out.
class PkWaitingBanner extends StatelessWidget {
  const PkWaitingBanner({super.key, required this.c});
  final LiveRoomController c;

  @override
  Widget build(BuildContext context) {
    final b = c.pkOutgoing;
    if (b == null) return const SizedBox.shrink();
    final opponent = b.hosts.where((h) => h.uid != c.myUid).firstOrNull;
    return _Ticker(
      period: const Duration(seconds: 1),
      builder: (context) => Container(
        margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
        padding: const EdgeInsets.fromLTRB(8, 6, 4, 6),
        decoration: BoxDecoration(
          color: BBColors.scrim,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: BBColors.goldOutline),
        ),
        child: Row(
          children: [
            BBAvatar.user(opponent?.brief, size: 28),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                'Waiting for ${opponent?.displayName ?? 'opponent'}… '
                '${_secondsUntil(b, b.inviteExpiresAt).clamp(0, 999)}s',
                style: const TextStyle(color: BBColors.ivory, fontSize: 12),
              ),
            ),
            TextButton(
              onPressed: c.cancelPkInvite,
              child: const Text('Cancel'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Host flow: pick a round length, then challenge a live host (all or friends) or a random one.
class PkPickerSheet extends ConsumerStatefulWidget {
  const PkPickerSheet({super.key, required this.c, required this.durations});
  final LiveRoomController c;
  final List<int> durations;

  static Future<void> show(
    BuildContext context,
    LiveRoomController c,
    List<int> durations,
  ) => showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => PkPickerSheet(c: c, durations: durations),
  );

  @override
  ConsumerState<PkPickerSheet> createState() => _PkPickerSheetState();
}

class _PkPickerSheetState extends ConsumerState<PkPickerSheet> {
  String _tab = 'all';
  late int _duration = widget.durations.contains(300)
      ? 300
      : widget.durations.first;
  late Future<List<PkCandidate>> _hosts = _load();
  String? _sendingTo;

  Future<List<PkCandidate>> _load() => ref.read(liveRepo).pkHosts(tab: _tab);

  Future<void> _challenge(Future<void> Function() send, String key) async {
    setState(() => _sendingTo = key);
    try {
      await send();
      if (mounted) context.pop();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sendingTo = null);
    }
  }

  String _label(int s) => s < 60 ? '${s}s' : '${s ~/ 60} min';

  @override
  Widget build(BuildContext context) => SafeArea(
    child: SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.7,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Text(
              'Start a PK battle',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Wrap(
              spacing: 8,
              children: [
                for (final d in widget.durations)
                  ChoiceChip(
                    label: Text('${_label(d)} / round'),
                    selected: d == _duration,
                    onSelected: (_) => setState(() => _duration = d),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Row(
              children: [
                SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'all', label: Text('Live hosts')),
                    ButtonSegment(value: 'friends', label: Text('Friends')),
                  ],
                  selected: {_tab},
                  onSelectionChanged: (v) => setState(() {
                    _tab = v.first;
                    _hosts = _load();
                  }),
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: _sendingTo != null
                      ? null
                      : () => _challenge(
                          () => widget.c.randomPk(_duration),
                          'random',
                        ),
                  icon: const Icon(Icons.shuffle_rounded),
                  label: const Text('Random'),
                ),
              ],
            ),
          ),
          Expanded(
            child: FutureBuilder<List<PkCandidate>>(
              future: _hosts,
              builder: (context, snap) {
                if (snap.hasError) {
                  return ErrorView(
                    error: snap.error!,
                    onRetry: () => setState(() => _hosts = _load()),
                  );
                }
                final items = snap.data;
                if (items == null) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (items.isEmpty) {
                  return EmptyState(
                    icon: Icons.bolt_rounded,
                    title: _tab == 'friends'
                        ? 'No friends are live'
                        : 'No other hosts are live',
                    message: 'Try a random match or check back soon.',
                  );
                }
                return RefreshIndicator(
                  onRefresh: () async {
                    final next = _load();
                    setState(() => _hosts = next);
                    await next;
                  },
                  child: ListView(
                    children: [
                      for (final h in items)
                        UserTile(
                          user: h.user,
                          subtitle: '${Fmt.compact(h.viewerCount)} watching',
                          trailing: h.busy
                              ? const Text(
                                  'In PK',
                                  style: TextStyle(color: BBColors.inkMuted),
                                )
                              : FilledButton(
                                  onPressed: _sendingTo != null
                                      ? null
                                      : () => _challenge(
                                          () => widget.c.invitePk(
                                            h.user.id,
                                            _duration,
                                          ),
                                          h.user.id,
                                        ),
                                  child: _sendingTo == h.user.id
                                      ? const SizedBox.square(
                                          dimension: 16,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                          ),
                                        )
                                      : const Text('Invite'),
                                ),
                        ),
                    ],
                  ),
                );
              },
            ),
          ),
        ],
      ),
    ),
  );
}
