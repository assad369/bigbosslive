import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/frame_view.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';

final giftsProvider = FutureProvider<List<Gift>>(
  (ref) => ref.watch(economyRepo).gifts(),
);

/// Bottom sheet for sending gifts in a room. Each tap is its own idempotent transaction; a
/// retry of a send that got no answer reuses its key, so it can't be charged twice.
class GiftPanel extends ConsumerStatefulWidget {
  const GiftPanel({super.key, required this.roomId, required this.receivers});
  final String roomId;
  final List<UserBrief> receivers;

  static Future<void> show(
    BuildContext context, {
    required String roomId,
    required List<UserBrief> receivers,
  }) => showModalBottomSheet<void>(
    context: context,
    backgroundColor: BBColors.espresso,
    isScrollControlled: true,
    builder: (_) => GiftPanel(roomId: roomId, receivers: receivers),
  );

  @override
  ConsumerState<GiftPanel> createState() => _GiftPanelState();
}

class _GiftPanelState extends ConsumerState<GiftPanel> {
  Gift? _selected;
  int _qty = 1;
  bool _sending = false;
  late String _receiver = widget.receivers.first.id;

  /// The last send that got no answer (network or timeout). Tapping Send again with the same
  /// gift, quantity and receiver retries *that* send; anything else is a new gift.
  ({String intent, String key})? _unanswered;

