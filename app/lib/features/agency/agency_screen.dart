import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/widgets/widgets.dart';
import 'agency_providers.dart';
import 'member_view.dart';
import 'owner_dashboard.dart';

/// Host agency hub. Owners and agency admins get the dashboard; everyone else sees their
/// membership, pending invitations, or agencies to apply to.
class AgencyScreen extends ConsumerStatefulWidget {
  const AgencyScreen({super.key});

  @override
  ConsumerState<AgencyScreen> createState() => _AgencyScreenState();
}

class _AgencyScreenState extends ConsumerState<AgencyScreen> {
  StreamSubscription<Map<String, dynamic>>? _push;

  @override
  void initState() {
    super.initState();
    // Applications, invitations and decisions arrive as `agency` notifications.
    _push = ref.read(socketProvider).on('notification:new').listen((n) {
      if (n['type'] == 'agency' && mounted) refreshAgency(ref);
    });
  }

  @override
  void dispose() {
    unawaited(_push?.cancel());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dash = ref.watch(agencyDashboardProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Host agency'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: () => refreshAgency(ref),
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: AsyncView(
        value: dash,
        onRetry: () => ref.invalidate(agencyDashboardProvider),
        data: (d) =>
            d != null ? AgencyDashboardView(dash: d) : const AgencyMemberView(),
      ),
    );
  }
}
