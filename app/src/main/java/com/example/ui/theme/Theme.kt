package com.example.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val DarkColorScheme = darkColorScheme(
    primary = TerracottaLight,
    onPrimary = InkDark,
    secondary = AccentGold,
    background = NightPaper,
    onBackground = NightInk,
    surface = NightPaperCard,
    onSurface = NightInk,
    surfaceVariant = NightPaper,
    onSurfaceVariant = NightInkMuted,
    outline = NightRuledLine
)

private val LightColorScheme = lightColorScheme(
    primary = TerracottaPrimary,
    onPrimary = PaperCream,
    secondary = TerracottaDark,
    background = PaperCream,
    onBackground = InkDark,
    surface = PaperCard,
    onSurface = InkDark,
    surfaceVariant = PaperCreamDarker,
    onSurfaceVariant = InkMedium,
    outline = RuledLineColor
)

@Composable
fun DailyDairyTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    // Preserve authentic diary parchment palette across devices
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
