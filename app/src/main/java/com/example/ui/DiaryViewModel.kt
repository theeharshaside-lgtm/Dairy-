package com.example.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.data.model.DiaryEntry
import com.example.data.model.ScreenState
import com.example.data.model.SessionState
import com.example.data.repository.DiaryRepository
import com.example.security.SecurityManager
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class DiaryViewModel(application: Application) : AndroidViewModel(application) {

    val securityManager = SecurityManager(application.applicationContext)
    val repository = DiaryRepository(application.applicationContext, securityManager)

    private val _screenState = MutableStateFlow(ScreenState.LOGIN)
    val screenState: StateFlow<ScreenState> = _screenState.asStateFlow()

    private val _sessionState = MutableStateFlow(SessionState())
    val sessionState: StateFlow<SessionState> = _sessionState.asStateFlow()

    val entries: StateFlow<List<DiaryEntry>> = repository.entries
    val isRefreshing: StateFlow<Boolean> = repository.isSyncing
    val remoteServerUrl: StateFlow<String> = repository.remoteUrlState

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val _infoMessage = MutableStateFlow<String?>(null)
    val infoMessage: StateFlow<String?> = _infoMessage.asStateFlow()

    private val _isSaving = MutableStateFlow(false)
    val isSaving: StateFlow<Boolean> = _isSaving.asStateFlow()

    private val _lockoutSeconds = MutableStateFlow(0L)
    val lockoutSeconds: StateFlow<Long> = _lockoutSeconds.asStateFlow()

    private val _pendingCount = MutableStateFlow(0)
    val pendingCount: StateFlow<Int> = _pendingCount.asStateFlow()

    private var countdownJob: Job? = null

    init {
        checkLockout()
        updatePendingCount()
    }

    private fun checkLockout() {
        val remaining = securityManager.getLockoutRemainingSeconds()
        if (remaining > 0) {
            _lockoutSeconds.value = remaining
            startLockoutCountdown(remaining)
        }
    }

    private fun startLockoutCountdown(initialSeconds: Long) {
        countdownJob?.cancel()
        countdownJob = viewModelScope.launch {
            var current = initialSeconds
            while (current > 0) {
                _lockoutSeconds.value = current
                delay(1000)
                current--
            }
            _lockoutSeconds.value = 0
            _errorMessage.value = null
        }
    }

    fun login(user: String, pass: String) {
        _errorMessage.value = null
        _infoMessage.value = null

        val result = securityManager.authenticate(user, pass)
        when (result) {
            is SecurityManager.AuthResult.Success -> {
                _sessionState.value = SessionState(
                    isAuthenticated = true,
                    username = user.trim(),
                    deviceId = repository.getCurrentDeviceId(),
                    authToken = result.token,
                    mustChangePassword = result.mustChangePassword
                )
                viewModelScope.launch {
                    repository.loginRemote(user, pass)
                }
                if (result.mustChangePassword) {
                    _screenState.value = ScreenState.CHANGE_PASSWORD
                } else {
                    _screenState.value = ScreenState.DIARY
                    onEnterDiaryScreen()
                }
            }
            is SecurityManager.AuthResult.LockedOut -> {
                _errorMessage.value = "Too many failed attempts. Locked for ${result.waitSeconds}s."
                startLockoutCountdown(result.waitSeconds)
            }
            is SecurityManager.AuthResult.Failure -> {
                _errorMessage.value = "${result.message}. Attempts remaining: ${result.attemptsLeft}"
            }
        }
    }

    fun changePassword(newPass: String, confirmPass: String) {
        if (newPass.length < 8) {
            _errorMessage.value = "Password must be at least 8 characters long."
            return
        }
        if (newPass != confirmPass) {
            _errorMessage.value = "Passwords do not match."
            return
        }

        val success = securityManager.updatePassword(newPass)
        if (success) {
            viewModelScope.launch {
                repository.changePasswordRemote(newPass)
            }
            _errorMessage.value = null
            _infoMessage.value = "Password changed securely. Welcome to Daily Dairy."
            _sessionState.value = _sessionState.value.copy(mustChangePassword = false)
            _screenState.value = ScreenState.DIARY
            onEnterDiaryScreen()
        } else {
            _errorMessage.value = "Failed to update password. Please try again."
        }
    }

    fun onEnterDiaryScreen() {
        repository.startViewingSession()
        updatePendingCount()
    }

    fun onLeaveDiaryScreen() {
        repository.closeViewingSessionAndConsume()
    }

    fun onAppBackgrounded() {
        // When app is backgrounded or hidden, close viewing session and purge read entries
        repository.closeViewingSessionAndConsume()
    }

    fun lockDiary() {
        onLeaveDiaryScreen()
        _sessionState.value = SessionState()
        _screenState.value = ScreenState.LOGIN
        _infoMessage.value = "Diary securely closed."
    }

    fun openSettings() {
        _screenState.value = ScreenState.SETTINGS
    }

    fun returnToDiary() {
        _screenState.value = ScreenState.DIARY
        onEnterDiaryScreen()
    }

    fun saveEntry(text: String, onResult: (Boolean) -> Unit) {
        if (text.isBlank()) return
        viewModelScope.launch {
            _isSaving.value = true
            _errorMessage.value = null
            try {
                val res = repository.saveEntry(text)
                if (res.isSuccess) {
                    _errorMessage.value = null
                    onResult(true)
                } else {
                    _errorMessage.value = res.exceptionOrNull()?.message ?: "Failed to save entry"
                    onResult(false)
                }
            } finally {
                _isSaving.value = false
                updatePendingCount()
            }
        }
    }

    fun refresh() {
        repository.refreshEntries()
        updatePendingCount()
    }

    fun updateRemoteServerUrl(url: String) {
        repository.setRemoteServerUrl(url)
        _infoMessage.value = if (url.isBlank()) "Switched to local paired mode" else "Connected to $url"
    }

    private fun updatePendingCount() {
        viewModelScope.launch {
            _pendingCount.value = repository.getPendingQueueCount()
        }
    }

    fun clearMessages() {
        _errorMessage.value = null
        _infoMessage.value = null
    }
}
