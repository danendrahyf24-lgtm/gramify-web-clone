// di sini saya memakaai bentuan ai untuk membantu menyusun
//  code dan menguload ke firebase secara real time agar data
//  dapat tersimpan di server.
const SESSION_USER_KEY = 'gramify_active_user_session';
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const OLD_DEFAULT_PHOTO =
  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=80';


const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect width='128' height='128' fill='%23dbdbdb'/><circle cx='64' cy='48' r='23' fill='%23ffffff'/><path d='M20 128c5-28 23-43 44-43s39 15 44 43' fill='%23ffffff'/></svg>";

let currentView = 'home'; 
let activeChatPartner = null; 
let profileTabMode = 'posts'; 
let activeStoryId = null;
let storyTimer = null;


let editorImageObj = new Image();
let editorState = {
  preset: 'normal',
  brightness: 100,
  contrast: 100,
  saturate: 100
};

document.addEventListener('DOMContentLoaded', () => {
  initGoogleAuthGate();
  initSidebarNavigation();
  initCreateModalAndEditor();
  initPostFeedEvents();
  initNotificationsModal();
  initProfileViewEvents();
  initMessagesPopup();
  initDirectMessagesView();
  initSearchModal();
  initStoryViewerEvents();
  initMoreMenuPopover();
  initPostDetailModal();
  initAppearanceModal();
  initPresenceSystem();
  initAppNavigationHistory();

  
  showAuthGate();
  startCloudBackend();

  
  document.addEventListener('focusout', () => {
    setTimeout(flushPendingRender, 50);
  });

  
  setInterval(() => {
    const removed = cleanExpiredStories();
    if (removed && getCurrentUser()) {
      renderStoriesBar();
    }
  }, 30000);
});



/* ==========================================================================
   DATABASE ONLINE (FIREBASE CLOUD FIRESTORE) - REAL-TIME ANTAR PERANGKAT
   Semua data (pengguna, postingan, story, pesan, notifikasi) disimpan di server.
   - getDB() mengembalikan cache data terbaru yang selalu disinkronkan real-time.
   - saveDB() mendeteksi item yang berubah lalu hanya mengirim perubahan tersebut.
   ========================================================================== */
const FIREBASE_SDK_VERSION = '10.12.2';
const DB_COLLECTIONS = ['users', 'posts', 'stories', 'messages', 'notifications'];

const memoryDB = { users: [], posts: [], stories: [], messages: [], notifications: [] };
const syncedSnapshots = {};
DB_COLLECTIONS.forEach((name) => {
  syncedSnapshots[name] = new Map();
});

const cloud = {
  ready: false,
  auth: null,
  firestore: null,
  fns: null,
  authUser: null,
  unsubscribers: [],
  dataLoaded: false,
  writeErrorShown: false
};

let renderTimer = null;
let pendingRender = false;

function getItemKey(collectionName, item) {
  if (!item) return null;
  if (collectionName === 'users') return item.email ? String(item.email).toLowerCase() : null;
  return item.id || null;
}

function sortCollection(collectionName) {
  const arr = memoryDB[collectionName];
  if (collectionName === 'messages') {
    arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  } else if (collectionName !== 'users') {
    arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
}

// Menormalkan data lama agar formatnya selalu sesuai dengan versi aplikasi terbaru
function normalizeItem(collectionName, item) {
  if (collectionName === 'users') {
    if (!item.avatar || item.avatar === OLD_DEFAULT_PHOTO) item.avatar = DEFAULT_AVATAR;
    if (item.website === 'danendra-sublevel-studio.vercel.app') item.website = '';
    if (!Array.isArray(item.followers)) item.followers = [];
    if (!Array.isArray(item.following)) item.following = [];
    if (!Array.isArray(item.savedPosts)) item.savedPosts = [];
    if (typeof item.isOnline !== 'boolean') item.isOnline = false;
    if (typeof item.lastActive !== 'number') item.lastActive = 0;
  } else if (collectionName === 'posts') {
    if (!item.authorAvatar || item.authorAvatar === OLD_DEFAULT_PHOTO) item.authorAvatar = DEFAULT_AVATAR;
    if (!Array.isArray(item.likes)) item.likes = [];
    if (!Array.isArray(item.comments)) item.comments = [];
    item.comments.forEach((c, cIdx) => {
      if (!c.id) c.id = `cmt_${item.id}_${cIdx}_${c.createdAt || 0}`;
      if (!Array.isArray(c.likes)) c.likes = [];
      if (!Array.isArray(c.replies)) c.replies = [];
    });
  } else if (collectionName === 'stories') {
    if (!item.authorAvatar || item.authorAvatar === OLD_DEFAULT_PHOTO) item.authorAvatar = DEFAULT_AVATAR;
  }
  return item;
}

function getDB() {
  return memoryDB;
}

function saveDB(db) {
  // Jika ada kode yang mengganti array (misal db.posts = db.posts.filter(...)),
  // pastikan cache utama ikut menunjuk ke array terbaru.
  if (db && db !== memoryDB) {
    DB_COLLECTIONS.forEach((name) => {
      if (Array.isArray(db[name])) memoryDB[name] = db[name];
    });
  }

  const upserts = [];
  const deletes = [];

  DB_COLLECTIONS.forEach((name) => {
    const synced = syncedSnapshots[name];
    const seenKeys = new Set();

    memoryDB[name].forEach((item) => {
      const key = getItemKey(name, item);
      if (!key) return;
      seenKeys.add(key);
      const json = JSON.stringify(item);
      if (synced.get(key) !== json) {
        synced.set(key, json);
        upserts.push({ name, key, json });
      }
    });

    Array.from(synced.keys()).forEach((key) => {
      if (!seenKeys.has(key)) {
        synced.delete(key);
        deletes.push({ name, key });
      }
    });
  });

  if (upserts.length || deletes.length) {
    pushChangesToCloud(upserts, deletes);
  }
}

async function pushChangesToCloud(upserts, deletes) {
  if (!cloud.ready || !cloud.authUser || !cloud.dataLoaded) return;
  const { doc, writeBatch } = cloud.fns;

  const ops = [];
  upserts.forEach((u) => {
    if (u.json.length >= 1000000) {
      alert('Ukuran data terlalu besar untuk disimpan (maksimal ±1 MB). Coba gunakan foto yang lebih kecil.');
      return;
    }
    ops.push((batch) =>
      batch.set(doc(cloud.firestore, u.name, u.key), { json: u.json, updatedAt: Date.now() })
    );
  });
  deletes.forEach((d) => {
    ops.push((batch) => batch.delete(doc(cloud.firestore, d.name, d.key)));
  });

  // Firestore membatasi 500 operasi per batch
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(cloud.firestore);
    ops.slice(i, i + 400).forEach((apply) => apply(batch));
    try {
      await batch.commit();
    } catch (err) {
      console.error('Gagal menyimpan ke server:', err);
      if (!cloud.writeErrorShown) {
        cloud.writeErrorShown = true;
        alert('Gagal menyimpan data ke server: ' + (err.code || err.message));
      }
    }
  }
}

// Terapkan perubahan dari server (perangkat/pengguna lain) ke cache lokal
function applyRemoteChanges(collectionName, snapshot) {
  const synced = syncedSnapshots[collectionName];
  const arr = memoryDB[collectionName];
  let changed = false;

  snapshot.docChanges().forEach((change) => {
    const key = change.doc.id;

    if (change.type === 'removed') {
      const idx = arr.findIndex((item) => getItemKey(collectionName, item) === key);
      if (idx !== -1) {
        arr.splice(idx, 1);
        changed = true;
      }
      synced.delete(key);
      return;
    }

    const data = change.doc.data();
    if (!data || typeof data.json !== 'string') return;
    let item;
    try {
      item = normalizeItem(collectionName, JSON.parse(data.json));
    } catch (err) {
      return;
    }
    const json = JSON.stringify(item);
    if (synced.get(key) === json) return; // Sudah sama dengan cache lokal

    synced.set(key, json);
    const existing = arr.find((it) => getItemKey(collectionName, it) === key);
    if (existing) {
      // Perbarui objek yang sama agar referensi yang sedang dipakai tetap valid
      Object.keys(existing).forEach((k) => {
        if (!(k in item)) delete existing[k];
      });
      Object.assign(existing, item);
    } else {
      arr.push(item);
    }
    changed = true;
  });

  if (changed) {
    sortCollection(collectionName);
    scheduleRender();
  }
}

function isUserTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (tag === 'INPUT' || tag === 'TEXTAREA') && el.type !== 'file' && String(el.value || '').length > 0;
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (!getCurrentUser()) return;
    if (isUserTyping()) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    renderAllViews();
  }, 120);
}

function flushPendingRender() {
  if (pendingRender && !isUserTyping()) {
    pendingRender = false;
    if (getCurrentUser()) renderAllViews();
  }
}

function resetLocalCache() {
  DB_COLLECTIONS.forEach((name) => {
    memoryDB[name].length = 0;
    syncedSnapshots[name].clear();
  });
}

