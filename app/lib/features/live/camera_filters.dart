import 'dart:math' as math;

import 'package:flutter/foundation.dart';

/// A 4×5 RGBA colour matrix in Flutter's [ColorFilter.matrix] layout (row-major, offsets in 0–255).
/// The same values drive the thumbnails and the native camera processors
/// (plugins/bb_camera_filter), so what is picked is what streams.
@immutable
class ColorMatrix {
  const ColorMatrix(this.values);
  final List<double> values;

  static const identity = ColorMatrix([
    1, 0, 0, 0, 0, //
    0, 1, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 1, 0,
  ]);

  /// RGB-only 3×3 matrix plus RGB offsets (0–255); alpha untouched.
  factory ColorMatrix.rgb(
    List<double> m, [
    List<double> offset = const [0, 0, 0],
  ]) => ColorMatrix([
    m[0], m[1], m[2], 0, offset[0], //
    m[3], m[4], m[5], 0, offset[1],
    m[6], m[7], m[8], 0, offset[2],
    0, 0, 0, 1, 0,
  ]);

  factory ColorMatrix.brightness(double b) =>
      ColorMatrix.rgb([b, 0, 0, 0, b, 0, 0, 0, b]);

  factory ColorMatrix.contrast(double c) {
    final o = (0.5 - 0.5 * c) * 255;
    return ColorMatrix.rgb([c, 0, 0, 0, c, 0, 0, 0, c], [o, o, o]);
  }

  /// CSS `saturate()`.
  factory ColorMatrix.saturate(double s) => ColorMatrix.rgb([
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, //
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ]);

  /// CSS `sepia()` (amount 0–1).
  factory ColorMatrix.sepia(double a) => _mix(const [
    0.393,
    0.769,
    0.189,
    0.349,
    0.686,
    0.168,
    0.272,
    0.534,
    0.131,
  ], a);

  /// CSS `grayscale()` (amount 0–1).
  factory ColorMatrix.grayscale(double a) => _mix(const [
    0.2126,
    0.7152,
    0.0722,
    0.2126,
    0.7152,
    0.0722,
    0.2126,
    0.7152,
    0.0722,
  ], a);

  /// CSS `hue-rotate()`.
  factory ColorMatrix.hueRotate(double degrees) {
    final r = degrees * math.pi / 180;
    final c = math.cos(r), s = math.sin(r);
    return ColorMatrix.rgb([
      0.213 + c * 0.787 - s * 0.213,
      0.715 - c * 0.715 - s * 0.715,
      0.072 - c * 0.072 + s * 0.928, //
      0.213 - c * 0.213 + s * 0.143,
      0.715 + c * 0.285 + s * 0.140,
      0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787,
      0.715 - c * 0.715 + s * 0.715,
      0.072 + c * 0.928 + s * 0.072,
    ]);
  }

  /// Blends toward a flat colour (the linear part of CSSgram's colour overlays).
  factory ColorMatrix.tint(int r, int g, int b, double amount) {
    final k = 1 - amount;
    return ColorMatrix.rgb(
      [k, 0, 0, 0, k, 0, 0, 0, k],
      [r * amount, g * amount, b * amount],
    );
  }

  static ColorMatrix _mix(List<double> m, double a) => ColorMatrix.rgb([
    for (var i = 0; i < 9; i++) (i % 4 == 0 ? 1 - a : 0) + a * m[i],
  ]);

  /// Applies `this` first, then [next] (i.e. next × this).
  ColorMatrix then(ColorMatrix next) {
    final a = next.values, b = values;
    final out = List<double>.filled(20, 0);
    for (var row = 0; row < 4; row++) {
      for (var col = 0; col < 5; col++) {
        var sum = 0.0;
        for (var k = 0; k < 4; k++) {
          sum += a[row * 5 + k] * b[k * 5 + col];
        }
        out[row * 5 + col] = sum + (col == 4 ? a[row * 5 + 4] : 0);
      }
    }
    return ColorMatrix(out);
  }

  static ColorMatrix chain(List<ColorMatrix> steps) =>
      steps.fold(identity, (m, s) => m.then(s));
}

