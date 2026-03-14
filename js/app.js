// ─────────────────────────────────────────────────────────────────────────────
// app.js — Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

import { generateRoomCode }    from './signaling.js'
import { PeerConnection }      from './webrtc.js'
import { AsciiEncoder, AsciiDecoder } from './ascii.js'
import { FpsController }       from './fps-controller.js'
import { Messenger }           from './messenger.js'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const screens = {
  boot:  $('screen-boot'),
  lobby: $('screen-lobby'),
  call:  $('screen-call')
}

// ── State ────────────────────────────────────────────────────────────────────
let peer      = null
let encoder   = null
let decoder   = null
let fps       = null
let stream    = null
let camOn     = true
let micOn     = true
let txBytes   = 0
let txMeasureTs = Date.now()

// Messenger
let messenger = null
let currentMode = 'video'  // 'video' or 'messenger'

// Bandwidth modes
let bandwidthMode = 'normal'  // 'normal', 'low', 'ultra'
const BANDWIDTH_MODES = {
  normal: {
    label: '⚡ NORMAL',
    audio: { bitrate: 24000, dtx: false },
    video: { fps: 10, cols: 120 },
    description: 'WiFi/4G'
  },
  low: {
    label: '🐌 LOW',
    audio: { bitrate: 8000, dtx: true },
    video: { fps: 3, cols: 60 },
    description: 'Slow 3G'
  },
  ultra: {
    label: '📡 ULTRA',
    audio: { bitrate: 6000, dtx: true },
    video: { fps: 1, cols: 40 },
    description: 'Mesh/LoRa/Sat'
  }
}

// ── Speech (STT + TTS) ───────────────────────────────────────────────────────
// ── Initialize Messenger ──────────────────────────────────────────────────────
function initializeMessenger() {
  console.log('[MESSENGER] Initializing...')
  
  messenger = new Messenger({
    onSendMessage: (message) => {
      // Send message via DataChannel
      if (peer && message.type === 'text') {
        peer.sendChatMessage(message.content)
      }
    }
  })
  
  console.log('[MESSENGER] Initialized')
}

// ── Mode Switching (VIDEO / MESSENGER) ───────────────────────────────────────
function setMode(mode) {
  console.log('[MODE] Switching to:', mode)
  currentMode = mode
  
  const videoArea = document.querySelector('.video-area')
  const messengerArea = document.querySelector('.messenger-area')
  const btnVideo = $('btn-mode-video')
  const btnMessenger = $('btn-mode-messenger')
  
  if (mode === 'video') {
    // Show video, hide messenger
    videoArea?.classList.remove('hidden')
    messengerArea?.classList.add('hidden')
    btnVideo?.classList.add('mode-btn-active')
    btnMessenger?.classList.remove('mode-btn-active')
    
    // Resume FPS with render loop if paused
    if (fps && !fps.isRunning) {
      startRenderLoop()
      console.log('[MODE] FPS and render loop resumed')
    }
    
    // Unmute mic in video mode
    peer?.setMicMuted(false)
    
  } else if (mode === 'messenger') {
    // Hide video, show messenger
    videoArea?.classList.add('hidden')
    messengerArea?.classList.remove('hidden')
    btnVideo?.classList.remove('mode-btn-active')
    btnMessenger?.classList.add('mode-btn-active')
    
    // Pause FPS to save bandwidth
    if (fps && fps.isRunning) {
      fps.stop()
      console.log('[MODE] FPS paused')
    }
    
    // Mute mic in messenger mode (not needed for text chat)
    peer?.setMicMuted(true)
    console.log('[MODE] Mic muted in messenger mode')
    
    // Render messages
    messenger?.renderMessages()
  }
}

