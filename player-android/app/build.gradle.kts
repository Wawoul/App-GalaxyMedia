plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.galaxymedia.player"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.galaxymedia.player"
        minSdk = 24        // Android TV 7.0+ covers TCL sets
        targetSdk = 35
        versionCode = 9
        versionName = "1.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Release builds must be signed with your own keystore (never committed).
        }
        debug {
            manifestPlaceholders["cleartextPermitted"] = "true"
        }
    }
    // Cleartext stays permitted in release so LAN-only installs (http:// + IP,
    // install.sh mode 2) work with the shipped APK. HTTPS is still the
    // recommended deployment for anything beyond a trusted LAN (SPEC §8).
    buildTypes.getByName("release").manifestPlaceholders["cleartextPermitted"] = "true"

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // java.time (Schedule.kt, play timestamps) on API 24-25 TVs needs desugaring.
        isCoreLibraryDesugaringEnabled = true
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06") // EncryptedSharedPreferences
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.5.1")   // live streams (.m3u8)
    implementation("androidx.media3:media3-exoplayer-dash:1.5.1")  // live streams (.mpd)
    implementation("androidx.media3:media3-ui:1.5.1")
}
