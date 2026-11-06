#import <Flutter/Flutter.h>

NS_ASSUME_NONNULL_BEGIN

/// `bigboss/camera_filter`: applies a camera filter (optional skin beautification, a colour matrix
/// and a vignette) to a flutter_webrtc local video track, before the preview and the encoder.
/// The Dart side is app/lib/features/live/camera_filter_channel.dart.
@interface CameraFilterPlugin : NSObject <FlutterPlugin>
@end

NS_ASSUME_NONNULL_END