// ── Bandwidth Mode Switching ──────────────────────────────────────────────────
function setBandwidthMode(mode) {
  console.log('[BANDWIDTH] Switching to:', mode)
  
  if (!BANDWIDTH_MODES[mode]) {
    console.error('[BANDWIDTH] ✗ Invalid mode:', mode)
    alert('Invalid bandwidth mode: ' + mode)
    return
  }
  
  bandwidthMode = mode
  const config = BANDWIDTH_MODES[mode]
  console.log('[BANDWIDTH] Config:', config)
  
  // Update FPS (works immediately)
  if (fps) {
    fps.setManualFps(config.video.fps)
    console.log('[BANDWIDTH] ✓ FPS set to:', config.video.fps)
  } else {
    console.log('[BANDWIDTH] ⚠ FPS not initialized yet')
  }
  
  // Update ASCII cols (works immediately)
  if (encoder) {
    encoder.setOptions({ cols: config.video.cols })
    console.log('[BANDWIDTH] ✓ Cols set to:', config.video.cols)
  } else {
    console.log('[BANDWIDTH] ⚠ Encoder not initialized yet')
  }
  
  // Update UI sliders
  const fpsSlider = $('fps-slider')
  const fpsDisplay = $('fps-display')
  const colsSelect = $('ascii-cols')
  
  if (fpsSlider) fpsSlider.value = config.video.fps
  if (fpsDisplay) fpsDisplay.textContent = config.video.fps
  if (colsSelect) colsSelect.value = config.video.cols
  
  // Update bandwidth indicator
  updateBandwidthUI()
  
  // Audio bitrate changes will apply on next connection
  if (peer && peer.pc) {
    console.log('[BANDWIDTH] ℹ In active call - audio changes will apply on next call')
  } else {
    console.log('[BANDWIDTH] ℹ Audio settings will be used when connecting')
  }
  
  console.log('[BANDWIDTH] ✓ Mode switched to:', mode, config.label)
}

function modifyOpusSDP(sdp, audioConfig) {
  // Find Opus codec line and add parameters
  const lines = sdp.split('\r\n')
  let opusPayloadType = null
  
  // Find Opus payload type
  for (let line of lines) {
    if (line.includes('opus/48000')) {
      const match = line.match(/:\d+ /)
      if (match) {
        opusPayloadType = match[0].replace(/[: ]/g, '')
      }
      break
    }
  }
  
  if (!opusPayloadType) {
    console.warn('[BANDWIDTH] Opus codec not found in SDP')
    return sdp
  }
  
  // Build fmtp line with Opus parameters
  const opusFmtp = `a=fmtp:${opusPayloadType} ` +
    `minptime=10;` +
    `useinbandfec=0;` +
    `maxaveragebitrate=${audioConfig.bitrate};` +
    `stereo=0;` +
    `sprop-stereo=0;` +
    `cbr=1;` +
    (audioConfig.dtx ? 'usedtx=1;' : 'usedtx=0;')
  
  // Remove existing fmtp line for this payload type
  const filteredLines = lines.filter(line => 
    !line.startsWith(`a=fmtp:${opusPayloadType}`)
  )
  
  // Insert new fmtp line after rtpmap
  const result = []
  for (let line of filteredLines) {
    result.push(line)
    if (line.includes(`a=rtpmap:${opusPayloadType}`)) {
      result.push(opusFmtp)
      console.log('[BANDWIDTH] Added Opus fmtp:', opusFmtp)
    }
  }
  
  return result.join('\r\n')
}

function updateBandwidthUI() {
  const indicator = $('bandwidth-indicator')
  if (!indicator) {
    console.error('[BANDWIDTH] ✗ bandwidth-indicator element not found!')
    return
  }
  
  const config = BANDWIDTH_MODES[bandwidthMode]
  indicator.textContent = config.label
  indicator.className = 'bandwidth-indicator bandwidth-' + bandwidthMode
  indicator.title = config.description
  
  console.log('[BANDWIDTH] ✓ Indicator updated to:', config.label)
}

// ── Boot sequence ─────────────────────────────────────────────────────────────
async function boot () {
  const log  = $('boot-log')
  const bar  = $('boot-bar-fill')
  const stat = $('boot-status')

  const steps = [
    [10,  'Loading Firebase SDK...'],
    [25,  'Checking WebRTC support...'],
    [45,  'Requesting camera & microphone...'],
    [65,  'Initializing ASCII encoder...'],
    [80,  'Configuring peer transport...'],
    [95,  'Ready.'],
    [100, 'SYSTEM ONLINE']
  ]

  for (const [pct, msg] of steps) {
    bar.style.width = pct + '%'
    stat.textContent = msg
    addBootLog(log, msg)
    await sleep(pct === 100 ? 400 : 200 + Math.random() * 150)
  }

  // Check browser support
  if (!window.RTCPeerConnection) {
    stat.textContent = 'ERROR: WebRTC not supported in this browser'
    return
  }

  // Initialize bandwidth mode listeners
  initBandwidthListeners()

  await sleep(300)
  showScreen('lobby')
}

