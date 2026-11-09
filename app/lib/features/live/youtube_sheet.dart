import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/network/api_exception.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';

/// Host, room-admin and staff controls for YouTube music: search (or paste a link) and the
/// "Up next" queue. Opens on Up next when [upNext].
class YouTubeSheet extends StatelessWidget {
  const YouTubeSheet({super.key, required this.c, this.upNext = false});
  final LiveRoomController c;
  final bool upNext;

  static Future<void> show(
    BuildContext context,
    LiveRoomController c, {
    bool upNext = false,
  }) => showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (_) => FractionallySizedBox(
      heightFactor: 0.75,
      child: YouTubeSheet(c: c, upNext: upNext),
    ),
  );

  @override
  Widget build(BuildContext context) => DefaultTabController(
    length: 2,
    initialIndex: upNext ? 1 : 0,
    child: Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.smart_display_rounded, color: BBColors.pkRed),
              const SizedBox(width: 6),
              Text(
                'YouTube music',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ],
          ),
          ListenableBuilder(
            listenable: c,
            builder: (_, _) {
              final n = c.youtube?.count ?? 0;
              return TabBar(
                tabs: [
                  const Tab(text: 'Search'),
                  Tab(text: n == 0 ? 'Up next' : 'Up next ($n)'),
                ],
              );
            },
          ),
          Expanded(
            child: TabBarView(
              children: [
                _SearchTab(c: c),
                _UpNextTab(c: c),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

Future<void> _command(
  BuildContext context,
  LiveRoomController c,
  Map<String, Object?> command, {
  String? done,
}) async {
  final error = await c.youtubeCommand(command);
  if (!context.mounted) return;
  if (error != null) {
    showMessage(context, error);
  } else if (done != null) {
    showMessage(context, done);
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

class _SearchTab extends StatefulWidget {
  const _SearchTab({required this.c});
  final LiveRoomController c;

  @override
  State<_SearchTab> createState() => _SearchTabState();
}

class _SearchTabState extends State<_SearchTab>
    with AutomaticKeepAliveClientMixin {
  final _query = TextEditingController();
  final _focus = FocusNode();
  final List<YtSearchResult> _items = [];
  String? _lastQuery;
  String? _next;
  Object? _failure;
  bool _loading = false;

  /// Video ids with a request in flight, so a double tap sends once.
  final Set<String> _busy = {};

  @override
  bool get wantKeepAlive => true;

  @override
  void dispose() {
    _query.dispose();
    _focus.dispose();
    super.dispose();
  }

  String? get _failureCode =>
      _failure is ApiException ? (_failure! as ApiException).code : null;

  /// Searches on submit only: every search spends YouTube quota.
  Future<void> _search({bool more = false}) async {
    final q = more ? _lastQuery : _query.text.trim();
    if (q == null || q.isEmpty || _loading) return;
    _focus.unfocus();
    setState(() {
      _loading = true;
      _failure = null;
      if (!more) {
        _items.clear();
        _next = null;
      }
    });
    try {
      final page = await widget.c.youtubeSearch(
        q,
        pageToken: more ? _next : null,
      );
      if (!mounted) return;
      setState(() {
        _items.addAll(
          page.items.where((i) => !_items.any((e) => e.videoId == i.videoId)),
        );
        _next = page.nextPageToken;
      });
    } catch (e) {
      if (mounted) setState(() => _failure = e);
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
          _lastQuery = q;
        });
      }
    }
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    if (!mounted) return;
    final text = data?.text?.trim();
    if (text == null || text.isEmpty) {
      showMessage(context, 'Copy a YouTube link first');
      return;
    }
    _query.text = text;
    await _search();
  }

  Future<void> _add(YtSearchResult r, {required bool now}) async {
    if (!_busy.add(r.videoId)) return;
    setState(() {});
    await _command(context, widget.c, {
      'action': now ? 'play' : 'enqueue',
      'videoId': r.videoId,
    }, done: now ? null : 'Added to Up next');
    if (mounted) setState(() => _busy.remove(r.videoId));
  }

  Widget _results() {
    final failure = _failure;
    if (_items.isEmpty && _loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_items.isEmpty && failure != null) {
      final quota = _failureCode == 'youtube_quota';
      final offline = failure is ApiException && failure.isNetwork;
      return EmptyState(
        icon: offline ? Icons.wifi_off_rounded : Icons.error_outline_rounded,
        title: switch (_failureCode) {
          'youtube_quota' => 'YouTube search is busy right now',
          'youtube_unavailable' => "YouTube isn't available right now",
          _ => failure is ApiException ? failure.message : 'Search failed',
        },
        // A spent search quota still lets a pasted link through.
        message: quota ? 'Links copied from YouTube still work.' : null,
        action: OutlinedButton(
          onPressed: quota ? _paste : _search,
          child: Text(quota ? 'Paste link' : 'Try again'),
        ),
      );
    }
    if (_items.isEmpty && _lastQuery != null) {
      return const EmptyState(
        icon: Icons.music_off_rounded,
        title: 'No songs found',
        message: 'Try other words, or paste a link.',
      );
    }
    if (_items.isEmpty) {
      return const EmptyState(
        icon: Icons.smart_display_rounded,
        title: 'Play a song for the room',
        message: 'Everyone in the live hears it in sync.',
      );
    }
    return ListView.builder(
      itemCount: _items.length + (_next != null ? 1 : 0),
      itemBuilder: (_, i) {
        if (i == _items.length) {
          return Padding(
            padding: const EdgeInsets.all(16),
            child: Center(
              child: _loading
                  ? const CircularProgressIndicator()
                  : TextButton(
                      onPressed: () => _search(more: true),
                      child: const Text('More results'),
                    ),
            ),
          );
        }
        final r = _items[i];
        final busy = _busy.contains(r.videoId);
        return _VideoTile(
          videoId: r.videoId,
          title: r.title,
          subtitle: r.playable
              ? '${r.channel} · ${ytDuration(r.durationSec)}'
              : ytRefusalText(r.reason) ?? "Can't play",
          enabled: r.playable,
          trailing: r.playable
              ? Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      tooltip: 'Add to Up next',
                      onPressed: busy ? null : () => _add(r, now: false),
                      icon: const Icon(Icons.playlist_add_rounded),
                    ),
                    IconButton(
                      tooltip: 'Play now',
                      onPressed: busy ? null : () => _add(r, now: true),
                      icon: const Icon(
                        Icons.play_circle_fill_rounded,
                        color: BBColors.pkRed,
                      ),
                    ),
                  ],
                )
              : null,
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: TextField(
            controller: _query,
            focusNode: _focus,
            textInputAction: TextInputAction.search,
            maxLength: 200,
            onSubmitted: (_) => _search(),
            decoration: InputDecoration(
              hintText: 'Search songs or paste a YouTube link',
              counterText: '',
              prefixIcon: const Icon(Icons.search_rounded),
              suffixIcon: IconButton(
                tooltip: 'Paste link',
                onPressed: _paste,
                icon: const Icon(Icons.content_paste_rounded),
              ),
            ),
          ),
        ),
        Expanded(child: _results()),
      ],
    );
  }
}

