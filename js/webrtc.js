// ─────────────────────────────────────────────────────────────────────────────
// webrtc.js — RTCPeerConnection wrapper
//
// Responsibilities:
//   - Create peer connection with STUN servers
//   - Manage audio track (mic → Opus)
//   - Create & manage DataChannel for ASCII video + text
//   - Orchestrate signaling via Firebase (via signaling.js)
// ─────────────────────────────────────────────────────────────────────────────

import { createRoom, joinRoom } from './signaling.js'

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' }
]

export class PeerConnection {
  constructor ({ onOpen, onData, onPong, onStateChange, sdpModifier } = {}) {
    this.onOpen        = onOpen        ?? (() => {})
    this.onData        = onData        ?? (() => {})
    this.onPong        = onPong        ?? (() => {})
    this.onStateChange = onStateChange ?? (() => {})
    this.sdpModifier   = sdpModifier   ?? ((sdp) => sdp)  // Optional SDP modifier

    this.pc     = null
    this.dc     = null    // DataChannel (ASCII video + text)
    this._sig   = null    // Signaling session
    this._unsubFns = []   // Firebase listener unsubscribe fns
  }

  // ── Create a room (caller) ───────────────────────────────────────────────
  async createRoom (roomCode, localStream) {
    this._initPC(localStream)
    this._createDataChannel()

    // Create offer
    const offer = await this.pc.createOffer()
    
    // Apply SDP modifications (e.g., Opus bitrate)
    offer.sdp = this.sdpModifier(offer.sdp)
    
    await this.pc.setLocalDescription(offer)
    await this._waitForICEGathering()

    // Push to Firebase
    this._sig = await createRoom(roomCode, this.pc.localDescription)

    // Buffer for ICE candidates that arrive before remote description
    const iceCandidateBuffer = []
    let remoteDescriptionSet = false

    // Listen for answer
    const unsubAnswer = this._sig.onAnswer(async (answerSdp) => {
      if (this.pc.signalingState === 'have-local-offer') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
        remoteDescriptionSet = true
        
        // Apply buffered ICE candidates
        for (const candidate of iceCandidateBuffer) {
          try { 
            await this.pc.addIceCandidate(candidate)
            console.log('[ICE] Applied buffered candidate')
          }
          catch (e) { console.warn('[ICE] Error adding buffered candidate:', e) }
        }
        iceCandidateBuffer.length = 0
      }
    })
    this._unsubFns.push(unsubAnswer)

