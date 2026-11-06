#import <bb_camera_filter/CameraFilterPlugin.h>

#import <CoreImage/CoreImage.h>
#import <Metal/Metal.h>
#import <WebRTC/WebRTC.h>
#import <flutter_webrtc/FlutterWebRTCPlugin.h>
#import <flutter_webrtc/LocalVideoTrack.h>
#import <flutter_webrtc/VideoProcessingAdapter.h>
#import <math.h>
#import <os/lock.h>

#pragma mark - Beauty

// Kept in sync with android/.../FilterProcessor.kt so both platforms produce the same look.

static const int kCubeSize = 32;
/// Whitening log-curve strength at whitening = 1.
static const float kWhiteningGain = 5.f;

/// 0 for NaN and infinities, else clamped to 0–1.
static float Clamp01(float x) { return isfinite(x) ? fminf(fmaxf(x, 0.f), 1.f) : 0.f; }

static float SmoothStep(float e0, float e1, float x) {
  float t = fminf(fmaxf((x - e0) / (e1 - e0), 0.f), 1.f);
  return t * t * (3.f - 2.f * t);
}

/// Soft skin classifier on BT.601 chroma (8-bit Cb 77–127, Cr 133–173), ignoring near-black pixels.
static float SkinMask(float r, float g, float b) {
  float cb = 0.5f - 0.168736f * r - 0.331264f * g + 0.5f * b;
  float cr = 0.5f + 0.5f * r - 0.418688f * g - 0.081312f * b;
  float y = 0.299f * r + 0.587f * g + 0.114f * b;
  return SmoothStep(0.27f, 0.32f, cb) * (1.f - SmoothStep(0.49f, 0.54f, cb)) * SmoothStep(0.50f, 0.545f, cr) *
         (1.f - SmoothStep(0.67f, 0.72f, cr)) * SmoothStep(0.08f, 0.2f, y);
}

/// RGBA float colour cube for CIColorCube (red varies fastest), filled by `fn(r, g, b, out)`.
static NSData *BuildCube(void (^fn)(float r, float g, float b, float *out)) {
  const int n = kCubeSize;
  NSMutableData *data = [NSMutableData dataWithLength:sizeof(float) * 4 * n * n * n];
  float *p = data.mutableBytes;
  for (int bi = 0; bi < n; bi++) {
    for (int gi = 0; gi < n; gi++) {
      for (int ri = 0; ri < n; ri++, p += 4) {
        fn(ri / (float)(n - 1), gi / (float)(n - 1), bi / (float)(n - 1), p);
        p[3] = 1.f;
      }
    }
  }
  return data;
}

/// Skin mask as a grey image.
static NSData *SkinCube(void) {
  static NSData *cube;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    cube = BuildCube(^(float r, float g, float b, float *out) {
      out[0] = out[1] = out[2] = SkinMask(r, g, b);
    });
  });
  return cube;
}

/// Whitening (log curve, mostly on skin) then a rosy tint on skin, as one colour lookup; nil when both are off.
static NSData *_Nullable ToneCube(float whitening, float redness) {
  if (whitening <= 0 && redness <= 0) return nil;
  const float k = kWhiteningGain * whitening;
  const float norm = whitening > 0 ? 1.f / logf(1.f + k) : 0.f;
  return BuildCube(^(float r, float g, float b, float *out) {
    float m = SkinMask(r, g, b);
    float c[3] = {r, g, b};
    const float rosy[3] = {1.12f, 0.95f, 1.02f};
    for (int i = 0; i < 3; i++) {
      if (whitening > 0) c[i] += (logf(1.f + c[i] * k) * norm - c[i]) * (0.3f + 0.7f * m);
      c[i] += (fminf(fmaxf(c[i] * rosy[i], 0.f), 1.f) - c[i]) * redness * m;
      out[i] = c[i];
    }
  });
}

/// CIColorMatrix parameters for `out.rgb = in.rgb × scale + bias` (alpha untouched).
static NSDictionary *Diagonal(CGFloat scale, CGFloat bias) {
  return @{
    @"inputRVector" : [CIVector vectorWithX:scale Y:0 Z:0 W:0],
    @"inputGVector" : [CIVector vectorWithX:0 Y:scale Z:0 W:0],
    @"inputBVector" : [CIVector vectorWithX:0 Y:0 Z:scale W:0],
    @"inputAVector" : [CIVector vectorWithX:0 Y:0 Z:0 W:1],
    @"inputBiasVector" : [CIVector vectorWithX:bias Y:bias Z:bias W:0],
  };
}

#pragma mark - Processor

