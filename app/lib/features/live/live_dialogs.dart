import 'dart:async';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../core/theme/bb_colors.dart';
import '../../core/utils/format.dart';
import '../../core/utils/json.dart';
import '../../core/widgets/widgets.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';
import 'live_room_controller.dart';

/// Dialogs shared by the full live screen and the mini-player. They take a plain
/// [BuildContext] so the mini-player can pass the router's navigator context.

Future<bool> confirmEndLive(BuildContext context) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('End your live?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Keep going'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('End live'),
          ),
        ],
      ),
    ) ??
    false;

Future<void> showLiveSummary(BuildContext context, Json? s) => showDialog<void>(
  context: context,
  builder: (ctx) => AlertDialog(
    title: const Text('Live ended'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _SummaryRow('Duration', Fmt.duration(s?.integer('durationSec') ?? 0)),
        _SummaryRow('Peak viewers', Fmt.full(s?.integer('peakViewers') ?? 0)),
        _SummaryRow('Gifts', Fmt.full(s?.integer('giftCount') ?? 0)),
        _SummaryRow(
          'Beans earned',
          '🫘 ${Fmt.full(s?.integer('giftBeans') ?? 0)}',
        ),
      ],
    ),
    actions: [
      FilledButton(
        onPressed: () => Navigator.pop(ctx),
        child: const Text('Done'),
      ),
    ],
  ),
);

/// Asks the host to accept or decline a PK challenge and sends the answer. Closes itself
/// (as a decline) when the invitation expires.
Future<void> showPkInviteDialog(
  BuildContext context,
  LiveRepository repo,
  PkBattle battle,
) async {
  final from = battle.host(battle.invitedBy) ?? battle.hosts.firstOrNull;
  if (from == null) return;
  final rounds = battle.maxRounds > 1 ? '${battle.maxRounds}-round ' : '';
  final accept = await showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => _ExpiringDialog(
      expiresAt: battle.inviteExpiresAt?.subtract(battle.clockOffset),
      title: 'PK challenge!',
      leading: BBAvatar.user(from.brief, size: 56),
      message:
          '${from.displayName} challenges you to a ${rounds}PK, '
          '${Fmt.duration(battle.durationSec)} per round.',
      decline: 'Decline',
      accept: 'Accept',
    ),
  );
  try {
    await repo.pkRespond(battle.id, accept ?? false);
  } catch (e) {
    // A declined or expired invitation may already be gone; only report failed accepts.
    if (accept == true && context.mounted) showError(context, e);
  }
}

/// A host or room admin invited this viewer on stage.
Future<bool> showSeatInviteDialog(
  BuildContext context,
  SeatInvite invite,
) async =>
    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _ExpiringDialog(
        expiresAt: invite.expiresAt,
        title: 'Join the stage?',
        leading: BBAvatar.user(invite.from, size: 56),
        message:
            '${invite.from.displayName} invited you to go live with them. '
            'Your camera and mic will turn on.',
        decline: 'Not now',
        accept: 'Join',
      ),
    ) ??
    false;

/// Asks for what being on stage needs before joining it: the microphone, and the camera in
/// a video room. Without the mic there is no point joining, so that returns false (with a
/// way to Settings when it is blocked for good). A missing camera only means audio.
Future<bool> ensureStagePermissions(
  BuildContext context, {
  required bool video,
}) async {
  final statuses = await [
    Permission.microphone,
    if (video) Permission.camera,
  ].request();
  final mic = statuses[Permission.microphone];
  if (mic?.isGranted ?? false) return true;
  if (!context.mounted) return false;
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: const Text('Allow microphone access to join the stage'),
        action: (mic?.isPermanentlyDenied ?? false)
            ? const SnackBarAction(
                label: 'Settings',
                onPressed: openAppSettings,
              )
            : null,
      ),
    );
  return false;
}

/// Asks for a locked room's password. Returns null when cancelled.
Future<String?> showRoomPasswordDialog(
  BuildContext context, {
  bool wrong = false,
}) => showDialog<String>(
  context: context,
  builder: (_) => _PasswordDialog(wrong: wrong),
);

class _PasswordDialog extends StatefulWidget {
  const _PasswordDialog({required this.wrong});
  final bool wrong;
  @override
  State<_PasswordDialog> createState() => _PasswordDialogState();
}

class _PasswordDialogState extends State<_PasswordDialog> {
  final _field = TextEditingController();

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  bool get _valid => RegExp(r'^\d{4,6}$').hasMatch(_field.text);

  @override
  Widget build(BuildContext context) => AlertDialog(
    icon: const Icon(Icons.lock_rounded, color: BBColors.goldDeep),
    title: const Text('This live is locked'),
    content: TextField(
      controller: _field,
      autofocus: true,
      keyboardType: TextInputType.number,
      obscureText: true,
      maxLength: 6,
      textAlign: TextAlign.center,
      decoration: InputDecoration(
        hintText: 'Enter the 4–6 digit password',
        counterText: '',
        errorText: widget.wrong && _field.text.isEmpty
            ? 'Wrong password, try again'
            : null,
      ),
      onChanged: (_) => setState(() {}),
      onSubmitted: (v) {
        if (_valid) Navigator.pop(context, v);
      },
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      FilledButton(
        onPressed: _valid ? () => Navigator.pop(context, _field.text) : null,
        child: const Text('Enter'),
      ),
    ],
  );
}

/// Accept/decline dialog with a visible countdown; pops `false` when time runs out.
class _ExpiringDialog extends StatefulWidget {
  const _ExpiringDialog({
    required this.expiresAt,
    required this.title,
    required this.leading,
    required this.message,
    required this.decline,
    required this.accept,
  });
  final DateTime? expiresAt;
  final String title;
  final Widget leading;
  final String message;
  final String decline;
  final String accept;
  @override
  State<_ExpiringDialog> createState() => _ExpiringDialogState();
}

class _ExpiringDialogState extends State<_ExpiringDialog> {
  Timer? _tick;

  int get _left => widget.expiresAt == null
      ? 0
      : widget.expiresAt!.difference(DateTime.now()).inSeconds;

  @override
  void initState() {
    super.initState();
    if (widget.expiresAt == null) return;
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (_left <= 0) {
        _tick?.cancel();
        _close(false);
      } else {
        setState(() {});
      }
    });
  }

  /// Closes *this* dialog. With two invites stacked, a plain pop from the older one's timer
  /// would close (and answer) the newer one instead.
  void _close(bool result) {
    if (!mounted) return;
    final route = ModalRoute.of(context);
    if (route == null) return;
    if (route.isCurrent) {
      Navigator.of(context).pop(result);
    } else if (route.isActive) {
      Navigator.of(context).removeRoute(route, result);
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.title, textAlign: TextAlign.center),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        widget.leading,
        const SizedBox(height: 12),
        Text(widget.message, textAlign: TextAlign.center),
        if (widget.expiresAt != null) ...[
          const SizedBox(height: 8),
          Text(
            '${_left.clamp(0, 999)}s',
            style: const TextStyle(color: BBColors.inkMuted),
          ),
        ],
      ],
    ),
    actions: [
      TextButton(onPressed: () => _close(false), child: Text(widget.decline)),
      FilledButton(onPressed: () => _close(true), child: Text(widget.accept)),
    ],
  );
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Row(
      children: [
        Text(label, style: const TextStyle(color: BBColors.inkMuted)),
        const Spacer(),
        Text(value, style: const TextStyle(fontWeight: FontWeight.w700)),
      ],
    ),
  );
}
