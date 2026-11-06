import 'dart:async';
import 'dart:ui' show ImageFilter;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/bb_colors.dart';
import 'camera_filters.dart';

/// Called with new beauty settings. [persist] is false while a slider is being dragged
/// (stream it, but don't write it yet) and true once the user lets go or resets.
typedef BeautyChanged = void Function(
  BeautyParams beauty, {
  required bool persist,
});

/// Opens the beauty & filter sheet over the camera picture: the filter strip and, while
/// Whitening & Beautify is picked, its Smooth / Whiten / Rosy sliders. Changes apply live.
Future<void> showFilterSheet(
  BuildContext context, {
  required String filterId,
  required BeautyParams beauty,
  required ValueChanged<CameraFilter> onFilter,
  required BeautyChanged onBeauty,
}) => showModalBottomSheet<void>(
  context: context,
  backgroundColor: BBColors.espressoShade,
  // Keep the camera picture clear: the user is judging how it looks.
  barrierColor: Colors.transparent,
  isScrollControlled: true,
  builder: (_) => CameraFilterSheet(
    filterId: filterId,
    beauty: beauty,
    onFilter: onFilter,
    onBeauty: onBeauty,
  ),
);

class CameraFilterSheet extends StatefulWidget {
  const CameraFilterSheet({
    super.key,
    required this.filterId,
    required this.beauty,
    required this.onFilter,
    required this.onBeauty,
  });

  final String filterId;
  final BeautyParams beauty;
  final ValueChanged<CameraFilter> onFilter;
  final BeautyChanged onBeauty;

  @override
  State<CameraFilterSheet> createState() => _CameraFilterSheetState();
}

class _CameraFilterSheetState extends State<CameraFilterSheet> {
  /// iOS rebuilds a 32³ colour cube per change, so drags are streamed at most this often.
  static const _throttle = Duration(milliseconds: 60);

  late String _filterId = widget.filterId;
  late BeautyParams _beauty = widget.beauty;
  Timer? _timer;
  BeautyParams? _pending;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _pick(CameraFilter f) {
    setState(() => _filterId = f.id);
    widget.onFilter(f);
  }

  void _drag(BeautyParams b) {
    setState(() => _beauty = b);
    _pending = b;
    if (_timer?.isActive ?? false) return;
    _flush();
    _timer = Timer(_throttle, _flush);
  }

  void _flush() {
    final b = _pending;
    _pending = null;
    if (b != null) widget.onBeauty(b, persist: false);
  }

  void _commit(BeautyParams b) {
    _timer?.cancel();
    _pending = null;
    setState(() => _beauty = b);
    widget.onBeauty(b, persist: true);
  }

  @override
  Widget build(BuildContext context) {
    final showSliders = CameraFilters.byId(_filterId).hasBeauty;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.only(bottom: 12),
              child: Text(
                'Beauty & filters',
                style: TextStyle(
                  color: BBColors.ivory,
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            FilterPicker(selectedId: _filterId, onSelected: _pick),
            AnimatedSize(
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOutCubic,
              child: showSliders
                  ? BeautySliders(
                      beauty: _beauty,
                      onChanged: _drag,
                      onChangeEnd: _commit,
                    )
                  : const SizedBox(width: double.infinity),
            ),
          ],
        ),
      ),
    );
  }
}

/// Smooth / Whiten / Rosy, 0–100, with a reset to the preset.
class BeautySliders extends StatelessWidget {
  const BeautySliders({
    super.key,
    required this.beauty,
    required this.onChanged,
    required this.onChangeEnd,
  });

  final BeautyParams beauty;
  final ValueChanged<BeautyParams> onChanged;
  final ValueChanged<BeautyParams> onChangeEnd;