/// Beauty (skin smoothing, whitening, rosy tint) + colour matrix (Flutter 4×5 layout, offsets 0–255) + vignette,
/// rendered with Core Image on the capture thread. Frames it can't handle, and every frame after a render failure,
/// pass through untouched.
@interface BBCameraFilterProcessor : NSObject <ExternalVideoProcessingDelegate>
- (void)setMatrix:(NSArray<NSNumber *> *)matrix vignette:(float)vignette smoothing:(float)smoothing whitening:(float)whitening redness:(float)redness;
@end

@implementation BBCameraFilterProcessor {
  os_unfair_lock _lock;
  CIVector *_r, *_g, *_b, *_a, *_bias;
  float _vignette;
  float _smoothing;
  NSData *_toneCube;
  CIContext *_context;
  CVPixelBufferPoolRef _pool;
  int _poolWidth, _poolHeight;
  BOOL _failed;
}

- (instancetype)init {
  if (self = [super init]) {
    _lock = OS_UNFAIR_LOCK_INIT;
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    // No colour management: apply the matrix to encoded values, exactly like Flutter's ColorFilter.matrix.
    NSDictionary *options = @{kCIContextWorkingColorSpace : [NSNull null], kCIContextOutputColorSpace : [NSNull null], kCIContextCacheIntermediates : @NO};
    _context = device ? [CIContext contextWithMTLDevice:device options:options] : [CIContext contextWithOptions:options];
  }
  return self;
}

- (void)dealloc {
  if (_pool) CVPixelBufferPoolRelease(_pool);
}

- (void)setMatrix:(NSArray<NSNumber *> *)m vignette:(float)vignette smoothing:(float)smoothing whitening:(float)whitening redness:(float)redness {
  // CIColorMatrix: out = r·RVector + g·GVector + b·BVector + a·AVector + bias, i.e. the matrix columns.
  CIVector *(^column)(int) = ^(int c) {
    return [CIVector vectorWithX:m[c].doubleValue Y:m[5 + c].doubleValue Z:m[10 + c].doubleValue W:m[15 + c].doubleValue];
  };
  CIVector *bias = [CIVector vectorWithX:m[4].doubleValue / 255.0 Y:m[9].doubleValue / 255.0 Z:m[14].doubleValue / 255.0 W:m[19].doubleValue / 255.0];
  NSData *toneCube = ToneCube(whitening, redness);
  os_unfair_lock_lock(&_lock);
  _smoothing = smoothing;
  _toneCube = toneCube;
  _r = column(0);
  _g = column(1);
  _b = column(2);
  _a = column(3);
  _bias = bias;
  _vignette = vignette;
  os_unfair_lock_unlock(&_lock);
}

- (RTCVideoFrame *)onFrame:(RTCVideoFrame *)frame {
  if (_failed || ![frame.buffer isKindOfClass:[RTCCVPixelBuffer class]]) return frame;
  @try {
    RTCVideoFrame *out = [self render:frame];
    return out ?: frame;
  } @catch (NSException *e) {
    NSLog(@"CameraFilter disabled after error: %@", e);
    _failed = YES;
    return frame;
  }
}

- (nullable RTCVideoFrame *)render:(RTCVideoFrame *)frame {
  RTCCVPixelBuffer *src = (RTCCVPixelBuffer *)frame.buffer;
  CIImage *image = [CIImage imageWithCVPixelBuffer:src.pixelBuffer];
  int width = src.width, height = src.height;
  if ([src requiresCropping]) {
    // Core Image's origin is bottom-left. (RTCCVPixelBuffer has no public bufferHeight in this SDK.)
    const int bufferHeight = (int)CVPixelBufferGetHeight(src.pixelBuffer);
    CGRect crop = CGRectMake(src.cropX, bufferHeight - src.cropY - src.cropHeight, src.cropWidth, src.cropHeight);
    image = [[image imageByCroppingToRect:crop] imageByApplyingTransform:CGAffineTransformMakeTranslation(-crop.origin.x, -crop.origin.y)];
    width = src.cropWidth;
    height = src.cropHeight;
  }

  os_unfair_lock_lock(&_lock);
  CIVector *r = _r, *g = _g, *b = _b, *a = _a, *bias = _bias;
  float vignette = _vignette, smoothing = _smoothing;
  NSData *toneCube = _toneCube;
  os_unfair_lock_unlock(&_lock);
  if (!r) return nil;

  CGRect extent = CGRectMake(0, 0, width, height);
  if (smoothing > 0) image = [self smoothSkin:image extent:extent amount:smoothing];
  if (toneCube) {
    image = [image imageByApplyingFilter:@"CIColorCube" withInputParameters:@{@"inputCubeDimension" : @(kCubeSize), @"inputCubeData" : toneCube}];
  }

  CIFilter *matrix = [CIFilter filterWithName:@"CIColorMatrix"];
  [matrix setValue:image forKey:kCIInputImageKey];
  [matrix setValue:r forKey:@"inputRVector"];
  [matrix setValue:g forKey:@"inputGVector"];
  [matrix setValue:b forKey:@"inputBVector"];
  [matrix setValue:a forKey:@"inputAVector"];
  [matrix setValue:bias forKey:@"inputBiasVector"];
  CIImage *result = [matrix.outputImage imageByClampingToExtent];
  result = [result imageByApplyingFilter:@"CIColorClamp"];
  if (vignette > 0) {
    result = [result imageByApplyingFilter:@"CIVignette" withInputParameters:@{kCIInputIntensityKey : @(vignette * 2.0), kCIInputRadiusKey : @(2.0)}];
  }
  result = [result imageByCroppingToRect:CGRectMake(0, 0, width, height)];

  CVPixelBufferRef target = [self pixelBufferWithWidth:width height:height];
  if (!target) return nil;
  [_context render:result toCVPixelBuffer:target bounds:CGRectMake(0, 0, width, height) colorSpace:nil];
  RTCCVPixelBuffer *outBuffer = [[RTCCVPixelBuffer alloc] initWithPixelBuffer:target];
  CVPixelBufferRelease(target);
  return [[RTCVideoFrame alloc] initWithBuffer:outBuffer rotation:frame.rotation timeStampNs:frame.timeStampNs];
}

