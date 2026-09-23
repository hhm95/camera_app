# Build wolfSSL (static, DTLS 1.3 + X25519 + Ed25519) with the CMake bundled in Visual Studio 2022.
# Output: third_party/wolfssl-install/{include,lib}
param(
    [string]$Tag = 'v5.9.2-stable',
    [string]$Config = 'Release'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'third_party\wolfssl'
$build = Join-Path $root 'third_party\wolfssl-build'
$install = Join-Path $root 'third_party\wolfssl-install'

$vs = 'C:\Program Files\Microsoft Visual Studio\2022\Community'
$cmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path $cmake)) { $cmake = (Get-Command cmake -ErrorAction Stop).Source }

if (-not (Test-Path $src)) {
    git clone --depth 1 --branch $Tag https://github.com/wolfSSL/wolfssl.git $src
}

& $cmake -S $src -B $build -G 'Visual Studio 17 2022' -A x64 `
    "-DCMAKE_INSTALL_PREFIX=$install" `
    -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL `
    -DBUILD_SHARED_LIBS=OFF `
    -DWOLFSSL_DTLS=yes `
    -DWOLFSSL_DTLS13=yes `
    -DWOLFSSL_HRR_COOKIE=yes `
    -DWOLFSSL_TLS13=yes `
    -DWOLFSSL_CURVE25519=yes `
    -DWOLFSSL_ED25519=yes `
    -DWOLFSSL_CERTGEN=yes `
    -DWOLFSSL_OPENSSLEXTRA=yes `
    -DWOLFSSL_EXAMPLES=no `
    -DWOLFSSL_CRYPT_TESTS=no
if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }

& $cmake --build $build --config $Config --target install
if ($LASTEXITCODE -ne 0) { throw 'cmake build failed' }

Write-Host "wolfSSL installed to $install"