async function startCloudBackend() {
  const config = window.GRAMIFY_FIREBASE_CONFIG || {};
  if (!config.apiKey || !config.projectId) {
    setGoogleAuthStatus('Server belum dikonfigurasi: isi data Firebase di js/firebase-config.js.', true);
    return;
  }

  setGoogleAuthStatus('Menghubungkan ke server...');
  try {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`)
    ]);

    const app = appMod.initializeApp(config);
    cloud.auth = authMod.getAuth(app);
    cloud.firestore = fsMod.getFirestore(app);
    cloud.fns = { ...authMod, ...fsMod };
    cloud.ready = true;

    authMod.onAuthStateChanged(cloud.auth, handleAuthStateChanged);
  } catch (err) {
    console.error(err);
    setGoogleAuthStatus('Gagal terhubung ke server. Periksa koneksi internet lalu muat ulang halaman.', true);
  }
}

function subscribeToCloudData() {
  const { collection, onSnapshot } = cloud.fns;
  let pending = DB_COLLECTIONS.length;

  return new Promise((resolve, reject) => {
    DB_COLLECTIONS.forEach((name) => {
      let first = true;
      const unsub = onSnapshot(
        collection(cloud.firestore, name),
        (snapshot) => {
          applyRemoteChanges(name, snapshot);
          if (first) {
            first = false;
            pending -= 1;
            if (pending === 0) resolve();
          }
        },
        (err) => {
          console.error('Listener ' + name + ' error:', err);
          if (first) reject(err);
        }
      );
      cloud.unsubscribers.push(unsub);
    });
  });
}

function unsubscribeCloudData() {
  cloud.unsubscribers.forEach((unsub) => unsub());
  cloud.unsubscribers = [];
  cloud.dataLoaded = false;
}

async function handleAuthStateChanged(firebaseUser) {
  const signInBtn = document.getElementById('btn-google-signin');

  if (!firebaseUser) {
    cloud.authUser = null;
    unsubscribeCloudData();
    resetLocalCache();
    sessionStorage.removeItem(SESSION_USER_KEY);
    showAuthGate();
    if (signInBtn) signInBtn.disabled = false;
    setGoogleAuthStatus('');
    return;
  }

  cloud.authUser = firebaseUser;
  if (signInBtn) signInBtn.disabled = true;
  setGoogleAuthStatus('Memuat data akun ' + firebaseUser.email + '...');

  try {
    unsubscribeCloudData();
    resetLocalCache();
    await subscribeToCloudData();
    cloud.dataLoaded = true;
  } catch (err) {
    setGoogleAuthStatus('Gagal memuat data dari server: ' + (err.code || err.message), true);
    if (signInBtn) signInBtn.disabled = false;
    return;
  }

  cleanExpiredStories();

  const email = String(firebaseUser.email || '').toLowerCase();
  const existingUser = memoryDB.users.find((u) => String(u.email).toLowerCase() === email);

  if (existingUser) {
    sessionStorage.setItem(SESSION_USER_KEY, existingUser.username);
    setGoogleAuthStatus('');
    enterApplication();
    return;
  }

  // Pengguna baru: lanjut ke pembuatan username
  const name = firebaseUser.displayName || email.split('@')[0];
  selectGoogleAccountForStep3({
    uid: firebaseUser.uid,
    email,
    name,
    defaultUsername: email.split('@')[0].replace(/[^a-zA-Z0-9._]/g, '').toLowerCase(),
    defaultFullName: name
  });
}

function getCurrentUser() {
  const username = sessionStorage.getItem(SESSION_USER_KEY);
  if (!username || !cloud.authUser) return null;
  return getUserByUsername(username);
}

function getUserByUsername(username) {
  if (!username) return null;
  const db = getDB();
  return db.users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function cleanExpiredStories() {
  if (!cloud.dataLoaded) return false;
  const db = getDB();
  const now = Date.now();
  const validStories = db.stories.filter((s) => s.expiresAt > now);
  if (validStories.length !== db.stories.length) {
    db.stories = validStories;
    saveDB(db);
    return true;
  }
  return false;
}

let pendingGoogleAccount = null;

function initGoogleAuthGate() {
  const signInBtn = document.getElementById('btn-google-signin');
  const setupForm = document.getElementById('setup-username-form');

  if (signInBtn) {
    signInBtn.addEventListener('click', signInWithGoogle);
  }

  
  if (setupForm) {
    setupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pendingGoogleAccount || !cloud.dataLoaded) return;

      const rawUsername = document.getElementById('setup-username-input').value.trim();
      const username = rawUsername.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._]/g, '').toLowerCase();
      const fullName = document.getElementById('setup-fullname-input').value.trim();

      if (!username || !fullName) {
        alert('Username hanya boleh berisi huruf, angka, titik, dan garis bawah.');
        return;
      }

      const db = getDB();
      const takenByOther = db.users.find(
        (u) => u.username.toLowerCase() === username && u.email !== pendingGoogleAccount.email
      );
      if (takenByOther) {
        alert('Username sudah dipakai pengguna lain. Silakan pilih username lain.');
        return;
      }

      let user = db.users.find((u) => u.email === pendingGoogleAccount.email);
      const avatarDataUrl = (user && user.avatar) || (pendingGoogleAccount && pendingGoogleAccount.avatar) || DEFAULT_AVATAR;

      if (!user) {
        user = {
          email: pendingGoogleAccount.email,
          googleUid: pendingGoogleAccount.uid,
          username,
          fullName,
          avatar: avatarDataUrl,
          bio: '',
          website: '',
          note: 'Note...',
          followers: [],
          following: [],
          savedPosts: [],
          createdAt: Date.now()
        };
        db.users.push(user);
      } else {
        user.username = username;
        user.fullName = fullName;
        user.avatar = avatarDataUrl;
      }

      saveDB(db);
      sessionStorage.setItem(SESSION_USER_KEY, user.username);
      setupForm.reset();
      pendingGoogleAccount = null;
      enterApplication();
    });
  }
}

async function signInWithGoogle() {
  if (!cloud.ready) return;
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = cloud.fns;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  setGoogleAuthStatus('Membuka jendela login Google...');
  try {
    await signInWithPopup(cloud.auth, provider);
  } catch (err) {
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(cloud.auth, provider);
      return;
    }
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
      setGoogleAuthStatus('');
      return;
    }
    if (err.code === 'auth/unauthorized-domain') {
      setGoogleAuthStatus(
        'Domain ini belum diizinkan. Tambahkan domain website di Firebase > Authentication > Settings > Authorized domains.',
        true
      );
      return;
    }
    setGoogleAuthStatus('Login gagal: ' + (err.code || err.message), true);
  }
}


function logoutAndShowAuthGate() {
  updateUserPresence(false);
  sessionStorage.removeItem(SESSION_USER_KEY);
  if (cloud.ready && cloud.authUser) {
    cloud.fns.signOut(cloud.auth); 
  } else {
    showAuthGate();
  }
}

function setGoogleAuthStatus(message, isError) {
  const status = document.getElementById('google-auth-status');
  if (!status) return;
  status.textContent = message || '';
  status.style.color = isError ? '#ed4956' : '#737373';
}

function selectGoogleAccountForStep3(acc) {
  pendingGoogleAccount = acc;
  const gate = document.getElementById('auth-gate');
  const step1 = document.getElementById('auth-step-1');
  const step3 = document.getElementById('auth-step-3');
  const infoBadge = document.getElementById('selected-google-info');
  const usernameInput = document.getElementById('setup-username-input');
  const fullnameInput = document.getElementById('setup-fullname-input');

  if (infoBadge) infoBadge.textContent = acc.email;
  if (usernameInput) usernameInput.value = acc.defaultUsername || '';
  if (fullnameInput) fullnameInput.value = acc.defaultFullName || acc.name;

  if (gate) gate.classList.remove('hidden');
  if (step1) step1.classList.add('hidden');
  if (step3) step3.classList.remove('hidden');
  if (usernameInput) usernameInput.focus();
}

function showAuthGate() {
  const gate = document.getElementById('auth-gate');
  const step1 = document.getElementById('auth-step-1');
  const step3 = document.getElementById('auth-step-3');

  pendingGoogleAccount = null;
  if (gate) gate.classList.remove('hidden');
  if (step1) step1.classList.remove('hidden');
  if (step3) step3.classList.add('hidden');
}


function isUserOnline(user) {
  if (!user) return false;
  const me = getCurrentUser();
  
  if (me && me.username && user.username && me.username.toLowerCase() === user.username.toLowerCase()) {
    return !document.hidden;
  }
  
  if (!user.isOnline) return false;
  const last = user.lastActive || 0;
  
  return (Date.now() - last) < 60000;
}

let lastPresenceSentTime = 0;
let lastPresenceSentStatus = null;

function updateUserPresence(isOnline) {
  const me = getCurrentUser();
  if (!me || !cloud.ready || !cloud.authUser || !cloud.dataLoaded) return;
  const db = getDB();
  const dbUser = db.users.find((u) => u.username && u.username.toLowerCase() === me.username.toLowerCase());
  if (!dbUser) return;

  const now = Date.now();
  
  if (lastPresenceSentStatus === isOnline && now - lastPresenceSentTime < 12000) {
    return;
  }

  lastPresenceSentTime = now;
  lastPresenceSentStatus = isOnline;

  dbUser.isOnline = isOnline;
  dbUser.lastActive = now;
  saveDB(db);
}

function initPresenceSystem() {
  
  setInterval(() => {
    if (!document.hidden && getCurrentUser()) {
      updateUserPresence(true);
    }
  }, 20000);

  
  let lastAct = 0;
  const onUserActivity = () => {
    const now = Date.now();
    if (now - lastAct > 15000) {
      lastAct = now;
      if (!document.hidden && getCurrentUser()) {
        updateUserPresence(true);
      }
    }
  };
  window.addEventListener('click', onUserActivity, { passive: true });
  window.addEventListener('keydown', onUserActivity, { passive: true });
  window.addEventListener('touchstart', onUserActivity, { passive: true });

  
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      updateUserPresence(false);
    } else {
      updateUserPresence(true);
    }
    renderOnlineIndicators();
  });

  
  window.addEventListener('beforeunload', () => {
    updateUserPresence(false);
  });
  window.addEventListener('pagehide', () => {
    updateUserPresence(false);
  });

  
  setInterval(() => {
    if (getCurrentUser()) {
      renderOnlineIndicators();
    }
  }, 8000);
}

function renderOnlineIndicators() {
  const me = getCurrentUser();
  if (!me) return;

  
  const profileDot = document.getElementById('profile-page-online-dot');
  if (profileDot) {
    const targetUser = (viewedProfileUsername && getUserByUsername(viewedProfileUsername)) || me;
    if (targetUser) {
      const online = isUserOnline(targetUser);
      profileDot.classList.toggle('hidden', !online);
    }
  }

  
  const msgPopup = document.getElementById('messages-popup-window');
  if (msgPopup && !msgPopup.classList.contains('hidden') && !activeChatPartner) {
    const threadRows = document.querySelectorAll('.msg-thread-row');
    const db = getDB();
    threadRows.forEach((row) => {
      const userText = row.querySelector('.msg-thread-name');
      if (userText) {
        const match = userText.textContent.match(/@([a-zA-Z0-9._]+)/);
        if (match) {
          const uName = match[1];
          const u = db.users.find((usr) => usr.username.toLowerCase() === uName.toLowerCase());
          const dot = row.querySelector('.msg-online-dot');
          const online = isUserOnline(u);
          if (dot && !online) dot.remove();
          if (!dot && online) {
            const wrap = row.querySelector('.msg-avatar-wrap');
            if (wrap) {
              const newDot = document.createElement('span');
              newDot.className = 'msg-online-dot';
              newDot.title = 'Sedang aktif';
              wrap.appendChild(newDot);
            }
          }
        }
      }
    });
  }

  
  if (activeChatPartner) {
    const partner = getUserByUsername(activeChatPartner);
    const online = isUserOnline(partner);
    const titleEl = document.getElementById('msg-popup-header-title');
    if (titleEl) {
      titleEl.innerHTML = `@${escapeHtml(activeChatPartner)} ${
        online
          ? '<span style="display:inline-flex; align-items:center; gap:4px; font-size:11px; color:var(--online-green); font-weight:600; margin-left:6px;"><span style="width:7px; height:7px; border-radius:50%; background:var(--online-green); display:inline-block;"></span>Aktif</span>'
          : ''
      }`;
    }
    const dmDot = document.getElementById('dm-header-online-dot');
    if (dmDot) dmDot.classList.toggle('hidden', !online);
  }
}


let activeNavDepth = 0;
let isProgrammaticBack = false;
let lastBackPressTime = 0;
let exitToastTimer = null;
let isHistoryInitialized = false;

function showExitToast(message) {
  let toast = document.getElementById('back-exit-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'back-exit-toast';
    toast.className = 'back-exit-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message || 'Tekan sekali lagi untuk keluar';
  toast.classList.add('show');
  clearTimeout(exitToastTimer);
  exitToastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

function pushNavState(name) {
  activeNavDepth++;
  history.pushState({ appNav: true, name: name, depth: activeNavDepth }, '');
}

function notifyModalClosedProgrammatically() {
  if (activeNavDepth > 0) {
    isProgrammaticBack = true;
    activeNavDepth--;
    history.back();
  }
}

function initAppNavigationHistory() {
  if (isHistoryInitialized) return;
  isHistoryInitialized = true;

  
  history.replaceState({ appNav: true, name: 'home-base', depth: 0 }, '');
  
  history.pushState({ appNav: true, name: 'home-root', depth: 1 }, '');
  activeNavDepth = 1;

  window.addEventListener('popstate', () => {
    
    if (isProgrammaticBack) {
      isProgrammaticBack = false;
      return;
    }

    if (activeNavDepth > 0) {
      activeNavDepth--;
    }

    
    const handled = handleAppBackNavigation();

    if (!handled) {
      
      const now = Date.now();
      if (now - lastBackPressTime < 2200) {
        
        history.back();
      } else {
        
        lastBackPressTime = now;
        showExitToast('Tekan sekali lagi untuk keluar');
        
        history.pushState({ appNav: true, name: 'home-root', depth: 1 }, '');
        activeNavDepth = 1;
      }
    }
  });
}

function handleAppBackNavigation() {
  
  const storyModal = document.getElementById('story-modal');
  if (storyModal && storyModal.classList.contains('open')) {
    closeStoryViewer(true);
    return true;
  }

  
  const postDetailModal = document.getElementById('post-detail-modal');
  if (postDetailModal && postDetailModal.classList.contains('open')) {
    closePostDetailModal(true);
    return true;
  }

  
  if (currentView === 'messages') {
    if (activeChatPartner) {
      showDirectEmptyView(true);
      return true;
    } else {
      switchMainView('home', true);
      return true;
    }
  }

  
  const msgPopup = document.getElementById('messages-popup-window');
  if (msgPopup && !msgPopup.classList.contains('hidden')) {
    if (activeChatPartner) {
      showMessagesThreadList(true);
      return true;
    } else {
      closeMessagesPopup(true);
      return true;
    }
  }

  
  const createModal = document.getElementById('create-modal');
  if (createModal && createModal.classList.contains('open')) {
    closeCreateModal(true);
    return true;
  }

  
  const searchModal = document.getElementById('search-modal');
  if (searchModal && searchModal.classList.contains('open')) {
    closeSearchModal(true);
    return true;
  }

  
  const notifModal = document.getElementById('notifications-modal');
  if (notifModal && notifModal.classList.contains('open')) {
    closeNotificationsModal(true);
    return true;
  }

  
  const appearanceModal = document.getElementById('appearance-modal');
  if (appearanceModal && !appearanceModal.classList.contains('hidden')) {
    closeAppearanceModal(true);
    return true;
  }

  
  const editProfileModal = document.getElementById('edit-profile-modal');
  if (editProfileModal && editProfileModal.classList.contains('open')) {
    closeEditProfileModal(true);
    return true;
  }

  
  const shareModal = document.getElementById('share-post-modal');
  if (shareModal && shareModal.classList.contains('open')) {
    shareModal.classList.remove('open');
    return true;
  }

  
  const morePopover = document.getElementById('more-menu-popover');
  if (morePopover && morePopover.classList.contains('open')) {
    morePopover.classList.remove('open');
    const moreBtn = document.getElementById('sidebar-more-btn');
    if (moreBtn) moreBtn.classList.remove('active');
    return true;
  }

  
  if (viewedProfileUsername !== null) {
    viewedProfileUsername = null;
    switchMainView('home', true);
    return true;
  }

  
  if (currentView !== 'home') {
    switchMainView('home', true);
    return true;
  }

  return false;
}

function enterApplication() {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.classList.add('hidden');
  updateUserPresence(true);
  initAppNavigationHistory();
  renderAllViews();
}


let viewedProfileUsername = null; 

function closeMessagesPopup(fromBack = false) {
  const popup = document.getElementById('messages-popup-window');
  const wasOpen = popup && !popup.classList.contains('hidden');
  const hadActiveChat = !!activeChatPartner;
  if (popup && wasOpen) {
    popup.classList.add('hidden');
  }
  activeChatPartner = null;

  if (wasOpen && !fromBack) {
    notifyModalClosedProgrammatically();
    if (hadActiveChat) {
      notifyModalClosedProgrammatically();
    }
  }
}

function openUserProfile(username) {
  closeMessagesPopup(true);
  if (!username) return;
  viewedProfileUsername = username;
  profileTabMode = 'posts';
  switchMainView('profile');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initSidebarNavigation() {
  document.addEventListener('click', (e) => {
    const profileLink = e.target.closest('[data-profile-user]');
    if (profileLink) {
      e.preventDefault();
      closeMessagesPopup(true);
      const targetUsername = profileLink.getAttribute('data-profile-user');
      openUserProfile(targetUsername);
      return;
    }

    const navBtn = e.target.closest('[data-nav-target]');
    if (!navBtn) return;
    e.preventDefault();
    closeMessagesPopup(true);
    const target = navBtn.getAttribute('data-nav-target');
    if (target === 'profile') {
      viewedProfileUsername = null;
    }
    if (target === 'home') {
      viewedProfileUsername = null;
    }
    switchMainView(target);
  });

  const rightSwitchBtn = document.getElementById('right-switch-btn');
  const switchGoogleBtn = document.getElementById('switch-google-account-btn');

  if (rightSwitchBtn) {
    rightSwitchBtn.addEventListener('click', () => {
      logoutAndShowAuthGate();
    });
  }
  if (switchGoogleBtn) {
    switchGoogleBtn.addEventListener('click', () => {
      logoutAndShowAuthGate();
    });
  }
}

function switchMainView(viewName, fromHistory = false) {
  closeMessagesPopup(true);
  currentView = viewName;

  if (!fromHistory && viewName !== 'home') {
    pushNavState(viewName);
  }

  const feedContainer = document.getElementById('feed-view-container');
  const profileContainer = document.getElementById('profile-view-container');
  const messagesContainer = document.getElementById('messages-view-container');
  const rightPanel = document.getElementById('right-panel');
  const storiesSection = document.getElementById('stories-section');
  const modeBanner = document.getElementById('feed-mode-banner');
  const modeTitle = document.getElementById('feed-mode-title');

  
  document.querySelectorAll('.sidebar .nav-row[data-nav-target]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-nav-target') === viewName);
  });
  document.querySelectorAll('.mobile-bottom-nav .mobile-nav-btn[data-nav-target]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-nav-target') === viewName);
  });

  if (viewName === 'profile') {
    document.body.classList.remove('in-messages-view');
    document.body.classList.remove('in-dm-chat');
    if (messagesContainer) messagesContainer.classList.add('hidden');
    feedContainer.classList.add('hidden');
    if (rightPanel) rightPanel.classList.add('hidden');
    profileContainer.classList.remove('hidden');
    renderProfileView();
  } else if (viewName === 'messages') {
    feedContainer.classList.add('hidden');
    profileContainer.classList.add('hidden');
    if (rightPanel) rightPanel.classList.add('hidden');
    if (messagesContainer) messagesContainer.classList.remove('hidden');
    document.body.classList.add('in-messages-view');
    renderDirectMessagesView();
  } else {
    document.body.classList.remove('in-messages-view');
    document.body.classList.remove('in-dm-chat');
    if (messagesContainer) messagesContainer.classList.add('hidden');
    profileContainer.classList.add('hidden');
    feedContainer.classList.remove('hidden');
    if (rightPanel) rightPanel.classList.remove('hidden');

    if (viewName === 'home') {
      storiesSection.classList.remove('hidden');
      modeBanner.classList.add('hidden');
    } else if (viewName === 'posts-only') {
      storiesSection.classList.add('hidden');
      modeBanner.classList.remove('hidden');
      modeTitle.textContent = 'Semua Postingan Pengguna';
    } else if (viewName === 'saved') {
      storiesSection.classList.add('hidden');
      modeBanner.classList.remove('hidden');
      modeTitle.textContent = 'Saved Posts (Postingan yang Disimpan)';
    } else if (viewName === 'liked') {
      storiesSection.classList.add('hidden');
      modeBanner.classList.remove('hidden');
      modeTitle.textContent = 'Liked Posts (Postingan yang Disukai)';
    }
    renderFeedPosts();
  }
}


const THEME_MODE_KEY = 'gramify_theme_mode';

function initMoreMenuPopover() {
  const moreBtn = document.getElementById('sidebar-more-btn');
  const popover = document.getElementById('more-menu-popover');
  const themeBtns = document.querySelectorAll('.theme-option-btn');
  const logoutBtn = document.getElementById('more-menu-logout-btn');

  
  const savedTheme = localStorage.getItem(THEME_MODE_KEY) || 'dark';
  applyThemeMode(savedTheme);

  
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  if (mediaQuery && mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', () => {
      const currentMode = localStorage.getItem(THEME_MODE_KEY) || 'dark';
      if (currentMode === 'auto') {
        applyThemeMode('auto');
      }
    });
  }

  if (moreBtn && popover) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = popover.classList.toggle('open');
      moreBtn.classList.toggle('active', isOpen);
      if (isOpen) {
        pushNavState('more-menu');
      } else {
        notifyModalClosedProgrammatically();
      }
    });

    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && !moreBtn.contains(e.target)) {
        if (popover.classList.contains('open')) {
          popover.classList.remove('open');
          moreBtn.classList.remove('active');
          notifyModalClosedProgrammatically();
        }
      }
    });
  }

  
  themeBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = btn.getAttribute('data-theme-mode') || 'dark';
      localStorage.setItem(THEME_MODE_KEY, mode);
      applyThemeMode(mode);
    });
  });

  
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      if (popover) popover.classList.remove('open');
      if (moreBtn) moreBtn.classList.remove('active');
      logoutAndShowAuthGate();
    });
  }
}


function openAppearanceModal() {
  const appearanceModal = document.getElementById('appearance-modal');
  if (!appearanceModal) return;
  const currentMode = localStorage.getItem(THEME_MODE_KEY) || 'dark';
  applyThemeMode(currentMode);
  const wasHidden = appearanceModal.classList.contains('hidden');
  appearanceModal.classList.remove('hidden');
  if (wasHidden) {
    pushNavState('appearance-modal');
  }
}

function closeAppearanceModal(fromBack = false) {
  const appearanceModal = document.getElementById('appearance-modal');
  if (!appearanceModal) return;
  const wasOpen = !appearanceModal.classList.contains('hidden');
  appearanceModal.classList.add('hidden');
  if (wasOpen && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}

function initAppearanceModal() {
  const gearBtn = document.getElementById('open-edit-profile-gear');
  const appearanceModal = document.getElementById('appearance-modal');
  const appearanceCloseBtn = document.getElementById('appearance-modal-close-btn');
  const appearanceDoneBtn = document.getElementById('appearance-modal-done-btn');

  if (gearBtn) {
    gearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openAppearanceModal();
    });
  }

  if (appearanceCloseBtn) {
    appearanceCloseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeAppearanceModal(false);
    });
  }

  if (appearanceDoneBtn) {
    appearanceDoneBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeAppearanceModal(false);
    });
  }

  if (appearanceModal) {
    appearanceModal.addEventListener('click', (e) => {
      if (e.target === appearanceModal) {
        closeAppearanceModal(false);
      }
    });

    
    const modalThemeBtns = appearanceModal.querySelectorAll('.theme-option-btn');
    modalThemeBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.getAttribute('data-theme-mode') || 'dark';
        localStorage.setItem(THEME_MODE_KEY, mode);
        applyThemeMode(mode);
      });
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && appearanceModal && !appearanceModal.classList.contains('hidden')) {
      closeAppearanceModal();
    }
  });
}

function applyThemeMode(mode) {
  let isDark = false;
  if (mode === 'dark') {
    isDark = true;
  } else if (mode === 'light') {
    isDark = false;
  } else if (mode === 'auto') {
    isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  document.body.classList.toggle('dark-mode', isDark);

  document.querySelectorAll('.theme-option-btn').forEach((btn) => {
    const btnMode = btn.getAttribute('data-theme-mode');
    btn.classList.toggle('selected', btnMode === mode);
  });
}

function renderAllViews() {
  const user = getCurrentUser();
  if (!user) return;

  
  const sideAvatar = document.getElementById('sidebar-profile-avatar');
  const mobAvatar = document.getElementById('mobile-profile-avatar');
  const rightAvatar = document.getElementById('right-panel-avatar');
  const rightUser = document.getElementById('right-panel-username');
  const rightFull = document.getElementById('right-panel-fullname');
  const logoutUserSpan = document.getElementById('more-logout-username');

  if (sideAvatar) sideAvatar.src = user.avatar;
  if (mobAvatar) mobAvatar.src = user.avatar;
  if (rightAvatar) rightAvatar.src = user.avatar;
  if (rightUser) rightUser.textContent = user.username;
  if (rightFull) rightFull.textContent = user.fullName;
  if (logoutUserSpan) logoutUserSpan.textContent = `(@${user.username})`;

  renderStoriesBar();
  renderFeedPosts();
  renderRightSuggestions();
  renderNotificationBadges();
  renderFloatingMessagesPill();
  if (currentView === 'profile') {
    renderProfileView();
  }
  if (currentView === 'messages') {
    renderDirectMessagesView();
  }
  if (activeDetailPostId) {
    renderPostDetailModalContent();
  }
  if (!document.getElementById('messages-popup-window').classList.contains('hidden')) {
    renderMessagesThreadsList();
    if (activeChatPartner) {
      renderActiveChatMessages(activeChatPartner);
    }
  }
  renderOnlineIndicators();
}


let isStoryPaused = false;

function getViewedStoryIds(username) {
  if (!username) return new Set();
  try {
    const raw = localStorage.getItem(`gramify_viewed_stories_${username}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    return new Set();
  }
}

