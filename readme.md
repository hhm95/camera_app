# IP Camera Streaming Project

## 1. Technical Requirements

### Core Technology

* **Runtime:** Node.js
* **Backend Framework:** Express.js hoặc NestJS
* **DTLS Library:** wolfSSL
* **Protocol:** DTLS 1.3
* **Specification:** RFC 9147
* **Key Exchange:** X25519
* **Signature:** Ed25519
* **Transport:** UDP
* **Video Codec:** H.264
* **Media Protocol:** RTP / RTP-H.264
* **API:** HTTP REST API
* **Dashboard:** HTML + CSS + JavaScript
* **Storage:** Local filesystem

### Architecture Requirement

Node.js không tự implement DTLS.

```text
Node.js
   │
   │ Application
   ▼
wolfSSL
   │
   │ DTLS 1.3
   │ RFC 9147
   │ X25519
   │ Ed25519
   ▼
UDP
```

Có thể sử dụng **Node.js Native Addon / N-API / C++ binding** để kết nối Node.js với wolfSSL.

---

# 2. Project Structure

```text
project/
│
├── camera_server/
│
├── host_backend/
│
└── dashboard_view/
```

---

# 3. camera_server

Mô phỏng IP Camera Server.

### Công nghệ

```text
Node.js
   +
wolfSSL
   +
DTLS 1.3 / RFC 9147
   +
X25519
   +
Ed25519
   +
UDP
   +
H.264
   +
RTP
```

### Chức năng

1. Khởi động UDP server.
2. Lắng nghe kết nối từ Host.
3. Thực hiện DTLS 1.3 handshake.
4. Handshake phải tuân theo RFC 9147.
5. Sử dụng X25519 cho key exchange.
6. Sử dụng X.509 + Ed25519 cho authentication/signature.
7. Chỉ bắt đầu truyền media sau khi handshake thành công.
8. Tạo pattern hình ảnh mô phỏng camera.
9. Encode pattern thành H.264.
10. Đóng gói H.264 thành RTP/H.264.
11. Gửi RTP packet qua DTLS 1.3.
12. Tiếp tục streaming cho tới khi client disconnect.

### Data flow

```text
Pattern
   ↓
H.264 Encoder
   ↓
RTP/H.264 Packetizer
   ↓
DTLS 1.3 / wolfSSL
   ↓
UDP
   ↓
Host Backend
```

---

# 4. host_backend

Đóng vai trò Camera Host / Backend.

### Công nghệ

```text
Node.js
   +
Express.js hoặc NestJS
   +
wolfSSL
   +
DTLS 1.3 / RFC 9147
   +
X25519
   +
Ed25519
   +
UDP
   +
RTP/H.264
```

### Chức năng

1. Khởi động backend.
2. Tạo UDP client.
3. Kết nối tới Camera Server.
4. Thực hiện DTLS 1.3 handshake.
5. Validate certificate/signature.
6. Hoàn thành handshake.
7. Nhận encrypted UDP data.
8. Decrypt bằng wolfSSL.
9. Parse RTP.
10. Reassemble H.264 NAL units/FU-A khi cần.
11. Decode H.264.
12. Lưu dữ liệu camera vào local filesystem.
13. Cung cấp REST API cho Dashboard.
14. Theo dõi trạng thái camera.
15. Hỗ trợ disconnect/reconnect.

### Data flow

```text
UDP
 ↓
wolfSSL
 ↓
DTLS 1.3 Decrypt
 ↓
RTP
 ↓
H.264 Reassembly
 ↓
H.264 Decode
 ↓
Local Storage
 ↓
REST API
 ↓
Dashboard
```

### Storage

```text
host_backend/
└── data/
    └── YYYY/
        └── MM/
            └── DD/
                └── camera_001/
                    ├── video/
                    ├── frames/
                    └── metadata/
```

### API dự kiến

```text
GET /api/cameras
GET /api/cameras/:id/status
GET /api/cameras/:id/live
GET /api/cameras/:id/recordings
GET /api/cameras/:id/recordings/:date
```

---

# 5. dashboard_view

Web Dashboard để xem camera.

### Công nghệ

```text
HTML
CSS
JavaScript
```

Có thể sử dụng framework frontend nếu cần, nhưng phiên bản đầu tiên nên giữ đơn giản.

### Chức năng

* Hiển thị danh sách camera.
* Hiển thị trạng thái camera.
* Hiển thị live camera.
* Lấy dữ liệu thông qua `host_backend API`.
* Không kết nối trực tiếp tới Camera Server.
* Có thể mở rộng nhiều camera.

