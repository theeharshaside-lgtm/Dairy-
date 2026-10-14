package com.example.data.remote

import com.squareup.moshi.JsonClass
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST

@JsonClass(generateAdapter = true)
data class ApiAuthRequest(
    val username: String,
    val password: String,
    val deviceId: String
)

@JsonClass(generateAdapter = true)
data class ApiAuthResponse(
    val success: Boolean,
    val token: String? = null,
    val mustChangePassword: Boolean = false,
    val error: String? = null
)

@JsonClass(generateAdapter = true)
data class ApiChangePasswordRequest(
    val newPassword: String
)

@JsonClass(generateAdapter = true)
data class ApiEntryDto(
    val id: String,
    val authorDeviceId: String,
    val content: String,
    val createdAt: Long,
    val status: String = "ACTIVE"
)

@JsonClass(generateAdapter = true)
data class ApiPostEntryRequest(
    val id: String,
    val authorDeviceId: String,
    val content: String,
    val createdAt: Long
)

@JsonClass(generateAdapter = true)
data class ApiSessionEventRequest(
    val deviceId: String,
    val entryIds: List<String>
)

@JsonClass(generateAdapter = true)
data class ApiGenericResponse(
    val success: Boolean,
    val message: String? = null,
    val consumedCount: Int? = null
)

interface DiaryApiService {
    @POST("api/auth/login")
    suspend fun login(@Body body: ApiAuthRequest): Response<ApiAuthResponse>

    @POST("api/auth/change-password")
    suspend fun changePassword(
        @Header("Authorization") token: String,
        @Body body: ApiChangePasswordRequest
    ): Response<ApiGenericResponse>

    @GET("api/entries")
    suspend fun getActiveEntries(
        @Header("Authorization") token: String,
        @Header("X-Device-Id") deviceId: String
    ): Response<List<ApiEntryDto>>

    @POST("api/entries")
    suspend fun createEntry(
        @Header("Authorization") token: String,
        @Body body: ApiPostEntryRequest
    ): Response<ApiGenericResponse>

    @POST("api/entries/view-session/start")
    suspend fun reportViewing(
        @Header("Authorization") token: String,
        @Body body: ApiSessionEventRequest
    ): Response<ApiGenericResponse>

    @POST("api/entries/consume")
    suspend fun consumeEntries(
        @Header("Authorization") token: String,
        @Body body: ApiSessionEventRequest
    ): Response<ApiGenericResponse>
}