function hasUserViewedStory(story, username) {
  if (!story || !username) return false;
  if (Array.isArray(story.viewers) && story.viewers.includes(username)) return true;
  const viewedIds = getViewedStoryIds(username);
  return viewedIds.has(story.id);
}

function markStoryAsViewed(storyId, username) {
  if (!storyId || !username) return;
  try {
    const viewedIds = getViewedStoryIds(username);
    viewedIds.add(storyId);
    localStorage.setItem(`gramify_viewed_stories_${username}`, JSON.stringify(Array.from(viewedIds)));
  } catch (e) {}

  const db = getDB();
  const story = db.stories.find((s) => s.id === storyId);
  if (story) {
    if (!Array.isArray(story.viewers)) story.viewers = [];
    if (!story.viewers.includes(username)) {
      story.viewers.push(username);
      saveDB(db);
    }
  }
}

function renderStoriesBar() {
  cleanExpiredStories();
  const container = document.getElementById('stories-section');
  const user = getCurrentUser();
  if (!container || !user) return;

  const db = getDB();
  container.innerHTML = '';

  const myStories = db.stories.filter((s) => s.authorUsername === user.username);
  const hasMyStory = myStories.length > 0;
  const myAllViewed = hasMyStory && myStories.every((s) => hasUserViewedStory(s, user.username));
  const myRingClass = hasMyStory
    ? (myAllViewed ? 'has-viewed-story' : 'has-active-story')
    : 'add-story-ring';

  
  const myStoryItem = document.createElement('div');
  myStoryItem.className = 'story-item';
  myStoryItem.innerHTML = `
    <div class="story-ring ${myRingClass}" id="my-story-ring">
      <img src="${escapeAttr(user.avatar)}" alt="${escapeAttr(user.username)}" />
      <span class="story-plus-badge" id="my-story-add-plus" title="Tambah Story">+</span>
    </div>
    <span class="story-username">Your story</span>
  `;

  const myRing = myStoryItem.querySelector('#my-story-ring');
  const plusBadge = myStoryItem.querySelector('#my-story-add-plus');

  if (plusBadge) {
    plusBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      openCreateModalWithType('story');
    });
  }

  if (myRing) {
    myRing.addEventListener('click', () => {
      if (hasMyStory) {
        const unviewed = myStories.find((s) => !hasUserViewedStory(s, user.username));
        openStoryViewer((unviewed || myStories[0]).id);
      } else {
        openCreateModalWithType('story');
      }
    });
  }

  container.appendChild(myStoryItem);

  
  const otherStories = db.stories.filter((s) => s.authorUsername !== user.username);
  const authorStoryMap = new Map();
  otherStories.forEach((st) => {
    if (!authorStoryMap.has(st.authorUsername)) {
      authorStoryMap.set(st.authorUsername, []);
    }
    authorStoryMap.get(st.authorUsername).push(st);
  });

  authorStoryMap.forEach((userStories, authorUsername) => {
    const firstStory = userStories[0];
    const isAllViewed = userStories.every((s) => hasUserViewedStory(s, user.username));
    const ringClass = isAllViewed ? 'has-viewed-story' : 'has-active-story';

    const item = document.createElement('div');
    item.className = 'story-item';
    item.innerHTML = `
      <div class="story-ring ${ringClass}">
        <img src="${escapeAttr(firstStory.authorAvatar)}" alt="${escapeAttr(authorUsername)}" />
      </div>
      <span class="story-username">${escapeHtml(authorUsername)}</span>
    `;
    item.addEventListener('click', () => {
      
      const unviewed = userStories.find((s) => !hasUserViewedStory(s, user.username));
      openStoryViewer((unviewed || firstStory).id);
    });
    container.appendChild(item);
  });
}

function initStoryViewerEvents() {
  const closeBtn = document.getElementById('story-close-btn');
  const modal = document.getElementById('story-modal');
  const deleteBtn = document.getElementById('story-delete-btn');
  const storyBox = document.querySelector('.story-viewer-box');

  if (closeBtn) {
    closeBtn.addEventListener('click', closeStoryViewer);
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeStoryViewer();
    });
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      if (!activeStoryId) return;
      const db = getDB();
      db.stories = db.stories.filter((s) => s.id !== activeStoryId);
      saveDB(db);
      closeStoryViewer();
      renderAllViews();
    });
  }

  
  if (storyBox) {
    const handlePauseDown = (e) => {
      if (e.target.closest('#story-close-btn') || e.target.closest('#story-delete-btn')) {
        return;
      }
      isStoryPaused = true;
      storyBox.classList.add('is-paused');
    };

    const handleResumeUp = () => {
      if (isStoryPaused) {
        isStoryPaused = false;
        storyBox.classList.remove('is-paused');
      }
    };

    storyBox.addEventListener('mousedown', handlePauseDown);
    storyBox.addEventListener('touchstart', handlePauseDown, { passive: true });

    window.addEventListener('mouseup', handleResumeUp);
    storyBox.addEventListener('mouseleave', handleResumeUp);
    window.addEventListener('touchend', handleResumeUp);
    window.addEventListener('touchcancel', handleResumeUp);

    
    storyBox.addEventListener('contextmenu', (e) => {
      if (modal && modal.classList.contains('open')) {
        e.preventDefault();
      }
    });
  }
}

function openStoryViewer(storyId) {
  const db = getDB();
  const story = db.stories.find((s) => s.id === storyId);
  const user = getCurrentUser();
  if (!story || !user) return;

  activeStoryId = story.id;
  isStoryPaused = false;

  
  markStoryAsViewed(story.id, user.username);
  renderStoriesBar();

  const modal = document.getElementById('story-modal');
  const imgEl = document.getElementById('story-viewer-img');
  const avatarEl = document.getElementById('story-viewer-avatar');
  const usernameEl = document.getElementById('story-viewer-username');
  const timeleftEl = document.getElementById('story-viewer-timeleft');
  const captionEl = document.getElementById('story-viewer-caption');
  const progressEl = document.getElementById('story-progress-bar');
  const deleteBtn = document.getElementById('story-delete-btn');
  const storyBox = document.querySelector('.story-viewer-box');
  if (storyBox) storyBox.classList.remove('is-paused');

  imgEl.src = story.imageUrl;
  avatarEl.src = story.authorAvatar;
  usernameEl.textContent = story.authorUsername;
  captionEl.textContent = story.caption || '';

  const remainingMs = Math.max(0, story.expiresAt - Date.now());
  const hoursLeft = Math.floor(remainingMs / (1000 * 60 * 60));
  const minsLeft = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
  timeleftEl.textContent = `${formatRelativeTime(story.createdAt)} • Hilang dalam ${hoursLeft}j ${minsLeft}m`;

  if (deleteBtn) {
    deleteBtn.classList.toggle('hidden', story.authorUsername !== user.username);
  }

  const wasOpen = modal.classList.contains('open');
  modal.classList.add('open');
  if (!wasOpen) {
    pushNavState('story-modal');
  }
  clearInterval(storyTimer);
  let pct = 0;
  progressEl.style.width = '0%';

  storyTimer = setInterval(() => {
    
    if (isStoryPaused) return;

    pct += 2.5;
    progressEl.style.width = `${pct}%`;
    if (pct >= 100) {
      
      const authorStories = db.stories.filter((s) => s.authorUsername === story.authorUsername);
      const currentIndex = authorStories.findIndex((s) => s.id === activeStoryId);
      if (currentIndex !== -1 && currentIndex + 1 < authorStories.length) {
        openStoryViewer(authorStories[currentIndex + 1].id);
      } else {
        closeStoryViewer();
      }
    }
  }, 100);
}

function closeStoryViewer(fromBack = false) {
  const modal = document.getElementById('story-modal');
  const wasOpen = modal && modal.classList.contains('open');
  if (modal) modal.classList.remove('open');
  clearInterval(storyTimer);
  isStoryPaused = false;
  const storyBox = document.querySelector('.story-viewer-box');
  if (storyBox) storyBox.classList.remove('is-paused');
  activeStoryId = null;
  renderStoriesBar();
  renderFeedPosts();

  if (wasOpen && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}


function closeCreateModal(fromBack = false) {
  const modal = document.getElementById('create-modal');
  const wasOpen = modal && modal.classList.contains('open');
  if (modal) modal.classList.remove('open');
  if (wasOpen && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}

let hasEditorImageLoaded = false;

function initCreateModalAndEditor() {
  const openBtns = document.querySelectorAll('.open-create-btn');
  const modal = document.getElementById('create-modal');
  const closeBtn = document.getElementById('create-modal-close');
  const fileInput = document.getElementById('create-file-input');
  const urlInput = document.getElementById('create-url-input');
  const urlApplyBtn = document.getElementById('create-url-apply-btn');
  const selectFileBtn = document.getElementById('create-select-file-btn');
  const changePhotoBtn = document.getElementById('create-change-photo-btn');
  const dropzone = document.getElementById('create-upload-dropzone');
  const editorSection = document.getElementById('create-editor-details-section');
  const filterBtns = document.querySelectorAll('.filter-pill-btn');
  const brightSlider = document.getElementById('edit-brightness');
  const contrastSlider = document.getElementById('edit-contrast');
  const saturateSlider = document.getElementById('edit-saturate');
  const form = document.getElementById('create-content-form');
  const typeTabs = document.querySelectorAll('.create-type-tab-btn');
  const locationField = document.getElementById('create-location-field');
  const modalTitle = document.getElementById('create-modal-title');
  const submitText = document.getElementById('create-submit-text');
  const lblBright = document.getElementById('label-val-brightness');
  const lblContrast = document.getElementById('label-val-contrast');
  const lblSaturate = document.getElementById('label-val-saturate');

  editorImageObj.crossOrigin = 'anonymous';
  editorImageObj.onload = () => {
    hasEditorImageLoaded = true;
    updateCreateUIState();
    drawEditorCanvas();
  };
  editorImageObj.onerror = () => {
    hasEditorImageLoaded = false;
    updateCreateUIState();
    drawEditorCanvas();
  };

  function updateCreateUIState() {
    if (hasEditorImageLoaded) {
      if (dropzone) dropzone.classList.add('hidden');
      if (editorSection) editorSection.classList.remove('hidden');
    } else {
      if (dropzone) dropzone.classList.remove('hidden');
      if (editorSection) editorSection.classList.add('hidden');
    }
  }

  
  openBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      openCreateModalWithType('post');
    });
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeCreateModal(false));
  }
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeCreateModal(false);
    });
  }

  
  if (selectFileBtn && fileInput) {
    selectFileBtn.addEventListener('click', () => fileInput.click());
  }

  
  if (changePhotoBtn) {
    changePhotoBtn.addEventListener('click', () => {
      hasEditorImageLoaded = false;
      if (fileInput) fileInput.value = '';
      if (urlInput) urlInput.value = '';
      editorImageObj.removeAttribute('src');
      updateCreateUIState();
    });
  }

  
  if (dropzone) {
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          editorImageObj.src = ev.target.result;
        };
        reader.readAsDataURL(files[0]);
      }
    });
  }

  
  typeTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const type = tab.getAttribute('data-type') || 'post';
      setCreateType(type);
    });
  });

  
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          editorImageObj.src = ev.target.result;
        };
        reader.readAsDataURL(e.target.files[0]);
      } else if (!urlInput || !urlInput.value.trim()) {
        hasEditorImageLoaded = false;
        updateCreateUIState();
        drawEditorCanvas();
      }
    });
  }

  
  if (urlApplyBtn && urlInput) {
    urlApplyBtn.addEventListener('click', () => {
      const val = urlInput.value.trim();
      if (val) {
        editorImageObj.src = val;
      }
    });

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = urlInput.value.trim();
        if (val) editorImageObj.src = val;
      }
    });
  }

  
  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      editorState.preset = btn.getAttribute('data-preset') || 'normal';
      drawEditorCanvas();
    });
  });

  
  if (brightSlider) {
    brightSlider.addEventListener('input', () => {
      editorState.brightness = parseInt(brightSlider.value, 10);
      if (lblBright) lblBright.textContent = brightSlider.value + '%';
      drawEditorCanvas();
    });
  }
  if (contrastSlider) {
    contrastSlider.addEventListener('input', () => {
      editorState.contrast = parseInt(contrastSlider.value, 10);
      if (lblContrast) lblContrast.textContent = contrastSlider.value + '%';
      drawEditorCanvas();
    });
  }
  if (saturateSlider) {
    saturateSlider.addEventListener('input', () => {
      editorState.saturate = parseInt(saturateSlider.value, 10);
      if (lblSaturate) lblSaturate.textContent = saturateSlider.value + '%';
      drawEditorCanvas();
    });
  }

  
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const user = getCurrentUser();
      if (!user) return;

      if (!hasEditorImageLoaded && (!urlInput || !urlInput.value.trim())) {
        if (fileInput) fileInput.click();
        return;
      }

      const selectedType = document.querySelector('input[name="create-type"]:checked')?.value || 'post';
      const caption = document.getElementById('create-caption-input').value.trim();
      const location = document.getElementById('create-location-input').value.trim();
      const canvas = document.getElementById('editor-canvas');

      let finalImageUrl = urlInput.value.trim();
      try {
        finalImageUrl = canvas.toDataURL('image/jpeg', 0.85);
      } catch (err) {
        
        finalImageUrl = urlInput.value.trim();
      }

      const db = getDB();
      const now = Date.now();

      if (selectedType === 'story') {
        db.stories.unshift({
          id: 'story_' + now + '_' + Math.random().toString(36).slice(2, 7),
          authorUsername: user.username,
          authorAvatar: user.avatar,
          imageUrl: finalImageUrl,
          caption,
          createdAt: now,
          expiresAt: now + TWENTY_FOUR_HOURS_MS
        });
      } else {
        db.posts.unshift({
          id: 'post_' + now + '_' + Math.random().toString(36).slice(2, 7),
          authorUsername: user.username,
          authorAvatar: user.avatar,
          imageUrl: finalImageUrl,
          caption,
          location,
          createdAt: now,
          likes: [],
          comments: []
        });
      }

      saveDB(db);
      form.reset();
      hasEditorImageLoaded = false;
      resetEditorControls();
      modal.classList.remove('open');
      if (selectedType === 'post' && currentView === 'profile') {
        renderProfileView();
      } else {
        switchMainView('home');
        renderAllViews();
      }
    });
  }
}