// ── Up next ──────────────────────────────────────────────────────────────────

class _UpNextTab extends StatefulWidget {
  const _UpNextTab({required this.c});
  final LiveRoomController c;

  @override
  State<_UpNextTab> createState() => _UpNextTabState();
}

class _UpNextTabState extends State<_UpNextTab> {
  /// The slider's position while it is dragged; null otherwise.
  double? _seeking;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // Moves the progress bar along with the server clock.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _seeking == null) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  void _cmd(Map<String, Object?> command) =>
      unawaited(_command(context, widget.c, command));

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.c,
    builder: (context, _) => _content(context),
  );

  Widget _content(BuildContext context) {
    final c = widget.c;
    final cur = c.youtube?.current;
    final queue = c.youtube?.queue ?? const <YtItem>[];
    if (cur == null && queue.isEmpty) {
      return const EmptyState(
        icon: Icons.queue_music_rounded,
        title: 'Nothing queued',
        message: 'Search for a song and add it to Up next.',
      );
    }
    final positionSec = cur == null
        ? 0.0
        : ytPositionMs(cur, c.serverNowMs) / 1000;
    final durationSec = (cur?.durationSec ?? 0).toDouble();
    final max = durationSec <= 0 ? 1.0 : durationSec;
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        if (cur != null) ...[
          _VideoTile(
            videoId: cur.videoId,
            title: cur.title,
            subtitle: 'Added by ${cur.addedBy.displayName}',
            enabled: true,
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Text(
                  ytDuration((_seeking ?? positionSec).round()),
                  style: const TextStyle(fontSize: 11),
                ),
                Expanded(
                  child: Slider(
                    max: max,
                    value: (_seeking ?? positionSec).clamp(0, max).toDouble(),
                    onChanged: (v) => setState(() => _seeking = v),
                    onChangeEnd: (v) {
                      setState(() => _seeking = null);
                      _cmd({
                        'action': 'seek',
                        'positionMs': (v * 1000).round(),
                      });
                    },
                  ),
                ),
                Text(
                  ytDuration(cur.durationSec),
                  style: const TextStyle(fontSize: 11),
                ),
              ],
            ),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                tooltip: 'Stop',
                onPressed: () => _cmd({'action': 'stop'}),
                icon: const Icon(Icons.stop_rounded),
              ),
              const SizedBox(width: 16),
              IconButton.filled(
                tooltip: cur.playing ? 'Pause' : 'Play',
                onPressed: () =>
                    _cmd({'action': cur.playing ? 'pause' : 'resume'}),
                icon: Icon(
                  cur.playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
                ),
              ),
              const SizedBox(width: 16),
              IconButton(
                tooltip: 'Next',
                onPressed: () => _cmd({'action': 'next', 'fromQid': cur.qid}),
                icon: const Icon(Icons.skip_next_rounded),
              ),
            ],
          ),
          const Divider(),
        ] else if (queue.isNotEmpty)
          Padding(
            padding: const EdgeInsets.all(16),
            child: GoldButton(
              label: 'Play Up next',
              onPressed: () => _cmd({'action': 'next', 'fromQid': null}),
            ),
          ),
        if (queue.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 4, 0),
            child: Row(
              children: [
                Text('Up next', style: Theme.of(context).textTheme.titleSmall),
                const Spacer(),
                TextButton(
                  onPressed: () => _cmd({'action': 'clearQueue'}),
                  child: const Text('Clear'),
                ),
              ],
            ),
          ),
        ReorderableListView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          buildDefaultDragHandles: false,
          itemCount: queue.length,
          onReorderItem: (from, to) =>
              _cmd({'action': 'move', 'qid': queue[from].qid, 'toIndex': to}),
          itemBuilder: (_, i) {
            final item = queue[i];
            return Dismissible(
              key: ValueKey(item.qid),
              direction: DismissDirection.endToStart,
              background: Container(
                alignment: Alignment.centerRight,
                padding: const EdgeInsets.only(right: 24),
                color: BBColors.danger,
                child: const Icon(
                  Icons.delete_outline_rounded,
                  color: BBColors.onAccent,
                ),
              ),
              onDismissed: (_) => _cmd({'action': 'remove', 'qid': item.qid}),
              child: _VideoTile(
                videoId: item.videoId,
                title: item.title,
                subtitle:
                    '${ytDuration(item.durationSec)} · ${item.addedBy.displayName}',
                enabled: true,
                onTap: () => _cmd({'action': 'playQueued', 'qid': item.qid}),
                trailing: ReorderableDragStartListener(
                  index: i,
                  child: const Padding(
                    padding: EdgeInsets.all(8),
                    child: Icon(Icons.drag_indicator_rounded),
                  ),
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}

class _VideoTile extends StatelessWidget {
  const _VideoTile({
    required this.videoId,
    required this.title,
    required this.subtitle,
    required this.enabled,
    this.trailing,
    this.onTap,
  });

  final String videoId;
  final String title;
  final String subtitle;
  final bool enabled;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => ListTile(
    enabled: enabled,
    onTap: onTap,
    contentPadding: const EdgeInsets.symmetric(horizontal: 16),
    leading: ClipRRect(
      borderRadius: const BorderRadius.all(Radius.circular(8)),
      child: Opacity(
        opacity: enabled ? 1 : 0.4,
        child: CachedNetworkImage(
          imageUrl: ytThumb(videoId),
          width: 80,
          height: 45,
          fit: BoxFit.cover,
          errorWidget: (_, _, _) => const SizedBox(
            width: 80,
            height: 45,
            child: ColoredBox(color: BBColors.champagne),
          ),
        ),
      ),
    ),
    title: Text(
      title,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 13),
    ),
    subtitle: Text(
      subtitle,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: const TextStyle(fontSize: 11, color: BBColors.inkMuted),
    ),
    trailing: trailing,
  );
}
