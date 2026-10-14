package com.example.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.data.model.DiaryEntry
import com.example.ui.DiaryViewModel
import com.example.ui.theme.InkDark
import com.example.ui.theme.InkMedium
import com.example.ui.theme.InkMuted
import com.example.ui.theme.PaperCream
import com.example.ui.theme.RuledLineColor
import com.example.ui.theme.RuledMarginLine
import com.example.ui.theme.TerracottaPrimary
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun DiaryScreen(
    viewModel: DiaryViewModel,
    modifier: Modifier = Modifier
) {
    val entries by viewModel.entries.collectAsStateWithLifecycle()
    val isRefreshing by viewModel.isRefreshing.collectAsStateWithLifecycle()
    val isSaving by viewModel.isSaving.collectAsStateWithLifecycle()
    val errorMessage by viewModel.errorMessage.collectAsStateWithLifecycle()
    val infoMessage by viewModel.infoMessage.collectAsStateWithLifecycle()

    var textInput by remember { mutableStateOf("") }
    val focusManager = LocalFocusManager.current
    val listState = rememberLazyListState()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Handle back button to safely lock and close viewing session
    BackHandler {
        viewModel.lockDiary()
    }

    // When this screen is active, mark viewing session
    DisposableEffect(Unit) {
        viewModel.onEnterDiaryScreen()
        onDispose {
            viewModel.onLeaveDiaryScreen()
        }
    }

    // Scroll to bottom on new entry
    LaunchedEffect(entries.size) {
        if (entries.isNotEmpty()) {
            listState.animateScrollToItem(entries.size)
        }
    }

    // Show error or info notifications cleanly
    LaunchedEffect(errorMessage) {
        errorMessage?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearMessages()
        }
    }
    LaunchedEffect(infoMessage) {
        infoMessage?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearMessages()
        }
    }

    val todayDateFormatted = remember {
        val sdf = SimpleDateFormat("EEEE, MMMM d", Locale.ENGLISH)
        sdf.format(Date())
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(PaperCream)
            .windowInsetsPadding(WindowInsets.statusBars)
            .drawBehind {
                val lineColor = RuledLineColor.copy(alpha = 0.65f)
                val marginColor = RuledMarginLine.copy(alpha = 0.35f)
                val lineSpacing = 36.dp.toPx()
                val leftMargin = 38.dp.toPx()

                // Ruled notebook lines
                var y = 140.dp.toPx()
                while (y < size.height) {
                    drawLine(
                        color = lineColor,
                        start = Offset(0f, y),
                        end = Offset(size.width, y),
                        strokeWidth = 1.dp.toPx()
                    )
                    y += lineSpacing
                }

                // Delicate vertical margin line on left
                drawLine(
                    color = marginColor,
                    start = Offset(leftMargin, 0f),
                    end = Offset(leftMargin, size.height),
                    strokeWidth = 1.5.dp.toPx()
                )
            }
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = 16.dp, end = 16.dp, bottom = 8.dp)
        ) {
            // Header: Minimal privacy header
            DiaryHeader(
                isRefreshing = isRefreshing,
                onLockClick = { viewModel.lockDiary() },
                onRefreshClick = { viewModel.refresh() },
                onSettingsClick = { viewModel.openSettings() }
            )

            // Date & Salutation: Classic Diary Stationery
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 28.dp, top = 4.dp, bottom = 12.dp)
            ) {
                Text(
                    text = todayDateFormatted,
                    style = TextStyle(
                        fontFamily = FontFamily.Serif,
                        fontWeight = FontWeight.Medium,
                        fontSize = 18.sp,
                        color = TerracottaPrimary,
                        letterSpacing = 0.2.sp
                    )
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "Dear Diary,",
                    style = TextStyle(
                        fontFamily = FontFamily.Serif,
                        fontWeight = FontWeight.Normal,
                        fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                        fontSize = 17.sp,
                        color = InkMedium
                    )
                )
            }

            // Entries List: Plain text paragraphs with generous spacing
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(start = 28.dp, end = 8.dp),
                contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp)
            ) {
                if (entries.isEmpty()) {
                    item {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 40.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = "The page is quiet...\nWrite something below.",
                                style = TextStyle(
                                    fontFamily = FontFamily.Serif,
                                    fontSize = 15.sp,
                                    color = InkMuted,
                                    fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                                    lineHeight = 22.sp
                                ),
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center
                            )
                        }
                    }
                } else {
                    items(entries, key = { it.id }) { entry ->
                        DiaryEntryParagraph(entry = entry)
                    }
                }
            }

            // Bottom Text Editor: Minimal lined entry area with [Save] button
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .imePadding()
                    .navigationBarsPadding(),
                color = PaperCream.copy(alpha = 0.95f),
                shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
                shadowElevation = 0.dp
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 4.dp, vertical = 6.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                color = Color.White.copy(alpha = 0.7f),
                                shape = RoundedCornerShape(12.dp)
                            )
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        BasicTextField(
                            value = textInput,
                            onValueChange = { textInput = it },
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = 40.dp, max = 120.dp)
                                .testTag("diary_input_field"),
                            textStyle = TextStyle(
                                fontFamily = FontFamily.Serif,
                                fontSize = 16.sp,
                                color = InkDark,
                                lineHeight = 22.sp
                            ),
                            cursorBrush = SolidColor(TerracottaPrimary),
                            keyboardOptions = KeyboardOptions(
                                capitalization = KeyboardCapitalization.Sentences,
                                imeAction = ImeAction.Default
                            ),
                            decorationBox = { innerTextField ->
                                if (textInput.isEmpty()) {
                                    Text(
                                        text = "Write something here...",
                                        style = TextStyle(
                                            fontFamily = FontFamily.Serif,
                                            fontSize = 16.sp,
                                            color = InkMuted,
                                            fontStyle = androidx.compose.ui.text.font.FontStyle.Italic
                                        )
                                    )
                                }
                                innerTextField()
                            }
                        )

                        Spacer(modifier = Modifier.width(8.dp))

                        Button(
                            onClick = {
                                if (textInput.isNotBlank()) {
                                    val textToSend = textInput
                                    focusManager.clearFocus()
                                    viewModel.saveEntry(textToSend) { success ->
                                        if (success) {
                                            textInput = ""
                                        }
                                    }
                                }
                            },
                            enabled = textInput.isNotBlank() && !isSaving,
                            modifier = Modifier
                                .height(40.dp)
                                .testTag("save_entry_button"),
                            shape = RoundedCornerShape(8.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = TerracottaPrimary,
                                contentColor = Color.White,
                                disabledContainerColor = TerracottaPrimary.copy(alpha = 0.4f),
                                disabledContentColor = Color.White.copy(alpha = 0.6f)
                            ),
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)
                        ) {
                            if (isSaving) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = Color.White
                                )
                            } else {
                                Text(
                                    text = "Save",
                                    style = TextStyle(
                                        fontFamily = FontFamily.Serif,
                                        fontWeight = FontWeight.SemiBold,
                                        fontSize = 15.sp
                                    )
                                )
                            }
                        }
                    }
                }
            }
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(bottom = 60.dp)
        )
    }
}

