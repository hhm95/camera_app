// N-API binding exposing wolfSSL DTLS 1.3 as a datagram-in / datagram-out state machine.
//
// The addon never touches a socket: Node's dgram moves UDP datagrams, wolfSSL does everything
// else (record layer, handshake, X25519, Ed25519 certificate validation, AEAD, replay window,
// retransmission). Datagrams received from the network are queued into `inbox` and handed to
// wolfSSL through a custom receive callback; datagrams wolfSSL wants to send are collected in
// `outbox` through a custom send callback and returned to JS.

#include <napi.h>

#include <wolfssl/options.h>
#include <wolfssl/ssl.h>
#include <wolfssl/wolfio.h>

#include <algorithm>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

namespace {

using Datagram = std::vector<uint8_t>;

std::string WolfError(int err) {
  char buf[WOLFSSL_MAX_ERROR_SZ];
  wolfSSL_ERR_error_string(static_cast<unsigned long>(err), buf);
  return std::string(buf) + " (" + std::to_string(err) + ")";
}

std::string ReadBufferArg(const Napi::Value& v, const char* name) {
  if (!v.IsBuffer() && !v.IsString()) {
    throw Napi::TypeError::New(v.Env(), std::string(name) + " must be a Buffer or string (PEM)");
  }
  if (v.IsString()) return v.As<Napi::String>().Utf8Value();
  auto b = v.As<Napi::Buffer<char>>();
  return std::string(b.Data(), b.Length());
}

class DtlsSession : public Napi::ObjectWrap<DtlsSession> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function fn = DefineClass(
        env, "DtlsSession",
        {
            InstanceMethod("startHandshake", &DtlsSession::StartHandshake),
            InstanceMethod("feed", &DtlsSession::Feed),
            InstanceMethod("write", &DtlsSession::Write),
            InstanceMethod("handleTimeout", &DtlsSession::HandleTimeout),
            InstanceMethod("nextTimeoutMs", &DtlsSession::NextTimeoutMs),
            InstanceMethod("needsTimer", &DtlsSession::NeedsTimer),
            InstanceMethod("info", &DtlsSession::Info),
            InstanceMethod("close", &DtlsSession::Close),
            InstanceMethod("free", &DtlsSession::Free),
        });
    exports.Set("DtlsSession", fn);
    exports.Set("wolfsslVersion", Napi::String::New(env, LIBWOLFSSL_VERSION_STRING));
    return exports;
  }

  explicit DtlsSession(const Napi::CallbackInfo& info) : Napi::ObjectWrap<DtlsSession>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
      throw Napi::TypeError::New(env, "options object required");
    }
    Napi::Object opts = info[0].As<Napi::Object>();
    std::string role = opts.Get("role").As<Napi::String>().Utf8Value();
    server_ = role == "server";
    if (!server_ && role != "client") {
      throw Napi::TypeError::New(env, "role must be 'server' or 'client'");
    }

    static bool initialised = false;
    if (!initialised) {
      wolfSSL_Init();
      initialised = true;
    }

    ctx_ = wolfSSL_CTX_new(server_ ? wolfDTLSv1_3_server_method() : wolfDTLSv1_3_client_method());
    if (!ctx_) throw Napi::Error::New(env, "wolfSSL_CTX_new failed (DTLS 1.3 not compiled in?)");

    wolfSSL_CTX_SetIORecv(ctx_, &DtlsSession::IoRecv);
    wolfSSL_CTX_SetIOSend(ctx_, &DtlsSession::IoSend);

    if (server_) {
      std::string cert = ReadBufferArg(opts.Get("cert"), "cert");
      std::string key = ReadBufferArg(opts.Get("key"), "key");
      Check(env,
            wolfSSL_CTX_use_certificate_chain_buffer_format(
                ctx_, reinterpret_cast<const unsigned char*>(cert.data()),
                static_cast<long>(cert.size()), WOLFSSL_FILETYPE_PEM),
            "load server certificate");
      Check(env,
            wolfSSL_CTX_use_PrivateKey_buffer(ctx_, reinterpret_cast<const unsigned char*>(key.data()),
                                              static_cast<long>(key.size()), WOLFSSL_FILETYPE_PEM),
            "load server private key");
      wolfSSL_CTX_set_verify(ctx_, WOLFSSL_VERIFY_NONE, nullptr);
    } else {
      bool verify = !opts.Has("verifyPeer") || opts.Get("verifyPeer").ToBoolean().Value();
      if (verify) {
        std::string ca = ReadBufferArg(opts.Get("ca"), "ca");
        Check(env,
              wolfSSL_CTX_load_verify_buffer(ctx_, reinterpret_cast<const unsigned char*>(ca.data()),
                                             static_cast<long>(ca.size()), WOLFSSL_FILETYPE_PEM),
              "load CA certificate");
        wolfSSL_CTX_set_verify(ctx_, WOLFSSL_VERIFY_PEER | WOLFSSL_VERIFY_FAIL_IF_NO_PEER_CERT, nullptr);
      } else {
        wolfSSL_CTX_set_verify(ctx_, WOLFSSL_VERIFY_NONE, nullptr);
      }
    }

    ssl_ = wolfSSL_new(ctx_);
    if (!ssl_) throw Napi::Error::New(env, "wolfSSL_new failed");

    // Key exchange: X25519 only. Signature: Ed25519 only. These are set on the WOLFSSL object,
    // not the CTX: wolfSSL_CTX_set1_sigalgs_list on a CTX that has not initialised its suites
    // yet (e.g. a client without a certificate) leaves the cipher suite list empty.
    // Overridable through opts.groups / opts.sigalgs (empty string = no restriction).
    std::string groups = opts.Has("groups") ? opts.Get("groups").As<Napi::String>().Utf8Value() : "X25519";
    std::string sigalgs = opts.Has("sigalgs") ? opts.Get("sigalgs").As<Napi::String>().Utf8Value() : "ED25519";
    if (!groups.empty()) {
      Check(env, wolfSSL_set1_groups_list(ssl_, const_cast<char*>(groups.c_str())), "set groups");
    }
    if (!sigalgs.empty()) {
      Check(env, wolfSSL_set1_sigalgs_list(ssl_, sigalgs.c_str()), "set sigalgs");
    }
    wolfSSL_SetIOReadCtx(ssl_, this);
    wolfSSL_SetIOWriteCtx(ssl_, this);
    wolfSSL_dtls_set_using_nonblock(ssl_, 1);

    if (!server_ && opts.Has("serverName") && opts.Get("serverName").IsString()) {
      std::string name = opts.Get("serverName").As<Napi::String>().Utf8Value();
      Check(env, wolfSSL_check_domain_name(ssl_, name.c_str()), "set domain check");
      wolfSSL_UseSNI(ssl_, WOLFSSL_SNI_HOST_NAME, name.data(), static_cast<word16>(name.size()));
    }
  }

  ~DtlsSession() override { Release(); }

 private:
  // ---- wolfSSL custom I/O -------------------------------------------------------------------
  static int IoRecv(WOLFSSL*, char* buf, int sz, void* ctx) {
    auto* self = static_cast<DtlsSession*>(ctx);
    if (self->inbox_.empty()) return WOLFSSL_CBIO_ERR_WANT_READ;
    Datagram d = std::move(self->inbox_.front());
    self->inbox_.pop_front();
    int n = static_cast<int>(std::min<size_t>(d.size(), static_cast<size_t>(sz)));
    std::memcpy(buf, d.data(), static_cast<size_t>(n));
    return n;  // one call == one datagram (truncated if larger than sz, as recv() would)
  }

  static int IoSend(WOLFSSL*, char* buf, int sz, void* ctx) {
    auto* self = static_cast<DtlsSession*>(ctx);
    self->outbox_.emplace_back(reinterpret_cast<uint8_t*>(buf), reinterpret_cast<uint8_t*>(buf) + sz);
    return sz;
  }

  // ---- helpers ------------------------------------------------------------------------------
  static void Check(Napi::Env env, int ret, const char* what) {
    if (ret != WOLFSSL_SUCCESS) {
      throw Napi::Error::New(env, std::string(what) + " failed: " + WolfError(ret));
    }
  }

  void Release() {
    if (ssl_) {
      wolfSSL_free(ssl_);
      ssl_ = nullptr;
    }
    if (ctx_) {
      wolfSSL_CTX_free(ctx_);
      ctx_ = nullptr;
    }
  }

  void RequireLive(Napi::Env env) {
    if (!ssl_) throw Napi::Error::New(env, "session already freed");
  }

  // Drive the handshake (until established) and drain application data. Runs until wolfSSL
  // needs more input than we have queued.
  void Pump() {
    if (!ssl_ || failed_) return;
    for (;;) {
      if (!established_) {
        int ret = server_ ? wolfSSL_accept(ssl_) : wolfSSL_connect(ssl_);
        if (ret == WOLFSSL_SUCCESS) {
          established_ = true;
          continue;
        }
        int err = wolfSSL_get_error(ssl_, ret);
        if (err == WOLFSSL_ERROR_WANT_READ || err == WOLFSSL_ERROR_WANT_WRITE) return;
        Fail(err);
        return;
      }

      uint8_t buf[2048];
      int n = wolfSSL_read(ssl_, buf, sizeof(buf));
      if (n > 0) {
        appData_.emplace_back(buf, buf + n);
        continue;
      }
      int err = wolfSSL_get_error(ssl_, n);
      if (err == WOLFSSL_ERROR_WANT_READ || err == WOLFSSL_ERROR_WANT_WRITE) return;
      if (err == WOLFSSL_ERROR_ZERO_RETURN) {
        closed_ = true;  // peer sent close_notify
        return;
      }
      Fail(err);
      return;
    }
  }

  void Fail(int err) {
    failed_ = true;
    error_ = WolfError(err);
  }

  Napi::Array TakeOutbox(Napi::Env env) {
    Napi::Array arr = Napi::Array::New(env, outbox_.size());
    for (size_t i = 0; i < outbox_.size(); ++i) {
      arr.Set(static_cast<uint32_t>(i),
              Napi::Buffer<uint8_t>::Copy(env, outbox_[i].data(), outbox_[i].size()));
    }
    outbox_.clear();
    return arr;
  }

  Napi::Object MakeResult(Napi::Env env) {
    Napi::Object res = Napi::Object::New(env);
    res.Set("out", TakeOutbox(env));
    Napi::Array data = Napi::Array::New(env, appData_.size());
    for (size_t i = 0; i < appData_.size(); ++i) {
      data.Set(static_cast<uint32_t>(i),
               Napi::Buffer<uint8_t>::Copy(env, appData_[i].data(), appData_[i].size()));
    }
    appData_.clear();
    res.Set("data", data);
    res.Set("established", Napi::Boolean::New(env, established_));
    res.Set("closed", Napi::Boolean::New(env, closed_));
    res.Set("error", failed_ ? Napi::Value(Napi::String::New(env, error_)) : env.Null());
    return res;
  }

  // ---- JS API -------------------------------------------------------------------------------
  // Client: produce the ClientHello datagram(s).
  Napi::Value StartHandshake(const Napi::CallbackInfo& info) {
    RequireLive(info.Env());
    Pump();
    return MakeResult(info.Env());
  }

  // Feed one received UDP datagram; returns { out, data, established, closed, error }.
  Napi::Value Feed(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    RequireLive(env);
    if (info.Length() < 1 || !info[0].IsBuffer()) throw Napi::TypeError::New(env, "Buffer required");
    auto b = info[0].As<Napi::Buffer<uint8_t>>();
    inbox_.emplace_back(b.Data(), b.Data() + b.Length());
    Pump();
    return MakeResult(env);
  }

  // Encrypt application data; returns the datagrams to send.
  Napi::Value Write(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    RequireLive(env);
    if (!established_) throw Napi::Error::New(env, "DTLS handshake not complete");
    if (failed_) throw Napi::Error::New(env, "DTLS session failed: " + error_);
    if (info.Length() < 1 || !info[0].IsBuffer()) throw Napi::TypeError::New(env, "Buffer required");
    auto b = info[0].As<Napi::Buffer<uint8_t>>();
    int ret = wolfSSL_write(ssl_, b.Data(), static_cast<int>(b.Length()));
    if (ret != static_cast<int>(b.Length())) {
      int err = wolfSSL_get_error(ssl_, ret);
      if (err != WOLFSSL_ERROR_WANT_WRITE && err != WOLFSSL_ERROR_WANT_READ) {
        throw Napi::Error::New(env, "wolfSSL_write failed: " + WolfError(err));
      }
    }
    return TakeOutbox(env);
  }

  // Retransmission timer fired.
  Napi::Value HandleTimeout(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    RequireLive(env);
    if (!failed_) {
      int ret = wolfSSL_dtls_got_timeout(ssl_);
      if (ret != WOLFSSL_SUCCESS) {
        int err = wolfSSL_get_error(ssl_, ret);
        if (err != WOLFSSL_ERROR_WANT_READ && err != WOLFSSL_ERROR_WANT_WRITE) Fail(err);
      }
    }
    return MakeResult(env);
  }

  Napi::Value NextTimeoutMs(const Napi::CallbackInfo& info) {
    RequireLive(info.Env());
    int secs = wolfSSL_dtls_get_current_timeout(ssl_);
    int ms = secs > 0 ? secs * 1000 : 1000;
    if (wolfSSL_dtls13_use_quick_timeout(ssl_)) ms = std::max(50, ms / 4);
    return Napi::Number::New(info.Env(), ms);
  }

  // True while the handshake is running or wolfSSL still waits for an ACK.
  Napi::Value NeedsTimer(const Napi::CallbackInfo& info) {
    RequireLive(info.Env());
    bool need = !failed_ && !closed_ && (!established_ || wolfSSL_dtls13_has_pending_msg(ssl_));
    return Napi::Boolean::New(info.Env(), need);
  }

  Napi::Value Info(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    RequireLive(env);
    Napi::Object o = Napi::Object::New(env);
    o.Set("established", Napi::Boolean::New(env, established_));
    o.Set("role", Napi::String::New(env, server_ ? "server" : "client"));
    if (!established_) return o;

    const char* ver = wolfSSL_get_version(ssl_);
    o.Set("version", Napi::String::New(env, ver ? ver : ""));
    WOLFSSL_CIPHER* cipher = wolfSSL_get_current_cipher(ssl_);
    const char* cname = cipher ? wolfSSL_CIPHER_get_name(cipher) : nullptr;
    o.Set("cipher", Napi::String::New(env, cname ? cname : ""));
    const char* curve = wolfSSL_get_curve_name(ssl_);
    o.Set("group", Napi::String::New(env, curve ? curve : ""));

    WOLFSSL_X509* peer = wolfSSL_get_peer_certificate(ssl_);
    if (peer) {
      char* subj = wolfSSL_X509_NAME_oneline(wolfSSL_X509_get_subject_name(peer), nullptr, 0);
      if (subj) {
        o.Set("peerSubject", Napi::String::New(env, subj));
        XFREE(subj, nullptr, DYNAMIC_TYPE_OPENSSL);
      }
      int sigType = wolfSSL_X509_get_signature_type(peer);
      o.Set("peerCertSignatureType", Napi::Number::New(env, sigType));
      wolfSSL_X509_free(peer);
    }
    o.Set("verifyResult", Napi::Number::New(env, static_cast<double>(wolfSSL_get_verify_result(ssl_))));
    return o;
  }

  // Send close_notify; returns the datagrams to send.
  Napi::Value Close(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    RequireLive(env);
    if (established_ && !failed_) wolfSSL_shutdown(ssl_);
    closed_ = true;
    return TakeOutbox(env);
  }

  Napi::Value Free(const Napi::CallbackInfo& info) {
    Release();
    return info.Env().Undefined();
  }

  WOLFSSL_CTX* ctx_ = nullptr;
  WOLFSSL* ssl_ = nullptr;
  bool server_ = false;
  bool established_ = false;
  bool closed_ = false;
  bool failed_ = false;
  std::string error_;
  std::deque<Datagram> inbox_;
  std::vector<Datagram> outbox_;
  std::vector<Datagram> appData_;
};

Napi::Object InitAll(Napi::Env env, Napi::Object exports) { return DtlsSession::Init(env, exports); }

}  // namespace

NODE_API_MODULE(wolfssl_dtls, InitAll)
