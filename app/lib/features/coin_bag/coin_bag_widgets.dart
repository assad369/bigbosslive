import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../live/live_room_controller.dart';
import 'coin_bag_models.dart';
import 'coin_bag_providers.dart';

/// The red-and-gold of a coin bag: crimson to deep crimson.
const _bagGradient = LinearGradient(
  begin: Alignment.topLeft,
  end: Alignment.bottomRight,
  colors: [BBColors.king, BBColors.kingDeep],
);

String _clock(Duration d) {
  final s = d.inSeconds;
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

/// The animated coin bag, decoded at its display size.
class CoinBagGif extends StatelessWidget {
  const CoinBagGif(this.size, {super.key});
  final double size;

  @override
  Widget build(BuildContext context) => Image.asset(
    'assets/coin_bag/coin_bag.gif',
    width: size,
    height: size,
    fit: BoxFit.contain,
    cacheWidth: (size * MediaQuery.devicePixelRatioOf(context)).round(),
    gaplessPlayback: true,
    semanticLabel: 'Coin bag',
  );
}

/// Rebuilds every second while mounted: countdowns.
mixin _Ticking<T extends StatefulWidget> on State<T> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }
}

// ── In the room ───────────────────────────────────────────────────────────────

/// The floating bag above the chat: this room's bag first, else the one opening soonest,
/// with its countdown, then GRAB! (here) or GO (another live). Hidden with no bag running.
class CoinBagFloatingButton extends ConsumerStatefulWidget {
  const CoinBagFloatingButton({super.key, required this.c});
  final LiveRoomController c;

  @override
  ConsumerState<CoinBagFloatingButton> createState() =>
      _CoinBagFloatingButtonState();
}

