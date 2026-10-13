package kitchen.longtable.app

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * LocalApi — the native half of Longtable's localhost API (E9).
 *
 * This class owns ONLY a socket. It binds 127.0.0.1 (loopback — never a
 * wildcard address), parses just enough HTTP/1.1 to frame a request,
 * forwards the request to the JS layer as a "request" event, and writes
 * back whatever the JS layer answers via [respond]. There is NO recipe
 * logic here: routing, auth, validation, and storage all live in
 * src/localapi/ where the app's own code paths run.
 *
 * The server runs only while the app process is alive and the user has
 * enabled the API in settings (it is off by default). No foreground
 * service, no boot receiver — when the app dies, the API dies with it.
 */
@CapacitorPlugin(name = "LocalApi")
class LocalApiPlugin : Plugin() {

    companion object {
        private const val TAG = "LongtableLocalApi"
        /** Bodies are recipe JSON (photos are data URLs): 16 MiB is ample. */
        private const val MAX_BODY_BYTES = 16 * 1024 * 1024
        private const val MAX_HEADER_BYTES = 64 * 1024
        /** How long a connection waits for the JS layer to answer. */
        private const val RESPONSE_TIMEOUT_MS = 30_000L
    }

    /** A request waiting for its JS-computed response. */
    private class Pending(val latch: CountDownLatch) {
        @Volatile var status: Int = 0
        @Volatile var body: String = ""
    }

    private class ParsedRequest(
        val method: String,
        val path: String,
        val query: String,
        val headers: Map<String, String>,
        val body: String,
        val tooLarge: Boolean,
    )

    private val pending = ConcurrentHashMap<String, Pending>()
    private val ids = AtomicLong(0)

    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var boundPort: Int = 0

    // ------------------------------------------------------------------
    // Plugin methods (JS -> native)
    // ------------------------------------------------------------------

