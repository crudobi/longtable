package kitchen.longtable.app

import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray

/**
 * SecureStore — the native half of Longtable's Keystore secret storage
 * (Wave 3, security H1).
 *
 * This class owns ONLY encrypted key/value storage. It holds no recipe
 * logic, no identity logic, and no knowledge of what the keys mean: the
 * JS layer (src/secrets/) decides which keys are secrets, migrates them
 * here, and reads them back through the in-memory mirror.
 *
 * Mechanism: AndroidX EncryptedSharedPreferences over a MasterKey held
 * in the Android Keystore (AES256_GCM). The encryption key never leaves
 * the Keystore; the file on disk (`longtable-secrets.xml`, app-private)
 * holds ciphertext only. `android:allowBackup="false"` is already set
 * in the manifest, so the ciphertext file is never backed up to a place
 * where the Keystore key does not exist (the classic unrestorable-
 * restore footgun: a backed-up ciphertext file without its Keystore
 * key decrypts to nothing).
 *
 * Failure mode is explicit, never silent: if EncryptedSharedPreferences
 * cannot be created (Keystore locked, corrupted, or unavailable on the
 * device), every method reports unavailable / rejects, and the JS layer
 * keeps the secrets in localStorage (degraded mode) instead of
 * pretending they are secured. A corrupted Keystore entry fails the
 * single read that hits it; the plugin does not delete anything.
 */
@CapacitorPlugin(name = "SecureStore")
class SecureStorePlugin : Plugin() {

    companion object {
        private const val TAG = "LongtableSecureStore"
        private const val PREFS_FILE = "longtable-secrets"
    }

    @Volatile
    private var prefs: SharedPreferences? = null

    @Volatile
    private var initFailed: Boolean = false

    /**
     * Lazily create the encrypted preferences, once per process. The
     * MasterKey lives in the Android Keystore; creating it is a Keystore
     * operation, so a failure here means the device cannot do Keystore
     * storage at all right now — not a per-key problem.
     */
    @Synchronized
    private fun prefs(): SharedPreferences? {
        prefs?.let { return it }
        if (initFailed) return null
        return try {
            val masterKey = MasterKey.Builder(context, MasterKey.DEFAULT_MASTER_KEY_ALIAS)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                PREFS_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            ).also { prefs = it }
        } catch (e: Exception) {
            Log.e(TAG, "EncryptedSharedPreferences init failed", e)
            initFailed = true
            null
        }
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val ret = JSObject()
        ret.put("available", prefs() != null)
        call.resolve(ret)
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = call.getString("key")
        if (key.isNullOrEmpty()) {
            call.reject("key must be a non-empty string")
            return
        }
        val store = prefs()
        if (store == null) {
            call.reject("secure storage unavailable")
            return
        }
        try {
            val ret = JSObject()
            // Absent key resolves with value null (JS reads `?? null`);
            // a present-but-undecryptable value rejects instead of
            // returning garbage — the caller treats that as a failed
            // migration, never as an empty secret.
            ret.put("value", store.getString(key, null))
            call.resolve(ret)
        } catch (e: Exception) {
            Log.e(TAG, "SecureStore get failed", e)
            call.reject("secure storage read failed")
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (key.isNullOrEmpty() || value == null) {
            call.reject("key and value must be non-empty strings")
            return
        }
        val store = prefs()
        if (store == null) {
            call.reject("secure storage unavailable")
            return
        }
        try {
            // apply() is async to disk; the JS layer verifies a
            // migration with a read-back before it clears the
            // localStorage copy, so the async flush is safe here.
            store.edit().putString(key, value).apply()
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "SecureStore set failed", e)
            call.reject("secure storage write failed")
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key")
        if (key.isNullOrEmpty()) {
            call.reject("key must be a non-empty string")
            return
        }
        val store = prefs()
        if (store == null) {
            call.reject("secure storage unavailable")
            return
        }
        try {
            store.edit().remove(key).apply()
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "SecureStore remove failed", e)
            call.reject("secure storage remove failed")
        }
    }

    @PluginMethod
    fun keys(call: PluginCall) {
        val store = prefs()
        if (store == null) {
            call.reject("secure storage unavailable")
            return
        }
        try {
            val ret = JSObject()
            ret.put("keys", JSONArray(store.all.keys.toList()))
            call.resolve(ret)
        } catch (e: Exception) {
            Log.e(TAG, "SecureStore keys failed", e)
            call.reject("secure storage read failed")
        }
    }
}