/// Edge-aware skin smoothing: a Gaussian blur, blended in only where the picture is skin-toned and locally flat (the
/// difference from the blur is small), so eyes, lips, hair and outlines keep their detail.
- (CIImage *)smoothSkin:(CIImage *)image extent:(CGRect)extent amount:(float)amount {
  CGFloat radius = MIN(extent.size.width, extent.size.height) * 0.008 * (0.5 + 0.5 * amount);
  CIImage *blurred = [[image.imageByClampingToExtent imageByApplyingFilter:@"CIGaussianBlur" withInputParameters:@{kCIInputRadiusKey : @(radius)}]
      imageByCroppingToRect:extent];
  // 1 where |image − blurred| < 0.05 (texture, blemishes), 0 above 0.15 (edges).
  CIImage *flat = [[[[image imageByApplyingFilter:@"CIDifferenceBlendMode" withInputParameters:@{kCIInputBackgroundImageKey : blurred}]
      imageByApplyingFilter:@"CIMaximumComponent"] imageByApplyingFilter:@"CIColorMatrix" withInputParameters:Diagonal(-10, 1.5)]
      imageByApplyingFilter:@"CIColorClamp"];
  CIImage *skin = [image imageByApplyingFilter:@"CIColorCube" withInputParameters:@{@"inputCubeDimension" : @(kCubeSize), @"inputCubeData" : SkinCube()}];
  // Keep ~15% of the fine detail so skin does not look plastic.
  CIImage *mask = [[flat imageByApplyingFilter:@"CIMultiplyCompositing" withInputParameters:@{kCIInputBackgroundImageKey : skin}]
      imageByApplyingFilter:@"CIColorMatrix" withInputParameters:Diagonal(0.85 * amount, 0)];
  return [blurred imageByApplyingFilter:@"CIBlendWithMask" withInputParameters:@{kCIInputBackgroundImageKey : image, kCIInputMaskImageKey : mask}];
}

/// BGRA IOSurface buffers from a pool sized to the current frame (recreated when the size changes).
- (CVPixelBufferRef)pixelBufferWithWidth:(int)width height:(int)height {
  if (!_pool || _poolWidth != width || _poolHeight != height) {
    if (_pool) CVPixelBufferPoolRelease(_pool);
    _pool = NULL;
    NSDictionary *attrs = @{
      (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
      (id)kCVPixelBufferWidthKey : @(width),
      (id)kCVPixelBufferHeightKey : @(height),
      (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
      (id)kCVPixelBufferMetalCompatibilityKey : @YES,
    };
    if (CVPixelBufferPoolCreate(kCFAllocatorDefault, NULL, (__bridge CFDictionaryRef)attrs, &_pool) != kCVReturnSuccess) return NULL;
    _poolWidth = width;
    _poolHeight = height;
  }
  CVPixelBufferRef buffer = NULL;
  if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, _pool, &buffer) != kCVReturnSuccess) return NULL;
  return buffer;
}

@end

#pragma mark - Plugin

@interface BBAttachedFilter : NSObject
@property(nonatomic, weak) LocalVideoTrack *track;
@property(nonatomic, strong) BBCameraFilterProcessor *processor;
@end

@implementation BBAttachedFilter
@end

@implementation CameraFilterPlugin {
  NSMutableDictionary<NSString *, BBAttachedFilter *> *_attached;
}

+ (void)registerWithRegistrar:(NSObject<FlutterPluginRegistrar> *)registrar {
  FlutterMethodChannel *channel = [FlutterMethodChannel methodChannelWithName:@"bigboss/camera_filter" binaryMessenger:[registrar messenger]];
  CameraFilterPlugin *instance = [[CameraFilterPlugin alloc] init];
  [registrar addMethodCallDelegate:instance channel:channel];
}

