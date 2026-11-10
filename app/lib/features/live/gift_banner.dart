import 'dart:async';
import 'dart:collection';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../../core/theme/bb_colors.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

/// Socket event for a gift announced to every live room (`SOCKET.app.giftAnnouncement`).
const giftAnnouncementEvent = 'gift:announcement';

/// A gift sent anywhere on the platform, announced in every live room.
@immutable
class GiftAnnouncement {
  const GiftAnnouncement({
    required this.id,
    required this.sender,
    required this.receiverNames,
    required this.giftName,
    required this.giftIconUrl,
    required this.quantity,
    required this.totalCost,
    this.roomId,
  });

  /// The gift transaction id: a repeat of the same id is dropped.
  final String id;
  final String? roomId;
  final UserBrief sender;
  final List<String> receiverNames;
  final String giftName;
  final String giftIconUrl;
  final int quantity;
  final int totalCost;

  /// "Ann sent Rose ×3 to Bob" (or "to Bob, Cy").
  String get text {
    final to = receiverNames.isEmpty ? '' : ' to ${receiverNames.join(', ')}';
    return '${sender.displayName} sent $giftName ×$quantity$to';
  }

  /// Null for a payload that isn't a usable announcement (no id or sender).
  static GiftAnnouncement? tryParse(Json j) {
    final sender = j.objOrNull('sender');
    final gift = j.objOrNull('gift');
    final id = j.str('id');
    if (id.isEmpty || sender == null || gift == null) return null;
    return GiftAnnouncement(
      id: id,
      roomId: j.strOrNull('roomId'),
      sender: UserBrief.fromJson(sender),
      receiverNames: j.list('receivers', (r) => r.str('displayName', 'User')),
      giftName: gift.str('name', 'a gift'),
      giftIconUrl: gift.str('iconUrl'),
      quantity: j.integer('quantity', 1),
      totalCost: j.integer('totalCost'),
    );
  }
}

/// Shows announcements one at a time: each for [display], then a [gap] before the next.
/// Repeats (by id) are dropped, and a burst keeps only the newest [capacity] waiting, so a
/// busy platform can never back the queue up for minutes.
class GiftBannerQueue extends ChangeNotifier {
  GiftBannerQueue({
    this.capacity = 20,
    this.display = const Duration(seconds: 6),
    this.gap = const Duration(milliseconds: 600),
  });

  final int capacity;
  final Duration display;
  final Duration gap;

  /// What is on screen now, if anything.
  GiftAnnouncement? get current => _current;
  GiftAnnouncement? _current;

  /// Waiting to be shown, oldest first.
  int get waiting => _pending.length;

  final _pending = Queue<GiftAnnouncement>();
  // Ids seen recently (shown, waiting or dropped), so a redelivery is never shown twice.
  final _seen = <String>{};
  static const _seenCap = 500;
  Timer? _timer;
  bool _disposed = false;

  void add(GiftAnnouncement a) {
    if (_disposed || !_seen.add(a.id)) return;
    if (_seen.length > _seenCap) _seen.remove(_seen.first);
    _pending.addLast(a);
    while (_pending.length > capacity) {
      _pending.removeFirst();
    }
    _next();
  }

  void _next() {
    if (_disposed || _current != null || _timer != null || _pending.isEmpty) {
      return;
    }
    _current = _pending.removeFirst();
    notifyListeners();
    _timer = Timer(display, () {
      _current = null;
      notifyListeners();
      _timer = Timer(gap, () {
        _timer = null;
        _next();
      });
    });
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

/// The gift banners at the top of a live room, fed by [announcements].
class GiftBannerOverlay extends StatefulWidget {
  const GiftBannerOverlay({
    super.key,
    required this.announcements,
    this.top = 0,
  });
  final Stream<GiftAnnouncement> announcements;

  /// Distance from the top of the screen.
  final double top;

  @override
  State<GiftBannerOverlay> createState() => _GiftBannerOverlayState();
}

class _GiftBannerOverlayState extends State<GiftBannerOverlay> {
  final _queue = GiftBannerQueue();
  StreamSubscription<GiftAnnouncement>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = widget.announcements.listen(_queue.add);
  }

  @override
  void didUpdateWidget(GiftBannerOverlay old) {
    super.didUpdateWidget(old);
    if (old.announcements != widget.announcements) {
      unawaited(_sub?.cancel());
      _sub = widget.announcements.listen(_queue.add);
    }
  }

  @override
  void dispose() {
    unawaited(_sub?.cancel());
    _queue.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: Padding(
      padding: EdgeInsets.only(top: widget.top),
      child: Align(
        alignment: Alignment.topCenter,
        child: ListenableBuilder(
          listenable: _queue,
          builder: (_, _) => AnimatedSwitcher(
            duration: const Duration(milliseconds: 300),
            transitionBuilder: (child, anim) => FadeTransition(
              opacity: anim,
              child: SlideTransition(
                position: Tween(
                  begin: const Offset(0.3, 0),
                  end: Offset.zero,
                ).animate(anim),
                child: child,
              ),
            ),
            child: switch (_queue.current) {
              null => const SizedBox.shrink(),
              // Keyed by the gift, so back-to-back banners animate as two.
              final a => GiftBanner(key: ValueKey(a.id), announcement: a),
            },
          ),
        ),
      ),
    ),
  );
}

/// One announcement: a burgundy pill with the sender, the text (scrolling once when it is
/// longer than the pill) and the gift's icon.
class GiftBanner extends StatelessWidget {
  const GiftBanner({super.key, required this.announcement});
  final GiftAnnouncement announcement;

