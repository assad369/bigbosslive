import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';

/// Bottom navigation: Live · Feed · [Go live] · Messages · Me.
class HomeShell extends ConsumerStatefulWidget {
  const HomeShell({super.key, required this.shell});
  final StatefulNavigationShell shell;

  @override
  ConsumerState<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends ConsumerState<HomeShell> {
  StreamSubscription<Map<String, dynamic>>? _wallet;

  @override
  void initState() {
    super.initState();
    // Server-side balance changes (recharges, agent top-ups) refresh the profile.
    _wallet = ref
        .read(socketProvider)
        .on('wallet:updated')
        .listen((_) => ref.read(sessionProvider.notifier).refresh());
  }

  @override
  void dispose() {
    _wallet?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final unread = ref.watch(unreadProvider).value;
    final index = widget.shell.currentIndex;
    // Shell branches 0..3 map to nav slots 0,1,3,4; slot 2 is the go-live button.
    final slot = index >= 2 ? index + 1 : index;

    Widget badge(int count, Widget icon) => count > 0
        ? Badge(
            label: Text(count > 99 ? '99+' : '$count'),
            backgroundColor: BBColors.danger,
            child: icon,
          )
        : icon;

    return Scaffold(
      body: widget.shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: slot,
        height: 68,
        onDestinationSelected: (i) {
          if (i == 2) {
            context.push('/go-live');
            return;
          }
          final branch = i > 2 ? i - 1 : i;
          widget.shell.goBranch(branch, initialLocation: branch == index);
        },
        destinations: [
          const NavigationDestination(
            icon: Icon(Icons.live_tv_outlined),
            selectedIcon: Icon(Icons.live_tv_rounded),
            label: 'Live',
          ),
          const NavigationDestination(
            icon: Icon(Icons.auto_awesome_outlined),
            selectedIcon: Icon(Icons.auto_awesome),
            label: 'Moments',
          ),
          NavigationDestination(
            icon: Container(
              width: 52,
              height: 40,
              decoration: BoxDecoration(
                gradient: BBColors.goldGradient,
                borderRadius: BorderRadius.circular(14),
                boxShadow: const [
                  BoxShadow(
                    color: BBColors.goldShadow,
                    blurRadius: 10,
                    offset: Offset(0, 4),
                  ),
                ],
              ),
              child: const Icon(Icons.videocam_rounded, color: BBColors.ink),
            ),
            label: 'Go live',
          ),
          NavigationDestination(
            icon: badge(
              unread?.chat ?? 0,
              const Icon(Icons.chat_bubble_outline_rounded),
            ),
            selectedIcon: const Icon(Icons.chat_bubble_rounded),
            label: 'Messages',
          ),
          NavigationDestination(
            icon: badge(
              unread?.notifications ?? 0,
              const Icon(Icons.person_outline_rounded),
            ),
            selectedIcon: const Icon(Icons.person_rounded),
            label: 'Me',
          ),
        ],
      ),
    );
  }
}
