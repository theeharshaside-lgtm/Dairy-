package com.example

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.data.model.ScreenState
import com.example.ui.DiaryViewModel
import com.example.ui.screens.ChangePasswordScreen
import com.example.ui.screens.DiaryScreen
import com.example.ui.screens.LoginScreen
import com.example.ui.screens.SettingsScreen
import com.example.ui.theme.DailyDairyTheme

class MainActivity : ComponentActivity() {

    private val diaryViewModel: DiaryViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            DailyDairyTheme {
                val lifecycleOwner = LocalLifecycleOwner.current

                // Listen to Android lifecycle events to trigger ephemeral consumption on app background/exit
                DisposableEffect(lifecycleOwner) {
                    val observer = LifecycleEventObserver { _, event ->
                        when (event) {
                            Lifecycle.Event.ON_STOP -> {
                                // Backgrounded or navigated away
                                diaryViewModel.onAppBackgrounded()
                            }
                            Lifecycle.Event.ON_START -> {
                                // Re-entered app
                                if (diaryViewModel.screenState.value == ScreenState.DIARY) {
                                    diaryViewModel.onEnterDiaryScreen()
                                }
                            }
                            else -> {}
                        }
                    }
                    lifecycleOwner.lifecycle.addObserver(observer)
                    onDispose {
                        lifecycleOwner.lifecycle.removeObserver(observer)
                    }
                }

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val screenState by diaryViewModel.screenState.collectAsStateWithLifecycle()

                    when (screenState) {
                        ScreenState.LOGIN -> {
                            LoginScreen(viewModel = diaryViewModel)
                        }
                        ScreenState.CHANGE_PASSWORD -> {
                            ChangePasswordScreen(viewModel = diaryViewModel)
                        }
                        ScreenState.DIARY -> {
                            DiaryScreen(viewModel = diaryViewModel)
                        }
                        ScreenState.SETTINGS -> {
                            SettingsScreen(viewModel = diaryViewModel)
                        }
                    }
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        diaryViewModel.onAppBackgrounded()
    }
}
