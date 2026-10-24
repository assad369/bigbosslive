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
        .listen((_) => _list.refresh());
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
          await _list.refresh();
          ref.invalidate(unreadProvider);
        },
        leading: BBAvatar(
          url: c.peer?.avatarUrl,
          name: c.peer?.displayName ?? '',
          vip: (c.peer?.vipTier ?? 0) > 0,
        ),
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
  });
  final String conversationId;
  final UserBrief? peer;

  @override
  ConsumerState<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends ConsumerState<ConversationScreen> {
  final _messages = <ChatMessage>[];
  final _input = TextEditingController();
  String? _cursor;
  bool _loading = true;
  bool _done = false;
  bool _peerTyping = false;
  Timer? _typingTimer;
  DateTime _lastTypingSent = DateTime(2000);
  final _subs = <StreamSubscription<Map<String, dynamic>>>[];

  String get _me => ref.read(meProvider).id;

  @override
  void initState() {
    super.initState();
    unawaited(_loadMore());
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
          if (m.conversationId != widget.conversationId) return;
          setState(() {
            // Replace our optimistic copy (same client id) or append.
            _messages.removeWhere(
              (x) => x.pending && x.senderId == m.senderId && x.text == m.text,
            );
            if (!_messages.any((x) => x.id == m.id)) _messages.insert(0, m);
            _peerTyping = false;
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
          if (data['conversationId'] != widget.conversationId) return;
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

  Future<void> _loadMore() async {
    if (_done) return;
    try {
      final page = await ref
          .read(socialRepo)
          .messages(widget.conversationId, cursor: _cursor);
      setState(() {
        _messages.addAll(page.items);
        _cursor = page.nextCursor;
        _done = page.nextCursor == null;
      });
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _send({String? text, File? image}) async {
    final peer = widget.peer;
    if (peer == null) return;
    final clientId = const Uuid().v4();
    final optimistic = ChatMessage(
      id: clientId,
      conversationId: widget.conversationId,
      senderId: _me,
      type: image != null ? 'image' : 'text',
      text: text,
      createdAt: DateTime.now(),
      pending: true,
    );
    setState(() => _messages.insert(0, optimistic));
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
      setState(() {
        final i = _messages.indexWhere((m) => m.id == clientId);
        if (i >= 0) _messages[i] = sent;
        _messages.removeWhere(
          (m) => m.id == sent.id && !identical(m, sent) && m.pending,
        );
      });
    } catch (e) {
      setState(() => _messages.removeWhere((m) => m.id == clientId));
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final peer = widget.peer;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: InkWell(
          onTap: peer == null ? null : () => context.push('/user/${peer.id}'),
          child: Row(
            children: [
              BBAvatar(
                url: peer?.avatarUrl,
                name: peer?.displayName ?? '',
                size: 34,
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    peer?.displayName ?? 'Chat',
                    style: const TextStyle(fontSize: 16),
                  ),
                  if (_peerTyping)
                    const Text(
                      'typing…',
                      style: TextStyle(fontSize: 12, color: BBColors.goldDeep),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : NotificationListener<ScrollNotification>(
                    onNotification: (n) {
                      if (n.metrics.extentAfter < 300) unawaited(_loadMore());
                      return false;
                    },
                    child: ListView.builder(
                      reverse: true,
                      padding: const EdgeInsets.all(12),
                      itemCount: _messages.length,
                      itemBuilder: (_, i) => _Bubble(
                        message: _messages[i],
                        mine: _messages[i].senderId == _me,
                      ),
                    ),
                  ),
          ),
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
                    onPressed: () async {
                      final x = await ImagePicker().pickImage(
                        source: ImageSource.gallery,
                        maxWidth: 1600,
                        imageQuality: 85,
                      );
                      if (x != null) unawaited(_send(image: File(x.path)));
                    },
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
                      onSubmitted: (v) {
                        if (v.trim().isEmpty) return;
                        _input.clear();
                        unawaited(_send(text: v.trim()));
                      },
                    ),
                  ),
                  const SizedBox(width: 6),
                  IconButton.filled(
                    style: IconButton.styleFrom(
                      backgroundColor: BBColors.goldDeep,
                    ),
                    onPressed: () {
                      final v = _input.text.trim();
                      if (v.isEmpty) return;
                      _input.clear();
                      unawaited(_send(text: v));
                    },
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
  const _Bubble({required this.message, required this.mine});
  final ChatMessage message;
  final bool mine;

  @override
  Widget build(BuildContext context) => Align(
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
        opacity: message.pending ? 0.6 : 1,
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
                message.text ?? '',
                style: TextStyle(
                  color: mine ? BBColors.ink : BBColors.ink,
                  fontSize: 15,
                ),
              ),
      ),
    ),
  );
}
