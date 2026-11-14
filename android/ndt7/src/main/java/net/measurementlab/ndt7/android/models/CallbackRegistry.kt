package net.measurementlab.ndt7.android.models
import net.measurementlab.ndt7.android.NDTTest
data class CallbackRegistry(
    val speedtestProgressCbk: (ClientResponse) -> Unit,
    val measurementProgressCbk: (Measurement) -> Unit,
    val onFinishedCbk: (ClientResponse, Throwable?, NDTTest.TestType) -> Unit,
    val onOpen: () -> Unit,
    val byteLimit: Long?
)