### Architecture

```text
Dashboard
    │
    │ HTTP
    ▼
host_backend API
    │
    ▼
Camera Data
```

---

# 6. DTLS 1.3 Handshake Requirement

Handshake phải sử dụng implementation của **wolfSSL** và tuân theo **RFC 9147**.

Mục tiêu:

```text
Client                                  Server
  │                                       │
  │────── ClientHello ──────────────────►│
  │       X25519 Key Share                │
  │       DTLS 1.3                        │
  │                                       │
  │◄───── ServerHello ───────────────────│
  │       X25519 Key Share                │
  │                                       │
  │◄───── EncryptedExtensions ───────────│
  │◄───── Certificate ───────────────────│
  │◄───── CertificateVerify ─────────────│
  │       Ed25519 Signature               │
  │◄───── Finished ──────────────────────│
  │                                       │
  │────── Finished ─────────────────────►│
  │                                       │
  │       DTLS 1.3 Established            │
  │                                       │
  │◄════ Encrypted RTP/H.264 Data ══════►│
```

Không tự implement handshake.

wolfSSL chịu trách nhiệm:

```text
DTLS record
Handshake
Key derivation
X25519
Certificate
CertificateVerify
Ed25519
Encryption
Decryption
Authentication
Replay protection
DTLS retransmission
```

Node.js chịu trách nhiệm:

```text
Application logic
Camera simulation
H.264 processing
RTP processing
Storage
REST API
Dashboard communication
```

---

# 7. Final System

```text
                    UDP
             DTLS 1.3 / RFC 9147
                    │
                    │
┌───────────────────▼───────────────────┐
│           camera_server               │
│                                       │
│ Node.js                               │
│   ↓                                   │
│ wolfSSL                               │
│   ↓                                   │
│ DTLS 1.3                              │
│ X25519 + Ed25519                     │
│   ↓                                   │
│ RTP/H.264                             │
└───────────────────┬───────────────────┘
                    │
                    │
                    ▼
┌───────────────────────────────────────┐
│            host_backend               │
│                                       │
│ UDP                                   │
│   ↓                                   │
│ wolfSSL                               │
│   ↓                                   │
│ DTLS 1.3 Decrypt                      │
│   ↓                                   │
│ RTP/H.264                             │
│   ↓                                   │
│ H.264 Decode                          │
│   ↓                                   │
│ Local Storage                         │
│   ↓                                   │
│ Express / NestJS API                  │
└───────────────────┬───────────────────┘
                    │
                    │ HTTP REST
                    ▼
┌───────────────────────────────────────┐
│           dashboard_view              │
│                                       │
│ HTML / CSS / JavaScript               │
│                                       │
│ Camera Live View                      │
│ Camera Status                         │
└───────────────────────────────────────┘
```

# 8. Expected Result

### Camera Server

```text
✓ Node.js application starts
✓ UDP server starts
✓ wolfSSL initialized
✓ DTLS 1.3 handshake
✓ RFC 9147
✓ X25519 key exchange
✓ Ed25519 signature verification
✓ Connection established
✓ Generate camera pattern
✓ H.264 encode
✓ RTP packetization
✓ DTLS encryption
✓ Streaming to Host
```

### Host Backend

```text
✓ Node.js application starts
✓ Connect to Camera Server
✓ wolfSSL DTLS 1.3 handshake
✓ RFC 9147
✓ X25519
✓ Ed25519
✓ Receive encrypted UDP
✓ DTLS decrypt
✓ RTP parsing
✓ H.264 reassembly
✓ H.264 decode
✓ Local storage
✓ REST API
```

### Dashboard

```text
✓ Web application starts
✓ Connect to Host Backend API
✓ Display camera status
✓ Display live camera
✓ View camera data
```

## Important Implementation Rule

**Không được dùng Node.js/OpenSSL DTLS thay cho wolfSSL.**

Kiến trúc bắt buộc:

```text
Node.js
   ↓
Native Addon / N-API
   ↓
wolfSSL
   ↓
DTLS 1.3
   ↓
RFC 9147
```

Express/NestJS chỉ phụ trách **HTTP API**, không phụ trách DTLS.
Một điểm mình sẽ chốt thêm cho Claude Code: dùng X25519 + Ed25519. Và ở Phase đầu chỉ cần 1 camera + 1 client + H.264 pattern, sau khi đường DTLS → RTP → H.264 chạy ổn mới mở rộng 5 camera.