function setCreateType(type) {
  const typeTabs = document.querySelectorAll('.create-type-tab-btn');
  const locationField = document.getElementById('create-location-field');
  const modalTitle = document.getElementById('create-modal-title');
  const submitText = document.getElementById('create-submit-text');

  typeTabs.forEach((t) => {
    const isActive = t.getAttribute('data-type') === type;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const radio = document.querySelector(`input[name="create-type"][value="${type}"]`);
  if (radio) radio.checked = true;

  if (locationField) {
    locationField.classList.toggle('hidden', type === 'story');
  }

  if (modalTitle) {
    modalTitle.textContent = type === 'story' ? 'Buat Story 24 Jam' : 'Buat Postingan Baru';
  }
  if (submitText) {
    submitText.textContent = type === 'story' ? 'Bagikan ke Story' : 'Bagikan Postingan';
  }
}

function openCreateModalWithType(type) {
  closeMessagesPopup();
  const modal = document.getElementById('create-modal');
  const urlInput = document.getElementById('create-url-input');
  const fileInput = document.getElementById('create-file-input');
  const dropzone = document.getElementById('create-upload-dropzone');
  const editorSection = document.getElementById('create-editor-details-section');

  setCreateType(type);

  hasEditorImageLoaded = false;
  if (urlInput) urlInput.value = '';
  if (fileInput) fileInput.value = '';
  editorImageObj.removeAttribute('src');

  if (dropzone) dropzone.classList.remove('hidden');
  if (editorSection) editorSection.classList.add('hidden');

  resetEditorControls();
  drawEditorCanvas();
  const wasOpen = modal.classList.contains('open');
  modal.classList.add('open');
  if (!wasOpen) {
    pushNavState('create-modal');
  }
}

function resetEditorControls() {
  editorState = { preset: 'normal', brightness: 100, contrast: 100, saturate: 100 };
  const b = document.getElementById('edit-brightness');
  const c = document.getElementById('edit-contrast');
  const s = document.getElementById('edit-saturate');
  if (b) b.value = 100;
  if (c) c.value = 100;
  if (s) s.value = 100;

  const lb = document.getElementById('label-val-brightness');
  const lc = document.getElementById('label-val-contrast');
  const ls = document.getElementById('label-val-saturate');
  if (lb) lb.textContent = '100%';
  if (lc) lc.textContent = '100%';
  if (ls) ls.textContent = '100%';

  document.querySelectorAll('.filter-pill-btn').forEach((btn, idx) => {
    btn.classList.toggle('active', idx === 0);
  });
}

function drawEditorCanvas() {
  const canvas = document.getElementById('editor-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  
  if (!hasEditorImageLoaded || !editorImageObj.complete || !editorImageObj.naturalWidth) {
    const isDark = document.body.classList.contains('dark-mode');
    ctx.fillStyle = isDark ? '#18181b' : '#f8f9fa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = isDark ? '#363636' : '#dbdbdb';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
    ctx.setLineDash([]);

    ctx.fillStyle = isDark ? '#a8a8a8' : '#737373';
    ctx.font = '600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Belum ada foto dipilih', canvas.width / 2, canvas.height / 2 - 8);
    ctx.font = '400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('Pilih file gambar dari perangkat atau tempel URL di atas', canvas.width / 2, canvas.height / 2 + 20);
    return;
  }

  let presetFilter = '';
  if (editorState.preset === 'clarendon') {
    presetFilter = 'contrast(120%) saturate(125%) ';
  } else if (editorState.preset === 'warm') {
    presetFilter = 'sepia(28%) saturate(135%) brightness(104%) ';
  } else if (editorState.preset === 'bw') {
    presetFilter = 'grayscale(100%) contrast(115%) ';
  } else if (editorState.preset === 'vintage') {
    presetFilter = 'sepia(45%) contrast(95%) brightness(95%) ';
  }

  ctx.filter = `${presetFilter}brightness(${editorState.brightness}%) contrast(${editorState.contrast}%) saturate(${editorState.saturate}%)`;

  
  const nw = editorImageObj.naturalWidth;
  const nh = editorImageObj.naturalHeight;
  const size = Math.min(nw, nh);
  const sx = (nw - size) / 2;
  const sy = (nh - size) / 2;

  ctx.drawImage(editorImageObj, sx, sy, size, size, 0, 0, canvas.width, canvas.height);
  ctx.filter = 'none';
}


function renderFeedPosts() {
  const postsList = document.getElementById('posts-list');
  const user = getCurrentUser();
  if (!postsList || !user) return;

  const db = getDB();
  let postsToRender = db.posts;

  if (currentView === 'saved') {
    const savedIds = user.savedPosts || [];
    postsToRender = db.posts.filter((p) => savedIds.includes(p.id));
  } else if (currentView === 'liked') {
    postsToRender = db.posts.filter((p) => p.likes.includes(user.username));
  }

  postsList.innerHTML = '';

  if (postsToRender.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.cssText = 'text-align:center; padding:48px 20px; border:1px solid var(--border-color); border-radius:12px; color:var(--text-muted);';
    if (currentView === 'saved') {
      emptyMsg.innerHTML = `<p style="font-weight:700; color:var(--text-main); margin-bottom:6px;">Belum ada postingan yang disimpan</p><p>Klik ikon pita (Save) di pojok kanan bawah postingan untuk menyimpannya ke sini.</p>`;
    } else if (currentView === 'liked') {
      emptyMsg.innerHTML = `<p style="font-weight:700; color:var(--text-main); margin-bottom:6px;">Belum ada postingan yang disukai</p><p>Klik ikon hati (Like) atau klik 2x pada foto postingan untuk menyukainya.</p>`;
    } else {
      emptyMsg.innerHTML = `<p style="font-weight:700; color:var(--text-main); margin-bottom:6px;">Beranda masih kosong</p><p style="margin-bottom:14px;">Jadilah yang pertama mengunggah foto melalui tombol <strong>+ Create</strong> di sidebar!</p><button type="button" class="btn-primary open-create-inline" style="max-width:200px;">+ Buat Postingan Pertama</button>`;
    }
    postsList.appendChild(emptyMsg);

    const inlineCreate = emptyMsg.querySelector('.open-create-inline');
    if (inlineCreate) {
      inlineCreate.addEventListener('click', () => openCreateModalWithType('post'));
    }
    return;
  }

  postsToRender.forEach((post) => {
    const isLiked = post.likes.includes(user.username);
    const isSaved = (user.savedPosts || []).includes(post.id);
    const isOwnPost = post.authorUsername === user.username;
    const isFollowingAuthor = (user.following || []).includes(post.authorUsername);
    const authorUser = getUserByUsername(post.authorUsername);
    const avatarSrc = authorUser ? authorUser.avatar : post.authorAvatar || DEFAULT_AVATAR;
    const reposts = post.reposts || [];
    const isReposted = reposts.includes(user.username);
    const repostedByLabel = isReposted
      ? 'Anda me-repost postingan ini'
      : (() => {
          const followedReposter = reposts.find((r) => (user.following || []).includes(r));
          return followedReposter ? `@${followedReposter} me-repost postingan ini` : '';
        })();

    const authorStories = db.stories.filter((s) => s.authorUsername === post.authorUsername);
    const hasAuthorStory = authorStories.length > 0;
    const authorStoriesAllViewed = hasAuthorStory && authorStories.every((s) => hasUserViewedStory(s, user.username));
    const authorStoryRingClass = hasAuthorStory
      ? (authorStoriesAllViewed ? 'has-viewed-story' : 'has-active-story')
      : 'no-story';

    const article = document.createElement('article');
    article.className = 'post-card';
    article.setAttribute('data-post-id', post.id);

    article.innerHTML = `
      ${
        repostedByLabel
          ? `<div class="post-repost-label">
              <svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                <path d="M19.5 9.5v-1a3 3 0 0 0-3-3H5.5" /><polyline points="8.5 2.5 5.5 5.5 8.5 8.5" />
                <path d="M4.5 14.5v1a3 3 0 0 0 3 3h11" /><polyline points="15.5 21.5 18.5 18.5 15.5 15.5" />
              </svg>
              <span>${escapeHtml(repostedByLabel)}</span>
            </div>`
          : ''
      }
      <header class="post-header">
        <div class="post-author">
          <div class="author-avatar-ring ${authorStoryRingClass}" data-profile-user="${escapeAttr(post.authorUsername)}" style="cursor:pointer;" title="Lihat profil @${escapeAttr(post.authorUsername)}">
            <img src="${escapeAttr(avatarSrc)}" alt="${escapeAttr(post.authorUsername)}" />
          </div>
          <div class="author-meta">
            <div class="author-name-row">
              <span class="author-username" data-profile-user="${escapeAttr(post.authorUsername)}" style="cursor:pointer;">${escapeHtml(post.authorUsername)}</span>
              <span class="post-time">• ${formatRelativeTime(post.createdAt)}</span>
              ${
                !isOwnPost
                  ? `<button type="button" class="post-inline-follow-btn" data-author="${escapeAttr(post.authorUsername)}">• ${
                      isFollowingAuthor ? 'Following' : 'Follow'
                    }</button>`
                  : ''
              }
            </div>
            ${post.location ? `<span class="post-location">${escapeHtml(post.location)}</span>` : ''}
          </div>
        </div>
        <div class="post-header-right">
          ${
            isOwnPost
              ? `<button type="button" class="post-more-btn delete-own-post-btn" data-post-id="${escapeAttr(post.id)}" title="Hapus Postingan" aria-label="Options">
                   <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.75"/><circle cx="6" cy="12" r="1.75"/><circle cx="18" cy="12" r="1.75"/></svg>
                 </button>`
              : `<button type="button" class="post-more-btn comment-trigger-btn" title="Opsi Postingan" aria-label="Options">
                   <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.75"/><circle cx="6" cy="12" r="1.75"/><circle cx="18" cy="12" r="1.75"/></svg>
                 </button>`
          }
        </div>
      </header>

      <div class="post-media">
        <img src="${escapeAttr(post.imageUrl)}" alt="Post" class="post-image" />
        <svg class="double-tap-heart" width="96" height="96" viewBox="0 0 24 24" fill="#ffffff">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
      </div>

      <div class="post-actions">
        <div class="post-actions-left">
          <button type="button" class="action-btn like-btn ${isLiked ? 'liked' : ''}" aria-label="Like">
            <svg class="icon-heart-outline" style="display:${isLiked ? 'none' : 'block'};" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" viewBox="0 0 24 24">
              <path d="M16.79 3.5c-1.98 0-3.71 1.06-4.79 2.67C10.92 4.56 9.19 3.5 7.21 3.5 4.33 3.5 2 5.93 2 8.93c0 5.36 8.03 10.63 9.55 11.6a.84.84 0 0 0 .9 0C13.97 19.56 22 14.29 22 8.93c0-3-2.33-5.43-5.21-5.43Z" />
            </svg>
            <svg class="icon-heart-filled" style="display:${isLiked ? 'block' : 'none'};" fill="currentColor" viewBox="0 0 24 24">
              <path d="M16.79 3.5c-1.98 0-3.71 1.06-4.79 2.67C10.92 4.56 9.19 3.5 7.21 3.5 4.33 3.5 2 5.93 2 8.93c0 5.36 8.03 10.63 9.55 11.6a.84.84 0 0 0 .9 0C13.97 19.56 22 14.29 22 8.93c0-3-2.33-5.43-5.21-5.43Z" />
            </svg>
            <span class="action-count">${formatCompactCount(post.likes.length)}</span>
          </button>
          <button type="button" class="action-btn comment-trigger-btn" aria-label="Comment">
            <svg fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" viewBox="0 0 24 24">
              <path d="M20.66 16.96A9.5 9.5 0 1 0 17.3 20.3L21.5 21.5Z" />
            </svg>
            <span class="action-count">${formatCompactCount(getTotalCommentsCount(post))}</span>
          </button>
          <button type="button" class="action-btn repost-btn ${isReposted ? 'reposted' : ''}" aria-label="Repost">
            <svg fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
              <path d="M19.5 9.5v-1a3 3 0 0 0-3-3H5.5" />
              <polyline points="8.5 2.5 5.5 5.5 8.5 8.5" />
              <path d="M4.5 14.5v1a3 3 0 0 0 3 3h11" />
              <polyline points="15.5 21.5 18.5 18.5 15.5 15.5" />
            </svg>
            <span class="action-count">${formatCompactCount(reposts.length)}</span>
          </button>
          <button type="button" class="action-btn share-post-btn" aria-label="Share">
            <svg fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" viewBox="0 0 24 24">
              <path d="M22 3 9.22 10.08" />
              <path d="M11.7 20.33 22 3H2l7.22 7.08 2.48 10.25Z" />
            </svg>
            <span class="action-count">${formatCompactCount(post.shares || 0)}</span>
          </button>
        </div>
        <button type="button" class="action-btn save-btn ${isSaved ? 'saved' : ''}" aria-label="Save">
          <svg class="icon-save-outline" style="display:${isSaved ? 'none' : 'block'};" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" viewBox="0 0 24 24">
            <path d="M20 21 12 13.44 4 21V3h16Z" />
          </svg>
          <svg class="icon-save-filled" style="display:${isSaved ? 'block' : 'none'};" fill="currentColor" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" viewBox="0 0 24 24">
            <path d="M20 21 12 13.44 4 21V3h16Z" />
          </svg>
        </button>
      </div>

      ${
        post.caption
          ? `<div class="post-caption"><strong data-profile-user="${escapeAttr(post.authorUsername)}" style="cursor:pointer;">${escapeHtml(post.authorUsername)}</strong> ${escapeHtml(post.caption)}</div>`
          : ''
      }
      ${
        getTotalCommentsCount(post) > 0
          ? `<button type="button" class="comment-trigger-btn" style="font-size:13px; color:var(--text-muted); margin-top:4px; padding:0;">View all ${getTotalCommentsCount(post)} comments</button>`
          : ''
      }
    `;

    postsList.appendChild(article);
  });
}

function getTotalCommentsCount(post) {
  if (!post || !Array.isArray(post.comments)) return 0;
  let total = post.comments.length;
  post.comments.forEach((c) => {
    if (Array.isArray(c.replies)) {
      total += c.replies.length;
    }
  });
  return total;
}

function initPostFeedEvents() {
  const postsList = document.getElementById('posts-list');
  if (!postsList) return;

  postsList.addEventListener('click', (e) => {
    const postCard = e.target.closest('.post-card');
    if (!postCard) return;
    const postId = postCard.getAttribute('data-post-id');

    
    if (e.target.closest('.like-btn')) {
      handleToggleLike(postId);
      return;
    }

    
    if (e.target.closest('.save-btn')) {
      handleToggleSave(postId);
      return;
    }

    
    const followInlineBtn = e.target.closest('.post-inline-follow-btn');
    if (followInlineBtn) {
      const targetUser = followInlineBtn.getAttribute('data-author');
      handleToggleFollow(targetUser);
      return;
    }

    
    const delBtn = e.target.closest('.delete-own-post-btn');
    if (delBtn) {
      const db = getDB();
      db.posts = db.posts.filter((p) => p.id !== postId);
      saveDB(db);
      renderAllViews();
      return;
    }

    
    if (e.target.closest('.comment-trigger-btn')) {
      openPostDetailModal(postId);
      return;
    }

    
    if (e.target.closest('.repost-btn')) {
      handleToggleRepost(postId);
      return;
    }

    
    if (e.target.closest('.share-post-btn')) {
      openSharePostModal(postId);
      return;
    }
  });

  
  postsList.addEventListener('dblclick', (e) => {
    const mediaBox = e.target.closest('.post-media');
    if (!mediaBox) return;
    const postCard = mediaBox.closest('.post-card');
    const postId = postCard.getAttribute('data-post-id');
    const heartSvg = mediaBox.querySelector('.double-tap-heart');

    if (heartSvg) {
      heartSvg.classList.remove('animate');
      void heartSvg.offsetWidth;
      heartSvg.classList.add('animate');
    }

    const db = getDB();
    const user = getCurrentUser();
    const post = db.posts.find((p) => p.id === postId);
    if (post && user && !post.likes.includes(user.username)) {
      handleToggleLike(postId);
    }
  });
}


let activeDetailPostId = null;
let activeReplyTarget = null; 
const expandedReplyCommentIds = new Set();

function initPostDetailModal() {
  const modal = document.getElementById('post-detail-modal');
  const closeBtn = document.getElementById('post-detail-close-btn');
  const authorLink = document.getElementById('post-detail-author-link');
  const mediaBox = document.getElementById('post-detail-media-box');
  const commentsScroll = document.getElementById('post-detail-comments-scroll');
  const pdLikeBtn = document.getElementById('pd-like-btn');
  const pdCommentFocusBtn = document.getElementById('pd-comment-focus-btn');
  const pdRepostBtn = document.getElementById('pd-repost-btn');
  const pdShareBtn = document.getElementById('pd-share-btn');
  const pdSaveBtn = document.getElementById('pd-save-btn');
  const cancelReplyBtn = document.getElementById('pd-cancel-reply-btn');
  const commentForm = document.getElementById('pd-comment-form');
  const commentInput = document.getElementById('pd-comment-input');
  const commentSubmit = document.getElementById('pd-comment-submit');
  const emojiBtn = document.getElementById('pd-emoji-btn');

  if (!modal) return;

  if (closeBtn) {
    closeBtn.addEventListener('click', closePostDetailModal);
  }
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePostDetailModal();
  });

  if (authorLink) {
    authorLink.addEventListener('click', () => {
      const db = getDB();
      const post = db.posts.find((p) => p.id === activeDetailPostId);
      if (post) {
        closePostDetailModal();
        openUserProfile(post.authorUsername);
      }
    });
  }

  
  if (mediaBox) {
    mediaBox.addEventListener('dblclick', () => {
      if (!activeDetailPostId) return;
      const heartSvg = document.getElementById('post-detail-dbl-heart');
      if (heartSvg) {
        heartSvg.classList.remove('animate');
        void heartSvg.offsetWidth;
        heartSvg.classList.add('animate');
      }
      const db = getDB();
      const user = getCurrentUser();
      const post = db.posts.find((p) => p.id === activeDetailPostId);
      if (post && user && !post.likes.includes(user.username)) {
        handleToggleLike(activeDetailPostId);
      }
    });
  }

  if (pdLikeBtn) {
    pdLikeBtn.addEventListener('click', () => {
      if (activeDetailPostId) handleToggleLike(activeDetailPostId);
    });
  }
  if (pdCommentFocusBtn) {
    pdCommentFocusBtn.addEventListener('click', () => {
      if (commentInput) commentInput.focus();
    });
  }
  if (pdRepostBtn) {
    pdRepostBtn.addEventListener('click', () => {
      if (activeDetailPostId) handleToggleRepost(activeDetailPostId);
    });
  }
  if (pdShareBtn) {
    pdShareBtn.addEventListener('click', () => {
      if (activeDetailPostId) openSharePostModal(activeDetailPostId);
    });
  }
  if (pdSaveBtn) {
    pdSaveBtn.addEventListener('click', () => {
      if (activeDetailPostId) handleToggleSave(activeDetailPostId);
    });
  }

  if (cancelReplyBtn) {
    cancelReplyBtn.addEventListener('click', () => {
      clearActiveReplyTarget();
    });
  }

  if (emojiBtn && commentInput) {
    const emojis = ['❤️', '🙌', '🔥', '👏', '😢', '😍', '😮', '😂'];
    let emojiIdx = 0;
    emojiBtn.addEventListener('click', () => {
      commentInput.value += emojis[emojiIdx % emojis.length];
      emojiIdx++;
      commentInput.focus();
      commentSubmit.classList.toggle('ready', commentInput.value.trim().length > 0);
    });
  }

  if (commentInput && commentSubmit) {
    commentInput.addEventListener('input', () => {
      commentSubmit.classList.toggle('ready', commentInput.value.trim().length > 0);
    });
  }

  
  if (commentsScroll) {
    commentsScroll.addEventListener('click', (e) => {
      const profileTarget = e.target.closest('[data-profile-user]');
      if (profileTarget) {
        const targetUsername = profileTarget.getAttribute('data-profile-user');
        closePostDetailModal();
        openUserProfile(targetUsername);
        return;
      }

      
      const likeCommentBtn = e.target.closest('.pd-comment-like-btn');
      if (likeCommentBtn && activeDetailPostId) {
        const commentId = likeCommentBtn.getAttribute('data-comment-id');
        const replyId = likeCommentBtn.getAttribute('data-reply-id') || null;
        handleToggleCommentLike(activeDetailPostId, commentId, replyId);
        return;
      }

      
      const replyTrigger = e.target.closest('.pd-reply-trigger');
      if (replyTrigger) {
        const commentId = replyTrigger.getAttribute('data-comment-id');
        const username = replyTrigger.getAttribute('data-username');
        setActiveReplyTarget(commentId, username);
        return;
      }

      
      const toggleRepliesBtn = e.target.closest('[data-toggle-replies]');
      if (toggleRepliesBtn) {
        const commentId = toggleRepliesBtn.getAttribute('data-toggle-replies');
        if (expandedReplyCommentIds.has(commentId)) {
          expandedReplyCommentIds.delete(commentId);
        } else {
          expandedReplyCommentIds.add(commentId);
        }
        renderPostDetailModalContent();
      }
    });
  }

  
  if (commentForm && commentInput) {
    commentForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!activeDetailPostId) return;
      const text = commentInput.value.trim();
      const user = getCurrentUser();
      if (!text || !user) return;

      const db = getDB();
      const post = db.posts.find((p) => p.id === activeDetailPostId);
      if (!post) return;

      post.comments = post.comments || [];

      if (activeReplyTarget) {
        const parentComment = post.comments.find((c) => c.id === activeReplyTarget.commentId);
        if (parentComment) {
          parentComment.replies = parentComment.replies || [];
          parentComment.replies.push({
            id: 'rep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            username: user.username,
            text,
            replyToUsername: activeReplyTarget.username,
            createdAt: Date.now(),
            likes: []
          });
          expandedReplyCommentIds.add(parentComment.id);
        }
      } else {
        post.comments.push({
          id: 'cmt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          username: user.username,
          text,
          createdAt: Date.now(),
          likes: [],
          replies: []
        });
      }

      commentInput.value = '';
      if (commentSubmit) commentSubmit.classList.remove('ready');
      clearActiveReplyTarget();
      saveDB(db);
      renderAllViews();
    });
  }
}

