import 'dart:async';
import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';

class InboxScreen extends ConsumerStatefulWidget {
  const InboxScreen({super.key});
  @override
  ConsumerState<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends ConsumerState<InboxScreen> {
  final _list = PagedListController<Conversation>();
  StreamSubscription<Map<String, dynamic>>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = ref
        .read(socketProvider)
        .on('chat:message')
        // Keep the rows on screen; only the order and previews change.
        .listen((_) => _list.refresh(keepItems: true));
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Messages'),
      actions: [
        IconButton(
          tooltip: 'Notifications',
          onPressed: () => context.push('/notifications'),
          icon: const Icon(Icons.notifications_none_rounded),
        ),
      ],
    ),
    body: PagedList<Conversation>(
      controller: _list,
      separator: true,
      load: (cursor) => ref.read(socialRepo).conversations(cursor: cursor),
      empty: const EmptyState(
        icon: Icons.forum_outlined,
        title: 'No conversations yet',
        message: 'Say hi from someone\'s profile.',
      ),
      itemBuilder: (context, c) => ListTile(
        onTap: () async {
          await context.push('/chat/${c.id}', extra: c.peer);
          await _list.refresh(keepItems: true);
          ref.invalidate(unreadProvider);
        },
        leading: BBAvatar.user(c.peer),
        title: Text(
          c.peer?.displayName ?? 'User',
          style: TextStyle(
            fontWeight: c.unread > 0 ? FontWeight.w800 : FontWeight.w600,
          ),
        ),
        subtitle: Text(
          c.lastText ?? '',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: c.unread > 0 ? BBColors.ink : BBColors.inkMuted,
          ),
        ),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              Fmt.ago(c.lastAt),
              style: const TextStyle(color: BBColors.inkSubtle, fontSize: 11),
            ),
            if (c.unread > 0) ...[
              const SizedBox(height: 4),
              Badge(
                label: Text('${c.unread}'),
                backgroundColor: BBColors.goldDeep,
              ),
            ],
          ],
        ),
      ),
    ),
  );
}

class ConversationScreen extends ConsumerStatefulWidget {
  const ConversationScreen({
    super.key,
    required this.conversationId,
    this.peer,
    this.peerId,
  });
  final String conversationId;

  /// Who we're talking to. Deep links (push taps) carry only [peerId], and the profile is
  /// loaded here.
  final UserBrief? peer;
  final String? peerId;

  @override
  ConsumerState<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends ConsumerState<ConversationScreen> {
  final _messages = <ChatMessage>[];
  final _input = TextEditingController();
  late UserBrief? _peer = widget.peer;
  bool _peerLoading = false;
  String? _cursor;
  bool _loading = true;
  bool _loadingMore = false;
  bool _done = false;
  Object? _error;
  bool _peerTyping = false;
  Timer? _typingTimer;
  DateTime _lastTypingSent = DateTime(2000);
  final _subs = <StreamSubscription<Map<String, dynamic>>>[];

  /// What a failed optimistic message was, so a retry resends it with the same client id
  /// (the server dedupes on it).
  final _outbox = <String, ({String? text, File? image})>{};

  String get _me => ref.read(meProvider).id;

  @override
  void initState() {
    super.initState();
    unawaited(_loadMore());
    unawaited(_loadPeer());
    unawaited(
      ref
          .read(socialRepo)
          .markRead(widget.conversationId)
          .catchError((Object _) {}),
    );
    final socket = ref.read(socketProvider);
    _subs
      ..add(
        socket.on('chat:message').listen((data) {
          final m = ChatMessage.fromJson(data);
          if (!mounted || m.conversationId != widget.conversationId) return;
          // Our own message echoes back on the socket, usually before the HTTP response.
          // While an optimistic copy is in flight, the response replaces it instead.
          final ownInFlight =
              m.senderId == _me &&
              _messages.any(
                (x) =>
                    x.pending &&
                    !x.failed &&
                    x.type == m.type &&
                    x.text == m.text,
              );
          if (ownInFlight) return;
          setState(() {
            if (!_messages.any((x) => x.id == m.id)) _messages.insert(0, m);
            if (m.senderId != _me) _peerTyping = false;
          });
          if (m.senderId != _me) {
            unawaited(
              ref
                  .read(socialRepo)
                  .markRead(widget.conversationId)
                  .catchError((Object _) {}),
            );
          }
        }),
      )
      ..add(
        socket.on('chat:typing').listen((data) {
          if (!mounted || data['conversationId'] != widget.conversationId) {
            return;
          }
          setState(() => _peerTyping = true);
          _typingTimer?.cancel();
          _typingTimer = Timer(
            const Duration(seconds: 4),
            () => mounted ? setState(() => _peerTyping = false) : null,
          );
        }),
      );
  }

  @override
  void dispose() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    _typingTimer?.cancel();
    _input.dispose();
    super.dispose();
  }

