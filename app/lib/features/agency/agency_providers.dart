import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_exception.dart';
import '../../core/providers.dart';
import '../../models/models.dart';

/// The agency the signed-in user runs (as owner or agency admin), or null when they run none.
final agencyDashboardProvider = FutureProvider.autoDispose<AgencyDashboard?>((
  ref,
) async {
  try {
    return await ref.watch(agencyRepo).dashboard();
  } on ApiException catch (e) {
    if (e.status == 403) return null;
    rethrow;
  }
});

final agencyMembershipProvider = FutureProvider.autoDispose<AgencyMembership?>(
  (ref) => ref.watch(agencyRepo).membership(),
);

/// Invitations waiting for the signed-in user to accept or decline.
final myAgencyInvitationsProvider =
    FutureProvider.autoDispose<List<AgencyInvitation>>(
      (ref) => ref.watch(agencyRepo).myInvitations(),
    );

final agencyMembersProvider = FutureProvider.autoDispose<List<AgencyMember>>(
  (ref) => ref.watch(agencyRepo).members(),
);

final agencyRequestsProvider = FutureProvider.autoDispose<List<AgencyRequest>>(
  (ref) => ref.watch(agencyRepo).requests(),
);

/// Invitations the agency has sent and that are still open.
final agencySentInvitationsProvider =
    FutureProvider.autoDispose<List<AgencyInvitation>>(
      (ref) => ref.watch(agencyRepo).invitations(),
    );

final agencyAnalyticsProvider = FutureProvider.autoDispose
    .family<AgencyAnalytics, int>(
      (ref, days) => ref.watch(agencyRepo).analytics(days: days),
    );

final agencyHostAnalyticsProvider = FutureProvider.autoDispose
    .family<AgencyAnalytics, String>(
      (ref, uid) => ref.watch(agencyRepo).hostAnalytics(uid),
    );

/// Top hosts for a month ("YYYY-MM"); null is the current month.
final agencyLeaderboardProvider = FutureProvider.autoDispose
    .family<AgencyLeaderboard, String?>(
      (ref, periodKey) =>
          ref.watch(agencyRepo).leaderboard(periodKey: periodKey),
    );

/// Home-screen slider: this month's ranking.
final topAgenciesProvider = FutureProvider.autoDispose<List<TopAgency>>(
  (ref) => ref.watch(agencyRepo).top(),
);

/// Re-read everything an agency screen shows, e.g. after an action or an agency push.
void refreshAgency(WidgetRef ref) {
  ref
    ..invalidate(agencyDashboardProvider)
    ..invalidate(agencyMembershipProvider)
    ..invalidate(myAgencyInvitationsProvider)
    ..invalidate(agencyMembersProvider)
    ..invalidate(agencyRequestsProvider)
    ..invalidate(agencySentInvitationsProvider)
    ..invalidate(agencyAnalyticsProvider)
    ..invalidate(agencyHostAnalyticsProvider)
    ..invalidate(agencyLeaderboardProvider);
}
