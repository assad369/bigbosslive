import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'agency_providers.dart';
import 'agency_widgets.dart';
import 'host_detail.dart';

void _open(BuildContext context, Widget screen) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));

/// Agency actions in flight, by id, so a double tap can't approve, decline or cancel twice.
final _busyProvider = NotifierProvider.autoDispose<_Busy, Set<String>>(
  _Busy.new,
);

class _Busy extends Notifier<Set<String>> {
  @override
  Set<String> build() => const {};

  Future<void> run(String id, Future<void> Function() action) async {
    if (state.contains(id)) return;
    state = {...state, id};
    try {
      await action();
    } finally {
      if (ref.mounted) state = {...state}..remove(id);
    }
  }
}

/// The dashboard as it is now. Sub-screens get a snapshot when opened, but roles,
/// suspension and settings can change while they are open.
AgencyDashboard _live(WidgetRef ref, AgencyDashboard opened) =>
    ref.watch(agencyDashboardProvider).value ?? opened;

/// Home of the agency dashboard for its owner or an agency admin.
class AgencyDashboardView extends ConsumerWidget {
  const AgencyDashboardView({super.key, required this.dash});
  final AgencyDashboard dash;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = dash.agency;
    return RefreshIndicator(
      onRefresh: () async {
        refreshAgency(ref);
        await ref.read(agencyDashboardProvider.future);
      },
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _Hero(dash: dash),
          if (dash.suspended)
            const Padding(
              padding: EdgeInsets.only(top: 12),
              child: Card(
                color: BBColors.champagne,
                child: ListTile(
                  leading: Icon(Icons.pause_circle, color: BBColors.danger),
                  title: Text('This agency is suspended'),
                  subtitle: Text(
                    'Commission is paused and hosts cannot join until support '
                    'reactivates it.',
                  ),
                ),
              ),
            ),
          const SizedBox(height: 16),
          AgencyStatGrid(
            children: [
              AgencyStat(
                icon: Icons.groups,
                label: 'Hosts',
                value: '${dash.total('members')}',
              ),
              AgencyStat(
                icon: Icons.sensors,
                label: 'Live now',
                value: '${dash.total('liveNow')}',
              ),
              AgencyStat(
                icon: Icons.calendar_month,
                label: 'Beans this month',
                value: '🫘 ${Fmt.compact(dash.total('periodBeans'))}',
              ),
              AgencyStat(
                icon: Icons.timer,
                label: 'Live time this month',
                value: Fmt.duration(dash.total('periodLiveSeconds')),
              ),
              AgencyStat(
                icon: Icons.today,
                label: 'Beans today',
                value: '🫘 ${Fmt.compact(dash.total('todayBeans'))}',
              ),
              AgencyStat(
                icon: Icons.av_timer,
                label: 'Live time today',
                value: Fmt.duration(dash.total('todayLiveSeconds')),
              ),
              AgencyStat(
                icon: Icons.payments,
                label: 'Commission this month',
                value: '🫘 ${Fmt.compact(dash.total('periodCommission'))}',
              ),
              AgencyStat(
                icon: Icons.savings,
                label: 'Commission all time',
                value: '🫘 ${Fmt.compact(dash.total('lifetimeCommission'))}',
              ),
            ],
          ),
          const SizedBox(height: 16),
          AgencyStatGrid(
            actions: true,
            children: [
              AgencyActionTile(
                icon: Icons.groups,
                label: 'Hosts',
                onTap: () => _open(context, AgencyHostsScreen(dash: dash)),
              ),
              AgencyActionTile(
                icon: Icons.how_to_reg,
                label: 'Applications',
                badge: dash.pendingRequests,
                onTap: () => _open(context, const AgencyRequestsScreen()),
              ),
              AgencyActionTile(
                icon: Icons.mail_outline,
                label: 'Invitations',
                badge: dash.pendingInvitations,
                onTap: () =>
                    _open(context, AgencyInvitationsScreen(dash: dash)),
              ),
              AgencyActionTile(
                icon: Icons.insights,
                label: 'Analytics',
                onTap: () => _open(context, const AgencyAnalyticsScreen()),
              ),
              AgencyActionTile(
                icon: Icons.emoji_events,
                label: 'Top hosts',
                onTap: () => _open(context, const AgencyTopHostsScreen()),
              ),
              AgencyActionTile(
                icon: Icons.history,
                label: 'Activity',
                onTap: () => _open(context, const AgencyActivityScreen()),
              ),
              AgencyActionTile(
                icon: dash.isOwner ? Icons.settings : Icons.info_outline,
                label: dash.isOwner ? 'Settings' : 'Agency info',
                onTap: () => _open(context, AgencySettingsScreen(dash: dash)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            '${a.name} earns ${(dash.commissionRate * 100).toStringAsFixed(1)}% '
            'of the value of every gift its hosts receive. Months run on the '
            "agency's calendar (${Fmt.monthKey(dash.periodKey)}).",
            style: const TextStyle(color: BBColors.inkSubtle, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.dash});
  final AgencyDashboard dash;

  @override
  Widget build(BuildContext context) {
    final a = dash.agency;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: BBColors.goldGradient,
        borderRadius: BorderRadius.circular(22),
      ),
      child: Row(
        children: [
          AgencyLogo(
            agency: a,
            size: 72,
            ring: const LinearGradient(
              colors: [BBColors.ivory, BBColors.champagne],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  a.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleLarge
                      ?.copyWith(color: BBColors.ivory),
                ),
                const SizedBox(height: 2),
                InkWell(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: a.code));
                    showMessage(context, 'Agency code copied');
                  },
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        a.code,
                        style: const TextStyle(
                          color: BBColors.ivory,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(width: 4),
                      const Icon(Icons.copy, size: 13, color: BBColors.ivory),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    _Pill(dash.isOwner ? 'Owner' : 'Agency admin'),
                    if (dash.rank != null)
                      _Pill('Rank #${dash.rank} this month'),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
    decoration: BoxDecoration(
      color: BBColors.ink.withValues(alpha: 0.25),
      borderRadius: BorderRadius.circular(20),
    ),
    child: Text(
      text,
      style: const TextStyle(
        color: BBColors.ivory,
        fontSize: 11,
        fontWeight: FontWeight.w700,
      ),
    ),
  );
}

// ── Hosts ──────────────────────────────────────────────────────────────────────

class AgencyHostsScreen extends ConsumerWidget {
  const AgencyHostsScreen({super.key, required this.dash});
  final AgencyDashboard dash;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(agencyMembersProvider);
    final dash = _live(ref, this.dash);
    return Scaffold(
      appBar: AppBar(title: const Text('Hosts')),
      floatingActionButton: dash.suspended
          ? null
          : FloatingActionButton.extended(
              onPressed: () => showInviteHostDialog(context, ref),
              icon: const Icon(Icons.person_add_alt_1),
              label: const Text('Invite host'),
            ),
      body: AsyncView(
        value: members,
        onRetry: () => ref.invalidate(agencyMembersProvider),
        data: (items) => RefreshIndicator(
          onRefresh: () => ref.refresh(agencyMembersProvider.future),
          child: items.isEmpty
              ? ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: const [
                    SizedBox(height: 80),
                    EmptyState(
                      icon: Icons.groups_outlined,
                      title: 'No hosts yet',
                      message: 'Invite hosts by their BigBoss ID',
                    ),
                  ],
                )
              : ListView.separated(
                  padding: const EdgeInsets.only(bottom: 96),
                  itemCount: items.length,
                  separatorBuilder: (_, _) => const Divider(indent: 72),
                  itemBuilder: (_, i) => _HostRow(dash: dash, m: items[i]),
                ),
        ),
      ),
    );
  }
}

class _HostRow extends ConsumerWidget {
  const _HostRow({required this.dash, required this.m});
  final AgencyDashboard dash;
  final AgencyMember m;

  Future<void> _run(
    BuildContext context,
    WidgetRef ref,
    Future<void> Function() action,
    String done,
  ) async {
    try {
      await ref.read(_busyProvider.notifier).run(
        'member:${m.user!.id}',
        () async {
          await action();
          refreshAgency(ref);
          if (context.mounted) showMessage(context, done);
        },
      );
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }

  Future<void> _onAction(
    BuildContext context,
    WidgetRef ref,
    String action,
  ) async {
    final u = m.user!;
    final repo = ref.read(agencyRepo);
    switch (action) {
      case 'promote':
        await _run(
          context,
          ref,
          () => repo.setRole(u.id, 'admin'),
          '${u.displayName} is now an agency admin',
        );
      case 'demote':
        await _run(
          context,
          ref,
          () => repo.setRole(u.id, 'host'),
          '${u.displayName} is no longer an agency admin',
        );
      case 'target':
        final minutes = await _askTarget(context, m.dailyTargetMinutes);
        if (minutes == null || !context.mounted) return;
        await _run(
          context,
          ref,
          () => repo.setTarget(u.id, minutes == 0 ? null : minutes),
          minutes == 0 ? 'Target cleared' : 'Daily target set to $minutes min',
        );
      case 'lock':
        if (!await _confirm(
          context,
          'Lock ${u.displayName}?',
          'They will not be able to leave the agency on their own. Only '
              'BigBoss support can unlock them.',
          'Lock',
        )) {
          return;
        }
        if (!context.mounted) return;
        await _run(context, ref, () => repo.lock(u.id), 'Host locked');
      case 'remove':
        if (!await _confirm(
          context,
          'Remove ${u.displayName}?',
          'They will leave the agency and you will stop earning commission '
              'on their gifts.',
          'Remove',
        )) {
          return;
        }
        if (!context.mounted) return;
        await _run(context, ref, () => repo.removeMember(u.id), 'Host removed');
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final u = m.user;
    if (u == null) return const SizedBox.shrink();
    final owner = dash.isOwner;
    final canRemove = owner || !m.isAdmin;
    final progress = m.targetProgress;
    return ListTile(
      onTap: () => _open(context, HostDetailScreen(uid: u.id, initial: m)),
      leading: BBAvatar.user(u, live: m.isLive),
      title: Row(
        children: [
          Flexible(
            child: Text(
              u.displayName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          if (m.isAdmin) ...[
            const SizedBox(width: 6),
            const _Tag('ADMIN', color: BBColors.goldDeep),
          ],
          if (m.locked) ...[
            const SizedBox(width: 4),
            const Icon(Icons.lock, size: 14, color: BBColors.danger),
          ],
        ],
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'ID ${u.shortId} · Month 🫘 ${Fmt.compact(m.periodBeans)} · '
            'Total 🫘 ${Fmt.compact(m.lifetimeBeans)}',
            style: const TextStyle(color: BBColors.inkSubtle, fontSize: 12),
          ),
          if (progress != null) ...[
            const SizedBox(height: 4),
            Text(
              'Today ${m.todayLiveSeconds ~/ 60} / ${m.dailyTargetMinutes} min',
              style: TextStyle(
                fontSize: 11,
                color: progress >= 1 ? BBColors.success : BBColors.inkMuted,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 2),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: progress,
                minHeight: 5,
                backgroundColor: BBColors.surfaceMuted,
                color: progress >= 1 ? BBColors.success : BBColors.gold,
              ),
            ),
          ] else
            Text(
              'Today ${Fmt.duration(m.todayLiveSeconds)} live',
              style: const TextStyle(color: BBColors.inkSubtle, fontSize: 11),
            ),
        ],
      ),
      trailing: PopupMenuButton<String>(
        tooltip: 'Manage host',
        enabled: !ref.watch(_busyProvider).contains('member:${u.id}'),
        onSelected: (a) => _onAction(context, ref, a),
        itemBuilder: (_) => [
          if (owner && !m.isAdmin)
            const PopupMenuItem(value: 'promote', child: Text('Make admin')),
          if (owner && m.isAdmin)
            const PopupMenuItem(value: 'demote', child: Text('Remove admin')),
          if (owner)
            const PopupMenuItem(
              value: 'target',
              child: Text('Set daily target'),
            ),
          if (owner && !m.locked)
            const PopupMenuItem(value: 'lock', child: Text('Lock host')),
          if (owner && m.locked)
            const PopupMenuItem(
              enabled: false,
              child: Text('Locked · support can unlock'),
            ),
          if (canRemove)
            const PopupMenuItem(
              value: 'remove',
              child: Text(
                'Remove from agency',
                style: TextStyle(color: BBColors.danger),
              ),
            ),
        ],
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.text, {required this.color});
  final String text;
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
    decoration: BoxDecoration(
      border: Border.all(color: color),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      text,
      style: TextStyle(color: color, fontSize: 9, fontWeight: FontWeight.w800),
    ),
  );
}

Future<bool> _confirm(
  BuildContext context,
  String title,
  String body,
  String action,
) async =>
    await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: Text(action),
          ),
        ],
      ),
    ) ??
    false;

/// Minutes per day, or 0 to clear; null when cancelled.
Future<int?> _askTarget(BuildContext context, int? current) => showDialog<int>(
  context: context,
  builder: (_) => _TargetDialog(current: current),
);

/// Owns its text controller, so it is disposed with the dialog's element, after the exit
/// animation (disposing when the future completes is too early: the field is still built).
class _TargetDialog extends StatefulWidget {
  const _TargetDialog({required this.current});
  final int? current;
  @override
  State<_TargetDialog> createState() => _TargetDialogState();
}

class _TargetDialogState extends State<_TargetDialog> {
  late final _field = TextEditingController(
    text: widget.current?.toString() ?? '',
  );

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  void _save() {
    final n = int.tryParse(_field.text.trim()) ?? 0;
    Navigator.pop(context, n.clamp(0, 1440));
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Daily live target'),
    content: TextField(
      controller: _field,
      autofocus: true,
      keyboardType: TextInputType.number,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      decoration: const InputDecoration(
        labelText: 'Minutes per day (1–1440)',
        helperText: 'Leave empty to clear the target',
      ),
      onSubmitted: (_) => _save(),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(onPressed: _save, child: const Text('Save')),
    ],
  );
}

/// Invite a host by BigBoss ID. They join only once they accept.
Future<void> showInviteHostDialog(BuildContext context, WidgetRef ref) async {
  final id = await showDialog<String>(
    context: context,
    builder: (c) => const _InviteDialog(),
  );
  if (id == null || id.isEmpty || !context.mounted) return;
  try {
    final inv = await ref.read(agencyRepo).invite(id);
    refreshAgency(ref);
    if (context.mounted) {
      showMessage(
        context,
        'Invitation sent to ${inv.user?.displayName ?? 'ID $id'}',
      );
    }
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}

class _InviteDialog extends StatefulWidget {
  const _InviteDialog();
  @override
  State<_InviteDialog> createState() => _InviteDialogState();
}

class _InviteDialogState extends State<_InviteDialog> {
  final _id = TextEditingController();

  @override
  void dispose() {
    _id.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Invite a host'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: _id,
          autofocus: true,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(labelText: 'Host BigBoss ID'),
          onSubmitted: (v) => Navigator.pop(context, v.trim()),
        ),
        const SizedBox(height: 8),
        const Text(
          'They get a notification and join once they accept. Invitations '
          'expire after 7 days.',
          style: TextStyle(color: BBColors.inkSubtle, fontSize: 12),
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: () => Navigator.pop(context, _id.text.trim()),
        child: const Text('Send invite'),
      ),
    ],
  );
}