  @override
  Widget build(BuildContext context) {
    Widget slider(
      String label,
      double value,
      BeautyParams Function(double v) update,
    ) => _BeautySlider(
      label: label,
      value: value,
      onChanged: (v) => onChanged(update(v)),
      onChangeEnd: (v) => onChangeEnd(update(v)),
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 0),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          slider(
            'Smooth',
            beauty.smoothing,
            (v) => beauty.copyWith(smoothing: v),
          ),
          slider(
            'Whiten',
            beauty.whitening,
            (v) => beauty.copyWith(whitening: v),
          ),
          slider('Rosy', beauty.redness, (v) => beauty.copyWith(redness: v)),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: beauty == BeautyParams.preset
                  ? null
                  : () => onChangeEnd(BeautyParams.preset),
              icon: const Icon(Icons.restart_alt_rounded, size: 18),
              label: const Text('Reset'),
              style: TextButton.styleFrom(
                foregroundColor: BBColors.goldLight,
                disabledForegroundColor: BBColors.inkSubtle,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BeautySlider extends StatelessWidget {
  const _BeautySlider({
    required this.label,
    required this.value,
    required this.onChanged,
    required this.onChangeEnd,
  });

  final String label;
  final double value;
  final ValueChanged<double> onChanged;
  final ValueChanged<double> onChangeEnd;

  @override
  Widget build(BuildContext context) {
    final percent = (value * 100).round();
    return Row(
      children: [
        SizedBox(
          width: 64,
          child: Text(label, style: const TextStyle(color: BBColors.ivory)),
        ),
        Expanded(
          child: Slider(
            value: value,
            divisions: 100,
            label: '$percent',
            semanticFormatterCallback: (v) => '$label ${(v * 100).round()}%',
            activeColor: BBColors.gold,
            inactiveColor: BBColors.champagneVeil,
            thumbColor: BBColors.goldLight,
            onChanged: onChanged,
            onChangeEnd: onChangeEnd,
          ),
        ),
        SizedBox(
          width: 36,
          child: Text(
            '$percent',
            textAlign: TextAlign.end,
            style: const TextStyle(
              color: BBColors.champagne,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
        ),
      ],
    );
  }
}

/// Horizontal strip of filter thumbnails. Each thumbnail renders the user's avatar (or a
/// sample scene) through the filter's own colour matrix, so the preview matches the stream.
class FilterPicker extends ConsumerStatefulWidget {
  const FilterPicker({
    super.key,
    required this.selectedId,
    required this.onSelected,
  });

  final String selectedId;
  final ValueChanged<CameraFilter> onSelected;

  @override
  ConsumerState<FilterPicker> createState() => _FilterPickerState();
}

class _FilterPickerState extends ConsumerState<FilterPicker> {
  static const _itemExtent = 72.0;
  late final _scroll = ScrollController(
    initialScrollOffset: _offsetFor(widget.selectedId),
  );

  /// Opens with the picked filter in view, one tile in from the left edge.
  double _offsetFor(String id) {
    final i = CameraFilters.all.indexWhere((f) => f.id == id);
    return i <= 1 ? 0 : (i - 1) * _itemExtent;
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final avatar = ref.watch(meProvider.select((m) => m.brief.avatarUrl));
    return SizedBox(
      height: 96,
      child: ListView.builder(
        controller: _scroll,
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        itemExtent: _itemExtent,
        itemCount: CameraFilters.all.length,
        itemBuilder: (context, i) {
          final f = CameraFilters.all[i];
          final selected = f.id == widget.selectedId;
          return Semantics(
            button: true,
            selected: selected,
            label: '${f.name} filter',
            excludeSemantics: true,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => widget.onSelected(f),
              child: Column(
                children: [
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    width: 60,
                    height: 60,
                    padding: const EdgeInsets.all(2),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected ? BBColors.gold : BBColors.goldOutline,
                        width: selected ? 3 : 1,
                      ),
                    ),
                    child: ClipOval(
                      child: f.isNone
                          ? const _NoneThumb()
                          : _FilteredThumb(filter: f, avatarUrl: avatar),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    f.name,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 11,
                      height: 1.1,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w400,
                      color: selected ? BBColors.goldLight : BBColors.ivory,
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _NoneThumb extends StatelessWidget {
  const _NoneThumb();

  @override
  Widget build(BuildContext context) => const ColoredBox(
    color: BBColors.scrim,
    child: Center(
      child: Icon(Icons.block_rounded, color: BBColors.champagne, size: 26),
    ),
  );
}

class _FilteredThumb extends StatelessWidget {
  const _FilteredThumb({required this.filter, this.avatarUrl});
  final CameraFilter filter;
  final String? avatarUrl;

  /// Beauty is a native skin effect; the thumbnail approximates it with a soft blur and a
  /// bright, rosy lift.
  static final _beautyLook = ColorMatrix.chain([
    ColorMatrix.brightness(1.08),
    ColorMatrix.tint(255, 214, 220, 0.08),
  ]);

  @override
  Widget build(BuildContext context) {
    final url = avatarUrl;
    Widget image = url == null || url.isEmpty
        ? const _SampleScene()
        : CachedNetworkImage(
            imageUrl: url,
            fit: BoxFit.cover,
            memCacheWidth: (60 * MediaQuery.devicePixelRatioOf(context))
                .round(),
            errorWidget: (_, _, _) => const _SampleScene(),
          );
    if (filter.hasBeauty) {
      image = ColorFiltered(
        colorFilter: ColorFilter.matrix(_beautyLook.values),
        child: ImageFiltered(
          imageFilter: ImageFilter.blur(
            sigmaX: 0.8,
            sigmaY: 0.8,
            tileMode: TileMode.clamp,
          ),
          child: image,
        ),
      );
    }
    return Stack(
      fit: StackFit.expand,
      children: [
        ColorFiltered(
          colorFilter: ColorFilter.matrix(filter.matrix.values),
          child: image,
        ),
        if (filter.hasBeauty)
          const Align(
            alignment: Alignment(0.55, -0.55),
            child: Icon(
              Icons.auto_awesome,
              color: BBColors.ivory,
              size: 16,
              shadows: [Shadow(color: BBColors.scrim, blurRadius: 4)],
            ),
          ),
        if (filter.vignette > 0)
          DecoratedBox(
            decoration: BoxDecoration(
              gradient: RadialGradient(
                colors: [
                  Colors.transparent,
                  BBColors.espresso.withValues(alpha: filter.vignette),
                ],
                stops: const [0.55, 1],
              ),
            ),
          ),
      ],
    );
  }
}

/// Sky, skin tones and foliage: enough colour range to tell the looks apart without a
/// bundled photo.
class _SampleScene extends StatelessWidget {
  const _SampleScene();

  @override
  Widget build(BuildContext context) => const DecoratedBox(
    decoration: BoxDecoration(gradient: BBColors.filterSampleGradient),
  );
}
