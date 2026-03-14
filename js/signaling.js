// ─────────────────────────────────────────────────────────────────────────────
// signaling.js — Firebase Realtime DB signaling for WebRTC
//
// Flow:
//   CALLER  → writes offer    → Firebase → CALLEE reads offer
//   CALLEE  → writes answer   → Firebase → CALLER reads answer
//   BOTH    → push ice cands  → Firebase → peer reads & adds
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp }                              from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'
import { getDatabase, ref, set, get, push, onValue,
         remove, onChildAdded }                       from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js'
import { firebaseConfig }                             from './firebase-config.js'

let db = null

function ensureDB () {
  if (!db) {
    const app = initializeApp(firebaseConfig)
    db = getDatabase(app)
  }
  return db
}

// ── Generate short room code ─────────────────────────────────────────────────
export function generateRoomCode () {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I confusion
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

// ── CALLER: write offer, wait for answer ────────────────────────────────────
export async function createRoom (roomCode, localDescription) {
  const database = ensureDB()
  const roomRef  = ref(database, `rooms/${roomCode}`)

  await set(ref(database, `rooms/${roomCode}/offer`), localDescription.sdp)

  return {
    // Listen for answer
    onAnswer: (callback) => {
      const answerRef = ref(database, `rooms/${roomCode}/answer`)
      return onValue(answerRef, snap => {
        if (snap.exists()) callback(snap.val())
      })
    },
    // Listen for callee ICE candidates
    onIceCandidate: (callback) => {
      const iceRef = ref(database, `rooms/${roomCode}/ice_answer`)
      return onChildAdded(iceRef, snap => {
        if (snap.exists()) callback(JSON.parse(snap.val()))
      })
    },
    // Push our own ICE candidates
    pushIceCandidate: (candidate) => {
      push(ref(database, `rooms/${roomCode}/ice_offer`), JSON.stringify(candidate))
    },
    // Cleanup after connection
    cleanup: () => remove(roomRef)
  }
}

// ── CALLEE: read offer, write answer ────────────────────────────────────────
export async function joinRoom (roomCode) {
  const database = ensureDB()

  const offerSnap = await get(ref(database, `rooms/${roomCode}/offer`))
  if (!offerSnap.exists()) throw new Error(`Room ${roomCode} not found`)

  const offerSdp = offerSnap.val()

  return {
    offerSdp,
    // Write answer
    setAnswer: (localDescription) =>
      set(ref(database, `rooms/${roomCode}/answer`), localDescription.sdp),

    // Listen for caller ICE candidates
    onIceCandidate: (callback) => {
      const iceRef = ref(database, `rooms/${roomCode}/ice_offer`)
      return onChildAdded(iceRef, snap => {
        if (snap.exists()) callback(JSON.parse(snap.val()))
      })
    },
    // Push our own ICE candidates
    pushIceCandidate: (candidate) => {
      push(ref(database, `rooms/${roomCode}/ice_answer`), JSON.stringify(candidate))
    },
    // Cleanup
    cleanup: () => remove(ref(database, `rooms/${roomCode}`))
  }
}
