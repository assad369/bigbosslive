import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/models.dart';
import '../network/api_exception.dart';
import '../theme/bb_colors.dart';
import '../utils/format.dart';
import '../utils/json.dart';

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
    return Opacity(
      opacity: enabled ? 1 : 0.6,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: BBColors.goldGradient,
          borderRadius: BorderRadius.circular(16),
          boxShadow: const [
            BoxShadow(
              color: Color(0x40B8860B),
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

/// Round avatar with an optional cosmetic frame overlay and gold ring for VIPs.
class BBAvatar extends StatelessWidget {
  const BBAvatar({
    super.key,
    this.url,
    this.name = '',
    this.size = 44,
    this.frameUrl,
    this.vip = false,
    this.live = false,
  });

  final String? url;
  final String name;
  final double size;
  final String? frameUrl;
  final bool vip;
  final bool live;

  @override
  Widget build(BuildContext context) {
    final initial = name.isNotEmpty ? name.characters.first.toUpperCase() : '?';
    final avatar = Container(
      width: size,
      height: size,
      padding: EdgeInsets.all(vip || live ? 2 : 0),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: vip || live ? BBColors.goldGradient : null,
      ),
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
    if (frameUrl == null && !live) return avatar;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          avatar,
          if (frameUrl != null && frameUrl!.endsWith('.png'))
            Positioned(
              left: -size * 0.15,
              top: -size * 0.15,
              right: -size * 0.15,
              bottom: -size * 0.15,
              child: CachedNetworkImage(imageUrl: frameUrl!),
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
                      color: Colors.white,
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
    if (level >= 70) {
      return const LinearGradient(
        colors: [Color(0xFF8B5A00), Color(0xFF5C3A00)],
      );
    }
    if (level >= 40) return BBColors.goldGradient;
    if (level >= 20) {
      return const LinearGradient(
        colors: [Color(0xFFBFBFBF), Color(0xFF8E8E8E)],
      );
    }
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
        color: Colors.white,
        fontSize: dense ? 9 : 11,
        fontWeight: FontWeight.w800,
      ),
    ),
  );
}

class VipBadge extends StatelessWidget {
  const VipBadge(this.tier, {super.key});
  final int tier;

  @override
  Widget build(BuildContext context) {
    if (tier <= 0) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: BBColors.ink,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: BBColors.gold),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            Icons.workspace_premium,
            size: 12,
            color: BBColors.goldLight,
          ),
          const SizedBox(width: 2),
          Text(
            'VIP$tier',
            style: const TextStyle(
              color: BBColors.goldLight,
              fontSize: 10,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
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
    leading: BBAvatar(
      url: user.avatarUrl,
      name: user.displayName,
      frameUrl: user.frameUrl,
      vip: user.vipTier > 0,
    ),
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
  });

  final Future<Paged<T>> Function(String? cursor) load;
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
  Future<void> refresh() async => _state?._refresh();
  void prepend(T item) => _state?._prepend(item);
  void replaceWhere(bool Function(T) test, T Function(T) update) =>
      _state?._replaceWhere(test, update);
  List<T> get items => _state?._items ?? const [];
}

class _PagedListState<T> extends State<PagedList<T>> {
  final _items = <T>[];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    widget.controller?._state = this;
    _more();
  }

  void _prepend(T item) => setState(() => _items.insert(0, item));
  void _replaceWhere(bool Function(T) test, T Function(T) update) =>
      setState(() {
        for (var i = 0; i < _items.length; i++) {
          if (test(_items[i])) _items[i] = update(_items[i]);
        }
      });

  Future<void> _refresh() async {
    setState(() {
      _items.clear();
      _cursor = null;
      _done = false;
      _error = null;
    });
    await _more();
  }

  Future<void> _more() async {
    if (!mounted || _loading || _done) return;
    setState(() => _loading = true);
    try {
      final page = await widget.load(_cursor);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _done = page.nextCursor == null;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty && _error != null) {
      return ErrorView(error: _error!, onRetry: _refresh);
    }
    if (_items.isEmpty && _loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_items.isEmpty && _done) {
      return RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          children: [
            const SizedBox(height: 80),
            widget.empty ?? const SizedBox(),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: NotificationListener<ScrollNotification>(
        onNotification: (n) {
          if (n.metrics.extentAfter < 400) _more();
          return false;
        },
        child: ListView.separated(
          reverse: widget.reverse,
          padding: widget.padding,
          itemCount: _items.length + (_done ? 0 : 1),
          separatorBuilder: (_, _) => widget.separator
              ? const Divider(indent: 72)
              : const SizedBox.shrink(),
          itemBuilder: (context, i) {
            if (i >= _items.length) {
              // The footer is only built once the user is near the end — or when the first
              // page is too short to scroll at all — so this is where the next page loads.
              if (!_loading && _error == null) {
                WidgetsBinding.instance.addPostFrameCallback((_) => _more());
              }
              if (_error != null) {
                return TextButton(
                  onPressed: _more,
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