function openPostDetailModal(postId) {
  activeDetailPostId = postId;
  clearActiveReplyTarget();
  renderPostDetailModalContent();
  const modal = document.getElementById('post-detail-modal');
  if (modal) {
    const wasOpen = modal.classList.contains('open');
    modal.classList.add('open');
    if (!wasOpen) {
      pushNavState('post-detail-modal');
    }
  }
  const commentInput = document.getElementById('pd-comment-input');
  if (commentInput) {
    setTimeout(() => commentInput.focus(), 50);
  }
}

function closePostDetailModal(fromBack = false) {
  const modal = document.getElementById('post-detail-modal');
  const wasOpen = modal && modal.classList.contains('open');
  if (modal) modal.classList.remove('open');
  activeDetailPostId = null;
  clearActiveReplyTarget();

  if (wasOpen && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}

function setActiveReplyTarget(commentId, username) {
  activeReplyTarget = { commentId, username };
  const banner = document.getElementById('pd-replying-banner');
  const label = document.getElementById('pd-replying-label');
  const input = document.getElementById('pd-comment-input');
  const submit = document.getElementById('pd-comment-submit');

  if (banner) banner.classList.remove('hidden');
  if (label) label.textContent = `Membalas @${username}`;
  if (input) {
    const prefix = `@${username} `;
    if (!input.value.startsWith(prefix)) {
      input.value = prefix;
    }
    input.focus();
    if (submit) submit.classList.add('ready');
  }
}

function clearActiveReplyTarget() {
  activeReplyTarget = null;
  const banner = document.getElementById('pd-replying-banner');
  if (banner) banner.classList.add('hidden');
}

function handleToggleCommentLike(postId, commentId, replyId) {
  const user = getCurrentUser();
  if (!user) return;
  const db = getDB();
  const post = db.posts.find((p) => p.id === postId);
  if (!post || !Array.isArray(post.comments)) return;

  const comment = post.comments.find((c) => c.id === commentId);
  if (!comment) return;

  let targetObj = comment;
  if (replyId && Array.isArray(comment.replies)) {
    targetObj = comment.replies.find((r) => r.id === replyId);
  }
  if (!targetObj) return;

  targetObj.likes = targetObj.likes || [];
  const idx = targetObj.likes.indexOf(user.username);
  if (idx === -1) {
    targetObj.likes.push(user.username);
  } else {
    targetObj.likes.splice(idx, 1);
  }

  saveDB(db);
  renderAllViews();
}

function renderPostDetailModalContent() {
  if (!activeDetailPostId) return;
  const db = getDB();
  const user = getCurrentUser();
  const post = db.posts.find((p) => p.id === activeDetailPostId);
  if (!post || !user) {
    closePostDetailModal();
    return;
  }

  const authorUser = getUserByUsername(post.authorUsername);
  const authorAvatar = authorUser ? authorUser.avatar : post.authorAvatar || DEFAULT_AVATAR;
  const authorSub = post.location || (authorUser ? authorUser.fullName : '');

  document.getElementById('post-detail-img').src = post.imageUrl;
  document.getElementById('post-detail-author-avatar').src = authorAvatar;
  document.getElementById('post-detail-author-username').textContent = post.authorUsername;
  document.getElementById('post-detail-author-sub').textContent = authorSub;

  
  const isLiked = post.likes.includes(user.username);
  const isReposted = (post.reposts || []).includes(user.username);
  const isSaved = (user.savedPosts || []).includes(post.id);

  const pdLikeBtn = document.getElementById('pd-like-btn');
  if (pdLikeBtn) {
    pdLikeBtn.classList.toggle('liked', isLiked);
    pdLikeBtn.querySelector('.icon-heart-outline').style.display = isLiked ? 'none' : 'block';
    pdLikeBtn.querySelector('.icon-heart-filled').style.display = isLiked ? 'block' : 'none';
  }

  const pdRepostBtn = document.getElementById('pd-repost-btn');
  if (pdRepostBtn) {
    pdRepostBtn.classList.toggle('reposted', isReposted);
  }

  const pdSaveBtn = document.getElementById('pd-save-btn');
  if (pdSaveBtn) {
    pdSaveBtn.classList.toggle('saved', isSaved);
    pdSaveBtn.querySelector('.icon-save-outline').style.display = isSaved ? 'none' : 'block';
    pdSaveBtn.querySelector('.icon-save-filled').style.display = isSaved ? 'block' : 'none';
  }

  document.getElementById('pd-likes-count-text').textContent = `${post.likes.length.toLocaleString('en-US')} likes`;
  document.getElementById('pd-post-time-text').textContent = formatRelativeTime(post.createdAt);

  
  const scrollEl = document.getElementById('post-detail-comments-scroll');
  scrollEl.innerHTML = '';

  
  if (post.caption) {
    const captionBlock = document.createElement('div');
    captionBlock.className = 'pd-comment-block';
    captionBlock.innerHTML = `
      <div class="pd-comment-row">
        <div class="pd-comment-left">
          <div class="author-avatar-ring" data-profile-user="${escapeAttr(post.authorUsername)}" style="cursor:pointer;">
            <img src="${escapeAttr(authorAvatar)}" alt="${escapeAttr(post.authorUsername)}" />
          </div>
          <div class="pd-comment-body">
            <div>
              <span class="pd-comment-username" data-profile-user="${escapeAttr(post.authorUsername)}">${escapeHtml(post.authorUsername)}</span>
              <span>${escapeHtml(post.caption)}</span>
            </div>
            <div class="pd-comment-meta">
              <span>${formatShortAge(post.createdAt)}</span>
            </div>
          </div>
        </div>
      </div>
    `;
    scrollEl.appendChild(captionBlock);
  }

  
  const comments = post.comments || [];
  if (comments.length === 0 && !post.caption) {
    scrollEl.innerHTML = `
      <div style="margin:auto; text-align:center; padding:32px 12px;">
        <div style="font-size:20px; font-weight:700; margin-bottom:6px;">No comments yet.</div>
        <div style="font-size:14px; color:var(--text-muted);">Start the conversation.</div>
      </div>
    `;
    return;
  }

  comments.forEach((c) => {
    const commenterUser = getUserByUsername(c.username);
    const commenterAvatar = commenterUser ? commenterUser.avatar : DEFAULT_AVATAR;
    const cLikes = Array.isArray(c.likes) ? c.likes : [];
    const isCommentLiked = cLikes.includes(user.username);
    const replies = Array.isArray(c.replies) ? c.replies : [];
    const isRepliesExpanded = expandedReplyCommentIds.has(c.id);

    const block = document.createElement('div');
    block.className = 'pd-comment-block';

    const likeLabel = `${cLikes.length} ${cLikes.length === 1 ? 'like' : 'likes'}`;

    let repliesHtml = '';
    if (replies.length > 0) {
      repliesHtml += `
        <button type="button" class="pd-view-replies-row" data-toggle-replies="${escapeAttr(c.id)}">
          <span class="pd-view-replies-line"></span>
          <span>${isRepliesExpanded ? 'Hide replies' : `View replies (${replies.length})`}</span>
        </button>
      `;
      if (isRepliesExpanded) {
        repliesHtml += `<div class="pd-replies-container">`;
        replies.forEach((r) => {
          const rUser = getUserByUsername(r.username);
          const rAvatar = rUser ? rUser.avatar : DEFAULT_AVATAR;
          const rLikes = Array.isArray(r.likes) ? r.likes : [];
          const isReplyLiked = rLikes.includes(user.username);
          const rLikeLabel = `${rLikes.length} ${rLikes.length === 1 ? 'like' : 'likes'}`;

          repliesHtml += `
            <div class="pd-comment-row">
              <div class="pd-comment-left">
                <img src="${escapeAttr(rAvatar)}" alt="${escapeAttr(r.username)}" class="pd-comment-avatar" data-profile-user="${escapeAttr(r.username)}" />
                <div class="pd-comment-body">
                  <div>
                    <span class="pd-comment-username" data-profile-user="${escapeAttr(r.username)}">${escapeHtml(r.username)}</span>
                    <span>${formatCommentTextWithMentions(r.text)}</span>
                  </div>
                  <div class="pd-comment-meta">
                    <span>${formatShortAge(r.createdAt)}</span>
                    <span style="font-weight:600;">${rLikeLabel}</span>
                    <button type="button" class="pd-comment-meta-btn pd-reply-trigger" data-comment-id="${escapeAttr(c.id)}" data-username="${escapeAttr(r.username)}">Reply</button>
                  </div>
                </div>
              </div>
              <button type="button" class="pd-comment-like-btn ${isReplyLiked ? 'liked' : ''}" data-comment-id="${escapeAttr(c.id)}" data-reply-id="${escapeAttr(r.id)}" aria-label="Like reply">
                ${
                  isReplyLiked
                    ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.79 3.5c-1.98 0-3.71 1.06-4.79 2.67C10.92 4.56 9.19 3.5 7.21 3.5 4.33 3.5 2 5.93 2 8.93c0 5.36 8.03 10.63 9.55 11.6a.84.84 0 0 0 .9 0C13.97 19.56 22 14.29 22 8.93c0-3-2.33-5.43-5.21-5.43Z"/></svg>`
                    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M16.79 3.5c-1.98 0-3.71 1.06-4.79 2.67C10.92 4.56 9.19 3.5 7.21 3.5 4.33 3.5 2 5.93 2 8.93c0 5.36 8.03 10.63 9.55 11.6a.84.84 0 0 0 .9 0C13.97 19.56 22 14.29 22 8.93c0-3-2.33-5.43-5.21-5.43Z"/></svg>`
                }
              </button>
            </div>
          `;
        });
        repliesHtml += `</div>`;
      }
    }

    block.innerHTML = `
      <div class="pd-comment-row">
        <div class="pd-comment-left">
          <img src="${escapeAttr(commenterAvatar)}" alt="${escapeAttr(c.username)}" class="pd-comment-avatar" data-profile-user="${escapeAttr(c.username)}" />
          <div class="pd-comment-body">
            <div>
              <span class="pd-comment-username" data-profile-user="${escapeAttr(c.username)}">${escapeHtml(c.username)}</span>
              <span>${formatCommentTextWithMentions(c.text)}</span>
            </div>
            <div class="pd-comment-meta">
              <span>${formatShortAge(c.createdAt)}</span>
              <span style="font-weight:600;">${likeLabel}</span>
              <button type="button" class="pd-comment-meta-btn pd-reply-trigger" data-comment-id="${escapeAttr(c.id)}" data-username="${escapeAttr(c.username)}">Reply</button>
            </div>
          </div>
        </div>
        <button type="button" class="pd-comment-like-btn ${isCommentLiked ? 'liked' : ''}" data-comment-id="${escapeAttr(c.id)}" aria-label="Like comment">
          ${
            isCommentLiked
              ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.79 3.5c-1.98 0-3.71 1.06-4.79 2.67C10.92 4.56 9.19 3.5 7.21 3.5 4.33 3.5 2 5.93 2 8.93c0 5.36 8.03 10.63 9.55 11.6a.84.84 0 0 0 .9 0C13.97 19.56 22 14.29 22 8.93c0-3-2.33-5.43-5.21-5.43Z"/></svg>`
              : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M16.79 3.5c-1.98 0-3.71 1.06-4.79 2.67C10.92 4.56 9.19 3.5 7.21 3.5 4.33 3.5 2 5.93 2 8.93c0 5.36 8.03 10.63 9.55 11.6a.84.84 0 0 0 .9 0C13.97 19.56 22 14.29 22 8.93c0-3-2.33-5.43-5.21-5.43Z"/></svg>`
          }
        </button>
      </div>
      ${repliesHtml}
    `;

    scrollEl.appendChild(block);
  });
}

function formatCommentTextWithMentions(rawText) {
  const safe = escapeHtml(rawText || '');
  return safe.replace(/@([a-zA-Z0-9._]+)/g, '<span style="color:#00376b; cursor:pointer;" data-profile-user="$1">@$1</span>');
}

function formatShortAge(timestamp) {
  const diffSec = Math.max(1, Math.floor((Date.now() - (timestamp || Date.now())) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const diffWeek = Math.floor(diffDay / 7);
  return `${diffWeek}w`;
}

function handleToggleLike(postId) {
  const user = getCurrentUser();
  if (!user) return;
  const db = getDB();
  const post = db.posts.find((p) => p.id === postId);
  if (!post) return;

  const idx = post.likes.indexOf(user.username);
  if (idx === -1) {
    post.likes.push(user.username);
    
    if (post.authorUsername !== user.username) {
      db.notifications.unshift({
        id: 'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type: 'like',
        fromUsername: user.username,
        fromFullName: user.fullName,
        fromAvatar: user.avatar,
        toUsername: post.authorUsername,
        postId: post.id,
        postImage: post.imageUrl,
        createdAt: Date.now(),
        read: false
      });
    }
  } else {
    post.likes.splice(idx, 1);
  }

  saveDB(db);
  renderAllViews();
}

function handleToggleSave(postId) {
  const user = getCurrentUser();
  if (!user) return;
  const db = getDB();
  const dbUser = db.users.find((u) => u.username === user.username);
  if (!dbUser) return;

  dbUser.savedPosts = dbUser.savedPosts || [];
  const idx = dbUser.savedPosts.indexOf(postId);
  if (idx === -1) {
    dbUser.savedPosts.unshift(postId);
  } else {
    dbUser.savedPosts.splice(idx, 1);
  }

  saveDB(db);
  renderAllViews();
}

function handleToggleFollow(targetUsername) {
  const user = getCurrentUser();
  if (!user || user.username === targetUsername) return;

  const db = getDB();
  const me = db.users.find((u) => u.username === user.username);
  const target = db.users.find((u) => u.username === targetUsername);
  if (!me || !target) return;

  me.following = me.following || [];
  target.followers = target.followers || [];

  const isAlreadyFollowing = me.following.includes(targetUsername);
  if (!isAlreadyFollowing) {
    me.following.push(targetUsername);
    if (!target.followers.includes(me.username)) {
      target.followers.push(me.username);
    }
    
    db.notifications.unshift({
      id: 'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: 'follow',
      fromUsername: me.username,
      fromFullName: me.fullName,
      fromAvatar: me.avatar,
      toUsername: target.username,
      createdAt: Date.now(),
      read: false
    });
  } else {
    me.following = me.following.filter((u) => u !== targetUsername);
    target.followers = target.followers.filter((u) => u !== me.username);
  }

  saveDB(db);
  renderAllViews();
}

function handleToggleRepost(postId) {
  const user = getCurrentUser();
  if (!user) return;
  const db = getDB();
  const post = db.posts.find((p) => p.id === postId);
  if (!post) return;

  post.reposts = post.reposts || [];
  const idx = post.reposts.indexOf(user.username);
  if (idx === -1) {
    post.reposts.push(user.username);
    if (post.authorUsername !== user.username) {
      db.notifications.unshift({
        id: 'notif_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type: 'repost',
        fromUsername: user.username,
        fromFullName: user.fullName,
        fromAvatar: user.avatar,
        toUsername: post.authorUsername,
        postId: post.id,
        postImage: post.imageUrl,
        createdAt: Date.now(),
        read: false
      });
    }
  } else {
    post.reposts.splice(idx, 1);
    db.notifications = db.notifications.filter(
      (n) => !(n.type === 'repost' && n.postId === post.id && n.fromUsername === user.username)
    );
  }

  saveDB(db);
  renderAllViews();
}


let sharingPostId = null;

function ensureShareModal() {
  let modal = document.getElementById('share-post-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'share-post-modal';
  modal.className = 'modal-overlay';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Share');
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <span>Share</span>
        <button id="share-modal-close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <input id="share-search-input" type="text" class="form-input" placeholder="Cari pengguna..." />
        </div>
        <div id="share-users-list" style="display:flex; flex-direction:column; max-height:300px; overflow-y:auto;"></div>
        <button id="share-copy-link-btn" type="button" class="profile-gray-btn" style="width:100%; margin-top:12px;">Salin link postingan</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('open');
  });
  modal.querySelector('#share-modal-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.querySelector('#share-search-input').addEventListener('input', (e) => {
    renderShareUsersList(e.target.value);
  });
  modal.querySelector('#share-copy-link-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const link = `${window.location.origin}${window.location.pathname}#post-${sharingPostId}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch (err) {
      
    }
    incrementPostShare(sharingPostId);
    btn.textContent = 'Link disalin ✓';
    setTimeout(() => {
      btn.textContent = 'Salin link postingan';
    }, 1500);
  });

  return modal;
}

function openSharePostModal(postId) {
  sharingPostId = postId;
  const modal = ensureShareModal();
  const input = modal.querySelector('#share-search-input');
  if (input) input.value = '';
  renderShareUsersList('');
  modal.classList.add('open');
}

function renderShareUsersList(query) {
  const container = document.getElementById('share-users-list');
  const me = getCurrentUser();
  if (!container || !me) return;

  const q = (query || '').toLowerCase().trim();
  const db = getDB();
  const others = db.users.filter(
    (u) =>
      u.username !== me.username &&
      (u.username.toLowerCase().includes(q) || (u.fullName || '').toLowerCase().includes(q))
  );

  container.innerHTML = '';
  if (others.length === 0) {
    container.innerHTML = `<p style="font-size:13px; color:var(--text-muted); text-align:center; padding:20px 0;">Belum ada pengguna lain untuk dikirimi postingan.</p>`;
    return;
  }

  others.forEach((other) => {
    const row = document.createElement('div');
    row.className = 'share-user-row';
    row.innerHTML = `
      <div class="user-mini-info">
        <img src="${escapeAttr(other.avatar || DEFAULT_AVATAR)}" alt="" class="avatar-md" />
        <div class="user-text">
          <span class="user-handle">${escapeHtml(other.username)}</span>
          <span class="user-subtext">${escapeHtml(other.fullName || '')}</span>
        </div>
      </div>
      <button type="button" class="share-send-btn">Send</button>
    `;
    const sendBtn = row.querySelector('.share-send-btn');
    sendBtn.addEventListener('click', () => {
      if (sendBtn.classList.contains('sent')) return;
      sendPostToUser(sharingPostId, other.username);
      sendBtn.classList.add('sent');
      sendBtn.textContent = 'Sent';
    });
    container.appendChild(row);
  });
}

function sendPostToUser(postId, toUsername) {
  const me = getCurrentUser();
  if (!me || !postId) return;
  const db = getDB();
  const post = db.posts.find((p) => p.id === postId);
  if (!post) return;

  const captionPreview = post.caption ? `: "${post.caption.slice(0, 60)}"` : '';
  db.messages.push({
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    fromUsername: me.username,
    toUsername,
    text: `Membagikan postingan @${post.authorUsername}${captionPreview}`,
    sharedPostId: post.id,
    createdAt: Date.now(),
    read: false
  });
  post.shares = (post.shares || 0) + 1;
  saveDB(db);
  renderAllViews();
}

function incrementPostShare(postId) {
  if (!postId) return;
  const db = getDB();
  const post = db.posts.find((p) => p.id === postId);
  if (!post) return;
  post.shares = (post.shares || 0) + 1;
  saveDB(db);
  renderAllViews();
}

function formatCompactCount(num) {
  const n = Number(num) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace('.0', '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace('.0', '') + 'K';
  return String(n);
}


function renderNotificationBadges() {
  const user = getCurrentUser();
  if (!user) return;
  const db = getDB();
  const unreadNotifs = db.notifications.filter((n) => n.toUsername === user.username && !n.read);

  const redDot = document.getElementById('notif-red-dot');
  const floatingBubble = document.getElementById('notif-floating-bubble');
  const bubbleCount = document.getElementById('notif-bubble-count');
  const mobileDot = document.getElementById('mobile-notif-dot');

  if (unreadNotifs.length > 0) {
    if (redDot) redDot.classList.remove('hidden');
    if (floatingBubble) floatingBubble.classList.remove('hidden');
    if (bubbleCount) bubbleCount.textContent = unreadNotifs.length;
    if (mobileDot) mobileDot.classList.remove('hidden');
  } else {
    if (redDot) redDot.classList.add('hidden');
    if (floatingBubble) floatingBubble.classList.add('hidden');
    if (mobileDot) mobileDot.classList.add('hidden');
  }
}

function closeNotificationsModal(fromBack = false) {
  const modal = document.getElementById('notifications-modal');
  const wasOpen = modal && modal.classList.contains('open');
  if (modal) modal.classList.remove('open');
  if (wasOpen && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}

function initNotificationsModal() {
  const openBtns = document.querySelectorAll('.open-notifications-btn');
  const modal = document.getElementById('notifications-modal');
  const closeBtn = document.getElementById('notifications-modal-close');

  openBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      closeMessagesPopup(true);
      renderNotificationsModalContent();
      const wasOpen = modal.classList.contains('open');
      modal.classList.add('open');
      if (!wasOpen) {
        pushNavState('notifications-modal');
      }

      
      const user = getCurrentUser();
      if (user) {
        const db = getDB();
        db.notifications.forEach((n) => {
          if (n.toUsername === user.username) n.read = true;
        });
        saveDB(db);
        renderNotificationBadges();
      }
    });
  });

  if (closeBtn) closeBtn.addEventListener('click', () => closeNotificationsModal(false));
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeNotificationsModal(false);
    });
  }
}

