import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/models.dart';
import '../network/api_exception.dart';
import '../theme/bb_colors.dart';
import '../utils/format.dart';
import '../utils/json.dart';
import 'frame_view.dart';

/// Gold-gradient call-to-action button.
class GoldButton extends StatelessWidget {
  const GoldButton({
    super.key,
    required this.label,
    this.onPressed,
    this.icon,
    this.loading = false,
    this.height = 52,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool loading;
  final double height;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !loading;
    // One announced button (not an InkWell plus a text node) that says when it is busy.
    return Semantics(
      button: true,
      enabled: enabled,
      label: loading ? '$label, in progress' : label,
      excludeSemantics: true,
      child: Opacity(
        opacity: enabled ? 1 : 0.6,
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: BBColors.goldGradient,
            borderRadius: BorderRadius.circular(16),
            boxShadow: const [
              BoxShadow(
                color: BBColors.goldShadow,
                blurRadius: 14,
                offset: Offset(0, 6),
              ),
            ],
          ),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              borderRadius: BorderRadius.circular(16),
              onTap: enabled ? onPressed : null,
              child: SizedBox(
                height: height,
                child: Center(
                  child: loading
                      ? const SizedBox(
                          width: 22,
                          height: 22,
                          child: CircularProgressIndicator(
                            strokeWidth: 2.4,
                            color: BBColors.ink,
                          ),
                        )
                      : Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (icon != null) ...[
                              Icon(icon, color: BBColors.ink, size: 20),
                              const SizedBox(width: 8),
                            ],
                            Text(
                              label,
                              style: Theme.of(context).textTheme.labelLarge
                                  ?.copyWith(color: BBColors.ink, fontSize: 16),
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

class GradientText extends StatelessWidget {
  const GradientText(
    this.text, {
    super.key,
    this.style,
    this.gradient = BBColors.goldGradient,
  });
  final String text;
  final TextStyle? style;
  final Gradient gradient;

  @override
  Widget build(BuildContext context) => ShaderMask(
    blendMode: BlendMode.srcIn,
    shaderCallback: (bounds) =>
        gradient.createShader(Offset.zero & bounds.size),
    child: Text(text, style: style),
  );
}

/// Round avatar with the user's cosmetic frame (image, SVGA or Lottie) and, when they have
/// no frame, a ring in their VIP tier's colours. Prefer [BBAvatar.user] so no call site can
/// forget the frame or tier.
class BBAvatar extends StatelessWidget {
  const BBAvatar({
    super.key,
    this.url,
    this.name = '',
    this.size = 44,
    this.frameUrl,
    this.frameFormat,
    this.vipTier = 0,
    this.live = false,
    this.ring = false,
  });

  BBAvatar.user(
    UserBrief? user, {
    Key? key,
    double size = 44,
    bool live = false,
    bool ring = false,
    String fallbackName = '',
  }) : this(
         key: key,
         url: user?.avatarUrl,
         name: user?.displayName ?? fallbackName,
         size: size,
         frameUrl: user?.frameUrl,
         frameFormat: user?.frameFormat,
         vipTier: user?.vipTier ?? 0,
         live: live,
         ring: ring,
       );

  final String? url;
  final String name;
  final double size;
  final String? frameUrl;
  final String? frameFormat;

  /// 0 none, 1 VIP, 2 VVIP, 3 King.
  final int vipTier;
  final bool live;

  /// Force a gold ring even without a tier (e.g. the host's seat).
  final bool ring;

  /// How far a frame reaches past the avatar on each side, as a fraction of [size].
  static const frameOverhang = 0.18;

  @override
  Widget build(BuildContext context) {
    final initial = name.isNotEmpty ? name.characters.first.toUpperCase() : '?';
    final hasFrame = frameUrl != null && frameUrl!.isNotEmpty;
    final Gradient? ringGradient = hasFrame
        ? null
        : BBColors.tierGradient(vipTier) ??
              (live || ring ? BBColors.goldGradient : null);
    final avatar = Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(ringGradient != null ? (size >= 56 ? 3 : 2) : 0),
      decoration: BoxDecoration(shape: BoxShape.circle, gradient: ringGradient),
      child: ClipOval(
        child: url == null || url!.isEmpty
            ? Container(
                color: BBColors.champagne,
                alignment: Alignment.center,
                child: Text(
                  initial,
                  style: TextStyle(
                    color: BBColors.bronzeDeep,
                    fontWeight: FontWeight.w700,
                    fontSize: size * 0.4,
                  ),
                ),
              )
            : CachedNetworkImage(
                imageUrl: url!,
                fit: BoxFit.cover,
                placeholder: (_, _) =>
                    const ColoredBox(color: BBColors.champagne),
                errorWidget: (_, _, _) =>
                    const ColoredBox(color: BBColors.champagne),
              ),
      ),
    );
    if (!hasFrame && !live) return avatar;
    final overhang = size * frameOverhang;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          avatar,
          if (hasFrame)
            Positioned(
              left: -overhang,
              top: -overhang,
              child: FrameView(
                url: frameUrl!,
                format: frameFormat,
                size: size + overhang * 2,
              ),
            ),
          if (live)
            Positioned(
              bottom: -4,
              left: 0,
              right: 0,
              child: Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    color: BBColors.danger,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Text(
                    'LIVE',
                    style: TextStyle(
                      color: BBColors.onAccent,
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Level badge. Tier colour follows the level band so it reads at a glance.
class LevelBadge extends StatelessWidget {
  const LevelBadge(this.level, {super.key, this.dense = false});
  final int level;
  final bool dense;

  static Gradient gradientFor(int level) {
    if (level >= 70) return BBColors.umberGradient;
    if (level >= 40) return BBColors.goldGradient;
    if (level >= 20) return BBColors.silverBadgeGradient;
    if (level >= 1) return BBColors.bronzeGradient;
    return const LinearGradient(
      colors: [BBColors.inkSubtle, BBColors.inkMuted],
    );
  }

  @override
  Widget build(BuildContext context) => Container(
    padding: EdgeInsets.symmetric(
      horizontal: dense ? 5 : 7,
      vertical: dense ? 1 : 2,
    ),
    decoration: BoxDecoration(
      gradient: gradientFor(level),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(
      'Lv $level',
      style: TextStyle(
        color: BBColors.onAccent,
        fontSize: dense ? 9 : 11,
        fontWeight: FontWeight.w800,
      ),
    ),
  );
}

/// VIP / VVIP / King badge in the tier's colours. Draws nothing for tier 0.
class VipBadge extends StatelessWidget {
  const VipBadge(this.tier, {super.key, this.dense = false});
  final int tier;
  final bool dense;

  static String? labelFor(int tier) => switch (tier) {
    1 => 'VIP',
    2 => 'VVIP',
    >= 3 => 'King',
    _ => null,
  };

  @override
  Widget build(BuildContext context) {
    final label = labelFor(tier);
    if (label == null) return const SizedBox.shrink();
    final king = tier >= 3;
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: dense ? 4 : 6,
        vertical: dense ? 1 : 2,
      ),
      decoration: BoxDecoration(
        gradient: BBColors.tierGradient(tier),
        borderRadius: BorderRadius.circular(8),
        border: king ? Border.all(color: BBColors.goldLight, width: 0.8) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            king ? Icons.emoji_events : Icons.workspace_premium,
            size: dense ? 10 : 12,
            color: BBColors.onAccent,
          ),
          const SizedBox(width: 2),
          Text(
            label,
            style: TextStyle(
              color: BBColors.onAccent,
              fontSize: dense ? 9 : 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.3,
            ),
          ),
        ],
      ),
    );
  }
}

/// The smallest tier marker, for tight spots under small avatars and in name plates.
class VipTag extends StatelessWidget {
  const VipTag(this.tier, {super.key});
  final int tier;

  @override
  Widget build(BuildContext context) {
    final label = VipBadge.labelFor(tier);
    if (label == null) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      decoration: BoxDecoration(
        gradient: BBColors.tierGradient(tier),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: BBColors.goldLight, width: 0.6),
      ),
      child: Text(
        label,
        // The smallest size that stays readable; it is shown under small avatars.
        style: const TextStyle(
          color: BBColors.onAccent,
          fontSize: 8,
          fontWeight: FontWeight.w800,
          height: 1.25,
        ),
      ),
    );
  }
}

class DiamondAmount extends StatelessWidget {
  const DiamondAmount(
    this.amount, {
    super.key,
    this.beans = false,
    this.style,
    this.compact = false,
  });
  final int amount;
  final bool beans;
  final TextStyle? style;
  final bool compact;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(
        beans ? '🫘' : '💎',
        style: TextStyle(fontSize: (style?.fontSize ?? 14) * 0.95),
      ),
      const SizedBox(width: 4),
      Text(
        compact ? Fmt.compact(amount) : Fmt.full(amount),
        style: (style ?? const TextStyle()).copyWith(
          fontWeight: FontWeight.w700,
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
    ],
  );
}

/// A list row showing a user with level/VIP badges.
class UserTile extends StatelessWidget {
  const UserTile({
    super.key,
    required this.user,
    this.trailing,
    this.onTap,
    this.subtitle,
  });
  final UserBrief user;
  final Widget? trailing;
  final VoidCallback? onTap;
  final String? subtitle;

  @override
  Widget build(BuildContext context) => ListTile(
    onTap: onTap,
    leading: BBAvatar.user(user),
    title: Row(
      children: [
        Flexible(
          child: Text(
            user.displayName,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
        ),
        const SizedBox(width: 6),
        LevelBadge(user.level, dense: true),
        const SizedBox(width: 4),
        VipBadge(user.vipTier),
      ],
    ),
    subtitle: Text(
      subtitle ?? 'ID ${user.shortId}',
      style: const TextStyle(color: BBColors.inkSubtle),
    ),
    trailing: trailing,
  );
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.action,
  });
  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 72,
            height: 72,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: BBColors.champagne,
            ),
            child: Icon(icon, size: 34, color: BBColors.bronze),
          ),
          const SizedBox(height: 16),
          Text(
            title,
            style: Theme.of(context).textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          if (message != null) ...[
            const SizedBox(height: 6),
            Text(
              message!,
              style: const TextStyle(color: BBColors.inkMuted),
              textAlign: TextAlign.center,
            ),
          ],
          if (action != null) ...[const SizedBox(height: 16), action!],
        ],
      ),
    ),
  );
}

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.error, this.onRetry});
  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => EmptyState(
    icon: error is ApiException && (error as ApiException).isNetwork
        ? Icons.wifi_off_rounded
        : Icons.error_outline_rounded,
    title: 'Something went wrong',
    message: error.toString(),
    action: onRetry == null
        ? null
        : OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
  );
}