/// Face beautification ("basic beauty"), applied natively before the colour matrix and only on
/// skin-toned pixels (a YCbCr skin mask), so eyes, hair and the background stay sharp. Every
/// amount is 0–1.
@immutable
class BeautyParams {
  const BeautyParams({
    required this.smoothing,
    required this.whitening,
    required this.redness,
  }) : assert(smoothing >= 0 && smoothing <= 1),
       assert(whitening >= 0 && whitening <= 1),
       assert(redness >= 0 && redness <= 1);

  /// Clamps each amount to 0–1; NaN and infinities become 0.
  factory BeautyParams.clamped({
    required double smoothing,
    required double whitening,
    required double redness,
  }) => BeautyParams(
    smoothing: _unit(smoothing),
    whitening: _unit(whitening),
    redness: _unit(redness),
  );

  /// Reads a stored map. Missing or malformed amounts take the [preset] value.
  factory BeautyParams.fromMap(Map<String, Object?> map) {
    double read(String key, double fallback) {
      final v = map[key];
      return v is num && v.isFinite ? v.toDouble() : fallback;
    }

    return BeautyParams.clamped(
      smoothing: read('smoothing', preset.smoothing),
      whitening: read('whitening', preset.whitening),
      redness: read('redness', preset.redness),
    );
  }

  /// The "Whitening & Beautify" look before the user adjusts it.
  static const preset = BeautyParams(
    smoothing: 0.6,
    whitening: 0.35,
    redness: 0.15,
  );

  /// Edge-preserving skin smoothing.
  final double smoothing;

  /// Log-curve brightening of skin (plus a gentle global lift).
  final double whitening;

  /// Rosy tint on skin.
  final double redness;

  bool get isOff => smoothing == 0 && whitening == 0 && redness == 0;

  BeautyParams copyWith({
    double? smoothing,
    double? whitening,
    double? redness,
  }) => BeautyParams.clamped(
    smoothing: smoothing ?? this.smoothing,
    whitening: whitening ?? this.whitening,
    redness: redness ?? this.redness,
  );

  Map<String, double> toMap() => {
    'smoothing': smoothing,
    'whitening': whitening,
    'redness': redness,
  };

  static double _unit(double v) => v.isFinite ? v.clamp(0.0, 1.0) : 0.0;

  @override
  bool operator ==(Object other) =>
      other is BeautyParams &&
      other.smoothing == smoothing &&
      other.whitening == whitening &&
      other.redness == redness;

  @override
  int get hashCode => Object.hash(smoothing, whitening, redness);

  @override
  String toString() =>
      'BeautyParams(smoothing: $smoothing, whitening: $whitening, redness: $redness)';
}

@immutable
class CameraFilter {
  const CameraFilter._(
    this.id,
    this.name,
    this.matrix, {
    this.vignette = 0,
    this.beauty,
  });
  final String id;
  final String name;
  final ColorMatrix matrix;

  /// Edge darkening, 0–1 (applied natively; thumbnails approximate it with a gradient).
  final double vignette;

  /// Skin smoothing / whitening applied before [matrix]; null for plain colour looks. For the
  /// beauty tile this is the default; the user's slider values replace it when streaming.
  final BeautyParams? beauty;

  bool get isNone => id == CameraFilters.none.id;
  bool get hasBeauty => beauty != null;
}

typedef _M = ColorMatrix;

/// Whitening & Beautify (the default), then Instagram-style looks (after the CSSgram recipes) and two colour pops.
abstract final class CameraFilters {
  static const none = CameraFilter._('none', 'None', ColorMatrix.identity);

  /// Streams the user's own [BeautyParams] (the sliders), starting from [BeautyParams.preset].
  static const beauty = CameraFilter._(
    'beauty',
    'Whitening & Beautify',
    ColorMatrix.identity,
    beauty: BeautyParams.preset,
  );

  /// Used until the user picks a filter, and for ids that no longer exist.
  static const defaultFilter = beauty;