function renderNotificationsModalContent() {
  const user = getCurrentUser();
  if (!user) return;
  const db = getDB();

  const incomingContainer = document.getElementById('incoming-notifications-list');
  const myLikedContainer = document.getElementById('my-liked-history-list');

  
  const myIncoming = db.notifications.filter((n) => n.toUsername === user.username);
  incomingContainer.innerHTML = '';

  if (myIncoming.length === 0) {
    incomingContainer.innerHTML = `<p style="font-size:13px; color:var(--text-muted);">Belum ada aktivitas masuk pada akunmu.</p>`;
  } else {
    myIncoming.forEach((n) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px;';
      if (n.type === 'like') {
        row.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px;">
            <img src="${escapeAttr(n.fromAvatar || DEFAULT_AVATAR)}" alt="" style="width:38px; height:38px; border-radius:50%; object-fit:cover;" />
            <div style="font-size:13px;">
              <strong>@${escapeHtml(n.fromUsername)}</strong> (${escapeHtml(n.fromFullName || '')}) menyukai postingan Anda.
              <span style="color:var(--text-muted); font-size:11px; display:block;">${formatRelativeTime(n.createdAt)}</span>
            </div>
          </div>
          ${n.postImage ? `<img src="${escapeAttr(n.postImage)}" alt="" style="width:40px; height:40px; border-radius:4px; object-fit:cover;" />` : ''}
        `;
      } else if (n.type === 'follow') {
        row.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px;">
            <img src="${escapeAttr(n.fromAvatar || DEFAULT_AVATAR)}" alt="" style="width:38px; height:38px; border-radius:50%; object-fit:cover;" />
            <div style="font-size:13px;">
              Pengikut baru: <strong>@${escapeHtml(n.fromUsername)}</strong> (${escapeHtml(n.fromFullName || '')}) mulai mengikuti Anda.
              <span style="color:var(--text-muted); font-size:11px; display:block;">${formatRelativeTime(n.createdAt)}</span>
            </div>
          </div>
        `;
      } else if (n.type === 'repost') {
        row.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px;">
            <img src="${escapeAttr(n.fromAvatar || DEFAULT_AVATAR)}" alt="" style="width:38px; height:38px; border-radius:50%; object-fit:cover;" />
            <div style="font-size:13px;">
              <strong>@${escapeHtml(n.fromUsername)}</strong> (${escapeHtml(n.fromFullName || '')}) me-repost postingan Anda.
              <span style="color:var(--text-muted); font-size:11px; display:block;">${formatRelativeTime(n.createdAt)}</span>
            </div>
          </div>
          ${n.postImage ? `<img src="${escapeAttr(n.postImage)}" alt="" style="width:40px; height:40px; border-radius:4px; object-fit:cover;" />` : ''}
        `;
      }
      incomingContainer.appendChild(row);
    });
  }

  
  const likedPosts = db.posts.filter((p) => p.likes.includes(user.username));
  myLikedContainer.innerHTML = '';

  if (likedPosts.length === 0) {
    myLikedContainer.innerHTML = `<p style="font-size:13px; color:var(--text-muted);">Kamu belum menyukai postingan siapa pun.</p>`;
  } else {
    likedPosts.forEach((p) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px;';
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px;">
          <img src="${escapeAttr(p.authorAvatar || DEFAULT_AVATAR)}" alt="" style="width:36px; height:36px; border-radius:50%; object-fit:cover;" />
          <div style="font-size:13px;">
            Kamu menyukai postingan milik <strong>@${escapeHtml(p.authorUsername)}</strong>
            <span style="color:var(--text-muted); font-size:12px; display:block;">"${escapeHtml(p.caption || 'Tanpa caption')}"</span>
          </div>
        </div>
        <img src="${escapeAttr(p.imageUrl)}" alt="" style="width:40px; height:40px; border-radius:4px; object-fit:cover;" />
      `;
      myLikedContainer.appendChild(row);
    });
  }
}