// ── Initialize Bandwidth Listeners ────────────────────────────────────────────
function initBandwidthListeners() {
  const btnBandwidth = $('btn-bandwidth')
  const menuBandwidth = $('bandwidth-menu')

  if (!btnBandwidth || !menuBandwidth) {
    console.error('[BANDWIDTH] Elements not found!')
    return
  }

  // Toggle menu
  btnBandwidth.addEventListener('click', (e) => {
    e.stopPropagation()
    menuBandwidth.classList.toggle('hidden')
  })

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!menuBandwidth.contains(e.target) && !btnBandwidth.contains(e.target)) {
      menuBandwidth.classList.add('hidden')
    }
  })

  // Add click listeners to each option button
  const options = menuBandwidth.querySelectorAll('.bandwidth-option')
  console.log('[BANDWIDTH] Found', options.length, 'option buttons')
  
  options.forEach((btn) => {
    const mode = btn.getAttribute('data-mode')
    
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      
      if (mode) {
        setBandwidthMode(mode)
        menuBandwidth.classList.add('hidden')
      }
    })
  })

  console.log('[BANDWIDTH] ✓ Listeners initialized')
}

function addBootLog (container, msg) {
  const line = document.createElement('div')
  line.className   = 'boot-log-line'
  line.textContent = `> ${msg}`
  container.appendChild(line)
  if (container.children.length > 6) container.firstChild.remove()
}

// ── Screen manager ────────────────────────────────────────────────────────────
function showScreen (name) {
  Object.values(screens).forEach(s => s.classList.remove('active'))
  screens[name].classList.add('active')
}

// ── Audio Constraints ──────────────────────────────────────────────────────────
function getAudioConstraints() {
  const mode = BANDWIDTH_MODES[bandwidthMode]
  
  if (bandwidthMode === 'normal') {
    // Normal quality - default WebRTC
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  } else {
    // LOW/ULTRA - optimized for low bandwidth
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,        // MONO
      sampleRate: 16000,      // 16kHz (instead of 48kHz)
      sampleSize: 16
    }
  }
}

// ── Camera & mic setup ────────────────────────────────────────────────────────
async function getMedia () {
  try {
    // Build audio constraints based on bandwidth mode
    const audioConstraints = getAudioConstraints()
    
    stream = await navigator.mediaDevices.getUserMedia({ 
      video: true, 
      audio: audioConstraints 
    })
    
    const videoEl = $('local-video')
    videoEl.srcObject = stream
    
    // КРИТИЧНО: принудительно запустить воспроизведение
    try {
      await videoEl.play()
      console.log('[CAMERA] Video playback started')
    } catch (e) {
      console.warn('[CAMERA] Autoplay failed, but continuing:', e)
    }
    
    return stream
  } catch (e) {
    console.warn('Failed to get audio+video, trying video only:', e)
    // Try video only
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      const videoEl = $('local-video')
      videoEl.srcObject = stream
      
      // КРИТИЧНО: принудительно запустить воспроизведение
      try {
        await videoEl.play()
        console.log('[CAMERA] Video playback started (video only)')
      } catch (e) {
        console.warn('[CAMERA] Autoplay failed, but continuing:', e)
      }
      
      return stream
    } catch (err) {
      console.error('Failed to get camera:', err)
      alert('Camera access denied or unavailable. Check browser permissions.')
      return null
    }
  }
}

