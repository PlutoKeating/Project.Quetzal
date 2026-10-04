import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// 正式签名：android/key.properties（不入库）里给出 storeFile / storePassword / keyAlias / keyPassword；没有时退回 debug 签名。
val keyProps = Properties().apply { rootProject.file("key.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) } }
val hasKey = keyProps.containsKey("storeFile")

android {
    namespace = "xyz.quetzal.console"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "xyz.quetzal.console"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasKey) create("release") {
            storeFile = rootProject.file(keyProps["storeFile"] as String)
            storePassword = keyProps["storePassword"] as String
            keyAlias = keyProps["keyAlias"] as String
            keyPassword = keyProps["keyPassword"] as String
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName(if (hasKey) "release" else "debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation("com.github.gkonovalov.android-vad:webrtc:2.0.10") // WebRTC VAD（MIT）：听觉的断句，纯 Kotlin，无模型文件
    implementation("androidx.core:core:1.13.1") // FileProvider：App 自身更新时把下载好的 APK 交给系统安装器
}
