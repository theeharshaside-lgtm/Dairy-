package com.example.data.model

import java.util.UUID

enum class EntryStatus {
    ACTIVE,
    VIEWED,
    CONSUMED
}

data class DiaryEntry(
    val id: String = UUID.randomUUID().toString(),
    val authorDeviceId: String,
    val content: String,
    val createdAt: Long = System.currentTimeMillis(),
    val status: EntryStatus = EntryStatus.ACTIVE,
    val viewedByRecipientAt: Long? = null,
    val consumedAt: Long? = null
)

data class SessionState(
    val isAuthenticated: Boolean = false,
    val username: String = "",
    val deviceId: String = "",
    val authToken: String = "",
    val mustChangePassword: Boolean = false,
    val viewingSessionActive: Boolean = false
)

enum class ScreenState {
    LOGIN,
    CHANGE_PASSWORD,
    DIARY,
    SETTINGS
}
