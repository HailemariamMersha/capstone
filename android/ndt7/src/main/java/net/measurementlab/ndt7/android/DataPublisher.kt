package net.measurementlab.ndt7.android

import net.measurementlab.ndt7.android.models.ClientResponse
import net.measurementlab.ndt7.android.models.Measurement

interface DataPublisher {
    fun onTransport(testType: NDTTest.TestType, observation: net.measurementlab.ndt7.android.models.TransportObservation) {}

    fun onMeasurementDownloadProgress(measurement: Measurement) {
    }

    fun onMeasurementUploadProgress(measurement: Measurement) {
    }

    fun onDownloadProgress(clientResponse: ClientResponse) {
    }

    fun onUploadProgress(clientResponse: ClientResponse) {
    }

    fun onFinished(clientResponse: ClientResponse?, error: Throwable?, testType: NDTTest.TestType) {
    }
}