function renderProfileView() {
  const me = getCurrentUser();
  if (!me) return;
  const db = getDB();

  const targetUser = (viewedProfileUsername && getUserByUsername(viewedProfileUsername)) || me;
  const isOwnProfile = !viewedProfileUsername || (targetUser && targetUser.username && me && me.username && targetUser.username.toLowerCase() === me.username.toLowerCase());

  const userPosts = db.posts.filter((p) => p.authorUsername === targetUser.username);
  const mySavedPosts = db.posts.filter((p) => (me.savedPosts || []).includes(p.id));
  const userReposts = db.posts.filter((p) => (p.reposts || []).includes(targetUser.username));

  const avatarEl = document.getElementById('profile-page-avatar');
  if (avatarEl) {
    avatarEl.src = targetUser.avatar || DEFAULT_AVATAR;
    avatarEl.style.cursor = isOwnProfile ? 'pointer' : 'default';
    avatarEl.title = isOwnProfile ? 'Klik untuk mengganti foto profil' : `@${targetUser.username}`;
  }
  const profileOnlineDot = document.getElementById('profile-page-online-dot');
  if (profileOnlineDot) {
    const isOnline = isUserOnline(targetUser);
    profileOnlineDot.classList.toggle('hidden', !isOnline);
  }
  document.getElementById('profile-page-username').textContent = targetUser.username;
  document.getElementById('profile-page-fullname').textContent = targetUser.fullName;
  document.getElementById('profile-stat-posts').textContent = userPosts.length;
  document.getElementById('profile-stat-followers').textContent = (targetUser.followers || []).length;
  document.getElementById('profile-stat-following').textContent = (targetUser.following || []).length;
  document.getElementById('profile-page-bio').textContent = targetUser.bio || '';
  document.getElementById('profile-page-handle-tag').textContent = targetUser.username;

  const noteBtn = document.getElementById('profile-note-btn');
  if (noteBtn) {
    noteBtn.textContent = targetUser.note || 'Note...';
    noteBtn.classList.toggle('hidden', !isOwnProfile && (!targetUser.note || targetUser.note === 'Note...'));
  }

  
  const editProfileBtn = document.getElementById('edit-profile-btn');
  const switchGoogleBtn = document.getElementById('switch-google-account-btn');
  const gearBtn = document.getElementById('open-edit-profile-gear');
  const otherFollowBtn = document.getElementById('other-profile-follow-btn');
  const otherMsgBtn = document.getElementById('other-profile-message-btn');
  const tabSaved = document.getElementById('profile-tab-saved');

  if (editProfileBtn) {
    editProfileBtn.classList.toggle('hidden', !isOwnProfile);
    editProfileBtn.style.setProperty('display', !isOwnProfile ? 'none' : '', !isOwnProfile ? 'important' : '');
  }
  if (switchGoogleBtn) {
    switchGoogleBtn.classList.toggle('hidden', !isOwnProfile);
    switchGoogleBtn.style.setProperty('display', !isOwnProfile ? 'none' : '', !isOwnProfile ? 'important' : '');
  }
  if (gearBtn) {
    gearBtn.classList.toggle('hidden', !isOwnProfile);
    gearBtn.style.setProperty('display', !isOwnProfile ? 'none' : '', !isOwnProfile ? 'important' : '');
  }
  const tabPosts = document.getElementById('profile-tab-posts');
  const tabReposts = document.getElementById('profile-tab-reposts');

  if (tabPosts) tabPosts.classList.toggle('active', profileTabMode === 'posts');
  if (tabSaved) {
    tabSaved.classList.toggle('hidden', !isOwnProfile);
    tabSaved.style.setProperty('display', !isOwnProfile ? 'none' : '', !isOwnProfile ? 'important' : '');
    tabSaved.classList.toggle('active', isOwnProfile && profileTabMode === 'saved');
  }
  if (tabReposts) tabReposts.classList.toggle('active', profileTabMode === 'reposts');

  if (otherFollowBtn) {
    otherFollowBtn.classList.toggle('hidden', isOwnProfile);
    otherFollowBtn.style.setProperty('display', isOwnProfile ? 'none' : '', isOwnProfile ? 'important' : '');
    if (!isOwnProfile) {
      const isFollowing = (me.following || []).includes(targetUser.username);
      otherFollowBtn.textContent = isFollowing ? 'Following' : 'Follow';
      otherFollowBtn.style.background = isFollowing ? 'var(--bg-secondary)' : 'var(--accent-blue)';
      otherFollowBtn.style.color = isFollowing ? 'var(--text-main)' : '#ffffff';
    }
  }
  if (otherMsgBtn) {
    otherMsgBtn.classList.toggle('hidden', isOwnProfile);
    otherMsgBtn.style.setProperty('display', isOwnProfile ? 'none' : '', isOwnProfile ? 'important' : '');
  }

  const webEl = document.getElementById('profile-page-website');
  if (targetUser.website) {
    webEl.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block; vertical-align:middle; margin-right:4px;">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>${escapeHtml(targetUser.website)}
    `;
    webEl.href = targetUser.website.startsWith('http') ? targetUser.website : 'https://' + targetUser.website;
    webEl.classList.remove('hidden');
  } else {
    webEl.classList.add('hidden');
  }

  const gridEl = document.getElementById('profile-posts-grid');
  const emptyEl = document.getElementById('profile-empty-posts');
  let listToRender = userPosts;
  if (profileTabMode === 'saved' && isOwnProfile) {
    listToRender = mySavedPosts;
  } else if (profileTabMode === 'reposts') {
    listToRender = userReposts;
  }

  gridEl.innerHTML = '';
  if (listToRender.length === 0) {
    emptyEl.classList.remove('hidden');
    if (profileTabMode === 'reposts') {
      emptyEl.innerHTML = isOwnProfile
        ? 'Belum ada postingan yang Anda posting ulang.<br><span style="font-size:12px; color:var(--text-muted); display:inline-block; margin-top:6px;">Tekan tombol Posting Ulang pada postingan di beranda untuk memposting ulang!</span>'
        : `Belum ada postingan yang di-posting ulang oleh <strong>@${escapeHtml(targetUser.username)}</strong>.`;
    } else if (profileTabMode === 'saved') {
      emptyEl.innerHTML = 'Belum ada postingan pengguna lain yang disimpan.';
    } else {
      emptyEl.innerHTML = isOwnProfile
        ? 'Belum ada riwayat postingan foto. Klik tombol <strong>+ Create</strong> untuk mengunggah postingan!'
        : `Belum ada postingan dari <strong>@${escapeHtml(targetUser.username)}</strong>.`;
    }
  } else {
    emptyEl.classList.add('hidden');
    listToRender.forEach((p) => {
      const cell = document.createElement('div');
      cell.className = 'grid-post-item';
      cell.innerHTML = `
        <img src="${escapeAttr(p.imageUrl)}" alt="Post" />
        ${(p.reposts || []).includes(targetUser.username) && profileTabMode === 'reposts' ? `
          <div class="grid-repost-badge" title="Posting Ulang">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
              <path d="M19.5 9.5v-1a3 3 0 0 0-3-3H5.5" /><polyline points="8.5 2.5 5.5 5.5 8.5 8.5" />
              <path d="M4.5 14.5v1a3 3 0 0 0 3 3h11" /><polyline points="15.5 21.5 18.5 18.5 15.5 15.5" />
            </svg>
          </div>
        ` : ''}
        <div class="grid-post-overlay">
          <span style="display:inline-flex; align-items:center; gap:6px;">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
            ${p.likes.length}
          </span>
          <span style="display:inline-flex; align-items:center; gap:6px;">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20.656 17.008a9.993 9.993 0 1 0-3.59 3.615L22 22Z"/>
            </svg>
            ${getTotalCommentsCount(p)}
          </span>
          <span style="display:inline-flex; align-items:center; gap:6px;">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24">
              <path d="M19.5 9.5v-1a3 3 0 0 0-3-3H5.5" /><polyline points="8.5 2.5 5.5 5.5 8.5 8.5" />
              <path d="M4.5 14.5v1a3 3 0 0 0 3 3h11" /><polyline points="15.5 21.5 18.5 18.5 15.5 15.5" />
            </svg>
            ${(p.reposts || []).length}
          </span>
        </div>
      `;
      cell.addEventListener('click', () => {
        openPostDetailModal(p.id);
      });
      gridEl.appendChild(cell);
    });
  }
}

function closeEditProfileModal(fromBack = false) {
  const modal = document.getElementById('edit-profile-modal');
  const wasOpen = modal && modal.classList.contains('open');
  if (modal) modal.classList.remove('open');
  if (wasOpen && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}

function initProfileViewEvents() {
  const tabPosts = document.getElementById('profile-tab-posts');
  const tabSaved = document.getElementById('profile-tab-saved');
  const editBtns = [
    document.getElementById('edit-profile-btn'),
    document.getElementById('profile-note-btn')
  ];
  const editModal = document.getElementById('edit-profile-modal');
  const editClose = document.getElementById('edit-profile-close');
  const editForm = document.getElementById('edit-profile-form');
  const profileAvatarImg = document.getElementById('profile-page-avatar');
  const quickAvatarInput = document.getElementById('quick-avatar-upload-input');
  const otherFollowBtn = document.getElementById('other-profile-follow-btn');
  const otherMsgBtn = document.getElementById('other-profile-message-btn');

  if (otherFollowBtn) {
    otherFollowBtn.addEventListener('click', () => {
      if (viewedProfileUsername) {
        handleToggleFollow(viewedProfileUsername);
      }
    });
  }

  if (otherMsgBtn) {
    otherMsgBtn.addEventListener('click', () => {
      if (viewedProfileUsername) {
        openDirectChatWithUser(viewedProfileUsername);
      }
    });
  }

  
  if (profileAvatarImg && quickAvatarInput) {
    profileAvatarImg.addEventListener('click', () => {
      const me = getCurrentUser();
      if (!me) return;
      if (viewedProfileUsername && viewedProfileUsername !== me.username) return;
      quickAvatarInput.click();
    });

    quickAvatarInput.addEventListener('change', async () => {
      if (!quickAvatarInput.files || !quickAvatarInput.files[0]) return;
      const user = getCurrentUser();
      if (!user) return;
      const db = getDB();
      const dbUser = db.users.find((u) => u.username === user.username);
      if (!dbUser) return;

      const newAvatar = await readImageFileAsDataUrl(quickAvatarInput.files[0], 300);
      dbUser.avatar = newAvatar;
      db.posts.forEach((p) => {
        if (p.authorUsername === dbUser.username) p.authorAvatar = newAvatar;
      });
      db.stories.forEach((s) => {
        if (s.authorUsername === dbUser.username) s.authorAvatar = newAvatar;
      });
      saveDB(db);
      quickAvatarInput.value = '';
      renderAllViews();
    });
  }

  const tabReposts = document.getElementById('profile-tab-reposts');

  if (tabPosts) {
    tabPosts.addEventListener('click', () => {
      profileTabMode = 'posts';
      renderProfileView();
    });
  }
  if (tabSaved) {
    tabSaved.addEventListener('click', () => {
      profileTabMode = 'saved';
      renderProfileView();
    });
  }
  if (tabReposts) {
    tabReposts.addEventListener('click', () => {
      profileTabMode = 'reposts';
      renderProfileView();
    });
  }

  editBtns.forEach((btn) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      const user = getCurrentUser();
      if (!user) return;
      document.getElementById('edit-prof-username').value = user.username;
      document.getElementById('edit-prof-fullname').value = user.fullName;
      document.getElementById('edit-prof-website').value = user.website || '';
      document.getElementById('edit-prof-bio').value = user.bio || '';
      document.getElementById('edit-prof-note').value = user.note || '';
      const wasOpen = editModal.classList.contains('open');
      editModal.classList.add('open');
      if (!wasOpen) {
        pushNavState('edit-profile-modal');
      }
    });
  });

  if (editClose) editClose.addEventListener('click', () => closeEditProfileModal(false));
  if (editModal) {
    editModal.addEventListener('click', (e) => {
      if (e.target === editModal) closeEditProfileModal(false);
    });
  }

  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = getCurrentUser();
      if (!user) return;

      const db = getDB();
      const dbUser = db.users.find((u) => u.username === user.username);
      if (!dbUser) return;

      dbUser.fullName = document.getElementById('edit-prof-fullname').value.trim();
      dbUser.website = document.getElementById('edit-prof-website').value.trim();
      dbUser.bio = document.getElementById('edit-prof-bio').value.trim();
      dbUser.note = document.getElementById('edit-prof-note').value.trim() || 'Note...';

      const avatarInput = document.getElementById('edit-prof-avatar-file');
      if (avatarInput && avatarInput.files && avatarInput.files[0]) {
        dbUser.avatar = await readImageFileAsDataUrl(avatarInput.files[0], 300);
      }

      saveDB(db);
      editModal.classList.remove('open');
      renderAllViews();
    });
  }
}


function renderFloatingMessagesPill() {
  const user = getCurrentUser();
  if (!user) return;
  const db = getDB();

  const unreadMessages = db.messages.filter((m) => m.toUsername === user.username && !m.read);
  const floatBadge = document.getElementById('floating-msg-badge');
  const sideBadge = document.getElementById('sidebar-msg-badge');
  const headerBadge = document.getElementById('msg-popup-header-badge');
  const mobileDmBadge = document.getElementById('mobile-bottom-dm-badge');

  [floatBadge, sideBadge, headerBadge, mobileDmBadge].forEach((b) => {
    if (!b) return;
    if (unreadMessages.length > 0) {
      b.textContent = unreadMessages.length > 9 ? '9+' : unreadMessages.length;
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  });

  
  const avatarsWrap = document.getElementById('floating-msg-avatars');
  if (avatarsWrap) {
    const otherUsers = db.users.filter((u) => u.username !== user.username).slice(0, 3);
    avatarsWrap.innerHTML =
      otherUsers
        .map((u) => {
          const online = isUserOnline(u);
          return `<div style="position:relative; display:inline-block;">
            <img src="${escapeAttr(u.avatar)}" alt="${escapeAttr(u.username)}" />
            ${online ? '<span class="msg-online-dot" style="width:8px; height:8px; border-width:1.5px;"></span>' : ''}
          </div>`;
        })
        .join('') +
      `<span class="floating-msg-more-dots">•••</span>`;
  }
}

function initMessagesPopup() {
  const openBtns = document.querySelectorAll('.open-messages-btn');
  const popup = document.getElementById('messages-popup-window');
  const closeBtn = document.getElementById('msg-close-btn');
  const expandBtn = document.getElementById('msg-expand-btn');
  const backBtn = document.getElementById('chat-back-to-list-btn');
  const composeBtn = document.getElementById('msg-compose-btn');
  const chatForm = document.getElementById('chat-send-form');

  openBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeMessagesPopup(true);
      switchMainView('messages');
    });
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeMessagesPopup(false));
  }

  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const isTall = popup.style.height === '640px';
      popup.style.height = isTall ? '520px' : '640px';
      popup.style.width = isTall ? '375px' : '430px';
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', () => showMessagesThreadList(false));
  }

  if (composeBtn) {
    composeBtn.addEventListener('click', () => {
      document.getElementById('search-modal').classList.add('open');
      renderSearchUsersList('');
    });
  }

  if (chatForm) {
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('chat-input-field');
      const text = input.value.trim();
      const user = getCurrentUser();
      if (!text || !user || !activeChatPartner) return;

      const db = getDB();
      db.messages.push({
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        fromUsername: user.username,
        toUsername: activeChatPartner,
        text,
        createdAt: Date.now(),
        read: false
      });

      saveDB(db);
      input.value = '';
      renderActiveChatMessages(activeChatPartner);
    });
  }
}

function showMessagesThreadList(fromBack = false) {
  const hadActiveChat = !!activeChatPartner;
  activeChatPartner = null;
  document.getElementById('msg-threads-list-view').classList.remove('hidden');
  document.getElementById('msg-active-chat-view').classList.add('hidden');
  document.getElementById('chat-back-to-list-btn').classList.add('hidden');
  document.getElementById('msg-popup-header-title').textContent = 'Messages';
  renderMessagesThreadsList();

  if (hadActiveChat && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}

function renderMessagesThreadsList() {
  const container = document.getElementById('msg-threads-container');
  const user = getCurrentUser();
  if (!container || !user) return;

  const db = getDB();
  const otherUsers = db.users.filter((u) => u.username !== user.username);

  container.innerHTML = '';

  if (otherUsers.length === 0) {
    container.innerHTML = `
      <div style="padding:36px 20px; text-align:center; color:var(--text-muted); font-size:13px;">
        <p style="font-weight:700; color:var(--text-main); margin-bottom:6px;">Belum ada pengguna lain yang login</p>
        <p>Buka tab browser baru atau klik <strong>Switch</strong> untuk login dengan akun Google ke-2 agar bisa saling kirim pesan secara real-time!</p>
      </div>
    `;
    return;
  }

  otherUsers.forEach((other) => {
    const conversation = db.messages.filter(
      (m) =>
        (m.fromUsername === user.username && m.toUsername === other.username) ||
        (m.fromUsername === other.username && m.toUsername === user.username)
    );
    const lastMsg = conversation[conversation.length - 1];
    const unreadCount = conversation.filter((m) => m.toUsername === user.username && !m.read).length;
    const isOnline = isUserOnline(other);

    const row = document.createElement('div');
    row.className = 'msg-thread-row';
    row.innerHTML = `
      <div class="msg-thread-left">
        <div class="msg-avatar-wrap">
          <img src="${escapeAttr(other.avatar)}" alt="${escapeAttr(other.username)}" />
          ${isOnline ? '<span class="msg-online-dot" title="Sedang aktif"></span>' : ''}
        </div>
        <div style="min-width:0;">
          <div class="msg-thread-name">${escapeHtml(other.fullName)} (@${escapeHtml(other.username)})</div>
          <div class="msg-thread-preview" style="${unreadCount > 0 ? 'font-weight:700; color:var(--text-main);' : ''}">
            ${
              lastMsg
                ? `${escapeHtml((lastMsg.text || '').replace(/📷\s*/g, '').replace(/📸\s*/g, '').trim())} · ${formatRelativeTime(lastMsg.createdAt)}`
                : 'Klik untuk mulai chat langsung'
            }
          </div>
        </div>
      </div>
      ${unreadCount > 0 ? '<span class="msg-unread-dot"></span>' : ''}
    `;

    row.addEventListener('click', () => {
      openMessagesPopupWithUser(other.username);
    });

    container.appendChild(row);
  });
}

function openMessagesPopupWithUser(partnerUsername) {
  openDirectChatWithUser(partnerUsername);
}

function renderActiveChatMessages(partnerUsername) {
  const area = document.getElementById('chat-messages-area');
  const user = getCurrentUser();
  if (!area || !user) return;

  const partnerUser = getUserByUsername(partnerUsername);
  const isOnline = isUserOnline(partnerUser);
  const titleEl = document.getElementById('msg-popup-header-title');
  if (titleEl) {
    titleEl.innerHTML = `@${escapeHtml(partnerUsername)} ${
      isOnline
        ? '<span style="display:inline-flex; align-items:center; gap:4px; font-size:11px; color:var(--online-green); font-weight:600; margin-left:6px;"><span style="width:7px; height:7px; border-radius:50%; background:var(--online-green); display:inline-block;"></span>Aktif</span>'
        : ''
    }`;
  }

  const db = getDB();
  let hasUnread = false;

  const msgs = db.messages.filter((m) => {
    const match =
      (m.fromUsername === user.username && m.toUsername === partnerUsername) ||
      (m.fromUsername === partnerUsername && m.toUsername === user.username);
    if (match && m.toUsername === user.username && !m.read) {
      m.read = true;
      hasUnread = true;
    }
    return match;
  });

  if (hasUnread) {
    saveDB(db);
    renderFloatingMessagesPill();
  }

  area.innerHTML = '';
  if (msgs.length === 0) {
    area.innerHTML = `<p style="text-align:center; color:var(--text-muted); font-size:12px; margin-top:24px;">Mulai percakapan asli dengan <strong>@${escapeHtml(partnerUsername)}</strong>.</p>`;
  } else {
    msgs.forEach((m) => {
      const isSent = m.fromUsername === user.username;
      const cleanText = (m.text || '').replace(/📷\s*/g, '').replace(/📸\s*/g, '').trim();

      
      const sharedPost = m.sharedPostId ? db.posts.find((p) => p.id === m.sharedPostId) : null;

      if (sharedPost) {
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${isSent ? 'sent' : 'received'} shared-post-bubble`;
        bubble.setAttribute('title', 'Klik untuk melihat postingan');
        bubble.innerHTML = `
          <div class="chat-shared-card" data-post-id="${escapeAttr(sharedPost.id)}">
            <div class="chat-shared-card-header">
              <img src="${escapeAttr(sharedPost.authorAvatar || DEFAULT_AVATAR)}" class="chat-shared-card-avatar" alt="" />
              <span class="chat-shared-card-author">@${escapeHtml(sharedPost.authorUsername)}</span>
            </div>
            <div class="chat-shared-card-media">
              <img src="${escapeAttr(sharedPost.imageUrl)}" alt="Postingan" />
            </div>
            ${sharedPost.caption ? `<div class="chat-shared-card-caption">${escapeHtml(sharedPost.caption)}</div>` : ''}
            <div class="chat-shared-card-footer">
              <span>Lihat Postingan</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </div>
          </div>
        `;
        bubble.addEventListener('click', () => {
          openPostDetailModal(sharedPost.id);
        });
        area.appendChild(bubble);
      } else if (cleanText.startsWith('Membagikan postingan')) {
        
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${isSent ? 'sent' : 'received'}`;
        bubble.innerHTML = `
          <div style="display:flex; align-items:flex-start; gap:6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0; margin-top:2px;">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </svg>
            <span>${escapeHtml(cleanText)}</span>
          </div>
        `;
        area.appendChild(bubble);
      } else {
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${isSent ? 'sent' : 'received'}`;
        bubble.textContent = cleanText;
        area.appendChild(bubble);
      }
    });
    area.scrollTop = area.scrollHeight;
  }
}

function initDirectMessagesView() {
  const searchInput = document.getElementById('dm-search-input');
  const composeBtn = document.getElementById('dm-compose-btn');
  const emptySendBtn = document.getElementById('dm-empty-send-btn');
  const mobileBackBtn = document.getElementById('dm-mobile-back-btn');
  const headerInfoBtn = document.getElementById('dm-header-info-btn');
  const sendForm = document.getElementById('dm-chat-send-form');
  const textInput = document.getElementById('dm-chat-text-input');
  const emojiBtn = document.getElementById('dm-emoji-btn');
  const sendHeartBtn = document.getElementById('dm-send-heart-btn');
  const submitBtn = document.getElementById('dm-submit-btn');
  const imgUploadBtn = document.getElementById('dm-image-upload-btn');
  const imgFileInput = document.getElementById('dm-image-file-input');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      renderDirectMessagesThreads(e.target.value.trim());
    });
  }

  if (composeBtn) {
    composeBtn.addEventListener('click', () => {
      const searchModal = document.getElementById('search-modal');
      if (searchModal) {
        searchModal.classList.add('open');
        renderSearchUsersList('');
      }
    });
  }

  if (emptySendBtn) {
    emptySendBtn.addEventListener('click', () => {
      const searchModal = document.getElementById('search-modal');
      if (searchModal) {
        searchModal.classList.add('open');
        renderSearchUsersList('');
      }
    });
  }

  if (mobileBackBtn) {
    mobileBackBtn.addEventListener('click', () => {
      showDirectEmptyView(false);
    });
  }

  if (headerInfoBtn) {
    headerInfoBtn.addEventListener('click', () => {
      if (activeChatPartner) {
        openUserProfile(activeChatPartner);
      }
    });
  }

  if (textInput) {
    textInput.addEventListener('input', () => {
      const val = textInput.value.trim();
      if (submitBtn) {
        submitBtn.classList.toggle('hidden', val.length === 0);
      }
      if (sendHeartBtn) {
        sendHeartBtn.classList.toggle('hidden', val.length > 0);
      }
    });
  }

  if (sendHeartBtn) {
    sendHeartBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sendDirectChatMessage('❤️');
    });
  }

  if (emojiBtn) {
    emojiBtn.addEventListener('click', () => {
      const emojis = ['😊', '😂', '🔥', '❤️', '👍', '✨', '🙌', '😍'];
      const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
      if (textInput) {
        textInput.value += randomEmoji;
        textInput.focus();
        textInput.dispatchEvent(new Event('input'));
      }
    });
  }

  if (imgUploadBtn && imgFileInput) {
    imgUploadBtn.addEventListener('click', () => {
      imgFileInput.click();
    });

    imgFileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (loadEvent) => {
        sendDirectChatMessage(null, loadEvent.target.result);
        imgFileInput.value = '';
      };
      reader.readAsDataURL(file);
    });
  }

  if (sendForm) {
    sendForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendDirectChatMessage();
    });
  }
}

