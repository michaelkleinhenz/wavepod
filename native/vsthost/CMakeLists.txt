# wavepod-vsthost: runs VST3 plug-ins in a separate process for WavePod.
# Talks to WavePod over stdin/stdout (see protocol in main.cpp). Never opens plug-in editors.
cmake_minimum_required(VERSION 3.25)

if(NOT DEFINED ENV{MACOSX_DEPLOYMENT_TARGET})
    set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "macOS deployment target")
endif()

project(wavepod_vsthost LANGUAGES C CXX)

option(WAVEPOD_VST3_SAMPLES "Also build the SDK's sample plug-ins (used by tests)" OFF)

include(FetchContent)
set(VST3_SDK_TAG "v3.8.1_build_84" CACHE STRING "VST3 SDK git tag")
if(DEFINED ENV{VST3_SDK_DIR})
    set(vst3sdk_SOURCE_DIR $ENV{VST3_SDK_DIR})
else()
    FetchContent_Declare(vst3sdk
        GIT_REPOSITORY https://github.com/steinbergmedia/vst3sdk.git
        GIT_TAG ${VST3_SDK_TAG}
        GIT_SHALLOW TRUE
        GIT_SUBMODULES base pluginterfaces public.sdk cmake
    )
    FetchContent_Populate(vst3sdk)
endif()

set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES ${WAVEPOD_VST3_SAMPLES} CACHE BOOL "" FORCE)
set(SMTG_RUN_VST_VALIDATOR OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_MODULE_INFO OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_AUV2_BUILDS OFF CACHE BOOL "" FORCE)
set(SMTG_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
set(SMTG_BUILD_UNIVERSAL_BINARY OFF CACHE BOOL "" FORCE)
add_subdirectory(${vst3sdk_SOURCE_DIR} ${CMAKE_BINARY_DIR}/vst3sdk EXCLUDE_FROM_ALL)

set(SDK_ROOT ${vst3sdk_SOURCE_DIR})
set(sources
    main.cpp
    ${SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp
    ${SDK_ROOT}/public.sdk/source/common/memorystream.cpp
)
if(APPLE)
    list(APPEND sources ${SDK_ROOT}/public.sdk/source/vst/hosting/module_mac.mm)
    set_source_files_properties(${SDK_ROOT}/public.sdk/source/vst/hosting/module_mac.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
elseif(WIN32)
    list(APPEND sources ${SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp)
else()
    list(APPEND sources ${SDK_ROOT}/public.sdk/source/vst/hosting/module_linux.cpp)
endif()

add_executable(wavepod-vsthost ${sources})
target_compile_features(wavepod-vsthost PRIVATE cxx_std_17)
# the SDK libraries use the static MSVC runtime (SMTG_USE_STATIC_CRT), so the helper must too
set_target_properties(wavepod-vsthost PROPERTIES MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
# same place for single- and multi-config generators, so packaging finds it (native/vsthost/bin)
set_target_properties(wavepod-vsthost PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/bin)
foreach(cfg Debug Release RelWithDebInfo MinSizeRel)
    string(TOUPPER ${cfg} CFG)
    set_target_properties(wavepod-vsthost PROPERTIES RUNTIME_OUTPUT_DIRECTORY_${CFG} ${CMAKE_CURRENT_SOURCE_DIR}/bin)
endforeach()
target_include_directories(wavepod-vsthost PRIVATE ${SDK_ROOT})
target_link_libraries(wavepod-vsthost PRIVATE sdk_hosting sdk_common)
if(APPLE)
    find_library(COCOA_FRAMEWORK Cocoa)
    target_link_libraries(wavepod-vsthost PRIVATE ${COCOA_FRAMEWORK})
endif()
if(MINGW)
    set_target_properties(wavepod-vsthost PROPERTIES LINK_FLAGS "-municode")
endif()
if(WAVEPOD_VST3_SAMPLES)
    add_custom_target(test_plugins DEPENDS adelay again-sample-accurate program-change)
endif()
