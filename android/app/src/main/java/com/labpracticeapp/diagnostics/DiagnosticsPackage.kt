package com.labpracticeapp.diagnostics

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.labpracticeapp.BuildConfig

class DiagnosticsPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        buildList {
            add(TracerouteModule(context))
            if (BuildConfig.SPEEDCHECKER_ENABLED) {
                val module = Class.forName("com.labpracticeapp.diagnostics.SpeedCheckerModule")
                    .getConstructor(ReactApplicationContext::class.java).newInstance(context) as NativeModule
                add(module)
            }
        }
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
