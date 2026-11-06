import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';

/// An image's real type, read from its magic bytes. File extensions can't be trusted:
/// Android's picker writes re-encoded JPEG bytes under the original `.gif`/`.webp` name.
enum ImageKind { jpeg, png, gif, webp, animatedWebp, other }

/// Bytes [sniffImageKind] needs to see.
const sniffLength = 32;

/// Longest side of a still avatar after downscaling.
const avatarMaxDimension = 720;

/// Largest avatar the server presigns (`UPLOAD_KINDS.avatar` in `backend/src/routes/content.ts`).
const avatarMaxBytes = 5 * 1024 * 1024;

ImageKind sniffImageKind(Uint8List b) {
  bool ascii(int at, String s) {
    if (b.length < at + s.length) return false;
    for (var i = 0; i < s.length; i++) {
      if (b[at + i] != s.codeUnitAt(i)) return false;
    }
    return true;
  }

  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return ImageKind.gif;
  if (b.length >= 8 &&
      b[0] == 0x89 &&
      ascii(1, 'PNG') &&
      b[4] == 0x0D &&
      b[5] == 0x0A &&
      b[6] == 0x1A &&
      b[7] == 0x0A) {
    return ImageKind.png;
  }
  if (b.length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) {
    return ImageKind.jpeg;
  }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    // Extended WebP (VP8X) keeps its feature flags in the first payload byte;
    // 0x02 marks an animation.
    final animated = ascii(12, 'VP8X') && b.length > 20 && b[20] & 0x02 != 0;
    return animated ? ImageKind.animatedWebp : ImageKind.webp;
  }
  return ImageKind.other;
}

String mimeFor(ImageKind k) => switch (k) {
  ImageKind.gif => 'image/gif',
  ImageKind.webp || ImageKind.animatedWebp => 'image/webp',
  ImageKind.png => 'image/png',
  ImageKind.jpeg || ImageKind.other => 'image/jpeg',
};

String _extFor(ImageKind k) => switch (k) {
  ImageKind.gif => 'gif',
  ImageKind.webp || ImageKind.animatedWebp => 'webp',
  ImageKind.png => 'png',
  ImageKind.jpeg || ImageKind.other => 'jpg',
};

class PickedAvatar {
  const PickedAvatar({
    required this.file,
    required this.contentType,
    required this.animated,
  });
  final File file;
  final String contentType;
  final bool animated;
}

/// An animated picture over [avatarMaxBytes]. Animations are uploaded as they are, so
/// they can't be shrunk to fit.
class AvatarTooLarge implements Exception {
  const AvatarTooLarge();
  @override
  String toString() => 'Animated pictures must be under 5 MB';
}

/// The picked file isn't an image we can decode.
class AvatarUnreadable implements Exception {
  const AvatarUnreadable();
  @override
  String toString() => 'Couldn\'t read that picture';
}

Future<XFile?> _pickFromGallery() => ImagePicker().pickImage(
  source: ImageSource.gallery,
  requestFullMetadata: false,
);

/// Picks a profile picture from the gallery.
///
/// The picker is asked for the original file: its own resizing (`maxWidth`,
/// `imageQuality`) flattens a GIF to one frame on Android. Animated GIF/WebP files are
/// then kept byte for byte so they stay animated, and stills are downscaled here to fit
/// [avatarMaxDimension].
Future<PickedAvatar?> pickAvatar({
  Future<XFile?> Function() pick = _pickFromGallery,
}) async {
  final x = await pick();
  if (x == null) return null;
  return prepareAvatar(File(x.path));
}

/// The upload-ready form of [source]; see [pickAvatar].
Future<PickedAvatar> prepareAvatar(File source) async {
  final head = await _head(source);
  final kind = sniffImageKind(head);
  if (kind == ImageKind.gif || kind == ImageKind.animatedWebp) {
    if (await source.length() > avatarMaxBytes) throw const AvatarTooLarge();
    return PickedAvatar(
      file: source,
      contentType: mimeFor(kind),
      animated: true,
    );
  }
  return _downscaleStill(source, kind);
}

Future<Uint8List> _head(File f) async {
  final raf = await f.open();
  try {
    return await raf.read(sniffLength);
  } finally {
    await raf.close();
  }
}

Future<PickedAvatar> _downscaleStill(File source, ImageKind kind) async {
  final bytes = await source.readAsBytes();
  final ui.Codec codec;
  var resized = false;
  try {
    final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    // Decoded natively: honours EXIF orientation and reads HEIC/HEIF too.
    codec = await ui.instantiateImageCodecWithSize(
      buffer,
      getTargetSize: (w, h) {
        final longest = w > h ? w : h;
        if (longest <= avatarMaxDimension) return const ui.TargetImageSize();
        resized = true;
        final scale = avatarMaxDimension / longest;
        return ui.TargetImageSize(
          width: (w * scale).round(),
          height: (h * scale).round(),
        );
      },
    );
  } catch (_) {
    throw const AvatarUnreadable();
  }
  final ui.Image image;
  try {
    image = (await codec.getNextFrame()).image;
  } catch (_) {
    throw const AvatarUnreadable();
  } finally {
    codec.dispose();
  }

  try {
    // Already small and in a type the server takes: upload it unchanged.
    if (!resized &&
        (kind == ImageKind.jpeg ||
            kind == ImageKind.png ||
            kind == ImageKind.webp)) {
      return PickedAvatar(
        file: source,
        contentType: mimeFor(kind),
        animated: false,
      );
    }
    // PNG keeps its transparency; everything else becomes a JPEG.
    final outKind = kind == ImageKind.png ? ImageKind.png : ImageKind.jpeg;
    final Uint8List out;
    if (outKind == ImageKind.png) {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) throw const AvatarUnreadable();
      out = data.buffer.asUint8List();
    } else {
      final rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (rgba == null) throw const AvatarUnreadable();
      out = await compute(
        _encodeJpeg,
        _Rgba(rgba.buffer.asUint8List(), image.width, image.height),
      );
    }
    final dir = await Directory.systemTemp.createTemp('avatar');
    final file = File('${dir.path}/avatar.${_extFor(outKind)}');
    await file.writeAsBytes(out, flush: true);
    return PickedAvatar(
      file: file,
      contentType: mimeFor(outKind),
      animated: false,
    );
  } finally {
    image.dispose();
  }
}

class _Rgba {
  const _Rgba(this.bytes, this.width, this.height);
  final Uint8List bytes;
  final int width;
  final int height;
}

Uint8List _encodeJpeg(_Rgba p) => img.encodeJpg(
  img.Image.fromBytes(
    width: p.width,
    height: p.height,
    bytes: p.bytes.buffer,
    numChannels: 4,
    order: img.ChannelOrder.rgba,
  ),
  quality: 85,
);
