import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'ban_sheet.dart';
import 'user_tools_sheet.dart';

/// Which accounts the panel lists; the value is the server's `status` filter.
enum ModerationFilter {
  all('all', 'All'),
  banned('banned', 'Banned'),
  active('active', 'Active');

  const ModerationFilter(this.wire, this.label);
  final String wire;
  final String label;
}

/// The Moderation panel for platform moderators: find an account by short ID, uid or name,
/// ban or unban it, and open its devices and live bans. Reached from Me → Moderation.
///
/// Every decision is the server's: this screen draws what `/me.moderation` allows and shows
/// the server's own message when it refuses (a protected account, the hourly limit).
class ModerationScreen extends ConsumerStatefulWidget {
  const ModerationScreen({super.key});

  /// Wait this long after the last keystroke before searching, so typing a name is one
  /// request, not one per letter.
  static const debounce = Duration(milliseconds: 400);

  @override
  ConsumerState<ModerationScreen> createState() => _ModerationScreenState();
}

class _ModerationScreenState extends ConsumerState<ModerationScreen> {
  final _list = PagedListController<ModeratedUser>();
  final _search = TextEditingController();
  Timer? _debounce;
  String _query = '';
  ModerationFilter _filter = ModerationFilter.all;

  /// Rows with an action in flight: their button spins and ignores a second tap.
  final _busy = <String>{};

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  void _onQuery(String value) {
    _debounce?.cancel();
    _debounce = Timer(ModerationScreen.debounce, () {
      if (!mounted || value.trim() == _query) return;
      setState(() => _query = value.trim());
      // A response for an older query is dropped by the list itself.
      unawaited(_list.refresh());
    });
  }

  void _setFilter(ModerationFilter f) {
    if (f == _filter) return;
    _debounce?.cancel();
    setState(() {
      _filter = f;
      _query = _search.text.trim();
    });
    unawaited(_list.refresh());
  }

  /// Puts the server's fresh copy of [row] in place, keeping the scroll position.
  void _replace(ModeratedUser row) =>
      _list.replaceWhere((u) => u.id == row.id, (_) => row);

  Future<void> _ban(ModeratedUser row) async {
    final updated = await BanSheet.show(context, row.user);
    if (updated != null && mounted) _replace(updated);
  }

  Future<void> _unban(ModeratedUser row) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Lift ${row.user.displayName}’s ban?'),
        content: const Text('They can sign in and use the app again at once.'),
        actions: [
          TextButton(
            onPressed: () => ctx.pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => ctx.pop(true),
            child: const Text('Lift ban'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted || _busy.contains(row.id)) return;
    setState(() => _busy.add(row.id));
    try {
      final updated = await ref.read(moderationRepo).unban(row.id);
      if (!mounted) return;
      _replace(updated);
      showMessage(context, 'Ban lifted');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy.remove(row.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(meProvider);
    // Staff may act on protected accounts; a platform moderator may not (the server agrees).
    final canActOnProtected = me.adminRole != null;
    return Scaffold(
      appBar: AppBar(title: const Text('Moderation')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: TextField(
              key: const Key('moderation-search'),
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search_rounded),
                hintText: 'Short ID, uid or name',
                suffixIcon: ValueListenableBuilder(
                  valueListenable: _search,
                  builder: (_, v, _) => v.text.isEmpty
                      ? const SizedBox.shrink()
                      : IconButton(
                          tooltip: 'Clear',
                          icon: const Icon(Icons.close_rounded),
                          onPressed: () {
                            _search.clear();
                            _onQuery('');
                          },
                        ),
                ),
              ),
              onChanged: _onQuery,
              onSubmitted: (v) {
                _debounce?.cancel();
                setState(() => _query = v.trim());
                unawaited(_list.refresh());
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: Wrap(
              spacing: 8,
              children: [
                for (final f in ModerationFilter.values)
                  ChoiceChip(
                    label: Text(f.label),
                    selected: _filter == f,
                    onSelected: (_) => _setFilter(f),
                  ),
              ],
            ),
          ),
          Expanded(
            child: PagedList<ModeratedUser>(
              controller: _list,
              separator: true,
              load: (cursor) => ref
                  .read(moderationRepo)
                  .search(query: _query, status: _filter.wire, cursor: cursor),
              empty: const EmptyState(
                icon: Icons.person_search_rounded,
                title: 'No accounts found',
                message: 'Try a different name, short ID or uid.',
              ),
              itemBuilder: (context, row) => ModerationUserTile(
                row: row,
                busy: _busy.contains(row.id),
                canAct:
                    row.id != me.id && (!row.isProtected || canActOnProtected),
                onBan: () => _ban(row),
                onUnban: () => _unban(row),
                onTools: () => UserToolsSheet.show(context, row),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// One account in the Moderation panel: who it is, its standing, and Ban or Unban.
class ModerationUserTile extends StatelessWidget {
  const ModerationUserTile({
    super.key,
    required this.row,
    required this.canAct,
    required this.onBan,
    required this.onUnban,
    required this.onTools,
    this.busy = false,
  });
  final ModeratedUser row;

  /// False for the moderator's own account and for accounts only staff may act on.
  final bool canAct;
  final bool busy;
  final VoidCallback onBan;
  final VoidCallback onUnban;
  final VoidCallback onTools;

  @override
  Widget build(BuildContext context) {
    final u = row.user;
    final until = row.bannedUntil;
    final banLine = row.isBanned
        ? until == null
              ? 'Banned · permanent'
              : 'Banned until ${Fmt.dateTime(until)}'
        : null;
    return ListTile(
      onTap: onTools,
      leading: BBAvatar.user(u, size: 44),
      title: Text(u.displayName, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('ID ${u.shortId}'),
          if (banLine != null)
            Text(
              row.banReason == null ? banLine : '$banLine · ${row.banReason}',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: BBColors.danger),
            ),
          if (row.isStaff || row.isPlatformModerator || row.isAgent)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Wrap(
                spacing: 6,
                children: [
                  if (row.isStaff) const _Pill('Staff', BBColors.goldDeep),
                  if (row.isPlatformModerator)
                    const _Pill('Moderator', BBColors.info),
                  if (row.isAgent) const _Pill('Agent', BBColors.bronze),
                ],
              ),
            ),
        ],
      ),
      isThreeLine: banLine != null,
      trailing: !canAct
          ? null
          : busy
          ? const SizedBox.square(
              dimension: 22,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : row.isBanned
          ? OutlinedButton(onPressed: onUnban, child: const Text('Unban'))
          : FilledButton(
              style: FilledButton.styleFrom(backgroundColor: BBColors.danger),
              onPressed: onBan,
              child: const Text('Ban'),
            ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.label, this.color);
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Text(
      label,
      style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w700),
    ),
  );
}