// ── Lobby: Create room ────────────────────────────────────────────────────────
$('btn-create').addEventListener('click', async () => {
  const code = generateRoomCode()
  $('room-code-value').textContent = code
  $('room-code-display').classList.remove('hidden')
  $('btn-create').disabled = true
  $('create-status').textContent = '⟳ WAITING FOR PEER...'

  const localStream = await getMedia()
  if (!localStream) {
    $('create-status').textContent = '✗ Camera access denied'
    $('btn-create').disabled = false
    return
  }

  peer = new PeerConnection({
    onOpen:        handleOpen,
    onData:        handleIncomingFrame,
    onPong:        ts => fps?.onPong(ts),
    onStateChange: handleStateChange,
    sdpModifier:   (sdp) => modifyOpusSDP(sdp, BANDWIDTH_MODES[bandwidthMode].audio)
  })

  try {
    await peer.createRoom(code, localStream)
  } catch (e) {
    console.error('Failed to create room:', e)
    $('create-status').textContent = '✗ Connection failed'
    $('btn-create').disabled = false
  }
})

// ── Lobby: Join room ──────────────────────────────────────────────────────────
$('btn-join').addEventListener('click', async () => {
  const code = $('join-code-input').value.trim().toUpperCase()
  if (code.length !== 6) return

  $('join-status').classList.remove('hidden')
  $('btn-join').disabled = true

  const localStream = await getMedia()
  if (!localStream) {
    $('join-status').textContent = '✗ Camera access denied'
    $('btn-join').disabled = false
    return
  }

  try {
    peer = new PeerConnection({
      onOpen:        handleOpen,
      onData:        handleIncomingFrame,
      onPong:        ts => fps?.onPong(ts),
      onStateChange: handleStateChange,
      sdpModifier:   (sdp) => modifyOpusSDP(sdp, BANDWIDTH_MODES[bandwidthMode].audio)
    })

    await peer.joinRoom(code, localStream)
  } catch (e) {
    console.error('Failed to join room:', e)
    $('join-status').textContent = `✗ Room not found: ${code}`
    $('btn-join').disabled = false
  }
})

// ── Code input formatting ─────────────────────────────────────────────────────
$('join-code-input').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
})
$('join-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-join').click()
})

// ── WebRTC handlers ───────────────────────────────────────────────────────────
function handleOpen (dc) {
  console.log('[APP] DataChannel opened')
  showScreen('call')
  startCallUI(dc)
}

function handleStateChange (state) {
  console.log('[APP] Connection state:', state)
  const badge = $('call-status-badge')
  if (state === 'connected') {
    badge.textContent = '● CONNECTED'
    badge.classList.add('connected')
  } else if (state === 'disconnected' || state === 'failed') {
    badge.textContent = '● DISCONNECTED'
    badge.classList.remove('connected')
  } else {
    badge.textContent = `● ${state.toUpperCase()}`
  }
}

function handleIncomingFrame (data) {
  // Check packet type
  const view = new DataView(data)
  const type = view.getUint8(0)
  
  console.log('[DATA] Received packet type:', '0x' + type.toString(16), 'size:', data.byteLength)
  
  // Type 0x06 = Chat text message (messenger)
  if (type === 0x06) {
    console.log('[DATA] Chat message packet detected')
    const textLength = view.getUint16(7)
    const textBytes = new Uint8Array(data, 9, textLength)
    const text = new TextDecoder('utf-8').decode(textBytes)
    console.log('[DATA] Chat message:', text)
    
    // Add to messenger
    messenger?.receiveMessage({ type: 'text', content: text })
    return
  }
  
  // Types 0x01-0x04 = ASCII video packets
  if (!decoder) return
  const text = decoder.decode(data)
  $('remote-ascii').textContent = text
}

// ── Call UI setup ─────────────────────────────────────────────────────────────
function startCallUI (dc) {
  // Encoder / Decoder
  encoder = new AsciiEncoder({ 
    cols: parseInt($('ascii-cols').value),
    charset: $('ascii-charset').value,
    invert: $('ascii-invert').checked
  })
  decoder = new AsciiDecoder()

  // FPS Controller
  fps = new FpsController({
    target: parseInt($('fps-slider').value),
    min: 1, max: 24,
    onChange: (newFps) => {
      $('fps-display').textContent = newFps
    }
  })

  fps.attachDataChannel(dc)
  
  // Initialize Messenger
  initializeMessenger()
  

  // Wait for video to be ready
  const videoEl = $('local-video')
  const waitForVideo = setInterval(() => {
    if (videoEl.readyState >= 2) {
      clearInterval(waitForVideo)
      console.log('[APP] Video ready, starting render loop')
      startRenderLoop()
    }
  }, 100)
}

