// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE CONFIG
// 1. Go to console.firebase.google.com
// 2. Create project → Realtime Database → Create Database
// 3. Project Settings → Add Web App → copy config below
// ─────────────────────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey: "AIzaSyCIf176dUzF-K0azEXndfUoKQuePTjgmfs",
  authDomain: "ascii-messenger.firebaseapp.com",
  databaseURL: "https://ascii-messenger-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "ascii-messenger",
  storageBucket: "ascii-messenger.firebasestorage.app",
  messagingSenderId: "144168420961",
  appId: "1:144168420961:web:a6491ce66a162d250fcc20"
};

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE RULES (paste into Realtime Database → Rules)
// ─────────────────────────────────────────────────────────────────────────────
/*
{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": true,
        ".write": true,
        "offer":  { ".validate": "newData.isString()" },
        "answer": { ".validate": "newData.isString()" },
        "ice_offer":  { "$i": { ".validate": "newData.isString()" } },
        "ice_answer": { "$i": { ".validate": "newData.isString()" } }
      }
    }
  }
}
*/