  Future<void> _send() async {
    final gift = _selected;
    if (gift == null || _sending) return;
    setState(() => _sending = true);
    final intent = '${gift.id}:$_qty:$_receiver';
    final key = _unanswered?.intent == intent
        ? _unanswered!.key
        : ApiClient.newIdempotencyKey();
    _unanswered = null;
    try {
      final diamonds = await ref
          .read(economyRepo)
          .sendGift(
            giftId: gift.id,
            quantity: _qty,
            receiverIds: [_receiver],
            roomId: widget.roomId,
            idempotencyKey: key,
          );
      final me = ref.read(sessionProvider).value;
      if (me != null) {
        ref.read(sessionProvider.notifier).replace(me.withDiamonds(diamonds));
      }
    } on ApiException catch (e) {
      if (e.isNetwork) _unanswered = (intent: intent, key: key);
      if (!mounted) return;
      if (e.insufficientBalance) {
        final go = await showDialog<bool>(
          context: context,
          builder: (c) => AlertDialog(
            title: const Text('Not enough diamonds'),
            content: const Text('Recharge to keep the gifts flowing.'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: const Text('Later'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, true),
                child: const Text('Recharge'),
              ),
            ],
          ),
        );
        if ((go ?? false) && mounted) unawaited(context.push('/wallet'));
      } else {
        showError(context, e);
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final gifts = ref.watch(giftsProvider);
    final diamonds = ref.watch(sessionProvider).value?.wallet.diamonds ?? 0;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.5,
        child: Column(
          children: [
            if (widget.receivers.length > 1)
              SizedBox(
                height: 48,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  children: [
                    for (final r in widget.receivers)
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          avatar: BBAvatar.user(r, size: 22),
                          label: Text(r.displayName),
                          selected: _receiver == r.id,
                          onSelected: (_) => setState(() => _receiver = r.id),
                        ),
                      ),
                  ],
                ),
              ),
            Expanded(
              child: gifts.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        e.toString(),
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: BBColors.champagne),
                      ),
                      TextButton(
                        onPressed: () => ref.invalidate(giftsProvider),
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
                data: (items) => GridView.builder(
                  padding: const EdgeInsets.all(12),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 4,
                    mainAxisSpacing: 8,
                    crossAxisSpacing: 8,
                    childAspectRatio: 0.72,
                  ),
                  itemCount: items.length,
                  itemBuilder: (_, i) {
                    final g = items[i];
                    final selected = _selected?.id == g.id;
                    return InkWell(
                      borderRadius: BorderRadius.circular(14),
                      onTap: () => setState(() => _selected = g),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 150),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(14),
                          color: selected
                              ? BBColors.goldTint
                              : Colors.transparent,
                          border: Border.all(
                            color: selected
                                ? BBColors.goldLight
                                : BBColors.champagneTint,
                          ),
                        ),
                        padding: const EdgeInsets.all(6),
                        child: Column(
                          children: [
                            Expanded(
                              child: CachedNetworkImage(
                                imageUrl: g.iconUrl,
                                errorWidget: (_, _, _) => const Icon(
                                  Icons.card_giftcard,
                                  color: BBColors.goldLight,
                                ),
                              ),
                            ),
                            Text(
                              g.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: BBColors.ivory,
                                fontSize: 11,
                              ),
                            ),
                            Text(
                              '💎 ${g.price}',
                              style: const TextStyle(
                                color: BBColors.goldLight,
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: Row(
                children: [
                  InkWell(
                    onTap: () => context.push('/wallet'),
                    child: DiamondAmount(
                      diamonds,
                      style: const TextStyle(
                        color: BBColors.goldLight,
                        fontSize: 15,
                      ),
                    ),
                  ),
                  const Spacer(),
                  DropdownButton<int>(
                    value: _qty,
                    dropdownColor: BBColors.espresso,
                    underline: const SizedBox(),
                    style: const TextStyle(
                      color: BBColors.ivory,
                      fontWeight: FontWeight.w700,
                    ),
                    items: const [1, 10, 66, 99, 188, 520, 999]
                        .map(
                          (q) => DropdownMenuItem(value: q, child: Text('×$q')),
                        )
                        .toList(),
                    onChanged: (q) => setState(() => _qty = q ?? 1),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    width: 110,
                    child: GoldButton(
                      label: 'Send',
                      height: 44,
                      loading: _sending,
                      onPressed: _selected == null ? null : _send,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Queued, full-screen gift celebrations plus a sliding banner.
class GiftOverlay extends StatefulWidget {
  const GiftOverlay({super.key, required this.gifts});
  final Stream<GiftEvent> gifts;

  @override
  State<GiftOverlay> createState() => _GiftOverlayState();
}

class _GiftOverlayState extends State<GiftOverlay> {
  final _queue = <GiftEvent>[];
  GiftEvent? _current;
  StreamSubscription<GiftEvent>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = widget.gifts.listen((g) {
      _enqueue(g);
      if (_current == null) _next();
    });
  }

  /// Each celebration takes seconds, so a busy room would fall minutes behind. A combo of the
  /// same gift from the same sender folds into one, and past [_maxQueued] the oldest waiting
  /// celebration is dropped.
  static const _maxQueued = 8;

  void _enqueue(GiftEvent g) {
    final last = _queue.isEmpty ? null : _queue.last;
    if (last != null &&
        last.gift.id == g.gift.id &&
        last.sender?.id == g.sender?.id) {
      _queue[_queue.length - 1] = GiftEvent(
        id: last.id,
        sender: last.sender,
        gift: last.gift,
        quantity: last.quantity + g.quantity,
        receiverNames: {...last.receiverNames, ...g.receiverNames}.toList(),
      );
      return;
    }
    _queue.add(g);
    if (_queue.length > _maxQueued) _queue.removeAt(0);
  }

  // A gift stays up until its banner beat and its animation (if any) have both finished.
  bool _bannerDone = false;
  bool _effectDone = false;
  int _seq = 0;
  Timer? _beat;

  static bool _animated(Gift gift) =>
      gift.animationUrl != null &&
      MediaFormat.resolve(gift.animationFormat, gift.animationUrl!) !=
          MediaFormat.none;

  void _next() {
    if (!mounted) return;
    _beat?.cancel();
    setState(() {
      _current = _queue.isEmpty ? null : _queue.removeAt(0);
      _seq++;
    });
    final g = _current;
    if (g == null) return;
    _bannerDone = false;
    _effectDone = !_animated(g.gift);
    _beat = Timer(const Duration(milliseconds: 2200), () {
      _bannerDone = true;
      _maybeAdvance();
    });
  }

  void _onEffectDone() {
    _effectDone = true;
    _maybeAdvance();
  }

  void _maybeAdvance() {
    if (_bannerDone && _effectDone) _next();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _beat?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final g = _current;
    return IgnorePointer(
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 300),
        child: g == null
            ? const SizedBox.shrink()
            : Stack(
                key: ValueKey(g.id),
                children: [
                  if (_animated(g.gift))
                    Positioned.fill(
                      child: EffectView(
                        key: ValueKey(_seq),
                        url: g.gift.animationUrl!,
                        format: g.gift.animationFormat,
                        fit: BoxFit.contain,
                        onDone: _onEffectDone,
                      ),
                    )
                  else if (g.gift.price >= 499)
                    Center(
                      child: TweenAnimationBuilder<double>(
                        tween: Tween(begin: 0.3, end: 1),
                        duration: const Duration(milliseconds: 600),
                        curve: Curves.elasticOut,
                        builder: (_, s, child) =>
                            Transform.scale(scale: s, child: child),
                        child: SizedBox(
                          width: 180,
                          height: 180,
                          child: CachedNetworkImage(imageUrl: g.gift.iconUrl),
                        ),
                      ),
                    ),
                  Positioned(
                    left: 12,
                    top: MediaQuery.paddingOf(context).top + 110,
                    child: TweenAnimationBuilder<double>(
                      tween: Tween(begin: -1, end: 0),
                      duration: const Duration(milliseconds: 350),
                      curve: Curves.easeOutCubic,
                      builder: (_, x, child) => FractionalTranslation(
                        translation: Offset(x, 0),
                        child: child,
                      ),
                      child: Container(
                        padding: const EdgeInsets.fromLTRB(4, 4, 14, 4),
                        decoration: BoxDecoration(
                          gradient: BBColors.goldGradient,
                          borderRadius: BorderRadius.circular(30),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            BBAvatar.user(g.sender, size: 32),
                            const SizedBox(width: 8),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    ConstrainedBox(
                                      constraints: const BoxConstraints(
                                        maxWidth: 140,
                                      ),
                                      child: Text(
                                        g.sender?.displayName ?? 'Someone',
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          fontWeight: FontWeight.w800,
                                          color: BBColors.ink,
                                          fontSize: 13,
                                        ),
                                      ),
                                    ),
                                    if ((g.sender?.vipTier ?? 0) > 0) ...[
                                      const SizedBox(width: 4),
                                      VipTag(g.sender!.vipTier),
                                    ],
                                  ],
                                ),
                                Text(
                                  'sent ${g.gift.name}',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    color: BBColors.bronzeDeep,
                                    fontSize: 11,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(width: 8),
                            SizedBox(
                              width: 34,
                              height: 34,
                              child: CachedNetworkImage(
                                imageUrl: g.gift.iconUrl,
                              ),
                            ),
                            Text(
                              ' ×${g.quantity}',
                              style: const TextStyle(
                                fontWeight: FontWeight.w900,
                                color: BBColors.ink,
                                fontSize: 18,
                                fontStyle: FontStyle.italic,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
