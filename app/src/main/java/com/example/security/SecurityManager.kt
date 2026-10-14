package com.example.security

import android.content.Context
import android.content.SharedPreferences
import java.security.NoSuchAlgorithmException
import java.security.SecureRandom
import java.security.spec.InvalidKeySpecException
import java.util.UUID
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

class SecurityManager(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("daily_dairy_sec_store", Context.MODE_PRIVATE)

    private val random = SecureRandom()

    companion object {
        private const val KEY_USERNAME = "cfg_username"
        private const val KEY_PWD_HASH = "cfg_pwd_hash"
        private const val KEY_PWD_SALT = "cfg_pwd_salt"
        private const val KEY_PWD_CHANGED = "cfg_pwd_changed"
        private const val KEY_DEVICE_ID = "cfg_device_id"
        private const val KEY_FAILED_ATTEMPTS = "cfg_failed_attempts"
        private const val KEY_LOCKOUT_UNTIL = "cfg_lockout_until"

        const val DEFAULT_USERNAME = "diary"
        const val DEFAULT_BOOTSTRAP_PASSWORD = "ChangeThisOnFirstLogin!"

        private const val ITERATIONS = 12000
        private const val KEY_LENGTH = 256
        private const val MAX_FAILED_ATTEMPTS = 5
        private const val LOCKOUT_DURATION_MS = 60_000L // 1 minute lockout
    }

    init {
        // Initialize default credentials securely if not yet configured
        if (!prefs.contains(KEY_USERNAME)) {
            val salt = generateSalt()
            val hash = hashPassword(DEFAULT_BOOTSTRAP_PASSWORD, salt)
            prefs.edit()
                .putString(KEY_USERNAME, DEFAULT_USERNAME)
                .putString(KEY_PWD_HASH, hash)
                .putString(KEY_PWD_SALT, salt)
                .putBoolean(KEY_PWD_CHANGED, false)
                .apply()
        }

        // Initialize persistent device UUID if not present
        if (!prefs.contains(KEY_DEVICE_ID)) {
            val newDeviceId = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_DEVICE_ID, newDeviceId).apply()
        }
    }

    fun getDeviceId(): String {
        return prefs.getString(KEY_DEVICE_ID, null) ?: run {
            val id = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            id
        }
    }

    fun setExplicitDeviceId(id: String) {
        prefs.edit().putString(KEY_DEVICE_ID, id).apply()
    }

    fun isMustChangePassword(): Boolean {
        return !prefs.getBoolean(KEY_PWD_CHANGED, false)
    }

    fun getLockoutRemainingSeconds(): Long {
        val lockoutUntil = prefs.getLong(KEY_LOCKOUT_UNTIL, 0L)
        val now = System.currentTimeMillis()
        return if (lockoutUntil > now) {
            (lockoutUntil - now) / 1000
        } else {
            0L
        }
    }

    sealed class AuthResult {
        data class Success(val token: String, val mustChangePassword: Boolean) : AuthResult()
        data class LockedOut(val waitSeconds: Long) : AuthResult()
        data class Failure(val message: String, val attemptsLeft: Int) : AuthResult()
    }

    fun authenticate(user: String, pass: String): AuthResult {
        val lockoutSeconds = getLockoutRemainingSeconds()
        if (lockoutSeconds > 0) {
            return AuthResult.LockedOut(lockoutSeconds)
        }

        val storedUser = prefs.getString(KEY_USERNAME, DEFAULT_USERNAME) ?: DEFAULT_USERNAME
        val storedHash = prefs.getString(KEY_PWD_HASH, "") ?: ""
        val storedSalt = prefs.getString(KEY_PWD_SALT, "") ?: ""
        val mustChange = isMustChangePassword()

        val trimmedUser = user.trim()
        val computedHash = hashPassword(pass, storedSalt)

        val usernameMatches = constantTimeEquals(trimmedUser, storedUser)
        val passwordMatches = constantTimeEquals(computedHash, storedHash)

        if (usernameMatches && passwordMatches) {
            // Reset failed counter
            prefs.edit()
                .putInt(KEY_FAILED_ATTEMPTS, 0)
                .putLong(KEY_LOCKOUT_UNTIL, 0L)
                .apply()

            val sessionToken = generateSessionToken()
            return AuthResult.Success(sessionToken, mustChange)
        } else {
            val attempts = prefs.getInt(KEY_FAILED_ATTEMPTS, 0) + 1
            if (attempts >= MAX_FAILED_ATTEMPTS) {
                val lockoutUntil = System.currentTimeMillis() + LOCKOUT_DURATION_MS
                prefs.edit()
                    .putInt(KEY_FAILED_ATTEMPTS, attempts)
                    .putLong(KEY_LOCKOUT_UNTIL, lockoutUntil)
                    .apply()
                return AuthResult.LockedOut(LOCKOUT_DURATION_MS / 1000)
            } else {
                prefs.edit().putInt(KEY_FAILED_ATTEMPTS, attempts).apply()
                val attemptsLeft = MAX_FAILED_ATTEMPTS - attempts
                return AuthResult.Failure("Invalid credentials", attemptsLeft)
            }
        }
    }

    fun updatePassword(newPassword: String): Boolean {
        if (newPassword.length < 8) return false
        val salt = generateSalt()
        val hash = hashPassword(newPassword, salt)
        prefs.edit()
            .putString(KEY_PWD_HASH, hash)
            .putString(KEY_PWD_SALT, salt)
            .putBoolean(KEY_PWD_CHANGED, true)
            .apply()
        return true
    }

    private fun generateSalt(): String {
        val saltBytes = ByteArray(16)
        random.nextBytes(saltBytes)
        return bytesToHex(saltBytes)
    }

    private fun generateSessionToken(): String {
        val tokenBytes = ByteArray(32)
        random.nextBytes(tokenBytes)
        return bytesToHex(tokenBytes)
    }

    private fun hashPassword(password: String, saltHex: String): String {
        try {
            val salt = hexToBytes(saltHex)
            val spec = PBEKeySpec(password.toCharArray(), salt, ITERATIONS, KEY_LENGTH)
            val skf = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            val hash = skf.generateSecret(spec).encoded
            return bytesToHex(hash)
        } catch (e: NoSuchAlgorithmException) {
            return ""
        } catch (e: InvalidKeySpecException) {
            return ""
        }
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var result = 0
        for (i in a.indices) {
            result = result or (a[i].code xor b[i].code)
        }
        return result == 0
    }

    private fun bytesToHex(bytes: ByteArray): String {
        val hexChars = "0123456789abcdef".toCharArray()
        val result = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xFF
            result[i * 2] = hexChars[v ushr 4]
            result[i * 2 + 1] = hexChars[v and 0x0F]
        }
        return String(result)
    }

    private fun hexToBytes(hex: String): ByteArray {
        val len = hex.length
        val data = ByteArray(len / 2)
        var i = 0
        while (i < len) {
            data[i / 2] = ((Character.digit(hex[i], 16) shl 4) +
                    Character.digit(hex[i + 1], 16)).toByte()
            i += 2
        }
        return data
    }
}