- (instancetype)init {
  if (self = [super init]) _attached = [NSMutableDictionary new];
  return self;
}

- (void)detachFromEngineForRegistrar:(NSObject<FlutterPluginRegistrar> *)registrar {
  for (NSString *trackId in _attached.allKeys) [self detach:trackId];
}

- (void)handleMethodCall:(FlutterMethodCall *)call result:(FlutterResult)result {
  FlutterWebRTCPlugin *webrtc = [FlutterWebRTCPlugin sharedSingleton];
  if (!webrtc) {
    result([FlutterError errorWithCode:@"UNAVAILABLE" message:@"WebRTC is not initialised" details:nil]);
    return;
  }
  [self pruneWith:webrtc];
  NSDictionary *args = [call.arguments isKindOfClass:[NSDictionary class]] ? call.arguments : @{};
  NSString *trackId = args[@"trackId"];
  if (![trackId isKindOfClass:[NSString class]]) {
    result([FlutterError errorWithCode:@"BAD_ARGS" message:@"trackId is required" details:nil]);
    return;
  }

  if ([call.method isEqualToString:@"apply"]) {
    NSArray<NSNumber *> *matrix = [self matrixFrom:args[@"matrix"]];
    if (matrix.count != 20 || ![self allFinite:matrix]) {
      result([FlutterError errorWithCode:@"BAD_ARGS" message:@"matrix must have 20 finite values" details:nil]);
      return;
    }
    float vignette = [args[@"vignette"] isKindOfClass:[NSNumber class]] ? Clamp01([args[@"vignette"] floatValue]) : 0.f;
    NSDictionary *beauty = [args[@"beauty"] isKindOfClass:[NSDictionary class]] ? args[@"beauty"] : @{};
    float (^amount)(NSString *) = ^float(NSString *key) {
      id v = beauty[key];
      return [v isKindOfClass:[NSNumber class]] ? Clamp01([v floatValue]) : 0.f;
    };
    float smoothing = amount(@"smoothing"), whitening = amount(@"whitening"), redness = amount(@"redness");
    id<LocalTrack> local = webrtc.localTracks[trackId];
    if (![local isKindOfClass:[LocalVideoTrack class]]) {
      result([FlutterError errorWithCode:@"NO_TRACK" message:[NSString stringWithFormat:@"No local video track %@", trackId] details:nil]);
      return;
    }
    LocalVideoTrack *track = (LocalVideoTrack *)local;
    BBAttachedFilter *existing = _attached[trackId];
    if (existing && existing.track == track) {
      [existing.processor setMatrix:matrix vignette:vignette smoothing:smoothing whitening:whitening redness:redness];
    } else {
      if (existing) [self detach:trackId];
      BBAttachedFilter *entry = [BBAttachedFilter new];
      entry.track = track;
      entry.processor = [BBCameraFilterProcessor new];
      [entry.processor setMatrix:matrix vignette:vignette smoothing:smoothing whitening:whitening redness:redness];
      [track addProcessing:entry.processor];
      _attached[trackId] = entry;
    }
    result(nil);
  } else if ([call.method isEqualToString:@"clear"]) {
    [self detach:trackId];
    result(nil);
  } else {
    result(FlutterMethodNotImplemented);
  }
}

- (BOOL)allFinite:(NSArray<NSNumber *> *)values {
  for (id v in values) {
    if (![v isKindOfClass:[NSNumber class]] || !isfinite([v doubleValue])) return NO;
  }
  return YES;
}

- (NSArray<NSNumber *> *)matrixFrom:(id)value {
  if ([value isKindOfClass:[FlutterStandardTypedData class]]) {
    FlutterStandardTypedData *data = value;
    if (data.type != FlutterStandardDataTypeFloat64) return @[];
    const double *d = data.data.bytes;
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:data.elementCount];
    for (uint32_t i = 0; i < data.elementCount; i++) [out addObject:@(d[i])];
    return out;
  }
  return [value isKindOfClass:[NSArray class]] ? value : @[];
}

/// Tracks replaced on camera restart or disposed when the live ends.
- (void)pruneWith:(FlutterWebRTCPlugin *)webrtc {
  for (NSString *trackId in _attached.allKeys) {
    BBAttachedFilter *entry = _attached[trackId];
    if (!entry.track || webrtc.localTracks[trackId] != (id<LocalTrack>)entry.track) [self detach:trackId];
  }
}

- (void)detach:(NSString *)trackId {
  BBAttachedFilter *entry = _attached[trackId];
  if (!entry) return;
  [_attached removeObjectForKey:trackId];
  [entry.track removeProcessing:entry.processor];
}

@end
