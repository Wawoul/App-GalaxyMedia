package com.galaxymedia.player

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Device state in Android-Keystore-backed encrypted storage (SPEC §8).
 * The device token never touches plain SharedPreferences or logs.
 */
/** Set when the encrypted store was unavailable and plain prefs are in use. */
const val UNENCRYPTED_MARKER = "galaxy_unencrypted_fallback"

class Prefs(context: Context) {
    private val prefs: SharedPreferences = createStore(context)

    /** True when this device fell back to unencrypted storage (see createStore). */
    val usingUnencryptedFallback: Boolean
        get() = prefs.getBoolean(UNENCRYPTED_MARKER, false)

    private fun createStore(context: Context): SharedPreferences =
        runCatching { buildEncryptedPrefs(context) }.getOrElse {
            // Keystore/prefs corruption (seen after OS upgrades or a botched
            // backup restore) would otherwise crash this app on every launch -
            // a permanent brick on unattended hardware. Wipe and recreate a
            // fresh, empty store instead: the box just re-pairs, which beats
            // never coming back at all.
            context.deleteSharedPreferences("galaxy_secure")
            runCatching {
                java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                    .deleteEntry(MasterKey.DEFAULT_MASTER_KEY_ALIAS)
            }
            runCatching { buildEncryptedPrefs(context) }.getOrElse {
                // The retry was unguarded, so a device whose Keystore/TEE is
                // genuinely broken (not just its stored data) threw straight out
                // of the constructor: crash, watchdog relaunch, crash again,
                // every 5 minutes forever. That is exactly the brick this whole
                // fallback exists to avoid. Plain prefs are a real downgrade -
                // the device token is no longer encrypted at rest - but a screen
                // that runs and can be unpaired remotely beats one that never
                // boots again. UNENCRYPTED_MARKER lets the rest of the app know.
                context
                    .getSharedPreferences("galaxy_plain", Context.MODE_PRIVATE)
                    .also { it.edit().putBoolean(UNENCRYPTED_MARKER, true).apply() }
            }
        }

    private fun buildEncryptedPrefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
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
