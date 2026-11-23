import java.net.URI

/*
 * PUET.Pulse for Android: a Trusted Web Activity. The app has no code of its
 * own and no WebView: it opens the PUET.Pulse web client of one server in the
 * user's browser engine (Chrome) full screen, so the page runs exactly as in
 * the browser, with the server's CSP, WebCrypto, IndexedDB and WebAssembly
 * (vodozemac E2EE), WebRTC calls and notifications delegated to this app.
 *
 * Build-time settings (Gradle properties or environment variables):
 *   pulseUrl / PULSE_URL                  the server, https only (default https://pulse.puet.edu.ua)
 *   pulseVersionCode / PULSE_VERSION_CODE  integer, must grow with every release
 *   pulseVersionName / PULSE_VERSION_NAME  e.g. 0.1.0
 * Release signing (never committed): ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD,
 * ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD.
 */

plugins {
    id("com.android.application")
}

fun setting(prop: String, env: String): String? =
    (findProperty(prop) as String?)?.takeIf { it.isNotBlank() } ?: System.getenv(env)?.takeIf { it.isNotBlank() }

val pulseUrl = setting("pulseUrl", "PULSE_URL") ?: "https://pulse.puet.edu.ua"
val pulse = URI(pulseUrl)
require(pulse.scheme == "https" && pulse.userInfo == null && pulse.port == -1 && !pulse.host.isNullOrBlank() && pulse.host.matches(Regex("^[A-Za-z0-9.-]+$"))) {
    "PULSE_URL must be https://<host> without credentials or a port"
}
val pulseHost: String = pulse.host.lowercase()
val pulseStartUrl = "https://$pulseHost/"

val keystoreFile = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }

android {
    namespace = "ua.edu.puet.pulse"
    compileSdk = 36

    defaultConfig {
        applicationId = "ua.edu.puet.pulse"
        minSdk = 24
        targetSdk = 36
        versionCode = (setting("pulseVersionCode", "PULSE_VERSION_CODE") ?: "1").toInt()
        versionName = setting("pulseVersionName", "PULSE_VERSION_NAME") ?: "0.1.0"

        manifestPlaceholders["pulseHost"] = pulseHost
        manifestPlaceholders["pulseStartUrl"] = pulseStartUrl
        // Digital Asset Links: the app claims the server; the server's
        // /.well-known/assetlinks.json must name this app and its signing key.
        resValue(
            "string",
            "asset_statements",
            "[{\\\"relation\\\": [\\\"delegate_permission/common.handle_all_urls\\\"], " +
                "\\\"target\\\": {\\\"namespace\\\": \\\"web\\\", \\\"site\\\": \\\"https://$pulseHost\\\"}}]",
        )
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isDebuggable = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        resValues = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}
