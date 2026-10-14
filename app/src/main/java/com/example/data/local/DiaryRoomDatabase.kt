package com.example.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase

@Entity(tableName = "pending_entries")
data class PendingEntryEntity(
    @PrimaryKey val id: String,
    val authorDeviceId: String,
    val content: String,
    val createdAt: Long,
    val isQueuedOffline: Boolean = true
)

@Dao
interface PendingEntryDao {
    @Query("SELECT * FROM pending_entries ORDER BY createdAt ASC")
    suspend fun getAllPending(): List<PendingEntryEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(entry: PendingEntryEntity)

    @Query("DELETE FROM pending_entries WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM pending_entries")
    suspend fun clearAll()
}

@Database(entities = [PendingEntryEntity::class], version = 1, exportSchema = false)
abstract class DiaryRoomDatabase : RoomDatabase() {
    abstract fun pendingEntryDao(): PendingEntryDao
}
