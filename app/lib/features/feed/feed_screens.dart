import 'dart:async';
import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/deep_links/deep_link.dart';
import '../../core/deep_links/share_link.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import '../profile/profile_screens.dart';

/// Bumped when the user posts, so the feed tabs pick up the new moment.
final feedRevisionProvider = NotifierProvider<FeedRevision, int>(
  FeedRevision.new,
);

class FeedRevision extends Notifier<int> {
  @override
  int build() => 0;
  void bump() => state++;
}

final _postProvider = FutureProvider.autoDispose.family<FeedPost, String>(
  (ref, id) => ref.watch(socialRepo).post(id),
);

class FeedScreen extends ConsumerWidget {
  const FeedScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => DefaultTabController(
    length: 3,
    child: Scaffold(
      appBar: AppBar(
        title: const Text('Moments'),
        bottom: const TabBar(
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          tabs: [
            Tab(text: 'Trending'),
            Tab(text: 'Latest'),
            Tab(text: 'Following'),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton(
        tooltip: 'New moment',
        backgroundColor: BBColors.gold,
        foregroundColor: BBColors.ink,
        onPressed: () => context.push('/post/new'),
        child: const Icon(Icons.edit_rounded),
      ),
      body: const TabBarView(
        children: [
          _FeedTab('trending'),
          _FeedTab('latest'),
          _FeedTab('following'),
        ],
      ),
    ),
  );
}

class _FeedTab extends ConsumerStatefulWidget {
  const _FeedTab(this.tab);
  final String tab;
  @override
  ConsumerState<_FeedTab> createState() => _FeedTabState();
}

class _FeedTabState extends ConsumerState<_FeedTab>
    with AutomaticKeepAliveClientMixin {
  final _list = PagedListController<FeedPost>();

  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    ref.listen(
      feedRevisionProvider,
      (_, _) => unawaited(_list.refresh(keepItems: true)),
    );
    return PagedList<FeedPost>(
      controller: _list,
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 96),
      load: (cursor) => ref.read(socialRepo).feed(widget.tab, cursor: cursor),
      empty: const EmptyState(
        icon: Icons.auto_awesome_outlined,
        title: 'Nothing here yet',
        message: 'Share a moment to get the room glowing.',
      ),
      itemBuilder: (context, p) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: PostCard(
          post: p,
          onChanged: (next) =>
              _list.replaceWhere((x) => x.id == next.id, (_) => next),
          onDeleted: () => _list.removeWhere((x) => x.id == p.id),
        ),
      ),
    );
  }
}

class PostCard extends ConsumerStatefulWidget {
  const PostCard({
    super.key,
    required this.post,
    required this.onChanged,
    this.onDeleted,
    this.inDetail = false,
  });
  final FeedPost post;
  final ValueChanged<FeedPost> onChanged;
  final VoidCallback? onDeleted;
  final bool inDetail;

  @override
  ConsumerState<PostCard> createState() => _PostCardState();
}

class _PostCardState extends ConsumerState<PostCard> {
  bool _liking = false;

  FeedPost get post => widget.post;

  Future<void> _toggleLike() async {
    // One request at a time: a second tap mid-flight would race and revert the first.
    if (_liking) return;
    _liking = true;
    final before = post;
    final liked = !before.likedByMe;
    widget.onChanged(
      before.copyWith(
        likedByMe: liked,
        likeCount: before.likeCount + (liked ? 1 : -1),
      ),
    );
    try {
      final count = await ref.read(socialRepo).like(before.id, liked);
      widget.onChanged(before.copyWith(likedByMe: liked, likeCount: count));
    } catch (e) {
      widget.onChanged(before);
      if (mounted) showError(context, e);
    } finally {
      _liking = false;
    }
  }

