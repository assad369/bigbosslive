import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/widgets/widgets.dart';
import '../../models/models.dart';
import 'agency_providers.dart';
import 'agency_widgets.dart';

/// For hosts: invitations to answer, their current agency, or agencies to apply to.
class AgencyMemberView extends ConsumerWidget {
  const AgencyMemberView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final membership = ref.watch(agencyMembershipProvider);
    final invites = ref.watch(myAgencyInvitationsProvider).value ?? const [];
    return AsyncView(
      value: membership,
      onRetry: () => ref.invalidate(agencyMembershipProvider),
      data: (m) => RefreshIndicator(
        onRefresh: () async {
          refreshAgency(ref);
          await ref.read(agencyMembershipProvider.future);
        },
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            for (final inv in invites) _InvitationCard(inv: inv),
            if (m != null) _Membership(m: m) else const _Browse(),
          ],
        ),
      ),
    );
  }
}

class _InvitationCard extends ConsumerStatefulWidget {
  const _InvitationCard({required this.inv});
  final AgencyInvitation inv;
  @override
  ConsumerState<_InvitationCard> createState() => _InvitationCardState();
}

class _InvitationCardState extends ConsumerState<_InvitationCard> {
  bool _busy = false;

  Future<void> _respond(bool accept) async {
    setState(() => _busy = true);
    try {
      await ref
          .read(agencyRepo)
          .respondInvitation(widget.inv.id, accept: accept);
      refreshAgency(ref);
      if (mounted) {
        showMessage(
          context,
          accept
              ? 'You joined ${widget.inv.agency.name}'
              : 'Invitation declined',
        );
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.inv.agency;
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                AgencyLogo(agency: a, size: 48),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${a.name} invited you',
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      Text(
                        '${a.code} · ${a.memberCount} hosts · expires ${Fmt.ago(widget.inv.expiresAt)}',
                        style: const TextStyle(
                          color: BBColors.inkSubtle,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            const Text(
              'Joining gives the agency a share of the gifts you receive.',
              style: TextStyle(color: BBColors.inkMuted, fontSize: 12),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy ? null : () => _respond(false),
                    child: const Text('Decline'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: _busy ? null : () => _respond(true),
                    child: const Text('Accept'),
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

class _Membership extends ConsumerWidget {
  const _Membership({required this.m});
  final AgencyMembership m;

  Future<void> _leave(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Leave ${m.agency.name}?'),
        content: const Text('You can apply to another agency afterwards.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Stay'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Leave'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(agencyRepo).leave();
      refreshAgency(ref);
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => Column(
    children: [
      const SizedBox(height: 24),
      AgencyLogo(agency: m.agency, size: 88),
      const SizedBox(height: 12),
      Text(m.agency.name, style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 4),
      Text(
        '${m.agency.code} · ${m.agency.memberCount} hosts',
        style: const TextStyle(color: BBColors.inkSubtle),
      ),
      const SizedBox(height: 4),
      Text(
        [
          m.role == 'admin' ? 'Agency admin' : 'Host',
          if (m.joinedAt != null) 'joined ${Fmt.ago(m.joinedAt)}',
        ].join(' · '),
        style: const TextStyle(color: BBColors.inkMuted),
      ),
      const SizedBox(height: 28),
      if (m.locked)
        const Card(
          child: ListTile(
            leading: Icon(Icons.lock, color: BBColors.danger),
            title: Text('Your membership is locked'),
            subtitle: Text(
              'Your agency locked your membership. Contact BigBoss support '
              'if you need to leave.',
            ),
          ),
        )
      else
        OutlinedButton.icon(
          onPressed: () => _leave(context, ref),
          icon: const Icon(Icons.logout),
          label: const Text('Leave agency'),
        ),
    ],
  );
}

class _Browse extends ConsumerStatefulWidget {
  const _Browse();
  @override
  ConsumerState<_Browse> createState() => _BrowseState();
}

class _BrowseState extends ConsumerState<_Browse> {
  final _q = TextEditingController();
  Timer? _debounce;
  late Future<List<AgencySummary>> _results = ref.read(agencyRepo).search('');

  @override
  void dispose() {
    _q.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  void _search(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      if (mounted) {
        setState(() => _results = ref.read(agencyRepo).search(q.trim()));
      }
    });
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text(
        'Join a host agency',
        style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
      ),
      const SizedBox(height: 4),
      const Text(
        'Agencies help hosts grow and earn a share of the gifts their hosts '
        'receive. Apply to one, or accept an invitation from an agency.',
        style: TextStyle(color: BBColors.inkMuted),
      ),
      const SizedBox(height: 14),
      TextField(
        controller: _q,
        decoration: const InputDecoration(
          hintText: 'Agency name or code (HA-…)',
          prefixIcon: Icon(Icons.search),
        ),
        onChanged: _search,
      ),
      const SizedBox(height: 8),
      FutureBuilder<List<AgencySummary>>(
        future: _results,
        builder: (context, snap) {
          if (snap.hasError) {
            return ErrorView(
              error: snap.error!,
              onRetry: () => _search(_q.text),
            );
          }
          if (!snap.hasData) {
            return const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            );
          }
          final items = snap.data!;
          if (items.isEmpty) {
            return const Padding(
              padding: EdgeInsets.only(top: 24),
              child: EmptyState(
                icon: Icons.business_outlined,
                title: 'No agencies found',
              ),
            );
          }
          return Column(
            children: [
              for (final a in items)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  onTap: () => showAgencySheet(context, a),
                  leading: AgencyLogo(agency: a, size: 44),
                  title: Text(
                    a.name,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  subtitle: Text('${a.code} · ${a.memberCount} hosts'),
                  trailing: const Icon(Icons.chevron_right),
                ),
            ],
          );
        },
      ),
    ],
  );
}
