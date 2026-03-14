// ─────────────────────────────────────────────────────────────────────────────
// speech.js — Speech-to-Text (STT) and Text-to-Speech (TTS)
// ─────────────────────────────────────────────────────────────────────────────

export class SpeechRecognizer {
  constructor({ onResult, lang = 'ru-RU', minTextLength = 3 } = {}) {
    this.onResult = onResult
    this.lang = lang
    this.minTextLength = minTextLength  // Минимальная длина текста для отправки
    this.recognition = null
    this.isRunning = false
    this.lastSentTime = 0
    this.sendDebounce = 1000  // Минимум 1 секунда между отправками
    
    // Check browser support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      console.warn('[STT] Speech Recognition not supported in this browser')
      return
    }
    
    this.recognition = new SpeechRecognition()
    this.recognition.continuous = true
    this.recognition.interimResults = true
    this.recognition.lang = lang
    
    this.recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1]
      const transcript = result[0].transcript.trim()
      const isFinal = result.isFinal
      
      // Filter: ignore empty or very short text
      if (transcript.length === 0) return
      
      // For interim results - show but don't filter by length
      if (!isFinal) {
        if (this.onResult) {
          this.onResult({ text: transcript, isFinal: false })
        }
        return
      }
      
      // For final results - apply filters
      if (isFinal) {
        // Filter 1: minimum length
        if (transcript.length < this.minTextLength) {
          console.log('[STT] Ignored (too short):', transcript)
          return
        }
        
        // Filter 2: debounce (don't send too frequently)
        const now = Date.now()
        if (now - this.lastSentTime < this.sendDebounce) {
          console.log('[STT] Ignored (debounce):', transcript)
          return
        }
        
        this.lastSentTime = now
        
        if (this.onResult) {
          this.onResult({ text: transcript, isFinal: true })
        }
      }
    }
    
    this.recognition.onerror = (event) => {
      console.error('[STT] Error:', event.error)
      
      // Don't auto-restart on certain errors
      if (event.error === 'aborted' || event.error === 'no-speech') {
        // Just log, don't restart
        console.log('[STT] Error (not restarting):', event.error)
      }
    }
    
    this.recognition.onend = () => {
      console.log('[STT] Ended')
      // DON'T auto-restart - this causes constant beeps on mobile
      // User must manually restart if needed
      this.isRunning = false
    }
  }
  
  start() {
    if (!this.recognition) {
      console.warn('[STT] Recognition not available')
      return false
    }
    
    if (this.isRunning) {
      console.log('[STT] Already running')
      return true
    }
    
    try {
      this.isRunning = true
      this.recognition.start()
      console.log('[STT] Started')
      return true
    } catch (e) {
      console.error('[STT] Failed to start:', e)
      this.isRunning = false
      return false
    }
  }
  
  stop() {
    if (!this.recognition) return
    
    this.isRunning = false
    try {
      this.recognition.stop()
      console.log('[STT] Stopped')
    } catch (e) {
      console.error('[STT] Failed to stop:', e)
    }
  }
  
  setLanguage(lang) {
    this.lang = lang
    if (this.recognition) {
      this.recognition.lang = lang
    }
  }
  
  isSupported() {
    return !!this.recognition
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SpeechSynthesizer — TTS wrapper
// ─────────────────────────────────────────────────────────────────────────────
export class SpeechSynthesizer {
  constructor({ lang = 'ru-RU', rate = 1.0, pitch = 1.0, volume = 1.0 } = {}) {
    this.lang = lang
    this.rate = rate
    this.pitch = pitch
    this.volume = volume
    this.voice = null
    this.isSpeaking = false
    this.voicesLoaded = false
    
    // Force load voices immediately
    this.loadVoices()
  }
  
  async loadVoices() {
    return new Promise((resolve) => {
      // Try to get voices immediately
      let voices = window.speechSynthesis.getVoices()
      
      if (voices.length > 0) {
        console.log('[TTS] Voices already loaded:', voices.length)
        this.selectVoice(voices)
        this.voicesLoaded = true
        resolve()
        return
      }
      
      // Wait for voiceschanged event (Windows 11 needs this)
      console.log('[TTS] Waiting for voices to load...')
      
      const onVoicesChanged = () => {
        voices = window.speechSynthesis.getVoices()
        console.log('[TTS] Voices loaded:', voices.length)
        
        if (voices.length > 0) {
          this.selectVoice(voices)
          this.voicesLoaded = true
          resolve()
        }
      }
      
      window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged, { once: true })
      
      // Fallback timeout
      setTimeout(() => {
        if (!this.voicesLoaded) {
          voices = window.speechSynthesis.getVoices()
          console.warn('[TTS] Timeout - using whatever voices available:', voices.length)
          if (voices.length > 0) {
            this.selectVoice(voices)
          }
          this.voicesLoaded = true
          resolve()
        }
      }, 1000)
    })
  }
  
  selectVoice(voices) {
    console.log('[TTS] Selecting voice from', voices.length, 'available voices')
    
    // List all voices for debugging
    voices.forEach((v, i) => {
      console.log(`[TTS] Voice ${i}:`, v.name, '|', v.lang, '|', v.localService ? 'local' : 'remote')
    })
    
    // Priority 1: Russian voice
    let voice = voices.find(v => v.lang.startsWith('ru'))
    
    // Priority 2: English voice
    if (!voice) {
      voice = voices.find(v => v.lang.startsWith('en'))
      console.log('[TTS] No Russian voice, using English')
    }
    
    // Priority 3: Any voice
    if (!voice && voices.length > 0) {
      voice = voices[0]
      console.log('[TTS] Using first available voice')
    }
    
    this.voice = voice
    
    if (voice) {
      console.log('[TTS] ✓ Selected voice:', voice.name, '|', voice.lang)
    } else {
      console.error('[TTS] ✗ No voices available!')
    }
  }
  
  async speak(text) {
    if (!text || text.trim().length === 0) return
    
    // Wait for voices to load if not ready
    if (!this.voicesLoaded) {
      console.log('[TTS] Waiting for voices before speaking...')
      await this.loadVoices()
    }
    
    // Cancel current speech if any
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel()
    }
    
    const utterance = new SpeechSynthesisUtterance(text)
    
    // CRITICAL: Set voice explicitly
    if (this.voice) {
      utterance.voice = this.voice
      console.log('[TTS] Using voice:', this.voice.name)
    } else {
      console.warn('[TTS] No voice selected, using default')
    }
    
    utterance.lang = this.voice ? this.voice.lang : this.lang
    utterance.rate = this.rate
    utterance.pitch = this.pitch
    utterance.volume = this.volume
    
    utterance.onstart = () => {
      this.isSpeaking = true
      console.log('[TTS] ▶ Speaking:', text.substring(0, 50), '| Voice:', this.voice?.name)
    }
    
    utterance.onend = () => {
      this.isSpeaking = false
      console.log('[TTS] ■ Finished')
    }
    
    utterance.onerror = (event) => {
      console.error('[TTS] ✗ Error:', event.error, event)
      this.isSpeaking = false
    }
    
    try {
      window.speechSynthesis.speak(utterance)
      console.log('[TTS] speak() called successfully')
    } catch (e) {
      console.error('[TTS] Exception calling speak():', e)
    }
  }
  
  stop() {
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel()
      this.isSpeaking = false
      console.log('[TTS] Stopped')
    }
  }
  
  setLanguage(lang) {
    this.lang = lang
    const voices = window.speechSynthesis.getVoices()
    if (voices.length > 0) {
      this.selectVoice(voices)
    }
  }
  
  setRate(rate) {
    this.rate = rate
  }
  
  setPitch(pitch) {
    this.pitch = pitch
  }
  
  setVolume(volume) {
    this.volume = volume
  }
  
  // Get available voices for current language
  getVoices() {
    return window.speechSynthesis.getVoices().filter(voice => 
      voice.lang.startsWith(this.lang.split('-')[0])
    )
  }
  
  isSupported() {
    return 'speechSynthesis' in window
  }
}