class _CoinBagFloatingButtonState extends ConsumerState<CoinBagFloatingButton>
    with _Ticking {
  @override
  void initState() {
    super.initState();
    // A fresh list for each room: the socket only carries changes.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(ref.read(coinBagsProvider.notifier).refresh());
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(coinBagsProvider);
    final now = ref.read(coinBagsProvider.notifier).clock.now();
    final running = [
      for (final b in state.bags)
        if (b.phaseAt(now) != CoinBagPhase.closed) b,
    ];
    if (running.isEmpty) return const SizedBox.shrink();
    final here = running.where((b) => b.roomId == widget.c.roomId);
    final bag = here.isNotEmpty
        ? here.first
        : (running.toList()..sort((a, b) => a.opensAt.compareTo(b.opensAt)))
              .first;
    final inRoom = bag.roomId == widget.c.roomId;
    final phase = bag.phaseAt(now);
    final grabbed = state.grabbed.containsKey(bag.id);
    final label = grabbed
        ? '+${Fmt.diamonds(state.grabbed[bag.id]!)}'
        : phase == CoinBagPhase.countdown
        ? _clock(bag.remainingAt(now))
        : inRoom || widget.c.isHost
        ? 'GRAB!'
        : 'GO';
    final ready = !grabbed && phase == CoinBagPhase.open;
    return Semantics(
      button: true,
      label: 'Coin bag, ${Fmt.diamonds(bag.pool)} diamonds, $label',
      excludeSemantics: true,
      child: GestureDetector(
        onTap: () => showCoinBagSheet(context, widget.c, focusId: bag.id),
        child: SizedBox(
          width: 64,
          height: 78,
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.topCenter,
            children: [
              const Positioned(top: 0, child: CoinBagGif(58)),
              if (running.length > 1)
                Positioned(
                  right: 0,
                  top: 0,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5),
                    constraints: const BoxConstraints(minWidth: 18),
                    height: 18,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: BBColors.liveRed,
                      borderRadius: BorderRadius.circular(9),
                      border: Border.all(color: BBColors.onAccent, width: 1.2),
                    ),
                    child: Text(
                      '${running.length}',
                      style: const TextStyle(
                        color: BBColors.onAccent,
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
              Positioned(
                bottom: 0,
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    gradient: ready ? BBColors.goldGradient : null,
                    color: ready ? null : BBColors.scrim,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: BBColors.goldOutline),
                  ),
                  child: Text(
                    label,
                    style: TextStyle(
                      color: ready ? BBColors.kingDeep : BBColors.ivory,
                      fontSize: 11,
                      fontWeight: FontWeight.w900,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
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

/// "X released a 💎N coin bag": slides in from the left for a few seconds when someone else
/// releases a bag anywhere. Tapping opens the list on that bag.
class CoinBagReleaseBanner extends ConsumerStatefulWidget {
  const CoinBagReleaseBanner({super.key, required this.c});
  final LiveRoomController c;

  @override
  ConsumerState<CoinBagReleaseBanner> createState() =>
      _CoinBagReleaseBannerState();
}

class _CoinBagReleaseBannerState extends ConsumerState<CoinBagReleaseBanner> {
  static const _shown = Duration(seconds: 6);
  static const _maxQueued = 5;

  final _queue = <CoinBag>[];
  CoinBag? _current;
  Timer? _hide;
  StreamSubscription<CoinBag>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = ref.read(coinBagsProvider.notifier).released.listen(_onReleased);
  }

  void _onReleased(CoinBag bag) {
    final me = ref.read(sessionProvider).value?.profile.id;
    if (bag.releaser?.id == me) return;
    if (_queue.length >= _maxQueued) _queue.removeAt(0);
    _queue.add(bag);
    if (_current == null) _next();
  }

  void _next() {
    if (!mounted) return;
    setState(() => _current = _queue.isEmpty ? null : _queue.removeAt(0));
    if (_current == null) return;
    _hide?.cancel();
    _hide = Timer(_shown, _next);
  }

  @override
  void dispose() {
    _hide?.cancel();
    unawaited(_sub?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bag = _current;
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 350),
      switchInCurve: Curves.easeOutBack,
      transitionBuilder: (child, a) => SlideTransition(
        position: Tween(
          begin: const Offset(-1.2, 0),
          end: Offset.zero,
        ).animate(a),
        child: child,
      ),
      child: bag == null
          ? const SizedBox.shrink(key: ValueKey('none'))
          : GestureDetector(
              key: ValueKey(bag.id),
              onTap: () => showCoinBagSheet(context, widget.c, focusId: bag.id),
              child: Container(
                margin: const EdgeInsets.only(left: 10, right: 60),
                padding: const EdgeInsets.fromLTRB(4, 4, 14, 4),
                decoration: BoxDecoration(
                  gradient: _bagGradient,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: BBColors.goldLight),
                  boxShadow: const [
                    BoxShadow(color: BBColors.plateShadow, blurRadius: 8),
                  ],
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const CoinBagGif(34),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: bag.releaser?.displayName ?? 'Someone',
                              style: const TextStyle(
                                color: BBColors.goldLight,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            TextSpan(
                              text:
                                  ' released a 💎${Fmt.diamonds(bag.amount)} coin bag',
                            ),
                            TextSpan(
                              text: bag.roomId == widget.c.roomId
                                  ? ' here, get ready!'
                                  : ' · Tap to go',
                              style: const TextStyle(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: BBColors.onAccent,
                          fontSize: 12,
                          height: 1.25,
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

/// The rail button: opens the coin bag list. Hidden while coin bags are switched off.
class CoinBagRailButton extends ConsumerWidget {
  const CoinBagRailButton({super.key, required this.c});
  final LiveRoomController c;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = ref.watch(coinBagConfigProvider).value?.enabled ?? false;
    if (!enabled) return const SizedBox.shrink();
    return Tooltip(
      message: 'Coin bags',
      child: Semantics(
        button: true,
        label: 'Coin bags',
        child: InkResponse(
          onTap: () => showCoinBagSheet(context, c),
          radius: 24,
          child: const SizedBox(
            width: 44,
            height: 42,
            child: Center(child: CoinBagGif(32)),
          ),
        ),
      ),
    );
  }
}

// ── Tapping a bag ─────────────────────────────────────────────────────────────

/// Grab, grab remotely, or go to the bag's live (leaving my seat first, after asking).
Future<void> _act(
  BuildContext context,
  WidgetRef ref,
  LiveRoomController c,
  CoinBag bag,
) async {
  final action = coinBagTapAction(
    bagRoomId: bag.roomId,
    myRoomId: c.roomId,
    isHost: c.isHost,
    onSeat: c.onSeat,
  );
  final router = GoRouter.of(context);
  switch (action) {
    case CoinBagTapAction.grabHere || CoinBagTapAction.grabRemote:
      await _grab(context, ref, bag);
    case CoinBagTapAction.leaveSeatThenGo:
      final ok = await showDialog<bool>(
        context: context,
        builder: (d) => AlertDialog(
          title: const Text('Leave your seat?'),
          content: Text(
            "This coin bag is in ${bag.host?.displayName ?? 'another'}'s live. "
            'You will leave your seat here to go there.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(d, false),
              child: const Text('Stay'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(d, true),
              child: const Text('Leave and go'),
            ),
          ],
        ),
      );
      if (ok != true) return;
      try {
        await c.leaveSeat();
      } catch (e) {
        if (context.mounted) showError(context, e);
        return;
      }
      if (context.mounted) Navigator.of(context).pop();
      unawaited(router.pushReplacement('/live/${bag.roomId}'));
    case CoinBagTapAction.go:
      if (context.mounted) Navigator.of(context).pop();
      unawaited(router.pushReplacement('/live/${bag.roomId}'));
  }
}

Future<void> _grab(BuildContext context, WidgetRef ref, CoinBag bag) async {
  unawaited(HapticFeedback.mediumImpact());
  try {
    final got = await ref.read(coinBagsProvider.notifier).grab(bag.id);
    if (context.mounted) {
      await CoinBagResultDialog.show(context, bag: bag, amount: got.amount);
    }
  } on ApiException catch (e) {
    if (!context.mounted) return;
    if (e.code == 'coin_bag_empty') {
      ref.read(coinBagsProvider.notifier).drop(bag.id);
      await CoinBagResultDialog.show(context, bag: bag, amount: null);
    } else {
      if (e.code == 'coin_bag_closed') {
        ref.read(coinBagsProvider.notifier).drop(bag.id);
      }
      showError(context, e);
    }
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}

// ── The list ──────────────────────────────────────────────────────────────────

Future<void> showCoinBagSheet(
  BuildContext context,
  LiveRoomController c, {
  String? focusId,
}) => showModalBottomSheet<void>(
  context: context,
  useSafeArea: true,
  isScrollControlled: true,
  backgroundColor: BBColors.espresso,
  builder: (_) => ConstrainedBox(
    constraints: BoxConstraints(
      maxHeight: MediaQuery.sizeOf(context).height * 0.7,
    ),
    child: _CoinBagSheet(c: c, focusId: focusId),
  ),
);

class _CoinBagSheet extends ConsumerStatefulWidget {
  const _CoinBagSheet({required this.c, this.focusId});
  final LiveRoomController c;
  final String? focusId;

  @override
  ConsumerState<_CoinBagSheet> createState() => _CoinBagSheetState();
}

class _CoinBagSheetState extends ConsumerState<_CoinBagSheet> with _Ticking {
  String? _busy;

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(coinBagsProvider);
    final config = ref.watch(coinBagConfigProvider).value;
    final now = ref.read(coinBagsProvider.notifier).clock.now();
    final bags =
        [
          for (final b in state.bags)
            if (b.phaseAt(now) != CoinBagPhase.closed ||
                state.grabbed.containsKey(b.id))
              b,
        ]..sort(
          (a, b) =>
              a.id == widget.focusId ? -1 : (b.id == widget.focusId ? 1 : 0),
        );
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Row(
            children: [
              const CoinBagGif(30),
              const SizedBox(width: 8),
              const Expanded(
                child: Text(
                  'Coin bags',
                  style: TextStyle(
                    color: BBColors.ivory,
                    fontSize: 17,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              Text(
                '${bags.length} live',
                style: const TextStyle(color: BBColors.champagne, fontSize: 12),
              ),
            ],
          ),
        ),
        Flexible(
          child: bags.isEmpty
              ? const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 24, vertical: 28),
                  child: Text(
                    'No coin bags right now.\nRelease one and everyone live will see it!',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: BBColors.champagne, height: 1.4),
                  ),
                )
              : ListView.separated(
                  shrinkWrap: true,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  itemCount: bags.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (context, i) {
                    final b = bags[i];
                    return _BagRow(
                      bag: b,
                      now: now,
                      focused: b.id == widget.focusId,
                      inRoom: b.roomId == widget.c.roomId,
                      remoteHost: widget.c.isHost,
                      grabbed: state.grabbed[b.id],
                      busy: _busy == b.id,
                      onTap: () async {
                        if (_busy != null) return;
                        setState(() => _busy = b.id);
                        try {
                          await _act(context, ref, widget.c, b);
                        } finally {
                          if (mounted) setState(() => _busy = null);
                        }
                      },
                    );
                  },
                ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                FilledButton.icon(
                  style: FilledButton.styleFrom(
                    backgroundColor: BBColors.king,
                    foregroundColor: BBColors.onAccent,
                    minimumSize: const Size.fromHeight(48),
                    shape: const StadiumBorder(),
                  ),
                  onPressed:
                      config != null && config.enabled && config.canRelease
                      ? () => CoinBagReleaseSheet.show(context, widget.c)
                      : null,
                  icon: const Icon(Icons.redeem_rounded),
                  label: const Text('Release a coin bag'),
                ),
                if (config != null && config.refusal != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    config.refusal!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BBColors.champagne,
                      fontSize: 12,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _BagRow extends StatelessWidget {
  const _BagRow({
    required this.bag,
    required this.now,
    required this.focused,
    required this.inRoom,
    required this.remoteHost,
    required this.grabbed,
    required this.busy,
    required this.onTap,
  });
  final CoinBag bag;
  final DateTime now;
  final bool focused;
  final bool inRoom;

  /// I host a live, so a bag elsewhere is grabbed from here.
  final bool remoteHost;
  final int? grabbed;
  final bool busy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final phase = bag.phaseAt(now);
    final left = bag.remainingAt(now);
    final where = inRoom
        ? 'In this live'
        : "${bag.host?.displayName ?? 'Another'}'s live";
    final when = switch (phase) {
      CoinBagPhase.countdown => 'opens in ${_clock(left)}',
      CoinBagPhase.open => 'ends in ${_clock(left)}',
      CoinBagPhase.closed => 'ended',
    };
    final Widget action;
    if (grabbed != null) {
      action = Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: BBColors.success,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Text(
          '+${Fmt.diamonds(grabbed!)}',
          style: const TextStyle(
            color: BBColors.onAccent,
            fontWeight: FontWeight.w800,
          ),
        ),
      );
    } else {
      final go = !inRoom && !remoteHost;
      final enabled = !busy && (go || phase == CoinBagPhase.open);
      action = FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: go ? BBColors.goldDeep : BBColors.king,
          foregroundColor: BBColors.onAccent,
          disabledBackgroundColor: BBColors.scrim,
          disabledForegroundColor: BBColors.champagne,
          minimumSize: const Size(72, 36),
          padding: const EdgeInsets.symmetric(horizontal: 14),
          shape: const StadiumBorder(),
        ),
        onPressed: enabled ? onTap : null,
        child: busy
            ? const SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: BBColors.onAccent,
                ),
              )
            : Text(
                go
                    ? 'Go'
                    : phase == CoinBagPhase.countdown
                    ? _clock(left)
                    : 'Grab',
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
      );
    }
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: BBColors.espressoGlow,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: focused ? BBColors.goldLight : BBColors.goldOutline,
          width: focused ? 1.6 : 1,
        ),
      ),
      child: Row(
        children: [
          BBAvatar.user(bag.releaser, size: 40),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  bag.releaser?.displayName ?? 'Someone',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: BBColors.ivory,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '💎 ${Fmt.diamonds(bag.pool)} · ${bag.sharesLeft}/${bag.shareCount} left',
                  style: const TextStyle(
                    color: BBColors.goldLight,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  '$where · $when',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: BBColors.champagne,
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          action,
        ],
      ),
    );
  }
}

// ── Releasing ─────────────────────────────────────────────────────────────────

/// Pick an amount and how many people share it, see the fee and balance, release.
class CoinBagReleaseSheet extends ConsumerStatefulWidget {
  const CoinBagReleaseSheet({super.key, required this.c});
  final LiveRoomController c;

  static Future<void> show(BuildContext context, LiveRoomController c) =>
      showModalBottomSheet<void>(
        context: context,
        useSafeArea: true,
        isScrollControlled: true,
        builder: (_) => CoinBagReleaseSheet(c: c),
      );

  @override
  ConsumerState<CoinBagReleaseSheet> createState() =>
      _CoinBagReleaseSheetState();
}

class _CoinBagReleaseSheetState extends ConsumerState<CoinBagReleaseSheet> {
  int? _amount;
  int? _shares;
  bool _sending = false;

  /// One key per intent: a retry after an error reuses it, so a release that went through
  /// is never charged twice. Dropped on success and when the choice changes.
  String? _key;

  Future<void> _release(CoinBagConfig config) async {
    final amount = _amount ?? config.amountOptions.first;
    final shares = _shares ?? config.shareOptions.first;
    if (_sending) return;
    setState(() => _sending = true);
    final key = _key ??= ApiClient.newIdempotencyKey();
    try {
      final r = await ref
          .read(coinBagRepo)
          .release(
            roomId: widget.c.roomId,
            amount: amount,
            shareCount: shares,
            idempotencyKey: key,
          );
      _key = null;
      ref.read(coinBagsProvider.notifier).upsert(r.bag);
      final me = ref.read(sessionProvider).value;
      if (me != null) {
        ref.read(sessionProvider.notifier).replace(me.withDiamonds(r.balance));
      }
      ref.invalidate(coinBagConfigProvider);
      if (!mounted) return;
      Navigator.of(context).pop();
      showMessage(context, 'Coin bag released!');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  void _pick({int? amount, int? shares}) => setState(() {
    _amount = amount ?? _amount;
    _shares = shares ?? _shares;
    _key = null;
  });

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(coinBagConfigProvider).value;
    final balance = ref.watch(sessionProvider).value?.wallet.diamonds ?? 0;
    if (config == null ||
        config.amountOptions.isEmpty ||
        config.shareOptions.isEmpty) {
      return const SizedBox(
        height: 200,
        child: Center(child: CircularProgressIndicator()),
      );
    }
    final amount = _amount ?? config.amountOptions.first;
    final shares = _shares ?? config.shareOptions.first;
    final split = config.breakdown(amount);
    final affordable = balance >= amount;
    final splittable = config.splittable(amount, shares);
    Widget row(String label, String value, {Color? color, bool bold = false}) =>
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(color: BBColors.inkMuted),
                ),
              ),
              Text(
                value,
                style: TextStyle(
                  color: color ?? BBColors.ink,
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w600,
                ),
              ),
            ],
          ),
        );
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const CoinBagGif(36),
                const SizedBox(width: 8),
                Text(
                  'Release a coin bag',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ],
            ),
            const SizedBox(height: 14),
            const Text(
              'Diamonds',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final a in config.amountOptions)
                  ChoiceChip(
                    label: Text('💎 ${Fmt.diamonds(a)}'),
                    selected: a == amount,
                    onSelected: (_) => _pick(amount: a),
                  ),
              ],
            ),
            const SizedBox(height: 14),
            const Text(
              'Shared by',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final n in config.shareOptions)
                  ChoiceChip(
                    label: Text('$n people'),
                    selected: n == shares,
                    onSelected: (_) => _pick(shares: n),
                  ),
              ],
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: BBColors.surfaceMuted,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: BBColors.border),
              ),
              child: Column(
                children: [
                  row('You pay', '💎 ${Fmt.diamonds(amount)}', bold: true),
                  row(
                    'Platform fee (${(config.feeRate * 100).round()}%)',
                    '💎 ${Fmt.diamonds(split.fee)}',
                  ),
                  row('Grabbers share', '💎 ${Fmt.diamonds(split.pool)}'),
                  row(
                    'Your balance',
                    '💎 ${Fmt.diamonds(balance)}',
                    color: affordable ? null : BBColors.danger,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Opens after ${config.countdownSec}s for ${(config.grabWindowSec / 60).round()} min. '
              'Unclaimed shares come back to you when the bag ends. The fee is not refunded.',
              style: const TextStyle(color: BBColors.inkSubtle, fontSize: 12),
            ),
            if (!splittable) ...[
              const SizedBox(height: 6),
              const Text(
                'That amount is too small for so many people.',
                style: TextStyle(color: BBColors.danger, fontSize: 12),
              ),
            ],
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: GoldButton(
                label: affordable ? 'Release' : 'Not enough diamonds',
                loading: _sending,
                onPressed: config.canRelease && affordable && splittable
                    ? () => _release(config)
                    : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── The result ────────────────────────────────────────────────────────────────

/// "+N" from someone's bag, or "Better luck next time" when every share was taken.
class CoinBagResultDialog extends StatefulWidget {
  const CoinBagResultDialog({super.key, required this.bag, this.amount});
  final CoinBag bag;

  /// Null: nothing left.
  final int? amount;

  static Future<void> show(
    BuildContext context, {
    required CoinBag bag,
    required int? amount,
  }) => showDialog<void>(
    context: context,
    builder: (_) => CoinBagResultDialog(bag: bag, amount: amount),
  );

  @override
  State<CoinBagResultDialog> createState() => _CoinBagResultDialogState();
}

class _CoinBagResultDialogState extends State<CoinBagResultDialog>
    with SingleTickerProviderStateMixin {
  late final _pop = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 520),
  )..forward();

  @override
  void dispose() {
    _pop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final won = widget.amount != null;
    final who = widget.bag.releaser?.displayName ?? 'Someone';
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      child: ScaleTransition(
        scale: CurvedAnimation(parent: _pop, curve: Curves.elasticOut),
        child: Container(
          width: 280,
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 18),
          decoration: BoxDecoration(
            gradient: _bagGradient,
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: BBColors.goldLight, width: 1.5),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CoinBagGif(110),
              const SizedBox(height: 6),
              Text(
                won ? 'Congratulations!' : 'Better luck next time',
                style: const TextStyle(
                  color: BBColors.goldLight,
                  fontSize: 20,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                won
                    ? "You grabbed from $who's coin bag"
                    : "Every share of $who's coin bag was taken.",
                textAlign: TextAlign.center,
                style: const TextStyle(color: BBColors.onAccent),
              ),
              if (won) ...[
                const SizedBox(height: 10),
                Text(
                  '+${Fmt.diamonds(widget.amount!)} 💎',
                  style: const TextStyle(
                    color: BBColors.goldLight,
                    fontSize: 32,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ],
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: GoldButton(
                  label: 'OK',
                  height: 44,
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
