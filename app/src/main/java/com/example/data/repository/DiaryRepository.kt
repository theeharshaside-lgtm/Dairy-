package com.example.data.repository

import android.content.Context
import androidx.room.Room
import com.example.data.local.DiaryRoomDatabase
import com.example.data.local.PendingEntryEntity
import com.example.data.model.DiaryEntry
import com.example.data.model.EntryStatus
import com.example.data.remote.ApiAuthRequest
import com.example.data.remote.ApiChangePasswordRequest
import com.example.data.remote.ApiPostEntryRequest
import com.example.data.remote.ApiSessionEventRequest
import com.example.data.remote.DiaryApiService
import com.example.security.SecurityManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class DiaryRepository(
    private val context: Context,
    val securityManager: SecurityManager
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Room database for offline queue
    private val roomDb = Room.databaseBuilder(
        context.applicationContext,
        DiaryRoomDatabase::class.java,
        "daily_dairy_local.db"
    ).fallbackToDestructiveMigration().build()

    private val pendingDao = roomDb.pendingEntryDao()

    // Remote server configuration
    private val prefs = context.getSharedPreferences("daily_dairy_repo_prefs", Context.MODE_PRIVATE)
    private val KEY_REMOTE_URL = "remote_server_url"
    private val KEY_REMOTE_TOKEN = "remote_auth_token"
    private val KEY_INSTALLATION_DEVICE_ID = "stable_installation_device_id"

    // Default production cloud backend URL
    companion object {
        const val DEFAULT_CLOUD_URL = "https://ais-pre-3i6x7necuhxco7v5lzvyym-50758065758.asia-east1.run.app"
    }

    private var remoteUrl: String = prefs.getString(KEY_REMOTE_URL, DEFAULT_CLOUD_URL) ?: DEFAULT_CLOUD_URL
    private var remoteAuthToken: String? = prefs.getString(KEY_REMOTE_TOKEN, null)
    private var cachedUser: String? = "diary"
    private var cachedPass: String? = "ChangeThisOnFirstLogin!"
    private var apiService: DiaryApiService? = null

    // Shared in-memory / local persistent atomic diary store
    private val atomicStore = ConcurrentHashMap<String, DiaryEntry>()

    // Tracking active viewing sessions (deviceId -> Set of entryIds)
    private val activeViewingByDevice = ConcurrentHashMap<String, MutableSet<String>>()

    // Active entries visible to the current UI
    private val _entries = MutableStateFlow<List<DiaryEntry>>(emptyList())
    val entries: StateFlow<List<DiaryEntry>> = _entries.asStateFlow()

    private val _isSyncing = MutableStateFlow(false)
    val isSyncing: StateFlow<Boolean> = _isSyncing.asStateFlow()

    private val _remoteUrlState = MutableStateFlow(remoteUrl)
    val remoteUrlState: StateFlow<String> = _remoteUrlState.asStateFlow()

    // Stable, persistent device ID unique to this physical installation (invisible to user)
    private val installationDeviceId: String

    init {
        installationDeviceId = prefs.getString(KEY_INSTALLATION_DEVICE_ID, null) ?: run {
            val gen = "android_" + UUID.randomUUID().toString().take(12)
            prefs.edit().putString(KEY_INSTALLATION_DEVICE_ID, gen).apply()
            gen
        }

        initRetrofit(remoteUrl)
        refreshEntries()

        // Realtime automatic synchronization loop: keeps entries in sync without manual refresh
        scope.launch {
            while (true) {
                delay(2500)
                if (apiService != null) {
                    refreshEntries()
                }
            }
        }
    }

    private fun initRetrofit(baseUrl: String) {
        if (baseUrl.isNotBlank() && (baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))) {
            val cleanUrl = if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/"
            try {
                val client = OkHttpClient.Builder()
                    .connectTimeout(6, TimeUnit.SECONDS)
                    .readTimeout(6, TimeUnit.SECONDS)
                    .build()
                val retrofit = Retrofit.Builder()
                    .baseUrl(cleanUrl)
                    .client(client)
                    .addConverterFactory(MoshiConverterFactory.create())
                    .build()
                apiService = retrofit.create(DiaryApiService::class.java)
            } catch (e: Exception) {
                apiService = null
            }
        } else {
            apiService = null
        }
    }

    fun setRemoteServerUrl(url: String) {
        remoteUrl = url.trim()
        prefs.edit().putString(KEY_REMOTE_URL, remoteUrl).apply()
        _remoteUrlState.value = remoteUrl
        remoteAuthToken = null
        prefs.edit().remove(KEY_REMOTE_TOKEN).apply()
        initRetrofit(remoteUrl)

        // Re-authenticate with new server URL if credentials known
        val u = cachedUser
        val p = cachedPass
        if (u != null && p != null) {
            scope.launch {
                loginRemote(u, p)
            }
        } else {
            refreshEntries()
        }
    }

    fun getCurrentDeviceId(): String = installationDeviceId

    suspend fun loginRemote(user: String, pass: String): Boolean = withContext(Dispatchers.IO) {
        cachedUser = user
        cachedPass = pass
        val service = apiService ?: return@withContext false

        try {
            val currentDevice = getCurrentDeviceId()
            val resp = service.login(ApiAuthRequest(user.trim(), pass, currentDevice))
            if (resp.isSuccessful && resp.body()?.success == true) {
                remoteAuthToken = resp.body()?.token
                prefs.edit().putString(KEY_REMOTE_TOKEN, remoteAuthToken).apply()
                refreshEntries()
                return@withContext true
            }
        } catch (e: Exception) {
            // Offline / network failure
        }
        return@withContext false
    }

    suspend fun changePasswordRemote(newPass: String): Boolean = withContext(Dispatchers.IO) {
        cachedPass = newPass
        val service = apiService ?: return@withContext false
        val token = getValidAuthToken() ?: return@withContext false

        try {
            val resp = service.changePassword("Bearer $token", ApiChangePasswordRequest(newPass))
            return@withContext resp.isSuccessful && resp.body()?.success == true
        } catch (e: Exception) {
            return@withContext false
        }
    }

    private suspend fun getValidAuthToken(): String? {
        if (!remoteAuthToken.isNullOrBlank()) return remoteAuthToken

        val u = cachedUser
        val p = cachedPass
        if (u != null && p != null && apiService != null) {
            val success = loginRemote(u, p)
            if (success) return remoteAuthToken
        }
        return remoteAuthToken
    }

    /**
     * Starts a viewing session when the diary page is displayed.
     * Marks entries authored by the other device as VIEWED.
     */
    fun startViewingSession() {
        val currentDevice = getCurrentDeviceId()
        val deviceViewingSet = activeViewingByDevice.computeIfAbsent(currentDevice) { ConcurrentHashMap.newKeySet() }

        val activeList = atomicStore.values
            .filter { it.status == EntryStatus.ACTIVE }
            .sortedBy { it.createdAt }

        val entriesFromOther = activeList.filter { it.authorDeviceId != currentDevice }
        val idsToMark = entriesFromOther.map { it.id }

        idsToMark.forEach { id ->
            deviceViewingSet.add(id)
            val existing = atomicStore[id]
            if (existing != null && existing.status == EntryStatus.ACTIVE) {
                atomicStore[id] = existing.copy(
                    status = EntryStatus.VIEWED,
                    viewedByRecipientAt = System.currentTimeMillis()
                )
            }
        }

        val service = apiService
        if (service != null && idsToMark.isNotEmpty()) {
            scope.launch {
                val token = getValidAuthToken()
                if (token != null) {
                    try {
                        service.reportViewing(
                            "Bearer $token",
                            ApiSessionEventRequest(currentDevice, idsToMark)
                        )
                    } catch (e: Exception) {
                        // Handled safely
                    }
                }
            }
        }
    }

    /**
     * CRITICAL LIFECYCLE METHOD:
     * When recipient leaves or locks the diary screen,
     * all entries authored by the other device that were viewed are consumed!
     */
    fun closeViewingSessionAndConsume(): Int {
        val currentDevice = getCurrentDeviceId()
        val viewedSet = activeViewingByDevice.remove(currentDevice) ?: emptySet()
        var consumedCount = 0

        if (viewedSet.isNotEmpty()) {
            val idsToConsume = viewedSet.toList()
            idsToConsume.forEach { id ->
                val entry = atomicStore[id]
                // Only consume if authored by someone else (recipient is exiting)
                if (entry != null && entry.authorDeviceId != currentDevice) {
                    atomicStore.remove(id)
                    consumedCount++
                }
            }

            val service = apiService
            if (service != null) {
                scope.launch {
                    val token = getValidAuthToken()
                    if (token != null) {
                        try {
                            service.consumeEntries(
                                "Bearer $token",
                                ApiSessionEventRequest(currentDevice, idsToConsume)
                            )
                        } catch (e: Exception) {
                            // Handled safely
                        }
                    }
                }
            }

            refreshEntries()
        }
        return consumedCount
    }

    /**
     * Add a new entry to the diary.
     * Persists to server before returning success.
     */
    suspend fun saveEntry(content: String): Result<DiaryEntry> = withContext(Dispatchers.IO) {
        if (content.isBlank()) return@withContext Result.failure(IllegalArgumentException("Entry is empty"))

        val currentDevice = getCurrentDeviceId()
        val entry = DiaryEntry(
            id = UUID.randomUUID().toString(),
            authorDeviceId = currentDevice,
            content = content.trim(),
            createdAt = System.currentTimeMillis(),
            status = EntryStatus.ACTIVE
        )

        val service = apiService
        if (service != null) {
            val token = getValidAuthToken()
            if (token != null) {
                try {
                    val resp = service.createEntry(
                        "Bearer $token",
                        ApiPostEntryRequest(entry.id, entry.authorDeviceId, entry.content, entry.createdAt)
                    )
                    if (resp.isSuccessful && resp.body()?.success == true) {
                        atomicStore[entry.id] = entry
                        refreshEntries()
                        return@withContext Result.success(entry)
                    } else {
                        val errorMsg = resp.errorBody()?.string() ?: "Server rejected entry"
                        return@withContext Result.failure(java.io.IOException(errorMsg))
                    }
                } catch (e: Exception) {
                    return@withContext Result.failure(java.io.IOException("Network error: Could not reach shared diary server", e))
                }
            } else {
                return@withContext Result.failure(java.io.IOException("Please unlock diary to synchronize with server"))
            }
        } else {
            atomicStore[entry.id] = entry
            refreshEntries()
            return@withContext Result.success(entry)
        }
    }

    /**
     * Synchronize with remote server and local cache.
     */
    fun refreshEntries() {
        scope.launch {
            _isSyncing.value = true
            try {
                val service = apiService
                if (service != null) {
                    val token = getValidAuthToken()
                    if (token != null) {
                        val currentDevice = getCurrentDeviceId()
                        try {
                            val resp = service.getActiveEntries("Bearer $token", currentDevice)
                            if (resp.isSuccessful) {
                                val remoteItems = resp.body() ?: emptyList()
                                val remoteIds = remoteItems.map { it.id }.toSet()
                                // Reconcile: remove entries that were consumed by recipient on the server!
                                atomicStore.keys.retainAll(remoteIds)
                                remoteItems.forEach { r ->
                                    if (!atomicStore.containsKey(r.id)) {
                                        atomicStore[r.id] = DiaryEntry(
                                            id = r.id,
                                            authorDeviceId = r.authorDeviceId,
                                            content = r.content,
                                            createdAt = r.createdAt,
                                            status = EntryStatus.ACTIVE
                                        )
                                    }
                                }
                            } else if (resp.code() == 401) {
                                // Token expired, re-login
                                remoteAuthToken = null
                                getValidAuthToken()
                            }
                        } catch (e: Exception) {
                            // Offline fallback
                        }
                    }
                }

                // Process pending offline outbox if any
                try {
                    val pending = pendingDao.getAllPending()
                    if (pending.isNotEmpty() && service != null) {
                        val token = getValidAuthToken()
                        if (token != null) {
                            pending.forEach { p ->
                                try {
                                    val resp = service.createEntry(
                                        "Bearer $token",
                                        ApiPostEntryRequest(p.id, p.authorDeviceId, p.content, p.createdAt)
                                    )
                                    if (resp.isSuccessful) {
                                        pendingDao.deleteById(p.id)
                                    }
                                } catch (e: Exception) {
                                    // Keep queued
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    // Handled safely
                }

                val visible = atomicStore.values
                    .filter { it.status == EntryStatus.ACTIVE || it.status == EntryStatus.VIEWED }
                    .sortedBy { it.createdAt }

                _entries.value = visible
            } finally {
                _isSyncing.value = false
            }
        }
    }

    suspend fun getPendingQueueCount(): Int = withContext(Dispatchers.IO) {
        try {
            pendingDao.getAllPending().size
        } catch (e: Exception) {
            0
        }
    }
}
