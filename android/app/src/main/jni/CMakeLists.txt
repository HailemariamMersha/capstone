cmake_minimum_required(VERSION 3.22.1)
project(appmodules)
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)
# RN glob-selects *.cpp in this directory as an override for its default OnLoad.
# Keep the independent packet library in a subdirectory so RN core registration stays intact.
add_library(capstonepacket SHARED packet/packet_engine.cpp)
target_compile_features(capstonepacket PRIVATE cxx_std_17)
target_compile_options(capstonepacket PRIVATE -Wall -Wextra -Werror)
target_link_options(capstonepacket PRIVATE "-Wl,-z,max-page-size=16384")