// ── Applications & invitations ───────────────────────────────────────────────────

class AgencyRequestsScreen extends ConsumerWidget {
  const AgencyRequestsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final reqs = ref.watch(agencyRequestsProvider);
    final busy = ref.watch(_busyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Applications')),
      body: AsyncView(
        value: reqs,
        onRetry: () => ref.invalidate(agencyRequestsProvider),
        data: (items) => RefreshIndicator(
          onRefresh: () => ref.refresh(agencyRequestsProvider.future),
          child: items.isEmpty
              ? ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: const [
                    SizedBox(height: 80),
                    EmptyState(
                      icon: Icons.how_to_reg_outlined,
                      title: 'No pending applications',
                    ),
                  ],
                )
              : ListView(
                  children: [
                    for (final r in items)
                      if (r.user != null)
                        UserTile(
                          user: r.user!,
                          key: ValueKey(r.id),
                          subtitle:
                              'ID ${r.user!.shortId} · applied ${Fmt.ago(r.createdAt)}',
                          trailing: busy.contains('req:${r.id}')
                              ? const Padding(
                                  padding: EdgeInsets.all(12),
                                  child: SizedBox.square(
                                    dimension: 20,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  ),
                                )
                              : Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    IconButton(
                                      tooltip: 'Decline',
                                      icon: const Icon(
                                        Icons.close,
                                        color: BBColors.danger,
                                      ),
                                      onPressed: () =>
                                          _decide(context, ref, r, false),
                                    ),
                                    IconButton(
                                      tooltip: 'Approve',
                                      icon: const Icon(
                                        Icons.check,
                                        color: BBColors.success,
                                      ),
                                      onPressed: () =>
                                          _decide(context, ref, r, true),
                                    ),
                                  ],
                                ),
                        ),
                  ],
                ),
        ),
      ),
    );
  }

  Future<void> _decide(
    BuildContext context,
    WidgetRef ref,
    AgencyRequest r,
    bool approve,
  ) async {
    try {
      await ref.read(_busyProvider.notifier).run('req:${r.id}', () async {
        await ref.read(agencyRepo).decideRequest(r.id, approve: approve);
        refreshAgency(ref);
        if (context.mounted) {
          showMessage(
            context,
            approve ? 'Host approved' : 'Application declined',
          );
        }
      });
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }
}