  static final all = <CameraFilter>[
    none,
    beauty,
    CameraFilter._(
      'addictive_blue',
      'Addictive Blue',
      _M.chain([
        _M.contrast(1.1),
        _M.saturate(1.15),
        _M.hueRotate(-8),
        _M.tint(0, 110, 255, 0.16),
      ]),
    ),
    CameraFilter._(
      'addictive_red',
      'Addictive Red',
      _M.chain([
        _M.contrast(1.1),
        _M.saturate(1.2),
        _M.tint(255, 40, 70, 0.16),
      ]),
    ),
    CameraFilter._(
      'aden',
      'Aden',
      _M.chain([
        _M.hueRotate(-20),
        _M.contrast(0.9),
        _M.saturate(0.85),
        _M.brightness(1.2),
        _M.tint(66, 10, 14, 0.05),
      ]),
    ),
    CameraFilter._(
      'amaro',
      'Amaro',
      _M.chain([
        _M.hueRotate(-10),
        _M.contrast(0.9),
        _M.brightness(1.1),
        _M.saturate(1.5),
      ]),
    ),
    CameraFilter._(
      'ashby',
      'Ashby',
      _M.chain([
        _M.sepia(0.5),
        _M.contrast(1.2),
        _M.saturate(1.8),
        _M.tint(125, 105, 24, 0.1),
      ]),
    ),
    CameraFilter._(
      'brooklyn',
      'Brooklyn',
      _M.chain([
        _M.contrast(0.9),
        _M.brightness(1.1),
        _M.tint(168, 223, 193, 0.12),
      ]),
    ),
    CameraFilter._(
      'charmes',
      'Charmes',
      _M.chain([
        _M.sepia(0.25),
        _M.contrast(1.25),
        _M.brightness(1.25),
        _M.hueRotate(5),
        _M.tint(125, 105, 24, 0.1),
      ]),
    ),
    CameraFilter._(
      'clarendon',
      'Clarendon',
      _M.chain([
        _M.contrast(1.2),
        _M.saturate(1.35),
        _M.tint(127, 187, 227, 0.1),
      ]),
    ),
    CameraFilter._(
      'crema',
      'Crema',
      _M.chain([
        _M.sepia(0.5),
        _M.contrast(1.25),
        _M.brightness(1.15),
        _M.saturate(0.9),
        _M.hueRotate(-2),
        _M.tint(125, 105, 24, 0.1),
      ]),
    ),
    CameraFilter._(
      'earlybird',
      'Early Bird',
      _M.chain([_M.contrast(0.9), _M.sepia(0.2), _M.tint(208, 186, 142, 0.15)]),
      vignette: 0.35,
    ),
    CameraFilter._(
      '1977',
      '1977',
      _M.chain([
        _M.contrast(1.1),
        _M.brightness(1.1),
        _M.saturate(1.3),
        _M.tint(243, 106, 188, 0.12),
      ]),
    ),
    CameraFilter._(
      'gingham',
      'Gingham',
      _M.chain([
        _M.brightness(1.05),
        _M.hueRotate(-10),
        _M.tint(230, 230, 250, 0.15),
      ]),
    ),
    CameraFilter._(
      'ginza',
      'Ginza',
      _M.chain([
        _M.sepia(0.25),
        _M.contrast(1.15),
        _M.brightness(1.2),
        _M.saturate(1.35),
        _M.hueRotate(-5),
        _M.tint(125, 105, 24, 0.1),
      ]),
    ),
    CameraFilter._(
      'hefe',
      'Hefe',
      _M.chain([
        _M.sepia(0.4),
        _M.contrast(1.5),
        _M.brightness(1.2),
        _M.saturate(1.4),
        _M.hueRotate(-10),
      ]),
      vignette: 0.3,
    ),
    CameraFilter._(
      'helena',
      'Helena',
      _M.chain([
        _M.sepia(0.5),
        _M.contrast(1.05),
        _M.brightness(1.05),
        _M.saturate(1.35),
        _M.tint(158, 175, 30, 0.08),
      ]),
    ),
    CameraFilter._(
      'hudson',
      'Hudson',
      _M.chain([
        _M.brightness(1.2),
        _M.contrast(0.9),
        _M.saturate(1.1),
        _M.tint(166, 177, 255, 0.12),
      ]),
    ),
    CameraFilter._(
      'inkwell',
      'Inkwell',
      _M.chain([
        _M.sepia(0.3),
        _M.contrast(1.1),
        _M.brightness(1.1),
        _M.grayscale(1),
      ]),
    ),
    CameraFilter._(
      'juno',
      'Juno',
      _M.chain([
        _M.sepia(0.35),
        _M.contrast(1.15),
        _M.brightness(1.15),
        _M.saturate(1.8),
        _M.tint(127, 187, 227, 0.08),
      ]),
    ),
    CameraFilter._(
      'lark',
      'Lark',
      _M.chain([
        _M.contrast(0.9),
        _M.brightness(1.08),
        _M.saturate(1.1),
        _M.tint(242, 242, 242, 0.08),
      ]),
    ),
    CameraFilter._(
      'lofi',
      'Lo-Fi',
      _M.chain([_M.saturate(1.1), _M.contrast(1.5)]),
      vignette: 0.35,
    ),
    CameraFilter._(
      'ludwig',
      'Ludwig',
      _M.chain([
        _M.contrast(1.05),
        _M.brightness(1.05),
        _M.saturate(1.6),
        _M.tint(125, 105, 24, 0.1),
      ]),
    ),
    CameraFilter._(
      'mayfair',
      'Mayfair',
      _M.chain([
        _M.contrast(1.1),
        _M.saturate(1.1),
        _M.tint(255, 200, 200, 0.1),
      ]),
      vignette: 0.2,
    ),
    CameraFilter._(
      'moon',
      'Moon',
      _M.chain([_M.grayscale(1), _M.contrast(1.1), _M.brightness(1.1)]),
    ),
    CameraFilter._(
      'nashville',
      'Nashville',
      _M.chain([
        _M.sepia(0.2),
        _M.contrast(1.2),
        _M.brightness(1.05),
        _M.saturate(1.2),
        _M.tint(247, 176, 153, 0.15),
      ]),
    ),
    CameraFilter._(
      'perpetua',
      'Perpetua',
      _M.chain([_M.contrast(1.05), _M.tint(115, 142, 107, 0.12)]),
    ),
    CameraFilter._(
      'reyes',
      'Reyes',
      _M.chain([
        _M.sepia(0.22),
        _M.brightness(1.1),
        _M.contrast(0.85),
        _M.saturate(0.75),
        _M.tint(239, 205, 173, 0.1),
      ]),
    ),
    CameraFilter._(
      'rise',
      'Rise',
      _M.chain([
        _M.brightness(1.05),
        _M.sepia(0.2),
        _M.contrast(0.9),
        _M.saturate(0.9),
        _M.tint(236, 205, 169, 0.12),
      ]),
    ),
    CameraFilter._(
      'slumber',
      'Slumber',
      _M.chain([
        _M.saturate(0.66),
        _M.brightness(1.05),
        _M.tint(125, 105, 24, 0.12),
      ]),
    ),
    CameraFilter._(
      'stinson',
      'Stinson',
      _M.chain([
        _M.contrast(0.75),
        _M.saturate(0.85),
        _M.brightness(1.15),
        _M.tint(240, 149, 128, 0.08),
      ]),
    ),
    CameraFilter._(
      'toaster',
      'Toaster',
      _M.chain([
        _M.contrast(1.5),
        _M.brightness(0.9),
        _M.tint(128, 78, 15, 0.15),
      ]),
      vignette: 0.4,
    ),
    CameraFilter._(
      'valencia',
      'Valencia',
      _M.chain([
        _M.contrast(1.08),
        _M.brightness(1.08),
        _M.sepia(0.08),
        _M.tint(58, 3, 57, 0.08),
      ]),
    ),
    CameraFilter._(
      'walden',
      'Walden',
      _M.chain([
        _M.brightness(1.1),
        _M.hueRotate(-10),
        _M.sepia(0.3),
        _M.saturate(1.6),
        _M.tint(0, 68, 204, 0.08),
      ]),
    ),
    CameraFilter._(
      'willow',
      'Willow',
      _M.chain([
        _M.grayscale(0.5),
        _M.contrast(0.95),
        _M.brightness(0.9),
        _M.tint(212, 169, 175, 0.1),
      ]),
    ),
    CameraFilter._(
      'xpro2',
      'X-Pro II',
      _M.chain([_M.sepia(0.3), _M.contrast(1.3), _M.saturate(1.2)]),
      vignette: 0.45,
    ),
  ];

  static final Map<String, CameraFilter> _byId = {for (final f in all) f.id: f};

  /// Missing ids (never picked) and unknown ids (e.g. a filter removed in a later release) fall back to [defaultFilter].
  static CameraFilter byId(String? id) => _byId[id] ?? defaultFilter;
}
