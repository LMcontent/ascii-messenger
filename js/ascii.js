// ─────────────────────────────────────────────────────────────────────────────
// ascii.js — Video frame → ASCII art pipeline
//
// Pipeline:
//   VideoFrame → Canvas → Grayscale pixels → INVERTED luminance → Char mapping →
//   Delta encode (only changed cells) → Binary packet
//
// Binary packet format (ArrayBuffer):
//   [type:1][timestamp:4][width:1][height:1][count:2][x:1][y:1][charIdx:1]×count
//
// Type: 0x01 = delta frame, 0x02 = full frame (keyframe)
// ─────────────────────────────────────────────────────────────────────────────

// Character sets ordered from dark→light density
const CHARSETS = {
  standard: ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
  blocks:   ' ░▒▓█',
  minimal:  ' .-:=+*#@',
  gradient: ' .:;+xX$'  // Оптимизированный для инвертированного режима
}

export class AsciiEncoder {
  constructor ({ cols = 80, charset = 'gradient', invert = false } = {}) {
    this.cols    = cols
    this.charset = CHARSETS[charset] ?? CHARSETS.gradient
    this.invert  = invert
    this.rows    = Math.floor(cols * 0.42)  // ~2.38:1 char aspect ratio
    this.canvas  = document.createElement('canvas')
    this.ctx     = this.canvas.getContext('2d', { willReadFrequently: true })
    this.prevFrame = null
    this.frameCount = 0
  }

  // ── Encode a video frame ──────────────────────────────────────────────────
  encodeFrame (videoEl) {
    const { cols, rows, charset } = this

    // Draw scaled-down frame
    this.canvas.width  = cols
    this.canvas.height = rows
    this.ctx.drawImage(videoEl, 0, 0, cols, rows)

    const imageData = this.ctx.getImageData(0, 0, cols, rows)
    const pixels    = imageData.data

    // Map each pixel to char index
    const current = new Uint8Array(cols * rows)
    for (let i = 0; i < cols * rows; i++) {
      const r = pixels[i * 4]
      const g = pixels[i * 4 + 1]
      const b = pixels[i * 4 + 2]
      // Perceptual luminance (с инверсией или без в зависимости от настройки)
      let lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      if (this.invert) lum = 1.0 - lum
      // Map to char index (0 = darkest space, last = densest)
      current[i] = Math.floor(lum * (charset.length - 1))
    }

    this.frameCount++
    const isKeyframe = !this.prevFrame || this.frameCount % 60 === 0

    // Build delta or full frame
    const changed = []
    for (let i = 0; i < cols * rows; i++) {
      if (isKeyframe || !this.prevFrame || this.prevFrame[i] !== current[i]) {
        const x = i % cols
        const y = Math.floor(i / cols)
        changed.push(x, y, current[i])
      }
    }

    this.prevFrame = current.slice()

    // Build binary packet: [type:1][ts:4][w:1][h:1][count:2][x,y,c triplets]
    const type       = isKeyframe ? 0x02 : 0x01
    const count      = changed.length / 3
    const bufferSize = 1 + 4 + 1 + 1 + 2 + count * 3
    const buffer     = new ArrayBuffer(bufferSize)
    const view       = new DataView(buffer)

    let offset = 0
    view.setUint8  (offset, type);           offset += 1
    view.setUint32 (offset, Date.now() & 0xFFFFFFFF); offset += 4
    view.setUint8  (offset, cols);           offset += 1
    view.setUint8  (offset, rows);           offset += 1
    view.setUint16 (offset, count);          offset += 2

    for (let i = 0; i < changed.length; i += 3) {
      view.setUint8(offset++, changed[i])     // x
      view.setUint8(offset++, changed[i + 1]) // y
      view.setUint8(offset++, changed[i + 2]) // charIdx
    }

    return buffer
  }

  // ── Render ASCII string for local preview ────────────────────────────────
  renderLocal (videoEl) {
    const { cols, rows, charset } = this
    this.canvas.width  = cols
    this.canvas.height = rows
    this.ctx.drawImage(videoEl, 0, 0, cols, rows)
    const imageData = this.ctx.getImageData(0, 0, cols, rows)
    const pixels    = imageData.data
    const lines     = []

    for (let y = 0; y < rows; y++) {
      let line = ''
      for (let x = 0; x < cols; x++) {
        const i   = (y * cols + x) * 4
        // Perceptual luminance (с инверсией или без в зависимости от настройки)
        let lum = (0.299 * pixels[i] + 0.587 * pixels[i+1] + 0.114 * pixels[i+2]) / 255
        if (this.invert) lum = 1.0 - lum
        line += charset[Math.floor(lum * (charset.length - 1))]
      }
      lines.push(line)
    }

    return lines.join('\n')
  }

  // ── Update settings ───────────────────────────────────────────────────────
  setOptions ({ cols, charset, invert } = {}) {
    if (cols)    { this.cols = cols; this.rows = Math.floor(cols * 0.42); }
    if (charset) { this.charset = CHARSETS[charset] ?? this.charset; }
    if (invert !== undefined) { this.invert = invert; }
    this.prevFrame = null // Force keyframe
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AsciiDecoder — applies received packets to a frame buffer, renders to <pre>
// ─────────────────────────────────────────────────────────────────────────────
export class AsciiDecoder {
  constructor () {
    this.buffer  = null
    this.cols    = 0
    this.rows    = 0
    this.charset = CHARSETS.gradient
  }

  // ── Decode a binary packet ────────────────────────────────────────────────
  decode (arrayBuffer) {
    const view   = new DataView(arrayBuffer)
    let offset   = 0

    const type   = view.getUint8(offset); offset += 1
    /* ts */       offset += 4
    const cols   = view.getUint8(offset); offset += 1
    const rows   = view.getUint8(offset); offset += 1
    const count  = view.getUint16(offset); offset += 2

    // Reset buffer on keyframe or dimension change
    if (type === 0x02 || !this.buffer || this.cols !== cols || this.rows !== rows) {
      this.cols   = cols
      this.rows   = rows
      this.buffer = new Uint8Array(cols * rows)
    }

    for (let i = 0; i < count; i++) {
      const x       = view.getUint8(offset++);
      const y       = view.getUint8(offset++);
      const charIdx = view.getUint8(offset++);
      if (x < cols && y < rows) this.buffer[y * cols + x] = charIdx
    }

    return this.render()
  }

  // ── Render buffer to ASCII string ─────────────────────────────────────────
  render () {
    const { buffer, cols, rows, charset } = this
    if (!buffer) return ''
    const lines = []
    for (let y = 0; y < rows; y++) {
      let line = ''
      for (let x = 0; x < cols; x++) {
        line += charset[buffer[y * cols + x]] ?? ' '
      }
      lines.push(line)
    }
    return lines.join('\n')
  }

  // ── Update charset (must match sender!) ──────────────────────────────────
  setCharset (name) {
    this.charset = CHARSETS[name] ?? this.charset
  }
}