@Composable
private fun DiaryHeader(
    isRefreshing: Boolean,
    onLockClick: () -> Unit,
    onRefreshClick: () -> Unit,
    onSettingsClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // App title & discreet lock icon
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.clickable(
                indication = null,
                interactionSource = remember { MutableInteractionSource() }
            ) { onLockClick() }
        ) {
            Icon(
                imageVector = Icons.Default.Lock,
                contentDescription = "Lock diary",
                tint = TerracottaPrimary,
                modifier = Modifier
                    .size(18.dp)
                    .testTag("privacy_lock_icon")
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = "Daily Dairy",
                style = TextStyle(
                    fontFamily = FontFamily.Serif,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 20.sp,
                    color = InkDark,
                    letterSpacing = 0.5.sp
                )
            )
        }

        // Action controls: discreet refresh, settings
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = onRefreshClick,
                modifier = Modifier.testTag("refresh_diary_button")
            ) {
                if (isRefreshing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = TerracottaPrimary
                    )
                } else {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = "Refresh diary",
                        tint = InkMedium,
                        modifier = Modifier.size(20.dp)
                    )
                }
            }

            IconButton(
                onClick = onSettingsClick,
                modifier = Modifier.testTag("open_settings_button")
            ) {
                Icon(
                    imageVector = Icons.Default.Settings,
                    contentDescription = "Settings",
                    tint = InkMedium,
                    modifier = Modifier.size(20.dp)
                )
            }
        }
    }
}

@Composable
private fun DiaryEntryParagraph(entry: DiaryEntry) {
    // Pure plain text paragraph on notebook page.
    // Explicitly NO bubbles, NO friend names, NO timestamps, NO read ticks!
    Text(
        text = entry.content,
        style = TextStyle(
            fontFamily = FontFamily.Serif,
            fontWeight = FontWeight.Normal,
            fontSize = 17.sp,
            color = InkDark,
            lineHeight = 27.sp,
            letterSpacing = 0.2.sp
        ),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("diary_entry_text")
    )
}
