# Build the wolfSSL N-API addon with cmake-js, using the CMake that ships with Visual Studio 2022.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cmakeDir = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
if (Test-Path $cmakeDir) { $env:PATH = "$cmakeDir;$env:PATH" }

if (-not (Test-Path (Join-Path $root 'third_party\wolfssl-install\lib\wolfssl.lib'))) {
    throw 'wolfSSL is not built yet: run "npm run setup:wolfssl" first.'
}

Push-Location (Join-Path $root 'native\wolfssl_dtls')
try {
    & node (Join-Path $root 'node_modules\cmake-js\bin\cmake-js') rebuild --generator 'Visual Studio 17 2022' --arch x64
    if ($LASTEXITCODE -ne 0) { throw 'cmake-js build failed' }
} finally {
    Pop-Location
}