  Future<void> _loadPeer() async {
    final id = widget.peerId;
    if (_peer != null || id == null) return;
    setState(() => _peerLoading = true);
    try {
      final user = await ref.read(accountRepo).user(id);
      if (mounted) setState(() => _peer = user.brief);
    } catch (_) {
      /* the header shows "Chat"; sending explains it can't */
    } finally {
      if (mounted) setState(() => _peerLoading = false);
    }
  }

  Future<void> _loadMore({bool retry = false}) async {
    if (_done || _loadingMore || (_error != null && !retry)) return;
    _loadingMore = true;
    if (retry) setState(() => _error = null);
    try {
      final page = await ref
          .read(socialRepo)
          .messages(widget.conversationId, cursor: _cursor);
      if (!mounted) return;
      setState(() {
        final seen = {for (final m in _messages) m.id};
        _messages.addAll(page.items.where((m) => !seen.contains(m.id)));
        _cursor = page.nextCursor;
        _done = page.nextCursor == null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      _loadingMore = false;
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _send({String? text, File? image, String? retryId}) async {
    final peer = _peer;
    if (peer == null) {
      showMessage(
        context,
        _peerLoading
            ? 'One moment, loading the conversation…'
            : 'You can\'t reply in this conversation',
      );
      return;
    }
    final clientId = retryId ?? const Uuid().v4();
    _outbox[clientId] = (text: text, image: image);
    final optimistic = ChatMessage(
      id: clientId,
      conversationId: widget.conversationId,
      senderId: _me,
      type: image != null ? 'image' : 'text',
      text: text,
      createdAt: DateTime.now(),
      pending: true,
    );
    setState(() {
      final i = _messages.indexWhere((m) => m.id == clientId);
      if (i >= 0) {
        _messages[i] = optimistic;
      } else {
        _messages.insert(0, optimistic);
      }
    });
    try {
      String? mediaUrl;
      if (image != null) {
        mediaUrl = await ref.read(contentRepo).upload('chat', image);
      }
      final sent = await ref
          .read(socialRepo)
          .send(
            to: peer.id,
            text: text,
            mediaUrl: mediaUrl,
            clientId: clientId,
          );
      _outbox.remove(clientId);
      if (!mounted) return;
      setState(() {
        // The socket echo may already have added the confirmed copy.
        _messages.removeWhere((m) => m.id == sent.id);
        final i = _messages.indexWhere((m) => m.id == clientId);
        if (i >= 0) {
          _messages[i] = sent;
        } else {
          _messages.insert(0, sent);
        }
      });
    } catch (e) {
      if (!mounted) return;
      // Keep what the user wrote; the bubble offers a retry.
      setState(() {
        final i = _messages.indexWhere((m) => m.id == clientId);
        if (i >= 0) _messages[i] = _messages[i].asFailed(failed: true);
      });
      showError(context, e);
    }
  }

  void _retry(ChatMessage m) {
    final draft = _outbox[m.id];
    if (draft == null) return;
    unawaited(_send(text: draft.text, image: draft.image, retryId: m.id));
  }

  void _discard(ChatMessage m) {
    _outbox.remove(m.id);
    setState(() => _messages.removeWhere((x) => x.id == m.id));
  }

  Future<void> _pickImage() async {
    try {
      final x = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        maxWidth: 1600,
        imageQuality: 85,
      );
      if (x != null && mounted) unawaited(_send(image: File(x.path)));
    } catch (e) {
      if (mounted) showError(context, 'Couldn\'t open your photos');
    }
  }

  void _submit() {
    final v = _input.text.trim();
    if (v.isEmpty) return;
    _input.clear();
    unawaited(_send(text: v));
  }

  Widget _body() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_messages.isEmpty && _error != null) {
      return ErrorView(error: _error!, onRetry: () => _loadMore(retry: true));
    }
    if (_messages.isEmpty) {
      return const EmptyState(
        icon: Icons.waving_hand_outlined,
        title: 'Say hello',
        message: 'Messages you send appear here.',
      );
    }
    return NotificationListener<ScrollNotification>(
      onNotification: (n) {
        if (n.metrics.extentAfter < 300) unawaited(_loadMore());
        return false;
      },
      child: ListView.builder(
        reverse: true,
        padding: const EdgeInsets.all(12),
        itemCount: _messages.length + (_error != null ? 1 : 0),
        itemBuilder: (_, i) {
          if (i >= _messages.length) {
            return TextButton(
              onPressed: () => _loadMore(retry: true),
              child: const Text('Couldn\'t load older messages — tap to retry'),
            );
          }
          final m = _messages[i];
          return _Bubble(
            key: ValueKey(m.id),
            message: m,
            mine: m.senderId == _me,
            onRetry: m.failed ? () => _retry(m) : null,
            onDiscard: m.failed ? () => _discard(m) : null,
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final peer = _peer;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: InkWell(
          onTap: peer == null ? null : () => context.push('/user/${peer.id}'),
          child: Row(
            children: [
              BBAvatar.user(peer, size: 34),
              const SizedBox(width: 10),
              Flexible(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      peer?.displayName ?? 'Chat',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 16),
                    ),
                    if (_peerTyping)
                      const Text(
                        'typing…',
                        style: TextStyle(
                          fontSize: 12,
                          color: BBColors.goldDeep,
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
      body: Column(
        children: [
          Expanded(child: _body()),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
              child: Row(
                children: [
                  IconButton(
                    tooltip: 'Photo',
                    icon: const Icon(
                      Icons.image_outlined,
                      color: BBColors.bronze,
                    ),
                    onPressed: _pickImage,
                  ),
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 4,
                      maxLength: 2000,
                      textInputAction: TextInputAction.send,
                      decoration: const InputDecoration(
                        hintText: 'Message',
                        counterText: '',
                      ),
                      onChanged: (_) {
                        if (DateTime.now()
                                .difference(_lastTypingSent)
                                .inSeconds >=
                            3) {
                          _lastTypingSent = DateTime.now();
                          ref.read(socketProvider).emit('chat:typing', {
                            'conversationId': widget.conversationId,
                          });
                        }
                      },
                      onSubmitted: (_) => _submit(),
                    ),
                  ),
                  const SizedBox(width: 6),
                  IconButton.filled(
                    tooltip: 'Send',
                    style: IconButton.styleFrom(
                      backgroundColor: BBColors.goldDeep,
                    ),
                    onPressed: _submit,
                    icon: const Icon(
                      Icons.send_rounded,
                      color: BBColors.surface,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({
    super.key,
    required this.message,
    required this.mine,
    this.onRetry,
    this.onDiscard,
  });
  final ChatMessage message;
  final bool mine;
  final VoidCallback? onRetry;
  final VoidCallback? onDiscard;

  @override
  Widget build(BuildContext context) {
    final bubble = _bubble(context);
    if (!message.failed) return bubble;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        bubble,
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.error_outline_rounded,
              size: 14,
              color: BBColors.danger,
            ),
            const SizedBox(width: 4),
            const Text(
              'Not sent',
              style: TextStyle(color: BBColors.danger, fontSize: 12),
            ),
            TextButton(onPressed: onRetry, child: const Text('Retry')),
            TextButton(onPressed: onDiscard, child: const Text('Delete')),
          ],
        ),
      ],
    );
  }

  Widget _bubble(BuildContext context) => Align(
    alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
    child: Container(
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width * 0.75,
      ),
      margin: const EdgeInsets.symmetric(vertical: 3),
      padding: message.mediaUrl != null
          ? const EdgeInsets.all(4)
          : const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(
        gradient: mine ? BBColors.goldGradient : null,
        color: mine ? null : BBColors.surface,
        border: mine ? null : Border.all(color: BBColors.border),
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(18),
          topRight: const Radius.circular(18),
          bottomLeft: Radius.circular(mine ? 18 : 4),
          bottomRight: Radius.circular(mine ? 4 : 18),
        ),
      ),
      child: Opacity(
        opacity: message.pending && !message.failed ? 0.6 : 1,
        child: message.mediaUrl != null
            ? ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: CachedNetworkImage(
                  imageUrl: message.mediaUrl!,
                  width: 220,
                  fit: BoxFit.cover,
                ),
              )
            : Text(
                message.type == 'image' && message.text == null
                    ? (message.failed ? '📷 Photo' : '📷 Sending photo…')
                    : message.text ?? '',
                style: const TextStyle(color: BBColors.ink, fontSize: 15),
              ),
      ),
    ),
  );
}
