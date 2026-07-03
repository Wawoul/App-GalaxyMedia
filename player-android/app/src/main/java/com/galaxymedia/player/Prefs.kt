package com.galaxymedia.player

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Device state in Android-Keystore-backed encrypted storage (SPEC §8).
 * The device token never touches plain SharedPreferences or logs.
 */
class Prefs(context: Context) {
    private val prefs: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context,
            "galaxy_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var serverUrl: String?
        get() = prefs.getString("server_url", null)
        set(value) = prefs.edit().putString("server_url", value).apply()

    var deviceToken: String?
        get() = prefs.getString("device_token", null)
        set(value) = prefs.edit().putString("device_token", value).apply()

    var pairingRequestId: String?
        get() = prefs.getString("pairing_request_id", null)
        set(value) = prefs.edit().putString("pairing_request_id", value).apply()

    /** Last successfully fetched manifest - played when offline (SPEC §6). */
    var cachedManifest: String?
        get() = prefs.getString("cached_manifest", null)
        set(value) = prefs.edit().putString("cached_manifest", value).apply()

    fun clearPairing() {
        prefs.edit()
            .remove("device_token")
            .remove("pairing_request_id")
            .remove("cached_manifest")
            .apply()
    }
}
