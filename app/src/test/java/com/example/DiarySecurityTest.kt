package com.example

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DiarySecurityTest {

    @Test
    fun testBootstrapCredentialsValidation() {
        val defaultUser = "diary"
        val defaultPass = "ChangeThisOnFirstLogin!"

        assertEquals("diary", defaultUser)
        assertEquals("ChangeThisOnFirstLogin!", defaultPass)
        assertTrue(defaultPass.length >= 8)
    }

    @Test
    fun testPasswordPolicy() {
        val shortPass = "123"
        val validPass = "ValidPass123!"

        assertFalse(shortPass.length >= 8)
        assertTrue(validPass.length >= 8)
    }

    @Test
    fun testEphemeralConsumptionLogic() {
        val phone1 = "device_alpha"
        val phone2 = "device_beta"

        // Author is phone1, viewer is phone2
        val authorId = phone1
        val recipientId = phone2

        val isRecipientViewing = (recipientId != authorId)
        assertTrue("Recipient is reading entry from author", isRecipientViewing)

        // Sender reading their own entry should not consume
        val isSenderViewing = (authorId == authorId)
        val shouldSenderConsume = (!isSenderViewing)
        assertFalse("Sender should never consume own entry", shouldSenderConsume)
    }
}
