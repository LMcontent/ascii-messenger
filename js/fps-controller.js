// ─────────────────────────────────────────────────────────────────────────────
// fps-controller.js — Adaptive FPS management
//
// Auto mode: measures DataChannel bufferedAmount and RTT ping/pong
// to dynamically lower FPS under network pressure, raise when clear.
// Manual mode: user slider sets target, but auto can still reduce it.
// ─────────────────────────────────────────────────────────────────────────────

export class FpsController {
  constructor ({ target = 10, min = 1, max = 24, onChange } = {}) {
    this.targetFps  = target
    this.minFps     = min
    this.maxFps     = max
    this.currentFps = target
    this.autoMode   = true
    this.onChange   = onChange ?? (() => {})

    // RTT tracking
    this.rtt        = 0
    this.pingTs     = 0
    this.pendingPing = false

    // Smoothed metrics
    this._rttSmooth = 0
    this._bufSmooth = 0

    // Intervals
    this._loopHandle  = null
    this._pingHandle  = null
  }

  // ── Start frame loop ─────────────────────────────────────────────────────
  start (renderFn) {
    this._renderFn = renderFn
    this._scheduleNext()
  }

  stop () {
    clearTimeout(this._loopHandle)
    clearInterval(this._pingHandle)
  }

  // ── Manual FPS (user slider) ─────────────────────────────────────────────
  setManualFps (fps) {
    this.targetFps = Math.max(this.minFps, Math.min(this.maxFps, fps))
    if (!this.autoMode) {
      this.currentFps = this.targetFps
      this.onChange(this.currentFps)
    }
  }

  setAutoMode (enabled) {
    this.autoMode = enabled
    if (!enabled) {
      this.currentFps = this.targetFps
      this.onChange(this.currentFps)
    }
  }

  // ── Attach DataChannel for buffer monitoring ─────────────────────────────
  attachDataChannel (dataChannel) {
    this._dc = dataChannel

    // Ping every 2s for RTT
    this._pingHandle = setInterval(() => this._sendPing(), 2000)
  }

  // ── Handle pong received ─────────────────────────────────────────────────
  onPong (timestamp) {
    const rtt       = Date.now() - timestamp
    this._rttSmooth = this._rttSmooth * 0.7 + rtt * 0.3
    this.rtt        = Math.round(this._rttSmooth)
    this.pendingPing = false
    if (this.autoMode) this._adjust()
  }

  // ── Internal ─────────────────────────────────────────────────────────────
  _scheduleNext () {
    const delay = 1000 / this.currentFps
    this._loopHandle = setTimeout(() => {
      if (this._renderFn) this._renderFn()
      this._scheduleNext()
    }, delay)
  }

  _sendPing () {
    if (!this._dc || this._dc.readyState !== 'open') return
    const buf  = new ArrayBuffer(5)
    const view = new DataView(buf)
    view.setUint8(0, 0x03) // type = ping
    view.setUint32(1, Date.now() & 0xFFFFFFFF)
    try { this._dc.send(buf) } catch (_) {}
    this.pendingPing = true
  }

  _adjust () {
    if (!this._dc) return

    const bufAmount  = this._dc.bufferedAmount ?? 0
    this._bufSmooth  = this._bufSmooth * 0.8 + bufAmount * 0.2

    const rtt        = this._rttSmooth
    const buf        = this._bufSmooth

    // Pressure score 0–1
    let pressure = 0
    if (rtt  > 300) pressure += 0.5
    else if (rtt > 150) pressure += 0.25
    else if (rtt > 80)  pressure += 0.1

    if (buf > 65536)  pressure += 0.5      // >64KB queued → bad
    else if (buf > 16384) pressure += 0.25
    else if (buf > 4096)  pressure += 0.1

    pressure = Math.min(1, pressure)

    // Target FPS based on pressure
    const range      = this.targetFps - this.minFps
    const desired    = Math.round(this.targetFps - pressure * range)
    const newFps     = Math.max(this.minFps, Math.min(this.targetFps, desired))

    if (newFps !== this.currentFps) {
      this.currentFps = newFps
      this.onChange(this.currentFps)
    }
  }

  getRTT ()   { return this.rtt }
  getFps ()   { return this.currentFps }
}
