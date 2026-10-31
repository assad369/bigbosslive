import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    id("com.google.gms.google-services")
    id("com.google.firebase.crashlytics")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing comes from android/key.properties (kept out of git):
//   storeFile=/path/to/upload.jks  storePassword=…  keyAlias=upload  keyPassword=…
val keystoreProperties = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

/** Share-link host (see lib/core/config/env.dart); must match link-web's PUBLIC_HOST. */
val linkHost: String = (project.findProperty("dart-defines") as String?)
    ?.split(",")
    ?.map { String(Base64.getDecoder().decode(it)) }
    ?.firstOrNull { it.startsWith("LINK_HOST=") }
    ?.substringAfter("=")
    ?.takeIf { it.isNotBlank() }
    ?: "links.example.com"

android {
    namespace = "com.bigbosslive.bigboss_live"
    // permission_handler_android requires API 37; compileSdk is backward compatible.
    compileSdk = maxOf(37, flutter.compileSdkVersion)
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications needs java.time etc. on older Android versions.
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        applicationId = "com.bigbosslive.bigboss_live"
        // LiveKit / WebRTC and Firebase require API 24+.
        minSdk = maxOf(24, flutter.minSdkVersion)
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // App Links host for AndroidManifest.xml. Same flag the Dart side reads
        // (--dart-define=LINK_HOST=…); Flutter hands dart-defines to Gradle base64-encoded.
        manifestPlaceholders["linkHost"] = linkHost
    }

    signingConfigs {
        create("release") {
            if (keystoreProperties.isNotEmpty()) {
                val storePath = keystoreProperties.getProperty("storeFile")
                if (!storePath.isNullOrEmpty()) {
                    val candidate = file(storePath)
                    storeFile = if (candidate.exists()) candidate else rootProject.file(storePath)
                }
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Falls back to debug signing only for local `flutter run --release`.
            signingConfig = if (keystoreProperties.isNotEmpty()) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

flutter {
    source = "../.."
}