class AgencyInvitationsScreen extends ConsumerWidget {
  const AgencyInvitationsScreen({super.key, required this.dash});
  final AgencyDashboard dash;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final invites = ref.watch(agencySentInvitationsProvider);
    final busy = ref.watch(_busyProvider);
    final dash = _live(ref, this.dash);
    return Scaffold(
      appBar: AppBar(title: const Text('Invitations')),
      floatingActionButton: dash.suspended
          ? null
          : FloatingActionButton.extended(
              onPressed: () => showInviteHostDialog(context, ref),
              icon: const Icon(Icons.person_add_alt_1),
              label: const Text('Invite host'),
            ),
      body: AsyncView(
        value: invites,
        onRetry: () => ref.invalidate(agencySentInvitationsProvider),
        data: (items) => RefreshIndicator(
          onRefresh: () => ref.refresh(agencySentInvitationsProvider.future),
          child: items.isEmpty
              ? ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: const [
                    SizedBox(height: 80),
                    EmptyState(
                      icon: Icons.mail_outline,
                      title: 'No open invitations',
                      message: 'Invite hosts by their BigBoss ID',
                    ),
                  ],
                )
              : ListView(
                  padding: const EdgeInsets.only(bottom: 96),
                  children: [
                    for (final inv in items)
                      if (inv.user != null)
                        UserTile(
                          user: inv.user!,
                          key: ValueKey(inv.id),
                          subtitle:
                              'Invited by ${inv.invitedBy?.displayName ?? '—'} · '
                              'expires ${Fmt.relative(inv.expiresAt)}',
                          trailing: TextButton(
                            onPressed: busy.contains('inv:${inv.id}')
                                ? null
                                : () async {
                                    try {
                                      await ref
                                          .read(_busyProvider.notifier)
                                          .run('inv:${inv.id}', () async {
                                            await ref
                                                .read(agencyRepo)
                                                .cancelInvitation(inv.id);
                                            refreshAgency(ref);
                                          });
                                    } catch (e) {
                                      if (context.mounted) {
                                        showError(context, e);
                                      }
                                    }
                                  },
                            child: const Text('Cancel'),
                          ),
                        ),
                  ],
                ),
        ),
      ),
    );
  }
}