  Future<void> _delete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete this moment?'),
        content: const Text('It will be removed for everyone.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: BBColors.danger),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await ref.read(socialRepo).deletePost(post.id);
      widget.onDeleted?.call();
      if (mounted) showMessage(context, 'Post deleted');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isMine = post.author?.id == ref.watch(meProvider).id;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Semantics(
                  button: post.author != null,
                  label: post.author == null
                      ? null
                      : 'Open ${post.author!.displayName}\'s profile',
                  child: GestureDetector(
                    onTap: post.author == null
                        ? null
                        : () => context.push('/user/${post.author!.id}'),
                    child: BBAvatar.user(post.author, size: 40),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              post.author?.displayName ?? 'User',
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          LevelBadge(post.author?.level ?? 0, dense: true),
                          if ((post.author?.vipTier ?? 0) > 0) ...[
                            const SizedBox(width: 4),
                            VipBadge(post.author!.vipTier, dense: true),
                          ],
                        ],
                      ),
                      Text(
                        Fmt.ago(post.createdAt),
                        style: const TextStyle(
                          color: BBColors.inkSubtle,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: 'More',
                  icon: const Icon(Icons.more_horiz, color: BBColors.inkSubtle),
                  onSelected: (v) async {
                    if (v == 'report') {
                      await ReportSheet.show(
                        context,
                        targetType: 'post',
                        targetId: post.id,
                      );
                    }
                    if (v == 'delete') await _delete();
                    if (v == 'share' && context.mounted) {
                      final name = post.author?.displayName;
                      await shareDeepLink(
                        context,
                        PostLink(post.id),
                        name == null
                            ? 'A moment on BigBoss Live'
                            : '$name\'s moment on BigBoss Live',
                      );
                    }
                  },
                  itemBuilder: (_) => [
                    const PopupMenuItem(
                      value: 'share',
                      child: Text('Share link'),
                    ),
                    if (isMine)
                      const PopupMenuItem(
                        value: 'delete',
                        child: Text('Delete'),
                      )
                    else
                      const PopupMenuItem(
                        value: 'report',
                        child: Text('Report'),
                      ),
                  ],
                ),
              ],
            ),
            if (post.text.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(
                  post.text,
                  style: const TextStyle(fontSize: 15, height: 1.35),
                ),
              ),
            if (post.media.isNotEmpty) ...[
              const SizedBox(height: 10),
              _MediaGrid(urls: post.media),
            ],
            const SizedBox(height: 8),
            Row(
              children: [
                TextButton.icon(
                  onPressed: _toggleLike,
                  icon: Icon(
                    post.likedByMe
                        ? Icons.favorite_rounded
                        : Icons.favorite_border_rounded,
                    color: post.likedByMe ? BBColors.danger : BBColors.inkMuted,
                  ),
                  label: Text(
                    Fmt.compact(post.likeCount),
                    style: const TextStyle(color: BBColors.inkMuted),
                  ),
                ),
                TextButton.icon(
                  onPressed: widget.inDetail
                      ? null
                      : () => context.push('/post/${post.id}', extra: post),
                  icon: const Icon(
                    Icons.chat_bubble_outline_rounded,
                    color: BBColors.inkMuted,
                  ),
                  label: Text(
                    Fmt.compact(post.commentCount),
                    style: const TextStyle(color: BBColors.inkMuted),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _MediaGrid extends StatelessWidget {
  const _MediaGrid({required this.urls});
  final List<String> urls;

  @override
  Widget build(BuildContext context) {
    if (urls.length == 1) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: AspectRatio(
          aspectRatio: 4 / 3,
          child: CachedNetworkImage(imageUrl: urls.first, fit: BoxFit.cover),
        ),
      );
    }
    return GridView.count(
      crossAxisCount: urls.length == 2 || urls.length == 4 ? 2 : 3,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 4,
      crossAxisSpacing: 4,
      children: [
        for (final u in urls)
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: CachedNetworkImage(imageUrl: u, fit: BoxFit.cover),
          ),
      ],
    );
  }
}

class PostScreen extends ConsumerStatefulWidget {
  const PostScreen({super.key, required this.post});
  final FeedPost post;
  @override
  ConsumerState<PostScreen> createState() => _PostScreenState();
}

class _PostScreenState extends ConsumerState<PostScreen> {
  late FeedPost _post = widget.post;
  final _comments = PagedListController<FeedComment>();
  final _input = TextEditingController();
  bool _sending = false;

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<void> _comment() async {
    final text = _input.text.trim();
    // The keyboard's send action ignores the disabled button, so guard here too.
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final c = await ref.read(socialRepo).comment(_post.id, text);
      if (!mounted) return;
      _input.clear();
      _comments.prepend(c);
      setState(
        () => _post = _post.copyWith(commentCount: _post.commentCount + 1),
      );
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Moment')),
    body: Column(
      children: [
        Expanded(
          // The post scrolls with its comments; on a small phone with the keyboard up a
          // fixed post would leave the comments no room at all.
          child: PagedList<FeedComment>(
            controller: _comments,
            header: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: PostCard(
                    post: _post,
                    inDetail: true,
                    onChanged: (p) {
                      if (mounted) setState(() => _post = p);
                    },
                    onDeleted: () {
                      if (mounted) context.pop();
                    },
                  ),
                ),
                const Divider(),
              ],
            ),
            load: (cursor) =>
                ref.read(socialRepo).comments(_post.id, cursor: cursor),
            empty: const Text(
              'Be the first to comment',
              textAlign: TextAlign.center,
              style: TextStyle(color: BBColors.inkSubtle),
            ),
            itemBuilder: (context, c) => ListTile(
              leading: BBAvatar.user(c.author, size: 34),
              title: Text(
                c.author?.displayName ?? 'User',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                ),
              ),
              subtitle: Text(
                c.text,
                style: const TextStyle(color: BBColors.ink),
              ),
              trailing: Text(
                Fmt.ago(c.createdAt),
                style: const TextStyle(color: BBColors.inkSubtle, fontSize: 11),
              ),
            ),
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 8, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    maxLength: 500,
                    textInputAction: TextInputAction.send,
                    decoration: const InputDecoration(
                      hintText: 'Add a comment',
                      counterText: '',
                    ),
                    onSubmitted: (_) => _comment(),
                  ),
                ),
                IconButton(
                  tooltip: 'Send comment',
                  onPressed: _sending ? null : _comment,
                  icon: const Icon(
                    Icons.send_rounded,
                    color: BBColors.goldDeep,
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

/// `/post/:id` opened from a link, without the post in hand.
class PostByIdScreen extends ConsumerWidget {
  const PostByIdScreen({super.key, required this.postId});
  final String postId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final post = ref.watch(_postProvider(postId));
    return post.when(
      data: (p) => PostScreen(post: p),
      loading: () => Scaffold(
        appBar: AppBar(title: const Text('Moment')),
        body: const Center(child: CircularProgressIndicator()),
      ),
      error: (e, _) => Scaffold(
        appBar: AppBar(title: const Text('Moment')),
        body: ErrorView(
          error: e,
          onRetry: () => ref.invalidate(_postProvider(postId)),
        ),
      ),
    );
  }
}

class CreatePostScreen extends ConsumerStatefulWidget {
  const CreatePostScreen({super.key});
  @override
  ConsumerState<CreatePostScreen> createState() => _CreatePostScreenState();
}

class _CreatePostScreenState extends ConsumerState<CreatePostScreen> {
  final _text = TextEditingController();
  final _images = <File>[];
  bool _posting = false;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  static const _maxImages = 9;

  Future<void> _pickImages() async {
    final room = _maxImages - _images.length;
    if (room <= 0) return;
    try {
      // pickMultiImage rejects a limit below 2, and some Android pickers treat the limit as
      // a hint, so cap the result as well.
      final picked = room == 1
          ? [
              ?await ImagePicker().pickImage(
                source: ImageSource.gallery,
                maxWidth: 1600,
                imageQuality: 85,
              ),
            ]
          : await ImagePicker().pickMultiImage(
              maxWidth: 1600,
              imageQuality: 85,
              limit: room,
            );
      if (!mounted) return;
      setState(
        () => _images.addAll(picked.take(room).map((x) => File(x.path))),
      );
    } catch (e) {
      if (mounted) showError(context, 'Couldn\'t open your photos');
    }
  }

  Future<void> _post() async {
    if (_posting) return;
    if (_text.text.trim().isEmpty && _images.isEmpty) return;
    setState(() => _posting = true);
    try {
      final urls = await Future.wait(
        _images.map((f) => ref.read(contentRepo).upload('post', f)),
      );
      await ref.read(socialRepo).createPost(_text.text.trim(), urls);
      ref.read(feedRevisionProvider.notifier).bump();
      if (mounted) {
        showMessage(context, 'Shared to Moments');
        context.pop();
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _posting = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('New moment'),
      actions: [
        Padding(
          padding: const EdgeInsets.only(right: 12),
          child: SizedBox(
            width: 90,
            child: GoldButton(
              label: 'Post',
              height: 38,
              loading: _posting,
              onPressed: _post,
            ),
          ),
        ),
      ],
    ),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        TextField(
          controller: _text,
          autofocus: true,
          maxLength: 2000,
          maxLines: 8,
          minLines: 4,
          decoration: const InputDecoration(
            hintText: 'Share something golden…',
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final (i, f) in _images.indexed)
              Stack(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.file(
                      f,
                      width: 100,
                      height: 100,
                      fit: BoxFit.cover,
                    ),
                  ),
                  Positioned(
                    right: 0,
                    top: 0,
                    // 40 px hit area around a 24 px badge.
                    child: Semantics(
                      button: true,
                      label: 'Remove photo',
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: () => setState(() => _images.removeAt(i)),
                        child: const Padding(
                          padding: EdgeInsets.all(8),
                          child: CircleAvatar(
                            radius: 12,
                            backgroundColor: BBColors.scrim,
                            child: Icon(
                              Icons.close,
                              size: 14,
                              color: BBColors.surface,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            if (_images.length < 9)
              InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: _pickImages,
                child: Container(
                  width: 100,
                  height: 100,
                  decoration: BoxDecoration(
                    color: BBColors.surfaceMuted,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: BBColors.border),
                  ),
                  child: const Icon(
                    Icons.add_photo_alternate_outlined,
                    color: BBColors.bronze,
                  ),
                ),
              ),
          ],
        ),
      ],
    ),
  );
}