/// Renders an [AsyncValue] with shared loading / error states.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({
    super.key,
    required this.value,
    required this.data,
    this.onRetry,
  });
  final AsyncValue<T> value;
  final Widget Function(T data) data;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => value.when(
    data: data,
    loading: () => const Center(child: CircularProgressIndicator()),
    error: (e, _) => ErrorView(error: e, onRetry: onRetry),
  );
}

void showError(BuildContext context, Object error) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(error.toString())));
}

void showMessage(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

/// Infinite list over a cursor-paged endpoint, with pull-to-refresh.
class PagedList<T> extends StatefulWidget {
  const PagedList({
    super.key,
    required this.load,
    required this.itemBuilder,
    this.empty,
    this.padding,
    this.separator = false,
    this.reverse = false,
    this.controller,
    this.header,
  });

  final Future<Paged<T>> Function(String? cursor) load;

  /// Scrolls with the rows (e.g. the post above its comments), in every state.
  final Widget? header;
  final Widget Function(BuildContext, T) itemBuilder;
  final Widget? empty;
  final EdgeInsets? padding;
  final bool separator;
  final bool reverse;
  final PagedListController<T>? controller;

  @override
  State<PagedList<T>> createState() => _PagedListState<T>();
}

class PagedListController<T> {
  _PagedListState<T>? _state;

  /// Reload from the first page. With [keepItems] the current rows stay on screen until the
  /// new page lands (and a failure leaves them in place), for background refreshes.
  Future<void> refresh({bool keepItems = false}) async =>
      _state?._refresh(keepItems: keepItems, quiet: keepItems);
  void prepend(T item) => _state?._prepend(item);
  void replaceWhere(bool Function(T) test, T Function(T) update) =>
      _state?._replaceWhere(test, update);
  void removeWhere(bool Function(T) test) => _state?._removeWhere(test);
  List<T> get items => _state?._items ?? const [];
}

class _PagedListState<T> extends State<PagedList<T>> {
  final _items = <T>[];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  Object? _error;

  /// Bumped by every refresh. A page requested under an older generation is dropped when it
  /// arrives, so a refresh during an in-flight load can't append a stale page.
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    widget.controller?._state = this;
    _more();
  }

  @override
  void didUpdateWidget(PagedList<T> old) {
    super.didUpdateWidget(old);
    if (!identical(old.controller, widget.controller)) {
      if (identical(old.controller?._state, this)) {
        old.controller?._state = null;
      }
      widget.controller?._state = this;
    }
  }

  @override
  void dispose() {
    if (identical(widget.controller?._state, this)) {
      widget.controller?._state = null;
    }
    super.dispose();
  }

  void _prepend(T item) => setState(() => _items.insert(0, item));
  void _replaceWhere(bool Function(T) test, T Function(T) update) =>
      setState(() {
        for (var i = 0; i < _items.length; i++) {
          if (test(_items[i])) _items[i] = update(_items[i]);
        }
      });
  void _removeWhere(bool Function(T) test) =>
      setState(() => _items.removeWhere(test));

  Future<void> _refresh({required bool keepItems, bool quiet = false}) {
    if (!mounted) return Future.value();
    _generation++;
    setState(() {
      // Kept rows keep their cursor too, so a failed refresh can still page on from them.
      if (!keepItems) {
        _items.clear();
        _cursor = null;
        _done = false;
      }
      _error = null;
      _loading = false;
    });
    return _fetch(replace: true, quiet: quiet);
  }

  /// Next page. While a page error is showing, only the retry button loads again; scrolling
  /// doesn't hammer a failing endpoint.
  Future<void> _more({bool retry = false}) async {
    if (!mounted || _loading || _done) return;
    if (_error != null && !retry) return;
    await _fetch(replace: false);
  }

  Future<void> _fetch({required bool replace, bool quiet = false}) async {
    final generation = _generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.load(replace ? null : _cursor);
      if (!mounted || generation != _generation) return;
      setState(() {
        if (replace) _items.clear();
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _done = page.nextCursor == null;
      });
    } catch (e) {
      if (!mounted || generation != _generation) return;
      if (replace && _items.isNotEmpty) {
        // A refresh over rows already on screen: keep them, they are still useful.
        if (!quiet) showError(context, e);
      } else {
        setState(() => _error = e);
      }
    } finally {
      if (mounted && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final header = widget.header;
    if (_items.isEmpty && (_error != null || _loading || _done)) {
      final Widget state;
      if (_error != null) {
        state = ErrorView(
          error: _error!,
          onRetry: () => _refresh(keepItems: false),
        );
      } else if (_loading) {
        state = const Padding(
          padding: EdgeInsets.all(32),
          child: Center(child: CircularProgressIndicator()),
        );
      } else {
        state = Padding(
          padding: const EdgeInsets.only(top: 80),
          child: widget.empty ?? const SizedBox(),
        );
      }
      if (header == null && _error != null) return state;
      if (header == null && _loading) {
        return const Center(child: CircularProgressIndicator());
      }
      return RefreshIndicator(
        onRefresh: () => _refresh(keepItems: true),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: widget.padding,
          children: [?header, state],
        ),
      );
    }
    final lead = header == null ? 0 : 1;
    return RefreshIndicator(
      onRefresh: () => _refresh(keepItems: true),
      child: NotificationListener<ScrollNotification>(
        onNotification: (n) {
          if (n.metrics.extentAfter < 400) _more();
          return false;
        },
        child: ListView.separated(
          reverse: widget.reverse,
          padding: widget.padding,
          itemCount: lead + _items.length + (_done ? 0 : 1),
          separatorBuilder: (_, i) => widget.separator && i >= lead
              ? const Divider(indent: 72)
              : const SizedBox.shrink(),
          itemBuilder: (context, index) {
            if (index < lead) return header!;
            final i = index - lead;
            if (i >= _items.length) {
              // The footer is only built once the user is near the end — or when the first
              // page is too short to scroll at all — so this is where the next page loads.
              if (!_loading && _error == null) {
                WidgetsBinding.instance.addPostFrameCallback((_) => _more());
              }
              if (_error != null) {
                return TextButton(
                  onPressed: () => _more(retry: true),
                  child: const Text('Couldn\'t load more — tap to retry'),
                );
              }
              return const Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
              );
            }
            return widget.itemBuilder(context, _items[i]);
          },
        ),
      ),
    );
  }
}

extension JsonWidgets on Json {
  UserBrief? brief(String key) {
    final o = objOrNull(key);
    return o == null ? null : UserBrief.fromJson(o);
  }
}
