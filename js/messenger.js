// ─────────────────────────────────────────────────────────────────────────────
// messenger.js — Simple Text Chat (no voice)
// ─────────────────────────────────────────────────────────────────────────────

export class Messenger {
  constructor({ onSendMessage } = {}) {
    this.onSendMessage = onSendMessage  // Callback to send message via DataChannel
    this.messages = []  // Message history
    this.maxMessages = 100
    
    console.log('[MESSENGER] Initialized (text-only)')
  }
  
  // ── Add message to history ────────────────────────────────────────────────
  addMessage(message) {
    // message = { type: 'text', content: string, sender: 'me'|'them', timestamp: Date }
    this.messages.push(message)
    
    // Limit history
    if (this.messages.length > this.maxMessages) {
      this.messages.shift()
    }
    
    this.renderMessages()
  }
  
  // ── Send text message ──────────────────────────────────────────────────────
  sendTextMessage(text) {
    if (!text || text.trim().length === 0) return
    
    const message = {
      type: 'text',
      content: text.trim(),
      sender: 'me',
      timestamp: new Date()
    }
    
    this.addMessage(message)
    
    if (this.onSendMessage) {
      this.onSendMessage({
        type: 'text',
        content: message.content
      })
    }
    
    console.log('[MESSENGER] Sent text:', text)
  }
  
  // ── Receive message from peer ─────────────────────────────────────────────
  receiveMessage(data) {
    // data = { type: 'text', content: string }
    const message = {
      type: data.type,
      content: data.content,
      sender: 'them',
      timestamp: new Date()
    }
    
    this.addMessage(message)
    
    console.log('[MESSENGER] Received', data.type + ':', data.content)
  }
  
  // ── Render messages in UI ──────────────────────────────────────────────────
  renderMessages() {
    const container = document.getElementById('messages-container')
    if (!container) return
    
    container.innerHTML = ''
    
    this.messages.forEach((msg, index) => {
      const msgEl = document.createElement('div')
      msgEl.className = `message message-${msg.sender}`
      
      // Time
      const time = msg.timestamp.toLocaleTimeString('ru-RU', { 
        hour: '2-digit', 
        minute: '2-digit' 
      })
      
      msgEl.innerHTML = `
        <div class="message-content">${msg.content}</div>
        <div class="message-time">${time}</div>
      `
      
      container.appendChild(msgEl)
    })
    
    // Scroll to bottom
    container.scrollTop = container.scrollHeight
  }
  
  // ── Clear all messages ─────────────────────────────────────────────────────
  clear() {
    this.messages = []
    this.renderMessages()
    console.log('[MESSENGER] Cleared')
  }
}
