package jp.masato.scanlite

import android.Manifest
import android.content.ContentValues
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.pdf.PdfDocument
import android.os.Bundle
import android.provider.MediaStore
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import com.google.mlkit.vision.text.TextRecognition
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private enum class ScanMode(val title: String) { BOOK("本"), DOCUMENT("書類") }

class MainActivity : ComponentActivity() {
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private var cameraGranted by mutableStateOf(false)
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        cameraGranted = it
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cameraGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        if (!cameraGranted) permissionRequest.launch(Manifest.permission.CAMERA)
        setContent { ScanScreen(cameraGranted, cameraExecutor) }
    }

    override fun onDestroy() {
        cameraExecutor.shutdown()
        super.onDestroy()
    }
}

@Composable
private fun ScanScreen(cameraGranted: Boolean, executor: ExecutorService) {
    val context = LocalContext.current
    val pages = remember { mutableStateListOf<File>() }
    var mode by remember { mutableStateOf(ScanMode.BOOK) }
    var capture by remember { mutableStateOf<ImageCapture?>(null) }
    var message by remember { mutableStateOf("撮影した画像はこの端末内に保存されます") }
    var recognizedText by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val navy = Color(0xFF13231F)
    val green = Color(0xFFB7F36B)

    MaterialTheme(colorScheme = lightColorScheme(primary = navy, secondary = green, background = Color(0xFFF5F5EF))) {
        Column(Modifier.fillMaxSize().background(Color(0xFFF5F5EF)).padding(18.dp)) {
            Text("ScanLite", style = MaterialTheme.typography.headlineMedium, color = navy)
            Text("本も書類も、かんたんスキャン", color = Color.DarkGray)
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ScanMode.entries.forEach { option ->
                    FilterChip(selected = mode == option, onClick = { mode = option }, label = { Text("${option.title}モード") })
                }
                Spacer(Modifier.weight(1f))
                Text("${pages.size} ページ", Modifier.align(Alignment.CenterVertically), color = navy)
            }
            if (cameraGranted) {
                AndroidView(
                    modifier = Modifier.fillMaxWidth().weight(1f).padding(vertical = 8.dp),
                    factory = { ctx ->
                        val view = PreviewView(ctx)
                        val providerFuture = ProcessCameraProvider.getInstance(ctx)
                        providerFuture.addListener({
                            val provider = providerFuture.get()
                            val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                            val imageCapture = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
                            capture = imageCapture
                            try {
                                provider.unbindAll()
                                provider.bindToLifecycle(ctx as ComponentActivity, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture)
                            } catch (_: Exception) { message = "カメラを起動できませんでした" }
                        }, ContextCompat.getMainExecutor(ctx))
                        view
                    }
                )
            } else {
                Box(Modifier.fillMaxWidth().weight(1f).background(navy, RoundedCornerShape(24.dp)), contentAlignment = Alignment.Center) {
                    Text("カメラの使用を許可してください", color = Color.White)
                }
            }
            Text(message, style = MaterialTheme.typography.bodySmall, color = Color.DarkGray)
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    modifier = Modifier.weight(1f).height(54.dp),
                    enabled = cameraGranted && capture != null && !busy,
                    onClick = {
                        val output = File(context.filesDir, "scans").apply { mkdirs() }
                        val file = File(output, "page_${System.currentTimeMillis()}.jpg")
                        val options = ImageCapture.OutputFileOptions.Builder(file).build()
                        capture?.takePicture(options, executor, object : ImageCapture.OnImageSavedCallback {
                            override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                                (context as ComponentActivity).runOnUiThread { pages.add(file); message = "${mode.title}ページを追加しました" }
                            }
                            override fun onError(error: ImageCaptureException) {
                                (context as ComponentActivity).runOnUiThread { message = "撮影に失敗しました: ${error.message}" }
                            }
                        })
                    }
                ) { Text("撮影する") }
                OutlinedButton(enabled = pages.isNotEmpty() && !busy, onClick = {
                    busy = true
                    exportPdf(context, pages.toList()) { ok ->
                        busy = false
                        message = if (ok) "PDFを「ScanLite」フォルダに保存しました" else "PDFの保存に失敗しました"
                    }
                }) { Text(if (busy) "保存中" else "PDF保存") }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(enabled = pages.isNotEmpty() && !busy, onClick = {
                    busy = true
                    recognize(context, pages.last()) { text ->
                        recognizedText = text
                        message = if (text.isBlank()) "文字を認識できませんでした" else "最後のページの日本語OCRが完了しました"
                        busy = false
                    }
                }) { Text("最後のページをOCR") }
                TextButton(enabled = pages.isNotEmpty(), onClick = { pages.lastOrNull()?.delete(); if (pages.isNotEmpty()) pages.removeAt(pages.lastIndex); message = "最後のページを削除しました" }) { Text("最後を削除") }
            }
            if (recognizedText.isNotBlank()) {
                Text("認識したテキスト", style = MaterialTheme.typography.titleSmall, color = navy)
                LazyColumn(Modifier.heightIn(max = 90.dp)) { item { Text(recognizedText, style = MaterialTheme.typography.bodySmall) } }
            }
        }
    }
}

private fun recognize(context: android.content.Context, file: File, complete: (String) -> Unit) {
    val recognizer = TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())
    val image = InputImage.fromFilePath(context, android.net.Uri.fromFile(file))
    recognizer.process(image).addOnSuccessListener { complete(it.text) }.addOnFailureListener { complete("") }.addOnCompleteListener { recognizer.close() }
}

private fun exportPdf(context: android.content.Context, pages: List<File>, complete: (Boolean) -> Unit) {
    try {
        val pdf = PdfDocument()
        pages.forEachIndexed { index, file ->
            val bitmap = BitmapFactory.decodeFile(file.absolutePath) ?: return@forEachIndexed
            val pageInfo = PdfDocument.PageInfo.Builder(bitmap.width, bitmap.height, index + 1).create()
            val page = pdf.startPage(pageInfo)
            page.canvas.drawBitmap(bitmap, 0f, 0f, Paint(Paint.FILTER_BITMAP_FLAG))
            pdf.finishPage(page)
            bitmap.recycle()
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "ScanLite_${SimpleDateFormat("yyyyMMdd_HHmm", Locale.JAPAN).format(Date())}.pdf")
            put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf")
            put(MediaStore.MediaColumns.RELATIVE_PATH, "Documents/ScanLite")
        }
        val uri = context.contentResolver.insert(MediaStore.Files.getContentUri("external"), values)
        if (uri == null) { pdf.close(); complete(false); return }
        context.contentResolver.openOutputStream(uri)?.use { pdf.writeTo(it) }
        pdf.close()
        complete(true)
    } catch (_: Exception) { complete(false) }
}