    // Listen for ICE candidates from callee
    const unsubIce = this._sig.onIceCandidate(async (candidate) => {
      if (remoteDescriptionSet) {
        // Remote description ready - add immediately
        try { await this.pc.addIceCandidate(candidate) }
        catch (e) { console.warn('[ICE] Error adding candidate:', e) }
      } else {
        // Buffer until remote description is set
        iceCandidateBuffer.push(candidate)
        console.log('[ICE] Buffering candidate (remote description not ready)')
      }
    })
    this._unsubFns.push(unsubIce)
  }

  // ── Join a room (callee) ─────────────────────────────────────────────────
  async joinRoom (roomCode, localStream) {
    this._initPC(localStream)

    // Buffer for ICE candidates that arrive before remote description
    const iceCandidateBuffer = []

    // Fetch offer from Firebase
    this._sig = await joinRoom(roomCode)
    const offerSdp = this._sig.offerSdp
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
    
    // Remote description now set - we can process ICE candidates

    // Create answer
    const answer = await this.pc.createAnswer()
    
    // Apply SDP modifications (e.g., Opus bitrate)
    answer.sdp = this.sdpModifier(answer.sdp)
    
    await this.pc.setLocalDescription(answer)
    await this._waitForICEGathering()

    // Push answer
    await this._sig.setAnswer(this.pc.localDescription)

    // Listen for ICE candidates from caller
    const unsubIce = this._sig.onIceCandidate(async (candidate) => {
      // We already set remote description, so add immediately
      try { await this.pc.addIceCandidate(candidate) }
      catch (e) { console.warn('[ICE] Error adding candidate:', e) }
    })
    this._unsubFns.push(unsubIce)
  }

  // ── Send binary data (ASCII frame) ───────────────────────────────────────
  send (arrayBuffer) {
    if (!this.dc || this.dc.readyState !== 'open') return
    try { this.dc.send(arrayBuffer) }
    catch (e) { console.warn('[DC] Send error:', e) }
  }

  // ── Send chat message (text message in messenger) ─────────────────────────
  sendChatMessage (text) {
    if (!text || text.trim().length === 0) return
    if (!this.dc || this.dc.readyState !== 'open') {
      console.error('[DC] DataChannel not ready for chat message')
      return
    }

    // Packet format: [type:1][timestamp:4][reserved:2][length:2][text:utf8]
    const encoder = new TextEncoder()
    const textBytes = encoder.encode(text)
    const buffer = new ArrayBuffer(9 + textBytes.length)
    const view = new DataView(buffer)

    view.setUint8(0, 0x06)  // Type 0x06 = Chat text message
    view.setUint32(1, Date.now() & 0xFFFFFFFF)
    view.setUint16(5, 0)
    view.setUint16(7, textBytes.length)

    const bytes = new Uint8Array(buffer)
    bytes.set(textBytes, 9)

    try {
      this.dc.send(buffer)
      console.log('[DC] Chat message sent:', text.substring(0, 50))
    } catch (e) {
      console.error('[DC] Send chat message error:', e)
    }
  }

  // ── Toggle audio track ───────────────────────────────────────────────────
  setMicMuted (muted) {
    this.pc?.getSenders()
      .filter(s => s.track?.kind === 'audio')
      .forEach(s => { s.track.enabled = !muted })
  }

  getDataChannel () { return this.dc }

  // ── Close connection ──────────────────────────────────────────────────────
  async close () {
    this._unsubFns.forEach(fn => fn())
    this._unsubFns = []
    this.dc?.close()
    this.pc?.close()
    await this._sig?.cleanup()
  }

  // ── Internal ─────────────────────────────────────────────────────────────
  _initPC (localStream) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    // Add audio track if available (Opus via WebRTC)
    if (localStream) {
      localStream.getAudioTracks().forEach(track => this.pc.addTrack(track, localStream))
    }

    // Forward ICE candidates to Firebase
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._sig?.pushIceCandidate(candidate.toJSON())
    }

    // Connection state
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState
      this.onStateChange(state)
      if (state === 'connected') {
        this._sig?.cleanup().catch(() => {})
      }
    }

    // Receive DataChannel (callee side)
    this.pc.ondatachannel = ({ channel }) => {
      this._setupDataChannel(channel)
    }

    // Receive remote audio
    this.pc.ontrack = ({ streams }) => {
      if (streams[0]) {
        const audio = document.createElement('audio')
        audio.srcObject = streams[0]
        audio.autoplay  = true
        document.body.appendChild(audio)
      }
    }
  }

  _createDataChannel () {
    const dc = this.pc.createDataChannel('ascii-video', {
      ordered:    false,     // Drop late frames — we don't want old video
      maxRetransmits: 0      // No retransmit, live video only
    })
    this._setupDataChannel(dc)
  }

  _setupDataChannel (dc) {
    this.dc = dc
    dc.binaryType = 'arraybuffer'

    dc.onopen  = () => {
      console.log('[DC] DataChannel opened, state:', dc.readyState)
      this.onOpen(dc)
    }
    dc.onerror = (e) => console.warn('[DC] error', e)
    dc.onclose = () => console.log('[DC] DataChannel closed')

    dc.onmessage = ({ data }) => {
      const view = new DataView(data)
      const type = view.getUint8(0)

      // Log ALL incoming packets for debugging
      console.log('[DC] ← Received packet: type=0x' + type.toString(16).padStart(2, '0'), 'size=' + data.byteLength + ' bytes')

      if (type === 0x03) {
        // Ping → send pong back
        const pongBuf = new ArrayBuffer(5)
        const pv = new DataView(pongBuf)
        pv.setUint8(0, 0x04)
        pv.setUint32(1, view.getUint32(1))
        try { dc.send(pongBuf) } catch (_) {}
        return
      }

      if (type === 0x04) {
        // Pong → measure RTT
        this.onPong(view.getUint32(1))
        return
      }

      // 0x01 / 0x02 / 0x05 — pass to app.js handler
      this.onData(data)
    }
  }

  // ── Wait for ICE gathering to complete (or 2s timeout) ───────────────────
  _waitForICEGathering () {
    return new Promise(resolve => {
      if (this.pc.iceGatheringState === 'complete') { resolve(); return }
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', check)
          resolve()
        }
      }
      this.pc.addEventListener('icegatheringstatechange', check)
      setTimeout(resolve, 2500) // Fallback timeout
    })
  }
}
