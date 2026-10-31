import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

import '../widgets/widgets.dart';
import 'deep_link.dart';

/// Opens the system share sheet with [message] and the link's URL. [context] anchors the
/// popover on iPad (required there, harmless elsewhere).
Future<void> shareDeepLink(
  BuildContext context,
  DeepLink link,
  String message,
) async {
  final box = context.findRenderObject() as RenderBox?;
  final origin = box != null && box.hasSize
      ? box.localToGlobal(Offset.zero) & box.size
      : null;
  final url = link.shareUri.toString();
  try {
    await SharePlus.instance.share(
      ShareParams(
        text: '$message\n$url',
        subject: message,
        sharePositionOrigin: origin,
      ),
    );
  } catch (_) {
    if (context.mounted) showMessage(context, 'Couldn’t open the share sheet');
  }
}