  static const height = 36.0;

  /// Share of the screen width.
  static const widthFactor = 0.77;

  @override
  Widget build(BuildContext context) {
    final a = announcement;
    return Semantics(
      liveRegion: true,
      label: a.text,
      excludeSemantics: true,
      child: Container(
        width: MediaQuery.sizeOf(context).width * widthFactor,
        height: height,
        padding: const EdgeInsets.symmetric(horizontal: 5),
        decoration: BoxDecoration(
          gradient: BBColors.giftBannerGradient,
          borderRadius: BorderRadius.circular(height / 2),
          border: Border.all(color: BBColors.goldOutline),
        ),
        child: Row(
          children: [
            BBAvatar.user(a.sender, size: 26, showBadge: false),
            const SizedBox(width: 6),
            Expanded(child: _MarqueeText(a.text)),
            const SizedBox(width: 4),
            SizedBox.square(
              dimension: 28,
              child: a.giftIconUrl.isEmpty
                  ? const Icon(
                      Icons.card_giftcard_rounded,
                      color: BBColors.goldLight,
                      size: 20,
                    )
                  : CachedNetworkImage(
                      imageUrl: a.giftIconUrl,
                      fit: BoxFit.contain,
                      errorWidget: (_, _, _) => const Icon(
                        Icons.card_giftcard_rounded,
                        color: BBColors.goldLight,
                        size: 20,
                      ),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.only(left: 2, right: 4),
              child: Text(
                '×${a.quantity}',
                style: const TextStyle(
                  color: BBColors.goldLight,
                  fontSize: 13,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Text that scrolls from its start to its end once (after a short pause) when it doesn't
/// fit, and sits still when it does.
class _MarqueeText extends StatefulWidget {
  const _MarqueeText(this.text);
  final String text;

  static const style = TextStyle(
    color: BBColors.ivory,
    fontSize: 13,
    fontWeight: FontWeight.w600,
  );

  @override
  State<_MarqueeText> createState() => _MarqueeTextState();
}

class _MarqueeTextState extends State<_MarqueeText>
    with SingleTickerProviderStateMixin {
  late final _anim = AnimationController(vsync: this);
  Timer? _start;
  double _overflow = 0;

  @override
  void dispose() {
    _start?.cancel();
    _anim.dispose();
    super.dispose();
  }

  void _measure(double width) {
    final painter = TextPainter(
      text: TextSpan(text: widget.text, style: _MarqueeText.style),
      maxLines: 1,
      textDirection: Directionality.of(context),
    )..layout();
    final overflow = painter.width - width;
    painter.dispose();
    if (overflow <= 0 || overflow == _overflow) return;
    _overflow = overflow;
    // About 40 px a second, after a pause to read the start.
    _anim.duration = Duration(milliseconds: (overflow / 40 * 1000).round());
    _start?.cancel();
    _start = Timer(const Duration(milliseconds: 800), () {
      if (mounted) unawaited(_anim.forward(from: 0));
    });
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      _measure(box.maxWidth);
      return ClipRect(
        child: AnimatedBuilder(
          animation: _anim,
          builder: (_, child) => Transform.translate(
            offset: Offset(-_overflow * _anim.value, 0),
            child: child,
          ),
          child: OverflowBox(
            alignment: Alignment.centerLeft,
            maxWidth: double.infinity,
            child: Text(
              widget.text,
              maxLines: 1,
              softWrap: false,
              style: _MarqueeText.style,
            ),
          ),
        ),
      );
    },
  );
}
