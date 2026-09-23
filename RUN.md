# Chạy hệ thống IP Camera (DTLS 1.3 / wolfSSL)

```
camera_server ──UDP · DTLS 1.3 (wolfSSL, X25519 + Ed25519) · RTP/H.264──► host_backend ──HTTP REST──► dashboard_view
```

DTLS chạy hoàn toàn trong wolfSSL qua native addon N-API (`native/wolfssl_dtls`). Node.js chỉ chuyển datagram UDP
(`dgram`) vào/ra addon; không dùng DTLS/OpenSSL của Node. (`node:crypto` chỉ dùng trong `scripts/gen-certs.js` để sinh chứng chỉ.)

## Yêu cầu (Windows)
- Node.js ≥ 18, Git
- Visual Studio 2022 (workload *Desktop development with C++*, có kèm CMake)
- `ffmpeg` có `libx264` trong `PATH` (hoặc đặt biến `FFMPEG=C:\đường\dẫn\ffmpeg.exe`)

## Cài đặt (một lần)
```powershell
npm install
npm run setup:wolfssl   # clone + build wolfSSL 5.9.2 (DTLS 1.3, X25519, Ed25519) → third_party/
npm run build:addon     # build addon N-API → native/wolfssl_dtls/build/Release/wolfssl_dtls.node
npm run gen-certs       # CA + chứng chỉ Ed25519 của camera → certs/
npm test                # 11 test: handshake DTLS 1.3, mất gói, cert sai, RTP/FU-A...
```

## Chạy
```powershell
npm run start:camera    # terminal 1: UDP :5684
npm run start:host      # terminal 2: REST API + dashboard tại http://localhost:3000/
```
Mở http://localhost:3000/ để xem trạng thái + live view.

## REST API (`host_backend`)
| Endpoint | Nội dung |
|---|---|
| `GET /api/cameras` | Danh sách camera + trạng thái tóm tắt |
| `GET /api/cameras/:id/status` | Trạng thái chi tiết: DTLS, fps, bitrate, RTP loss, reconnects |
| `GET /api/cameras/:id/live` | Live MJPEG (`multipart/x-mixed-replace`, dùng được trong `<img>`) |
| `GET /api/cameras/:id/live/snapshot.jpg` | Frame mới nhất |
| `GET /api/cameras/:id/recordings` | Các ngày có dữ liệu |
| `GET /api/cameras/:id/recordings/:date` | Video / frames / events của ngày `YYYY-MM-DD` |

Dữ liệu lưu ở `host_backend/data/YYYY/MM/DD/camera_001/{video,frames,metadata}` (video `.h264` chia đoạn 5 phút, mỗi đoạn bắt đầu ở IDR;
frame JPEG mỗi 5 giây; `metadata/events.jsonl`). Phát lại: `ffplay file.h264`.

## Cấu hình (biến môi trường)
| Biến | Mặc định |
|---|---|
| `CAMERA_ID`, `CAMERA_PORT`, `CAMERA_FPS`, `CAMERA_WIDTH`, `CAMERA_HEIGHT`, `CAMERA_BITRATE_KBPS` | `camera_001`, `5684`, `15`, `640`, `360`, `800` |
| `HOST_HTTP_PORT`, `HOST_DATA_DIR`, `CAMERAS_FILE` | `3000`, `host_backend/data`, `host_backend/cameras.json` |
| `HOST_SEGMENT_SECONDS`, `HOST_FRAME_INTERVAL_SECONDS` | `300`, `5` |

Thêm camera: thêm phần tử vào `host_backend/cameras.json` (`id`, `name`, `host`, `port`, `serverName`). `serverName` phải khớp SAN
trong chứng chỉ của camera (dùng tên FQDN hợp lệ, ví dụ `camera-001.local`; wolfSSL không chấp nhận dấu `_`).

## Ghi chú thiết kế
- Handshake: ClientHello (X25519 key share) → ServerHello → EncryptedExtensions/Certificate/CertificateVerify (Ed25519)/Finished → Finished.
  Host xác thực chứng chỉ camera bằng `certs/ca-cert.pem` và kiểm tra tên (SAN). Camera chỉ bắt đầu gửi media sau khi handshake xong,
  và bỏ qua mọi datagram không phải ClientHello từ địa chỉ lạ.
- RTP/H.264 theo RFC 6184: single NAL, STAP-A (SPS+PPS), FU-A; tối đa 1100 byte/gói để vừa một DTLS record.
  Gói RTP bị mất trong một picture → bỏ picture đó và chờ IDR kế tiếp (không ghi/giải mã dữ liệu hỏng).
- Host gửi keepalive mỗi 5 s; im lặng > 10 s → reconnect (backoff 1 s → 10 s). Camera đóng session im lặng > 15 s.
- Chưa có: RTCP, pacing gói RTP, xác thực dashboard/HTTPS cho REST, nhiều camera đồng thời trong cấu hình mặc định (registry đã hỗ trợ nhiều mục).



MANH NOTE:
Mở hai cửa sổ cmd. Trên máy này wolfSSL, addon và chứng chỉ đã build sẵn, nên chỉ cần chạy 2 tiến trình.

Cửa sổ 1: camera


cd /d D:\trongkn\3.camera_app
npm run start:camera
Cửa sổ 2: host và dashboard


cd /d D:\trongkn\3.camera_app
npm run start:host
Sau đó mở http://localhost:3000/ trong trình duyệt. Log ở cửa sổ camera và cửa sổ host phải có dòng DTLS established: DTLSv1.3 ... X25519 ... Ed25519. Nếu chạy host trước camera cũng được, vì host tự thử lại (backoff 1 s đến 10 s).

Muốn dừng thì bấm Ctrl+C ở mỗi cửa sổ, camera dừng ffmpeg khi không còn client.

Đổi cấu hình (dùng set trong cùng cửa sổ, trước khi chạy):


set CAMERA_FPS=10
set CAMERA_WIDTH=1280
set CAMERA_HEIGHT=720
set HOST_HTTP_PORT=8080
npm run start:camera
Nếu ffmpeg không nằm trong PATH thì đặt set FFMPEG=C:\ffmpeg\bin\ffmpeg.exe cho cả hai cửa sổ.

Cài từ đầu trên máy mới (một lần):


cd /d D:\trongkn\3.camera_app
npm install
npm run setup:wolfssl
npm run build:addon
npm run gen-certs
npm test
Các script setup gọi PowerShell bên trong, nên chạy được từ cmd bình thường. Cần cài Visual Studio 2022 (workload C++) và ffmpeg trước.

Kiểm tra nhanh bằng cmd (curl có sẵn trên Windows 10):


curl http://localhost:3000/api/cameras
curl http://localhost:3000/api/cameras/camera_001/status
curl -o snap.jpg http://localhost:3000/api/cameras/camera_001/live/snapshot.jpg
Video và frame được lưu ở host_backend\data\YYYY\MM\DD\camera_001\. Xem lại video bằng ffplay <file>.h264.

Nếu báo lỗi EADDRINUSE, cổng 3000 (host) hoặc UDP 5684 (camera) đang bị chiếm. Đổi bằng HOST_HTTP_PORT hoặc CAMERA_PORT, và nhớ đổi port tương ứng trong host_backend\cameras.json.