    @PluginMethod
    fun start(call: PluginCall) {
        val port = call.getInt("port")
        if (port == null || port < 1024 || port > 65535) {
            call.reject("port must be between 1024 and 65535")
            return
        }
        synchronized(this) {
            if (serverSocket != null && boundPort == port) {
                call.resolve(statusObject())
                return
            }
            stopLocked()
            try {
                // Loopback ONLY. Binding the wildcard address here would
                // expose the cookbook to the whole LAN — the bind address
                // is the security boundary, and the e2e proof asserts it.
                val ss = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
                serverSocket = ss
                boundPort = port
                val t = Thread({ acceptLoop(ss) }, "longtable-localapi-accept")
                t.isDaemon = true
                t.start()
            } catch (e: Exception) {
                Log.w(TAG, "failed to bind 127.0.0.1:$port", e)
                call.reject("could not listen on 127.0.0.1:$port — ${e.message}")
                return
            }
        }
        call.resolve(statusObject())
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        synchronized(this) { stopLocked() }
        call.resolve(statusObject())
    }

    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(statusObject())
    }

    @PluginMethod
    fun respond(call: PluginCall) {
        val id = call.getString("id")
        val p = if (id != null) pending[id] else null
        if (p == null) {
            call.reject("unknown or already-answered request id")
            return
        }
        p.status = call.getInt("status") ?: 200
        p.body = call.getString("body") ?: ""
        p.latch.countDown()
        call.resolve()
    }

    override fun handleOnDestroy() {
        synchronized(this) { stopLocked() }
        super.handleOnDestroy()
    }

    private fun statusObject(): JSObject {
        val ret = JSObject()
        val running = serverSocket != null && !(serverSocket?.isClosed ?: true)
        ret.put("running", running)
        ret.put("port", if (running) boundPort else 0)
        return ret
    }

    private fun stopLocked() {
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        serverSocket = null
        boundPort = 0
        // Fail in-flight requests fast instead of letting them time out.
        for ((_, p) in pending) {
            p.status = 503
            p.body = "{\"error\":\"The localhost API was stopped.\"}"
            p.latch.countDown()
        }
        pending.clear()
    }

    // ------------------------------------------------------------------
    // HTTP plumbing (native -> JS -> native)
    // ------------------------------------------------------------------

    private fun acceptLoop(ss: ServerSocket) {
        while (!ss.isClosed) {
            val socket = try {
                ss.accept()
            } catch (e: Exception) {
                break // socket closed by stop()
            }
            val t = Thread({ handleConnection(socket) }, "longtable-localapi-conn")
            t.isDaemon = true
            t.start()
        }
    }

    private fun handleConnection(socket: Socket) {
        try {
            socket.soTimeout = 60_000
            val input = BufferedInputStream(socket.getInputStream())
            val out = socket.getOutputStream()
            val request = readRequest(input, out)
            when {
                request == null ->
                    writeResponse(out, 400, "{\"error\":\"That HTTP request could not be read.\"}")
                request.tooLarge ->
                    writeResponse(out, 413, "{\"error\":\"That request body is too large.\"}")
                else -> {
                    val id = "req-" + ids.incrementAndGet()
                    val p = Pending(CountDownLatch(1))
                    pending[id] = p
                    val event = JSObject()
                    event.put("id", id)
                    event.put("method", request.method)
                    event.put("path", request.path)
                    event.put("query", request.query)
                    val headers = JSObject()
                    for ((k, v) in request.headers) headers.put(k, v)
                    event.put("headers", headers)
                    event.put("body", request.body)
                    notifyListeners("request", event)
                    val answered = p.latch.await(RESPONSE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                    pending.remove(id)
                    if (answered) {
                        writeResponse(out, p.status, p.body)
                    } else {
                        writeResponse(
                            out, 504,
                            "{\"error\":\"The app did not answer in time — it may be suspended in the background.\"}",
                        )
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "connection failed", e)
            try {
                writeResponse(
                    socket.getOutputStream(), 500,
                    "{\"error\":\"Something went wrong on the device.\"}",
                )
            } catch (_: Exception) {
            }
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
            }
        }
    }

    /**
     * Read one HTTP/1.1 request: request line, headers, then the body
     * framed by Content-Length or chunked transfer encoding. Returns
     * null on garbage. Header names are lowercased for the JS layer.
     */
    private fun readRequest(input: InputStream, out: OutputStream): ParsedRequest? {
        val headerBytes = readUntil(input, byteArrayOf(13, 10, 13, 10), MAX_HEADER_BYTES)
            ?: return null
        val headerText = String(headerBytes, Charsets.ISO_8859_1)
        val lines = headerText.split("\r\n")
        if (lines.isEmpty()) return null
        val requestLine = lines[0].split(" ")
        if (requestLine.size < 2) return null
        val method = requestLine[0].uppercase()
        val target = requestLine[1]
        val q = target.indexOf('?')
        val path = if (q >= 0) target.substring(0, q) else target
        val query = if (q >= 0) target.substring(q + 1) else ""

        val headers = LinkedHashMap<String, String>()
        for (i in 1 until lines.size) {
            val line = lines[i]
            val colon = line.indexOf(':')
            if (colon > 0) {
                headers[line.substring(0, colon).trim().lowercase()] =
                    line.substring(colon + 1).trim()
            }
        }

        if (headers["expect"]?.equals("100-continue", ignoreCase = true) == true) {
            out.write("HTTP/1.1 100 Continue\r\n\r\n".toByteArray(Charsets.US_ASCII))
            out.flush()
        }

        var tooLarge = false
        val bodyBytes: ByteArray
        val contentLength = headers["content-length"]?.toIntOrNull()
        val chunked = headers["transfer-encoding"]
            ?.contains("chunked", ignoreCase = true) == true
        when {
            chunked -> {
                val acc = ByteArrayOutputStream()
                var overflow = false
                while (true) {
                    val sizeLine = readLine(input) ?: break
                    val size = sizeLine.trim().toIntOrNull(16) ?: break
                    if (size == 0) {
                        // Trailer part: lines until an empty one.
                        while (true) {
                            val trailer = readLine(input)
                            if (trailer == null || trailer.isEmpty()) break
                        }
                        break
                    }
                    var remaining = size
                    val buf = ByteArray(8192)
                    while (remaining > 0) {
                        val n = input.read(buf, 0, minOf(buf.size, remaining))
                        if (n < 0) {
                            remaining = -1
                            break
                        }
                        if (!overflow) {
                            acc.write(buf, 0, n)
                            if (acc.size() > MAX_BODY_BYTES) overflow = true
                        }
                        remaining -= n
                    }
                    if (remaining < 0) break
                    readLine(input) // chunk-terminating CRLF
                }
                tooLarge = overflow
                bodyBytes = acc.toByteArray()
            }
            contentLength != null -> {
                if (contentLength < 0) return null
                if (contentLength > MAX_BODY_BYTES) {
                    tooLarge = true
                    bodyBytes = ByteArray(0)
                } else {
                    val acc = ByteArrayOutputStream(contentLength)
                    val buf = ByteArray(8192)
                    var remaining = contentLength
                    while (remaining > 0) {
                        val n = input.read(buf, 0, minOf(buf.size, remaining))
                        if (n < 0) break
                        acc.write(buf, 0, n)
                        remaining -= n
                    }
                    bodyBytes = acc.toByteArray()
                }
            }
            else -> bodyBytes = ByteArray(0)
        }
        return ParsedRequest(
            method, path, query, headers,
            String(bodyBytes, Charsets.UTF_8), tooLarge,
        )
    }

    /** Read until the delimiter sequence is consumed; null on EOF/overflow. */
    private fun readUntil(input: InputStream, delim: ByteArray, cap: Int): ByteArray? {
        val acc = ByteArrayOutputStream()
        var matched = 0
        while (acc.size() <= cap) {
            val b = input.read()
            if (b < 0) return null
            acc.write(b)
            matched = when {
                b == delim[matched].toInt() -> matched + 1
                b == delim[0].toInt() -> 1
                else -> 0
            }
            if (matched == delim.size) return acc.toByteArray()
        }
        return null
    }

    /** Read one CRLF-terminated line (without the CRLF); null on immediate EOF. */
    private fun readLine(input: InputStream): String? {
        val acc = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (acc.size() == 0) null else String(acc.toByteArray(), Charsets.ISO_8859_1)
            if (b == 10) {
                val bytes = acc.toByteArray()
                val len = if (bytes.isNotEmpty() && bytes[bytes.size - 1] == 13.toByte())
                    bytes.size - 1 else bytes.size
                return String(bytes, 0, len, Charsets.ISO_8859_1)
            }
            acc.write(b)
            if (acc.size() > MAX_HEADER_BYTES) return null
        }
    }

    private fun writeResponse(out: OutputStream, status: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status ${reasonPhrase(status)}\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.US_ASCII))
        out.write(bytes)
        out.flush()
    }

    private fun reasonPhrase(status: Int): String = when (status) {
        200 -> "OK"
        201 -> "Created"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        413 -> "Payload Too Large"
        422 -> "Unprocessable Entity"
        500 -> "Internal Server Error"
        502 -> "Bad Gateway"
        503 -> "Service Unavailable"
        504 -> "Gateway Timeout"
        else -> "Status"
    }
}
