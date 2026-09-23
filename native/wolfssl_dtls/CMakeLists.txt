cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW)
project(wolfssl_dtls CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# wolfSSL is built with /MD (see scripts/setup-wolfssl.ps1); the addon must match.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")

set(WOLFSSL_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/wolfssl-install"
    CACHE PATH "wolfSSL install prefix")

execute_process(
  COMMAND node -p "require('node-addon-api').include_dir"
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})

add_library(${PROJECT_NAME} SHARED src/addon.cc ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR} "${WOLFSSL_ROOT}/include")
target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=8 NAPI_CPP_EXCEPTIONS _CRT_SECURE_NO_WARNINGS NOMINMAX)
target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB} "${WOLFSSL_ROOT}/lib/wolfssl.lib"
  ws2_32 bcrypt crypt32 advapi32)
if(MSVC)
  target_compile_options(${PROJECT_NAME} PRIVATE /EHsc)
  if(CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET_NAME)
    execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF}
      /out:${CMAKE_JS_NODELIB_TARGET_NAME} ${CMAKE_STATIC_LINKER_FLAGS})
  endif()
endif()
