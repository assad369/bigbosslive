import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/widgets.dart';

final _membershipProvider = FutureProvider.autoDispose(
  (ref) => ref.watch(economyRepo).membership(),
);

/// Owners see their agency dashboard; members see their agency; everyone else can apply.
final _ownedAgencyProvider = FutureProvider.autoDispose<Json?>((ref) async {
  try {
    return await ref.watch(economyRepo).myAgency();
  } on ApiException catch (e) {
    if (e.status == 403) return null;
    rethrow;
  }
});

class AgencyScreen extends ConsumerWidget {
  const AgencyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final owned = ref.watch(_ownedAgencyProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Host agency')),
      body: AsyncView(
        value: owned,
        onRetry: () => ref.invalidate(_ownedAgencyProvider),
        data: (dash) =>
            dash != null ? _OwnerDashboard(dash: dash) : const _MemberView(),
      ),
    );
  }
}

class _OwnerDashboard extends ConsumerWidget {
  const _OwnerDashboard({required this.dash});
  final Json dash;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agency = dash.obj('agency');
    final totals = dash.obj('totals');
    final members = dash.list('members', (m) => m);
    return RefreshIndicator(
      onRefresh: () => ref.refresh(_ownedAgencyProvider.future),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              gradient: BBColors.goldGradient,
              borderRadius: BorderRadius.circular(20),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  agency.str('name'),
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                Text(
                  'Commission ${(agency.dbl('commissionRate') * 100).toStringAsFixed(1)}%',
                  style: const TextStyle(color: BBColors.bronzeDeep),
                ),
                const SizedBox(height: 14),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    _Kpi('Hosts', Fmt.full(totals.integer('members'))),
                    _Kpi(
                      'Beans this month',
                      Fmt.compact(totals.integer('periodBeans')),
                    ),
                    _Kpi(
                      'Live time',
                      Fmt.duration(totals.integer('periodLiveSeconds')),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _Requests(),
          const SizedBox(height: 8),
          Text('Hosts', style: Theme.of(context).textTheme.titleMedium),
          for (final m in members)
            if (m.brief('user') != null)
              UserTile(
                user: m.brief('user')!,
                subtitle:
                    '🫘 ${Fmt.compact(m.integer('periodBeans'))} · ${Fmt.duration(m.integer('periodLiveSeconds'))}',
              ),
        ],
      ),
    );
  }
}

class _Kpi extends StatelessWidget {
  const _Kpi(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        value,
        style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
      ),
      Text(
        label,
        style: const TextStyle(color: BBColors.bronzeDeep, fontSize: 12),
      ),
    ],
  );
}

class _Requests extends ConsumerStatefulWidget {
  @override
  ConsumerState<_Requests> createState() => _RequestsState();
}

class _RequestsState extends ConsumerState<_Requests> {
  List<Json>? _items;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final items = await ref
        .read(economyRepo)
        .agencyRequests()
        .catchError((Object _) => <Json>[]);
    if (mounted) setState(() => _items = items);
  }

  @override
  Widget build(BuildContext context) {
    final items = _items ?? const [];
    if (items.isEmpty) return const SizedBox.shrink();
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Text(
              'Applications',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
          for (final r in items)
            if (r.brief('user') != null)
              UserTile(
                user: r.brief('user')!,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      icon: const Icon(Icons.close),
                      onPressed: () => _decide(r.str('id'), false),
                    ),
                    IconButton(
                      icon: const Icon(
                        Icons.check_circle,
                        color: BBColors.success,
                      ),
                      onPressed: () => _decide(r.str('id'), true),
                    ),
                  ],
                ),
              ),
        ],
      ),
    );
  }

  Future<void> _decide(String id, bool approve) async {
    try {
      await ref.read(economyRepo).decideAgencyRequest(id, approve);
      ref.invalidate(_ownedAgencyProvider);
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }
}

class _MemberView extends ConsumerStatefulWidget {
  const _MemberView();
  @override
  ConsumerState<_MemberView> createState() => _MemberViewState();
}

class _MemberViewState extends ConsumerState<_MemberView> {
  List<Json> _results = const [];

  Future<void> _search(String q) async {
    final r = await ref
        .read(economyRepo)
        .agencies(q)
        .catchError((Object _) => <Json>[]);
    if (mounted) setState(() => _results = r);
  }

  @override
  void initState() {
    super.initState();
    unawaited(_search(''));
  }

  @override
  Widget build(BuildContext context) {
    final membership = ref.watch(_membershipProvider);
    return AsyncView(
      value: membership,
      data: (m) => m != null
          ? EmptyState(
              icon: Icons.groups_2_rounded,
              title: m.str('name'),
              message: 'You are a host in this agency. Your beans and live time count toward its monthly totals.',
              action: OutlinedButton(
                onPressed: () async {
                  await ref.read(economyRepo).leaveAgency();
                  ref.invalidate(_membershipProvider);
                },
                child: const Text('Leave agency'),
              ),
            )
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                const Text(
                  'Join a host agency to get coaching, events and promotion. Agencies earn a small commission on gifts you receive — your beans are not reduced beyond the published rate.',
                  style: TextStyle(color: BBColors.inkMuted),
                ),
                const SizedBox(height: 12),
                TextField(
                  decoration: const InputDecoration(
                    prefixIcon: Icon(Icons.search),
                    hintText: 'Search agencies',
                  ),
                  onSubmitted: _search,
                ),
                const SizedBox(height: 8),
                for (final a in _results)
                  ListTile(
                    leading: const CircleAvatar(
                      backgroundColor: BBColors.champagne,
                      child: Icon(
                        Icons.groups_2_outlined,
                        color: BBColors.bronze,
                      ),
                    ),
                    title: Text(a.str('name')),
                    subtitle: Text('${a.integer('memberCount')} hosts'),
                    trailing: TextButton(
                      onPressed: () async {
                        try {
                          await ref.read(economyRepo).joinAgency(a.str('id'));
                          if (context.mounted) {
                            showMessage(context, 'Application sent');
                          }
                        } catch (e) {
                          if (context.mounted) showError(context, e);
                        }
                      },
                      child: const Text('Apply'),
                    ),
                  ),
              ],
            ),
    );
  }
}