function startRenderLoop () {
  const videoEl = $('local-video')

  // Start render loop
  fps.start(() => {
    // Check if peer and video are ready
    if (!peer) {
      return
    }
    if (!camOn) {
      return
    }
    if (videoEl.readyState < 2) {
      return
    }

    try {
      // Encode and send ASCII frame to peer
      const packet = encoder.encodeFrame(videoEl)
      peer.send(packet)
      txBytes += packet.byteLength

      // Render local preview
      const localAscii = encoder.renderLocal(videoEl)
      $('local-ascii').textContent = localAscii

      // Update TX stats every second
      const now = Date.now()
      if (now - txMeasureTs > 1000) {
        const kbps = Math.round(txBytes * 8 / ((now - txMeasureTs)))
        $('stat-tx').textContent = kbps
        $('stat-rtt').textContent = fps.getRTT()
        txBytes = 0
        txMeasureTs = now
      }
    } catch (e) {
      console.error('[RENDER] Error:', e)
    }
  })
}


// ── Controls ──────────────────────────────────────────────────────────────────

// FPS Slider
$('fps-slider').addEventListener('input', e => {
  const val = parseInt(e.target.value)
  $('fps-display').textContent = val
  fps?.setManualFps(val)
})

// Auto FPS toggle
$('btn-auto-fps').addEventListener('click', () => {
  const btn    = $('btn-auto-fps')
  const isAuto = btn.classList.toggle('active')
  fps?.setAutoMode(isAuto)
})

// Toggle camera
$('btn-toggle-cam').addEventListener('click', () => {
  camOn = !camOn
  stream?.getVideoTracks().forEach(t => { t.enabled = camOn })
  $('btn-toggle-cam').classList.toggle('muted', !camOn)
  if (!camOn) $('local-ascii').textContent = '[CAMERA OFF]'
})

// Swap video views
$('btn-swap-views').addEventListener('click', () => {
  const videoArea = document.querySelector('.video-area')
  videoArea.classList.toggle('swapped')
})

// Hangup
$('btn-hangup').addEventListener('click', async () => {
  fps?.stop()
  await peer?.close()
  peer = null
  encoder = null
  decoder = null
  fps = null
  stream?.getTracks().forEach(t => t.stop())
  stream = null
  $('local-ascii').textContent  = 'INITIALIZING CAMERA...'
  $('remote-ascii').textContent = 'WAITING FOR SIGNAL...'
  $('btn-create').disabled   = false
  $('btn-join').disabled     = false
  $('room-code-display').classList.add('hidden')
  $('join-status').classList.add('hidden')
  
  // Clear messenger and reset to video mode
  messenger?.clear()
  setMode('video')
  
  showScreen('lobby')
})

// ASCII settings
$('ascii-cols').addEventListener('change', () => {
  encoder?.setOptions({ cols: parseInt($('ascii-cols').value) })
})
$('ascii-charset').addEventListener('change', () => {
  const name = $('ascii-charset').value
  encoder?.setOptions({ charset: name })
  decoder?.setCharset(name)
})
$('ascii-invert').addEventListener('change', () => {
  encoder?.setOptions({ invert: $('ascii-invert').checked })
})

// ── Messenger Event Listeners ─────────────────────────────────────────────────

// Mode switching
$('btn-mode-video').addEventListener('click', () => {
  setMode('video')
})

$('btn-mode-messenger').addEventListener('click', () => {
  setMode('messenger')
})

// Send text message
$('btn-send-message').addEventListener('click', () => {
  const input = $('message-input')
  const text = input.value.trim()
  
  if (text.length > 0) {
    messenger?.sendTextMessage(text)
    input.value = ''
  }
})

// Send on Enter key
$('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    $('btn-send-message').click()
  }
})

// ── Utils ─────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Start ─────────────────────────────────────────────────────────────────────
boot()
