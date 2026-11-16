import 'dart:io';

import 'package:flutter_cache_manager/flutter_cache_manager.dart';
import 'package:gal/gal.dart';
import 'package:path_provider/path_provider.dart';

/// A save to the device gallery that didn't happen; [toString] is the line to show.
class GallerySaveException implements Exception {
  const GallerySaveException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Saves a photo or video from a URL to the device's Photos / Gallery, in the
/// [album] album.
///
/// The file comes from the same cache `CachedNetworkImage` uses, so a photo already on
/// screen is not downloaded again. `gal` asks for access the first time.
abstract final class GallerySaver {
  static const album = 'BigBoss Live';

  static Future<void> save(String url, {bool isVideo = false}) async {
    final File file;
    try {
      file = await DefaultCacheManager().getSingleFile(url);
    } catch (_) {
      throw const GallerySaveException(
        'Couldn’t download it. Check your connection and try again.',
      );
    }
    if (!await Gal.hasPermission(toAlbum: true) &&
        !await Gal.requestPermission(toAlbum: true)) {
      throw const GallerySaveException(
        'Allow photo access in Settings to save to your gallery.',
      );
    }
    try {
      if (isVideo) {
        await Gal.putVideo(await _withExtension(file, '.mp4'), album: album);
      } else {
        // The format is read from the bytes, so a cached file without an extension works.
        await Gal.putImageBytes(
          await file.readAsBytes(),
          album: album,
          name: 'bigboss_${DateTime.now().millisecondsSinceEpoch}',
        );
      }
    } on GalException catch (e) {
      throw GallerySaveException(switch (e.type) {
        GalExceptionType.permissionDenied =>
          'Allow photo access in Settings to save to your gallery.',
        GalExceptionType.notEnoughSpace => 'Not enough storage on this device.',
        GalExceptionType.notSupportedFormat =>
          'This file type can’t be saved to the gallery.',
        GalExceptionType.unexpected => 'Couldn’t save it. Please try again.',
      });
    }
  }

  /// `Gal.putVideo` needs the extension in the path; cached files may not have one.
  static Future<String> _withExtension(File file, String ext) async {
    final name = file.uri.pathSegments.last;
    if (name.contains('.')) return file.path;
    final dir = await getTemporaryDirectory();
    final copy = await file.copy('${dir.path}/$name$ext');
    return copy.path;
  }
}