// ── Analytics ────────────────────────────────────────────────────────────────────

/// Daily bars for one metric, oldest on the left.
class DailyBars extends StatelessWidget {
  const DailyBars({
    super.key,
    required this.days,
    required this.value,
    this.height = 90,
  });
  final List<AgencyDay> days;
  final int Function(AgencyDay) value;
  final double height;

  @override
  Widget build(BuildContext context) {
    final max = days.fold<int>(0, (m, d) => value(d) > m ? value(d) : m);
    return SizedBox(
      height: height,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          for (final d in days)
            Expanded(
              child: Tooltip(
                message: '${d.dayKey}: ${Fmt.full(value(d))}',
                child: Container(
                  margin: const EdgeInsets.symmetric(horizontal: 1),
                  height: max == 0
                      ? 2
                      : (value(d) / max * (height - 4)).clamp(2, height),
                  decoration: BoxDecoration(
                    gradient: BBColors.goldGradient,
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class AgencyAnalyticsScreen extends ConsumerStatefulWidget {
  const AgencyAnalyticsScreen({super.key});
  @override
  ConsumerState<AgencyAnalyticsScreen> createState() =>
      _AgencyAnalyticsScreenState();
}

class _AgencyAnalyticsScreenState extends ConsumerState<AgencyAnalyticsScreen> {
  int _days = 30;

  @override
  Widget build(BuildContext context) {
    final data = ref.watch(agencyAnalyticsProvider(_days));
    return Scaffold(
      appBar: AppBar(title: const Text('Analytics')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 7, label: Text('7 days')),
                ButtonSegment(value: 30, label: Text('30 days')),
                ButtonSegment(value: 90, label: Text('90 days')),
              ],
              selected: {_days},
              onSelectionChanged: (s) => setState(() => _days = s.first),
            ),
          ),
          Expanded(
            child: AsyncView(
              value: data,
              onRetry: () => ref.invalidate(agencyAnalyticsProvider(_days)),
              data: (a) => ListView(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                children: [
                  AgencyStatGrid(
                    children: [
                      AgencyStat(
                        label: 'Beans',
                        value: '🫘 ${Fmt.compact(a.totals.beans)}',
                      ),
                      AgencyStat(
                        label: 'Commission',
                        value: '🫘 ${Fmt.compact(a.totals.commission)}',
                      ),
                      AgencyStat(
                        label: 'Gifts',
                        value: Fmt.compact(a.totals.gifts),
                      ),
                      AgencyStat(
                        label: 'Live time',
                        value: Fmt.duration(a.totals.liveSeconds),
                      ),
                    ],
                  ),
                  const SizedBox(height: 18),
                  const Text(
                    'Beans per day',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 8),
                  DailyBars(days: a.daily, value: (d) => d.beans),
                  const SizedBox(height: 18),
                  for (final d in a.daily.reversed)
                    if (d.beans > 0 || d.liveSeconds > 0)
                      ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        title: Text(d.dayKey),
                        subtitle: Text(
                          '${d.activeHosts ?? 0} active hosts · '
                          '${Fmt.duration(d.liveSeconds)} live · '
                          '${d.gifts} gifts',
                        ),
                        trailing: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(
                              '🫘 ${Fmt.full(d.beans)}',
                              style: const TextStyle(
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            Text(
                              '+${Fmt.full(d.commission)} commission',
                              style: const TextStyle(
                                color: BBColors.success,
                                fontSize: 11,
                              ),
                            ),
                          ],
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

// ── Top hosts ────────────────────────────────────────────────────────────────────

class AgencyTopHostsScreen extends ConsumerStatefulWidget {
  const AgencyTopHostsScreen({super.key});
  @override
  ConsumerState<AgencyTopHostsScreen> createState() =>
      _AgencyTopHostsScreenState();
}

class _AgencyTopHostsScreenState extends ConsumerState<AgencyTopHostsScreen> {
  String? _period;

  @override
  Widget build(BuildContext context) {
    final board = ref.watch(agencyLeaderboardProvider(_period));
    return Scaffold(
      appBar: AppBar(title: const Text('Top hosts')),
      body: AsyncView(
        value: board,
        onRetry: () => ref.invalidate(agencyLeaderboardProvider(_period)),
        data: (b) => ListView(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: DropdownButtonFormField<String>(
                // The value must be one of the items, or the dropdown asserts.
                initialValue: b.periods.contains(b.periodKey)
                    ? b.periodKey
                    : b.periods.firstOrNull,
                decoration: const InputDecoration(labelText: 'Month'),
                items: [
                  for (final p in b.periods)
                    DropdownMenuItem(value: p, child: Text(Fmt.monthKey(p))),
                ],
                onChanged: (p) => setState(
                  () => _period = p == b.periods.firstOrNull ? null : p,
                ),
              ),
            ),
            if (b.items.isEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 60),
                child: EmptyState(
                  icon: Icons.emoji_events_outlined,
                  title: 'No earnings this month yet',
                ),
              ),
            for (final r in b.items)
              if (r.user != null)
                UserTile(
                  user: r.user!,
                  subtitle: '${Fmt.duration(r.liveSeconds)} live',
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '🫘 ${Fmt.compact(r.beans)}',
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(width: 10),
                      Container(
                        width: 30,
                        height: 30,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          gradient: AgencyPodium.gradient(r.rank),
                          shape: BoxShape.circle,
                        ),
                        child: Text(
                          '${r.rank}',
                          style: TextStyle(
                            fontWeight: FontWeight.w900,
                            color: r.rank <= 3
                                ? BBColors.onAccent
                                : BBColors.ink,
                          ),
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

// ── Activity ─────────────────────────────────────────────────────────────────────

const _auditLabels = {
  'agency_created': 'Agency created',
  'agency_updated': 'Agency details updated',
  'agency_suspended': 'Agency suspended',
  'agency_reactivated': 'Agency reactivated',
  'host_invited': 'Invited a host',
  'invite_cancelled': 'Cancelled an invitation',
  'invite_accepted': 'Accepted the invitation',
  'invite_declined': 'Declined the invitation',
  'request_submitted': 'Applied to join',
  'request_approved': 'Approved an application',
  'request_rejected': 'Declined an application',
  'host_added': 'Host joined',
  'host_removed': 'Removed a host',
  'host_left': 'Left the agency',
  'host_locked': 'Locked a host',
  'host_unlocked': 'Host unlocked by support',
  'admin_promoted': 'Made an agency admin',
  'admin_demoted': 'Removed an agency admin',
  'target_updated': 'Set a daily target',
};

class AgencyActivityScreen extends ConsumerWidget {
  const AgencyActivityScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    appBar: AppBar(title: const Text('Activity')),
    body: PagedList<AgencyAuditRow>(
      separator: true,
      load: (cursor) => ref.read(agencyRepo).audit(cursor: cursor),
      empty: const EmptyState(icon: Icons.history, title: 'No activity yet'),
      itemBuilder: (_, r) {
        final target = r.target != null && r.target!.id != r.actor?.id
            ? ' · ${r.target!.displayName} (ID ${r.target!.shortId})'
            : '';
        return ListTile(
          leading: BBAvatar.user(r.actor, size: 40, fallbackName: '?'),
          title: Text(_auditLabels[r.action] ?? r.action),
          subtitle: Text(
            '${r.actor?.displayName ?? 'Support'}$target\n'
            '${r.createdAt == null ? '' : Fmt.dateTime(r.createdAt!)}',
          ),
          isThreeLine: true,
        );
      },
    ),
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────────

class AgencySettingsScreen extends ConsumerStatefulWidget {
  const AgencySettingsScreen({super.key, required this.dash});
  final AgencyDashboard dash;
  @override
  ConsumerState<AgencySettingsScreen> createState() =>
      _AgencySettingsScreenState();
}

class _AgencySettingsScreenState extends ConsumerState<AgencySettingsScreen> {
  late final _name = TextEditingController(text: widget.dash.agency.name);
  File? _logo;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.length < 2) {
      return showMessage(context, 'Enter an agency name (at least 2 letters)');
    }
    setState(() => _busy = true);
    try {
      final repo = ref.read(agencyRepo);
      final logoUrl = _logo == null ? null : await repo.uploadLogo(_logo!);
      await repo.updateProfile(
        name: name == widget.dash.agency.name ? null : name,
        logoUrl: logoUrl,
      );
      refreshAgency(ref);
      if (mounted) {
        showMessage(context, 'Agency updated');
        Navigator.of(context).pop();
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.dash;
    final owner = d.isOwner;
    return Scaffold(
      appBar: AppBar(title: Text(owner ? 'Agency settings' : 'Agency info')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Center(
            child: GestureDetector(
              onTap: !owner
                  ? null
                  : () async {
                      try {
                        final x = await ImagePicker().pickImage(
                          source: ImageSource.gallery,
                          maxWidth: 512,
                          imageQuality: 85,
                        );
                        if (x != null && mounted) {
                          setState(() => _logo = File(x.path));
                        }
                      } catch (_) {
                        if (context.mounted) {
                          showMessage(context, 'Couldn\'t open your photos');
                        }
                      }
                    },
              child: Stack(
                children: [
                  _logo != null
                      ? CircleAvatar(
                          radius: 48,
                          backgroundImage: FileImage(_logo!),
                        )
                      : AgencyLogo(agency: d.agency, size: 96),
                  if (owner)
                    const Positioned(
                      right: 0,
                      bottom: 0,
                      child: CircleAvatar(
                        radius: 16,
                        backgroundColor: BBColors.gold,
                        child: Icon(
                          Icons.camera_alt,
                          size: 16,
                          color: BBColors.onAccent,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _name,
            enabled: owner,
            maxLength: 40,
            decoration: const InputDecoration(labelText: 'Agency name'),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Agency code'),
            trailing: Text(d.agency.code),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Commission rate'),
            subtitle: const Text('Set by BigBoss'),
            trailing: Text('${(d.commissionRate * 100).toStringAsFixed(1)}%'),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Status'),
            trailing: Text(d.suspended ? 'Suspended' : 'Active'),
          ),
          if (owner) ...[
            const SizedBox(height: 16),
            GoldButton(label: 'Save', loading: _busy, onPressed: _save),
          ],
        ],
      ),
    );
  }
}