function renderDirectMessagesView() {
  const user = getCurrentUser();
  if (!user) return;

  const headerUserEl = document.getElementById('dm-header-current-username');
  if (headerUserEl) {
    headerUserEl.textContent = user.username;
  }

  const searchInput = document.getElementById('dm-search-input');
  renderDirectMessagesThreads(searchInput ? searchInput.value.trim() : '');

  const emptyPanel = document.getElementById('dm-empty-state-panel');
  const activePanel = document.getElementById('dm-active-chat-panel');

  if (activeChatPartner) {
    if (emptyPanel) emptyPanel.classList.add('hidden');
    if (activePanel) activePanel.classList.remove('hidden');
    document.body.classList.add('in-dm-chat');

    const partner = getUserByUsername(activeChatPartner);
    const partnerNameEl = document.getElementById('dm-header-partner-name');
    const partnerAvatarEl = document.getElementById('dm-header-partner-avatar');
    const partnerOnlineDot = document.getElementById('dm-header-online-dot');

    const isOnline = partner ? isUserOnline(partner) : false;
    if (partnerNameEl) partnerNameEl.textContent = partner ? (partner.fullName || partner.username) : activeChatPartner;
    if (partnerAvatarEl) partnerAvatarEl.src = partner ? partner.avatar : DEFAULT_AVATAR;
    if (partnerOnlineDot) partnerOnlineDot.classList.toggle('hidden', !isOnline);

    renderDirectChatMessages(activeChatPartner);
  } else {
    if (emptyPanel) emptyPanel.classList.remove('hidden');
    if (activePanel) activePanel.classList.add('hidden');
    document.body.classList.remove('in-dm-chat');
  }
}

function renderDirectMessagesThreads(filterQuery = '') {
  const container = document.getElementById('dm-threads-list');
  const user = getCurrentUser();
  if (!container || !user) return;

  const db = getDB();
  const q = (filterQuery || '').toLowerCase();
  const others = db.users.filter((u) => {
    if (u.username === user.username) return false;
    if (!q) return true;
    return u.username.toLowerCase().includes(q) || (u.fullName || '').toLowerCase().includes(q);
  });

  container.innerHTML = '';

  if (others.length === 0) {
    container.innerHTML = `
      <div style="padding:40px 20px; text-align:center; color:var(--text-muted); font-size:13px;">
        <p style="font-weight:700; color:var(--text-main); margin-bottom:6px;">Tidak ada obrolan ditemukan</p>
        <p>Gunakan tombol tulis pesan atau login dengan akun Google ke-2 di tab lain untuk mulai chat secara real-time.</p>
      </div>
    `;
    return;
  }

  others.forEach((other) => {
    const conversation = db.messages.filter(
      (m) =>
        (m.fromUsername === user.username && m.toUsername === other.username) ||
        (m.fromUsername === other.username && m.toUsername === user.username)
    );
    const lastMsg = conversation[conversation.length - 1];
    const unreadCount = conversation.filter((m) => m.toUsername === user.username && !m.read).length;
    const isOnline = isUserOnline(other);
    const isActive = activeChatPartner === other.username;

    let previewText = 'Mulai obrolan langsung';
    if (lastMsg) {
      if (lastMsg.imageUrl) {
        previewText = (lastMsg.fromUsername === user.username ? 'You: Sent a photo' : 'Sent a photo') + ` · ${formatRelativeTime(lastMsg.createdAt)}`;
      } else if (lastMsg.sharedPostId) {
        previewText = (lastMsg.fromUsername === user.username ? 'You sent an attachment' : `${other.username} sent an attachment`) + ` · ${formatRelativeTime(lastMsg.createdAt)}`;
      } else {
        const clean = (lastMsg.text || '').replace(/📷\s*/g, '').replace(/📸\s*/g, '').trim();
        const prefix = lastMsg.fromUsername === user.username ? 'You: ' : '';
        previewText = `${prefix}${clean} · ${formatRelativeTime(lastMsg.createdAt)}`;
      }
    }

    const item = document.createElement('div');
    item.className = `dm-thread-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <div class="dm-thread-avatar-wrap">
        <img src="${escapeAttr(other.avatar || DEFAULT_AVATAR)}" alt="${escapeAttr(other.username)}" />
        ${isOnline ? '<span class="msg-online-dot" style="bottom:1px; right:1px;" title="Sedang aktif"></span>' : ''}
      </div>
      <div class="dm-thread-info">
        <div class="dm-thread-name">${escapeHtml(other.fullName || other.username)}</div>
        <div class="dm-thread-preview ${unreadCount > 0 ? 'unread' : ''}">
          ${unreadCount > 0 ? `${unreadCount} new messages · ` : ''}${escapeHtml(previewText)}
        </div>
      </div>
      ${unreadCount > 0 ? '<span class="dm-thread-unread-dot"></span>' : ''}
    `;

    item.addEventListener('click', () => {
      openDirectChatWithUser(other.username);
    });

    container.appendChild(item);
  });
}

function openDirectChatWithUser(partnerUsername) {
  if (currentView !== 'messages') {
    switchMainView('messages');
  }

  activeChatPartner = partnerUsername;
  pushNavState('dm-chat-' + partnerUsername);

  const emptyPanel = document.getElementById('dm-empty-state-panel');
  const activePanel = document.getElementById('dm-active-chat-panel');
  if (emptyPanel) emptyPanel.classList.add('hidden');
  if (activePanel) activePanel.classList.remove('hidden');
  document.body.classList.add('in-dm-chat');

  const partner = getUserByUsername(partnerUsername);
  const partnerNameEl = document.getElementById('dm-header-partner-name');
  const partnerAvatarEl = document.getElementById('dm-header-partner-avatar');
  const partnerOnlineDot = document.getElementById('dm-header-online-dot');

  const isOnline = partner ? isUserOnline(partner) : false;
  if (partnerNameEl) partnerNameEl.textContent = partner ? (partner.fullName || partner.username) : partnerUsername;
  if (partnerAvatarEl) partnerAvatarEl.src = partner ? partner.avatar : DEFAULT_AVATAR;
  if (partnerOnlineDot) partnerOnlineDot.classList.toggle('hidden', !isOnline);

  renderDirectChatMessages(partnerUsername);

  document.querySelectorAll('.dm-thread-item').forEach((item) => {
    const isThis = item.querySelector('.dm-thread-name')?.textContent.includes(partnerUsername);
    item.classList.toggle('active', !!isThis);
  });

  const textInput = document.getElementById('dm-chat-text-input');
  if (textInput) {
    textInput.focus();
  }
}

function showDirectEmptyView(fromBack = false) {
  const hadPartner = !!activeChatPartner;
  activeChatPartner = null;

  const emptyPanel = document.getElementById('dm-empty-state-panel');
  const activePanel = document.getElementById('dm-active-chat-panel');
  if (emptyPanel) emptyPanel.classList.remove('hidden');
  if (activePanel) activePanel.classList.add('hidden');
  document.body.classList.remove('in-dm-chat');

  document.querySelectorAll('.dm-thread-item').forEach((item) => {
    item.classList.remove('active');
  });

  if (hadPartner && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}

function renderDirectChatMessages(partnerUsername) {
  const container = document.getElementById('dm-chat-messages-container');
  const user = getCurrentUser();
  if (!container || !user) return;

  const db = getDB();
  const partner = getUserByUsername(partnerUsername);

  let hasUnread = false;
  const conversation = db.messages.filter((m) => {
    const isPair =
      (m.fromUsername === user.username && m.toUsername === partnerUsername) ||
      (m.fromUsername === partnerUsername && m.toUsername === user.username);
    if (isPair && m.toUsername === user.username && !m.read) {
      m.read = true;
      hasUnread = true;
    }
    return isPair;
  });

  if (hasUnread) {
    saveDB(db);
    renderFloatingMessagesPill();
  }

  container.innerHTML = '';

  if (conversation.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:60px 20px; color:var(--text-muted); font-size:13px;">
        <img src="${escapeAttr(partner ? partner.avatar : DEFAULT_AVATAR)}" style="width:72px; height:72px; border-radius:50%; object-fit:cover; margin-bottom:12px;" />
        <h3 style="font-size:16px; font-weight:700; color:var(--text-main); margin-bottom:4px;">${escapeHtml(partner ? (partner.fullName || partner.username) : partnerUsername)}</h3>
        <p style="margin-bottom:14px;">@${escapeHtml(partnerUsername)} · Gramify</p>
        <p>Kirim pesan untuk memulai obrolan dengan <strong>@${escapeHtml(partnerUsername)}</strong>.</p>
      </div>
    `;
    return;
  }

  let lastDateStr = null;

  conversation.forEach((msg) => {
    const timeFormatted = formatClockTime(msg.createdAt);
    if (timeFormatted !== lastDateStr) {
      lastDateStr = timeFormatted;
      const timeDiv = document.createElement('div');
      timeDiv.className = 'dm-timestamp-pill';
      timeDiv.textContent = timeFormatted;
      container.appendChild(timeDiv);
    }

    const isSent = msg.fromUsername === user.username;
    const row = document.createElement('div');
    row.className = `dm-message-row ${isSent ? 'sent' : 'received'}`;

    if (!isSent) {
      const partnerMiniAvatar = document.createElement('img');
      partnerMiniAvatar.src = partner ? partner.avatar : DEFAULT_AVATAR;
      partnerMiniAvatar.alt = '';
      partnerMiniAvatar.style.cssText = 'width:28px; height:28px; border-radius:50%; object-fit:cover; margin-bottom:4px; flex-shrink:0;';
      row.appendChild(partnerMiniAvatar);
    }

    const sharedPost = msg.sharedPostId ? db.posts.find((p) => p.id === msg.sharedPostId) : null;

    if (sharedPost) {
      const cardWrap = document.createElement('div');
      cardWrap.className = 'dm-shared-post-card';
      cardWrap.innerHTML = `
        <div class="dm-shared-post-header">
          <img src="${escapeAttr(sharedPost.authorAvatar || DEFAULT_AVATAR)}" class="dm-shared-author-avatar" alt="" />
          <span class="dm-shared-author-name">${escapeHtml(sharedPost.authorUsername)}</span>
        </div>
        <div class="dm-shared-post-thumb">
          <img src="${escapeAttr(sharedPost.imageUrl)}" alt="Postingan" />
          ${sharedPost.caption ? `<div class="dm-shared-post-caption-overlay">${escapeHtml(sharedPost.caption.slice(0, 75))}${sharedPost.caption.length > 75 ? '...' : ''}</div>` : ''}
        </div>
        <div class="dm-heart-reaction-badge" title="Disukai">❤️</div>
      `;
      cardWrap.addEventListener('click', () => {
        openPostDetailModal(sharedPost.id);
      });
      row.appendChild(cardWrap);
    } else if (msg.imageUrl) {
      const imgBubble = document.createElement('div');
      imgBubble.className = `dm-chat-bubble ${isSent ? 'sent' : 'received'}`;
      imgBubble.style.padding = '4px';
      imgBubble.innerHTML = `
        <img src="${escapeAttr(msg.imageUrl)}" alt="Foto" style="max-width:260px; max-height:320px; border-radius:16px; display:block; object-fit:cover;" />
      `;
      row.appendChild(imgBubble);
    } else {
      const cleanText = (msg.text || '').replace(/📷\s*/g, '').replace(/📸\s*/g, '').trim();
      const bubble = document.createElement('div');
      bubble.className = `dm-chat-bubble ${isSent ? 'sent' : 'received'}`;
      if (cleanText === '❤️') {
        bubble.style.cssText = 'background:none; border:none; font-size:42px; padding:0; line-height:1;';
        bubble.textContent = '❤️';
      } else {
        bubble.textContent = cleanText;
      }
      row.appendChild(bubble);
    }

    container.appendChild(row);
  });

  container.scrollTop = container.scrollHeight;
}

function sendDirectChatMessage(customText = null, customImageUrl = null) {
  const user = getCurrentUser();
  if (!user || !activeChatPartner) return;

  const textInput = document.getElementById('dm-chat-text-input');
  const text = customText !== null ? customText : (textInput ? textInput.value.trim() : '');
  const imageUrl = customImageUrl || null;

  if (!text && !imageUrl) return;

  const db = getDB();
  db.messages.push({
    id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    fromUsername: user.username,
    toUsername: activeChatPartner,
    text: text || '',
    imageUrl: imageUrl || null,
    createdAt: Date.now(),
    read: false
  });

  saveDB(db);

  if (textInput && customText === null) {
    textInput.value = '';
    const submitBtn = document.getElementById('dm-submit-btn');
    const sendHeartBtn = document.getElementById('dm-send-heart-btn');
    if (submitBtn) submitBtn.classList.add('hidden');
    if (sendHeartBtn) sendHeartBtn.classList.remove('hidden');
  }

  renderDirectChatMessages(activeChatPartner);
  const searchInput = document.getElementById('dm-search-input');
  renderDirectMessagesThreads(searchInput ? searchInput.value.trim() : '');
}

function formatClockTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  let hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}


function renderRightSuggestions() {
  const container = document.getElementById('right-suggestions-list');
  const user = getCurrentUser();
  if (!container || !user) return;

  const db = getDB();
  const others = db.users.filter((u) => u.username !== user.username);

  container.innerHTML = '';
  if (others.length === 0) {
    container.innerHTML = `<p style="font-size:12px; color:var(--text-muted);">Pengguna lain yang login dengan akun Google akan muncul di sini.</p>`;
    return;
  }

  others.slice(0, 5).forEach((other) => {
    const isFollowing = (user.following || []).includes(other.username);
    const isOnline = isUserOnline(other);
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.innerHTML = `
      <div class="user-mini-info" data-profile-user="${escapeAttr(other.username)}" style="cursor:pointer;" title="Lihat profil @${escapeAttr(other.username)}">
        <div style="position:relative; display:inline-block; flex-shrink:0;">
          <img src="${escapeAttr(other.avatar)}" alt="${escapeAttr(other.username)}" class="avatar-md" />
          ${isOnline ? '<span class="msg-online-dot" style="width:9px; height:9px; border-width:1.5px;"></span>' : ''}
        </div>
        <div class="user-text">
          <span class="user-handle">${escapeHtml(other.username)}</span>
          <span class="user-subtext">${escapeHtml(other.fullName)}</span>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button type="button" class="follow-btn ${isFollowing ? 'following' : ''}" data-target="${escapeAttr(other.username)}">
          ${isFollowing ? 'Following' : 'Follow'}
        </button>
      </div>
    `;

    item.querySelector('.follow-btn').addEventListener('click', () => {
      handleToggleFollow(other.username);
    });

    container.appendChild(item);
  });
}

function closeSearchModal(fromBack = false) {
  const modal = document.getElementById('search-modal');
  const wasOpen = modal && modal.classList.contains('open');
  if (modal) modal.classList.remove('open');
  if (wasOpen && !fromBack) {
    notifyModalClosedProgrammatically();
  }
}

function initSearchModal() {
  const openBtns = document.querySelectorAll('.open-search-btn');
  const modal = document.getElementById('search-modal');
  const closeBtn = document.getElementById('search-modal-close');
  const input = document.getElementById('user-search-input');

  openBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      closeMessagesPopup(true);
      const wasOpen = modal.classList.contains('open');
      modal.classList.add('open');
      if (!wasOpen) {
        pushNavState('search-modal');
      }
      renderSearchUsersList(input ? input.value : '');
      if (input) input.focus();
    });
  });

  if (closeBtn) closeBtn.addEventListener('click', () => closeSearchModal(false));
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSearchModal(false);
    });
  }
  if (input) {
    input.addEventListener('input', (e) => {
      renderSearchUsersList(e.target.value);
    });
  }
}

function renderSearchUsersList(query) {
  const container = document.getElementById('search-results-container');
  const user = getCurrentUser();
  if (!container || !user) return;

  const q = (query || '').toLowerCase().trim();
  const db = getDB();
  const matched = db.users.filter(
    (u) =>
      u.username !== user.username &&
      (u.username.toLowerCase().includes(q) || u.fullName.toLowerCase().includes(q))
  );

  container.innerHTML = '';
  if (matched.length === 0) {
    container.innerHTML = `<p style="font-size:13px; color:var(--text-muted); text-align:center; padding:20px 0;">Tidak ada pengguna lain ditemukan.</p>`;
    return;
  }

  matched.forEach((other) => {
    const isFollowing = (user.following || []).includes(other.username);
    const row = document.createElement('div');
    row.className = 'suggestion-item';
    row.style.marginBottom = '0';
    row.innerHTML = `
      <div class="user-mini-info" style="cursor:pointer;" title="Lihat profil @${escapeAttr(other.username)}">
        <img src="${escapeAttr(other.avatar)}" alt="" class="avatar-md" />
        <div class="user-text">
          <span class="user-handle">${escapeHtml(other.username)}</span>
          <span class="user-subtext">${escapeHtml(other.fullName)}</span>
        </div>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <button type="button" class="chat-from-search-btn" style="font-size:12px; font-weight:600; padding:6px 10px; border:1px solid var(--border-color); border-radius:8px;">Chat</button>
        <button type="button" class="follow-btn ${isFollowing ? 'following' : ''}">${isFollowing ? 'Following' : 'Follow'}</button>
      </div>
    `;

    row.querySelector('.user-mini-info').addEventListener('click', () => {
      document.getElementById('search-modal').classList.remove('open');
      openUserProfile(other.username);
    });

    row.querySelector('.follow-btn').addEventListener('click', () => {
      handleToggleFollow(other.username);
      renderSearchUsersList(query);
    });
    row.querySelector('.chat-from-search-btn').addEventListener('click', () => {
      document.getElementById('search-modal').classList.remove('open');
      openDirectChatWithUser(other.username);
    });

    container.appendChild(row);
  });
}


function readImageFileAsDataUrl(file, maxSize) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = maxSize;
        canvas.height = maxSize;
        const ctx = canvas.getContext('2d');
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, maxSize, maxSize);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function formatRelativeTime(timestamp) {
  const diffSec = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'Baru saja';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}
