// Telão — cliente. Cada transmissão é uma conexão WebRTC de quem transmite
// para cada pessoa que clicou em "Assistir" (um para vários).
(() => {
  'use strict';

  const QUALITY = {
    '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
    '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
    '720p60': { width: 1280, height: 720, fps: 60, bitrate: 4_000_000 },
    '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
    '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: 12_000_000 },
  };
  const MIN_BITRATE = 400_000;
  const SHARE_LABEL = { screen: 'Compartilhar tela', game: 'Transmitir jogo', rubinot: 'Transmitir RubinOT', camera: 'Transmitir câmera' };

  const $ = (id) => document.getElementById(id);
  const el = {
    sidebar: $('sidebar'), roomList: $('roomList'), newRoomForm: $('newRoomForm'), newRoomInput: $('newRoomInput'),
    selfAvatar: $('selfAvatar'), selfName: $('selfName'), selfStatus: $('selfStatus'), logoutBtn: $('logoutBtn'),
    roomTitle: $('roomTitle'), roomMeta: $('roomMeta'), grid: $('grid'), empty: $('emptyState'),
    controls: $('controls'), quality: $('quality'), shareBtn: $('shareBtn'), leaveBtn: $('leaveBtn'),
    loginModal: $('loginModal'), discordLogin: $('discordLogin'), orDivider: $('orDivider'), guestForm: $('guestForm'),
    guestName: $('guestName'), codeWrap: $('codeWrap'), accessCode: $('accessCode'), loginError: $('loginError'),
    toast: $('toast'), openSidebar: $('openSidebar'), closeSidebar: $('closeSidebar'),
    headActions: $('headActions'), inviteBtn: $('inviteBtn'), soundBtn: $('soundBtn'), chatBtn: $('chatBtn'), unread: $('unread'),
    chat: $('chat'), chatTitle: $('chatTitle'), closeChat: $('closeChat'), chatList: $('chatList'), chatForm: $('chatForm'),
    chatInput: $('chatInput'), source: $('source'), camera: $('camera'),
  };

  const state = {
    config: null,
    identity: null, // { name, avatar, discord }
    code: '',
    room: null,
    selfId: null,
    members: [],
    lobby: {},
    localStream: null,
    outPeers: new Map(), // viewerId -> RTCPeerConnection (eu transmito)
    inPeers: new Map(), // streamerId -> { pc, stream } (eu assisto)
    relayViewers: new Set(), // viewerIds que me assistem pelo servidor (sem WebRTC)
    inRelay: new Map(), // streamerId -> vídeo que recebo pelo servidor
    watching: new Set(), // streamerIds que pedi para assistir
    focus: null, // id do bloco ampliado
    volumes: new Map(),
    iceServers: null, // recebidos ao entrar na sala (podem incluir TURN)
    shareGen: 0, // muda ao trocar/sair de sala; invalida capturas em andamento
    sharing: false, // seletor de tela aberto
    viewerNames: new Map(), // viewerId -> nome (quem me assiste)
    chatOpen: window.innerWidth > 760,
    unread: 0,
    sound: true,
    localMode: 'screen',
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* sem armazenamento */ } },
  };

  const socket = io({ autoConnect: false });

  // Dentro de uma Atividade do Discord não existe WebRTC: o vídeo chega pelo
  // servidor (gravado em pedaços por quem transmite). "?modo=servidor" força
  // esse caminho também no navegador (útil para testar ou para redes difíceis).
  const query = new URLSearchParams(location.search);
  const inActivity = location.hostname.endsWith('.discordsays.com') || query.has('frame_id');
  const forceRelay = query.get('modo') === 'servidor';
  const useRelay = () => inActivity || forceRelay || !window.RTCPeerConnection;
  let apiBase = ''; // vira "/.proxy" se a Atividade só responder por esse caminho
  let sdk = null; // SDK do Discord (só na Atividade)
  if (inActivity) {
    // Na Atividade só dá para assistir e conversar: os textos não falam em transmitir.
    document.documentElement.classList.add('activity');
    const intro = document.querySelector('#loginModal .muted');
    if (intro) intro.textContent = 'Assista às telas dos amigos sem sair do Discord.';
    const emptyText = document.querySelector('#emptyState p');
    if (emptyText) emptyText.textContent = 'Entre numa sala na lista ao lado para assistir.';
  } else if (window.TELAO_STATIC_CONFIG) {
    const emptyText = document.querySelector('#emptyState p');
    if (emptyText) emptyText.innerHTML = 'Só <b>uma</b> pessoa cria a sala e clica em <b>Convidar</b>. Os outros abrem esse convite (ou colam ele no campo ao lado).';
    const input = document.getElementById('newRoomInput');
    if (input) { input.placeholder = '+ criar sala ou colar convite'; input.maxLength = 200; }
  }

  // Pasta onde o Telão está publicado ("/" no servidor, "/telao/" no GitHub Pages).
  const BASE_PATH = location.pathname.replace(/[^/]*$/, '') || '/';

  function setUrl(room) {
    if (inActivity) return; // na Atividade o endereço carrega dados do Discord
    const p = new URLSearchParams();
    if (room) p.set('sala', room);
    if (forceRelay) p.set('modo', 'servidor');
    history.replaceState(null, '', `${BASE_PATH}${p.toString() ? `?${p}` : ''}`);
  }

  // ---------- ajudantes ----------

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
  }

  function colorFor(name) {
    const palette = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6'];
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return palette[h % palette.length];
  }

  function avatarEl(member, size) {
    const a = document.createElement('div');
    a.className = `avatar ${size || ''}`;
    if (member.avatar) {
      a.style.backgroundImage = `url("${member.avatar.replace(/"/g, '')}")`;
    } else {
      a.style.backgroundColor = colorFor(member.name || '?');
      a.textContent = (member.name || '?').trim().charAt(0).toUpperCase();
    }
    return a;
  }

  function svgIcon(paths) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = paths;
    return s;
  }
  const ICON_SCREEN = '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>';
  const ICON_EYE = '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';

  function slug(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  }

  // ---------- entrada ----------

  async function fetchConfig() {
    // Versão sem servidor (site estático): a configuração vem do p2p.js.
    if (window.TELAO_STATIC_CONFIG) return window.TELAO_STATIC_CONFIG;
    let lastErr;
    for (const base of inActivity ? ['', '/.proxy'] : ['']) {
      try {
        const res = await fetch(`${base}/api/config`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();
        apiBase = base;
        return cfg;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`não carregou ${src}`));
      document.head.append(s);
    });
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('tempo esgotado')), ms))]);
  }

  // Na Atividade o Discord já sabe quem é a pessoa: pede a autorização e troca
  // pelo nome/foto no servidor. Se algo falhar, a pessoa entra como convidada.
  async function activityLogin(cfg) {
    const fromHost = /^(\d{15,22})\./.exec(location.hostname)?.[1];
    const clientId = fromHost || cfg.discordClientId || '';
    if (!/^\d{15,22}$/.test(clientId)) return;
    await loadScript('vendor/discord-sdk.js');
    sdk = new window.DiscordSDK(clientId);
    await withTimeout(sdk.ready(), 10000);
    if (!cfg.discordLogin) return;
    const { code } = await sdk.commands.authorize({
      client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'],
    });
    const res = await fetch(`${apiBase}/api/activity/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = await res.json();
    if (!out?.token || !out.user) throw new Error('resposta inválida');
    socket.auth = { token: out.token };
    cfg.user = out.user;
  }

  async function boot() {
    try {
      state.config = await fetchConfig();
    } catch {
      el.loginError.textContent = 'Servidor indisponível. Tente recarregar a página.';
      el.loginModal.hidden = false;
      return;
    }
    const cfg = state.config;
    if (apiBase) socket.io.opts.path = `${apiBase}/socket.io`;
    if (inActivity) {
      try { await activityLogin(cfg); } catch (err) { console.warn('[atividade]', err); }
    }
    el.discordLogin.hidden = !cfg.discordLogin;
    el.orDivider.hidden = !cfg.discordLogin || cfg.requireDiscordLogin;
    el.codeWrap.hidden = !cfg.accessCodeRequired;
    el.guestName.value = store.get('telao_name') || '';
    state.code = store.get('telao_code') || '';
    const params = new URLSearchParams(location.search);
    if (params.get('codigo')) {
      state.code = params.get('codigo').slice(0, 64);
      store.set('telao_code', state.code);
      params.delete('codigo');
      if (!inActivity) history.replaceState(null, '', `${BASE_PATH}${params.toString() ? `?${params}` : ''}`);
    }
    el.accessCode.value = state.code;
    state.sound = store.get('telao_som') !== '0';

    if (cfg.user) {
      state.identity = { name: cfg.user.name, avatar: cfg.user.avatar, discord: true };
      // Com login Discord, o formulário só pede o código (se houver).
      el.guestName.hidden = true;
      el.guestForm.querySelector('label[for=guestName]').hidden = true;
      el.discordLogin.hidden = true;
      el.orDivider.hidden = true;
      if (!cfg.accessCodeRequired || state.code) return start();
    } else if (cfg.requireDiscordLogin) {
      el.guestForm.hidden = true;
      if (inActivity) el.loginError.textContent = 'Não foi possível entrar com o Discord por aqui. Feche e abra a atividade de novo.';
    } else if (el.guestName.value && (!cfg.accessCodeRequired || state.code)) {
      state.identity = { name: el.guestName.value, avatar: null, discord: false };
      return start();
    }
    el.loginModal.hidden = false;
    (el.guestName.hidden ? el.accessCode : el.guestName).focus();
  }

  el.guestForm.addEventListener('submit', (e) => {
    e.preventDefault();
    el.loginError.textContent = '';
    if (!state.config?.user) {
      const name = el.guestName.value.trim();
      if (!name) { el.loginError.textContent = 'Escolha um nome.'; return; }
      state.identity = { name, avatar: null, discord: false };
      store.set('telao_name', name);
    }
    state.code = el.accessCode.value;
    if (state.code) store.set('telao_code', state.code);
    start();
  });

  function sendAuth() {
    if (!state.identity || !socket.connected) return;
    socket.emit('auth', { code: state.code }, (res) => {
      if (!res?.error) return;
      if (/código/i.test(res.error)) store.del('telao_code');
      el.loginError.textContent = res.error;
      el.loginModal.hidden = false;
    });
  }

  function start() {
    el.loginModal.hidden = true;
    renderSelf();
    if (!socket.connected) socket.connect();
    else sendAuth();
    const wanted = slug(new URLSearchParams(location.search).get('sala') || store.get('telao_room')
      || (inActivity ? state.config.rooms?.[0] : '') || '');
    if (wanted) joinRoom(wanted);
  }

  el.logoutBtn.addEventListener('click', async () => {
    await leaveRoom();
    store.del('telao_name');
    store.del('telao_code');
    if (state.config?.user) await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    location.href = BASE_PATH;
  });

  function renderSelf() {
    const id = state.identity || { name: '—' };
    el.selfAvatar.replaceWith((el.selfAvatar = avatarEl(id, 'sm')));
    el.selfAvatar.id = 'selfAvatar';
    el.selfName.textContent = id.name;
    if (!socket.connected) {
      el.selfStatus.textContent = 'conectando…';
      el.selfStatus.className = 'user-status';
    } else if (state.room) {
      el.selfStatus.textContent = state.localStream ? `transmitindo em #${state.room}` : `em #${state.room}`;
      el.selfStatus.className = 'user-status on';
    } else {
      el.selfStatus.textContent = 'online';
      el.selfStatus.className = 'user-status';
    }
  }

  // ---------- salas ----------

  function joinRoom(room) {
    if (!state.identity) { el.loginModal.hidden = false; return; }
    if (room === state.room) return;
    socket.emit('join', { room, name: state.identity.name, code: state.code }, (res) => {
      if (res?.error) {
        toast(res.error);
        if (/código/i.test(res.error)) {
          store.del('telao_code');
          el.loginError.textContent = res.error;
          el.loginModal.hidden = false;
        }
        if (/Discord/.test(res.error)) el.loginModal.hidden = false;
        return;
      }
      resetMedia({ keepLocal: false });
      state.shareGen++;
      state.room = room;
      state.selfId = res.self.id;
      state.iceServers = res.iceServers || null;
      state.focus = null;
      store.set('telao_room', room);
      setUrl(room);
      el.controls.hidden = false;
      el.headActions.hidden = false;
      // Na Atividade, sem endereço público o convite levaria a um link que não abre fora do Discord.
      el.inviteBtn.hidden = inActivity && !state.config?.publicUrl;
      el.chat.hidden = !state.chatOpen;
      el.sidebar.classList.remove('open');
      state.viewerNames.clear();
      loadChat(res.chat || []);
      renderAll();
    });
  }

  async function leaveRoom() {
    state.shareGen++;
    if (!state.room) { resetMedia({ keepLocal: false }); return; }
    resetMedia({ keepLocal: false });
    socket.emit('leave');
    state.room = null;
    state.members = [];
    state.focus = null;
    store.del('telao_room');
    setUrl(null);
    el.controls.hidden = true;
    el.headActions.hidden = true;
    el.chat.hidden = true;
    el.chatList.replaceChildren();
    renderAll();
  }

  el.leaveBtn.addEventListener('click', leaveRoom);

  el.newRoomForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const typed = el.newRoomInput.value.trim();
    // Colou o convite inteiro? Entra exatamente na sala dele.
    const fromLink = /[?&]sala=([a-z0-9-]{1,24})/i.exec(typed)?.[1];
    let room = slug(fromLink || typed);
    if (!room) { toast('Use letras, números ou hífen.'); return; }
    // Sem servidor, o nome da sala é o que protege a entrada: sala NOVA ganha um
    // final aleatório. Convite colado ou nome já com final (ex. jogos-3fa9c1) entra igual.
    const exact = fromLink || /-[0-9a-f]{6}$/.test(room);
    if (state.config?.p2p && !exact) {
      const tag = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
      room = `${room.slice(0, 17).replace(/-+$/, '')}-${tag}`;
    }
    el.newRoomInput.value = '';
    joinRoom(room);
  });

  el.openSidebar.addEventListener('click', () => el.sidebar.classList.add('open'));
  el.closeSidebar.addEventListener('click', () => el.sidebar.classList.remove('open'));

  // ---------- transmitir ----------

  const canScreen = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const canCam = Boolean(navigator.mediaDevices?.getUserMedia);
  const canShare = canScreen || canCam;
  if (!canScreen) {
    // Celular: dá para assistir e transmitir a câmera, mas não a tela.
    for (const opt of [...el.source.options]) if (opt.value !== 'camera') opt.remove();
    el.source.value = 'camera';
  }
  if (!canShare) {
    el.shareBtn.disabled = true;
    el.shareBtn.title = 'Este aparelho não permite transmitir (dá para assistir).';
    el.quality.hidden = true;
    el.source.hidden = true;
  }

  let gameTipShown = false;
  let rubinotTipShown = false;
  el.source.addEventListener('change', async () => {
    const mode = el.source.value;
    if (mode === 'game' && QUALITY[el.quality.value].fps < 60) el.quality.value = '1080p60';
    if (mode === 'rubinot') el.quality.value = '1080p30';
    el.camera.hidden = mode !== 'camera';
    if (mode === 'camera') await listCameras();
    if (mode === 'game' && !gameTipShown) {
      gameTipShown = true;
      toast('Dica para jogos: escolha "Tela inteira" (funciona com jogo em tela cheia) e marque "Compartilhar áudio do sistema".');
    }
    if (mode === 'rubinot' && !rubinotTipShown) {
      rubinotTipShown = true;
      toast('RubinOT: escolha a aba "Janela" e clique no RubinOT. Quer o som do jogo junto? Escolha "Tela inteira" e marque "Compartilhar áudio do sistema".');
    }
    renderAll();
  });

  async function listCameras() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const keep = el.camera.value;
      el.camera.replaceChildren();
      devices.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Câmera ${i + 1}`;
        el.camera.append(o);
      });
      if (!devices.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = 'Nenhuma câmera encontrada';
        el.camera.append(o);
      }
      if (keep && devices.some((d) => d.deviceId === keep)) el.camera.value = keep;
    } catch {
      /* sem permissão para listar */
    }
  }

  el.shareBtn.addEventListener('click', () => (state.localStream ? stopShare() : startShare()));

  async function startShare() {
    if (!state.room || state.sharing || state.localStream) return;
    const mode = el.source.value;
    const base = QUALITY[el.quality.value] || QUALITY['1080p30'];
    // RubinOT/Tibia: pouco movimento e muito texto; mais qualidade por quadro deixa nomes e chat legíveis.
    const q = mode === 'rubinot' ? { ...base, bitrate: Math.round(base.bitrate * 1.4) } : base;
    const room = state.room;
    const gen = state.shareGen;
    state.sharing = true;
    el.shareBtn.disabled = true;
    const video = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps, max: q.fps } };
    const rawAudio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream;
    try {
      if (mode === 'camera') {
        if (el.camera.value) video.deviceId = { exact: el.camera.value };
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: rawAudio });
        listCameras();
      } else {
        if (mode === 'rubinot') video.displaySurface = 'window';
        // Tela inteira primeiro: janelas com aceleração de vídeo (Discord, jogos) podem sair verdes ou pretas.
        if (mode === 'game' || mode === 'screen') video.displaySurface = 'monitor';
        stream = await navigator.mediaDevices.getDisplayMedia({
          video,
          audio: rawAudio,
          systemAudio: 'include',
          surfaceSwitching: 'include',
          selfBrowserSurface: 'exclude',
        });
      }
    } catch (err) {
      if (err?.name === 'NotAllowedError') {
        if (mode === 'camera') toast('Permissão da câmera negada. Libere no cadeado ao lado do endereço.');
      } else if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
        toast('Câmera não encontrada. Confira se ela está conectada e não está em uso por outro programa.');
      } else {
        toast(mode === 'camera' ? 'Não foi possível abrir a câmera.' : 'Não foi possível capturar a tela.');
      }
      return;
    } finally {
      state.sharing = false;
      el.shareBtn.disabled = !canShare;
    }
    // Trocou ou saiu da sala enquanto escolhia a tela: descarta a captura.
    if (state.room !== room || state.shareGen !== gen || state.localStream) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const track = stream.getVideoTracks()[0];
    const fluid = mode === 'rubinot' ? false : mode !== 'screen' || q.fps >= 60;
    if (track) {
      track.contentHint = mode === 'rubinot' ? 'text' : fluid ? 'motion' : 'detail';
      track.addEventListener('ended', stopShare);
      if (mode !== 'rubinot' && mode !== 'camera' && track.getSettings?.().displaySurface === 'window') {
        setTimeout(() => toast('Compartilhando uma janela. Se aparecer verde ou preto para os amigos, escolha Tela inteira.'), 400);
      }
    }
    state.localStream = stream;
    state.localQuality = q;
    state.localMode = mode;
    state.localFluid = fluid;
    socket.emit('stream-start');
    if (mode !== 'camera' && !stream.getAudioTracks().length) {
      toast(mode === 'rubinot'
        ? 'RubinOT ao vivo, sem som (janela não envia áudio). Para ter som, transmita a "Tela inteira" com "Compartilhar áudio do sistema".'
        : 'Transmitindo sem som. Para incluir o som, marque "Compartilhar áudio" ao escolher a tela.');
    }
    renderAll();
  }

  function stopShare() {
    if (!state.localStream) return;
    for (const pc of state.outPeers.values()) pc.close();
    state.outPeers.clear();
    stopRelay();
    state.relayViewers.clear();
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    if (state.focus === state.selfId) state.focus = null;
    socket.emit('stream-stop');
    renderAll();
  }

  function newPeer() {
    return new RTCPeerConnection({ iceServers: state.iceServers || state.config.iceServers });
  }

  function queueIce(pc) {
    pc._pending = [];
    pc._addIce = async (c) => {
      if (!pc.remoteDescription) { pc._pending.push(c); return; }
      try { await pc.addIceCandidate(c); } catch { /* candidato antigo */ }
    };
    pc._flushIce = async () => {
      const list = pc._pending.splice(0);
      for (const c of list) { try { await pc.addIceCandidate(c); } catch { /* ignora */ } }
    };
  }

  // VP9 comprime tela/texto melhor que H.264 com a mesma banda; mantém os outros como reserva.
  function preferScreenCodec(pc) {
    if (state.localMode === 'camera' || !window.RTCRtpSender?.getCapabilities) return;
    try {
      const caps = RTCRtpSender.getCapabilities('video')?.codecs || [];
      const rank = (c) => (/vp9/i.test(c.mimeType) ? 0 : /vp8/i.test(c.mimeType) ? 1 : /h264/i.test(c.mimeType) ? 2 : 3);
      const sorted = [...caps].sort((a, b) => rank(a) - rank(b));
      for (const t of pc.getTransceivers()) {
        if (t.sender.track?.kind === 'video' && t.setCodecPreferences) t.setCodecPreferences(sorted);
      }
    } catch {
      /* navegador sem suporte: usa o padrão */
    }
  }

  async function createOutPeer(viewerId) {
    if (!state.localStream) return;
    state.outPeers.get(viewerId)?.close();
    const pc = newPeer();
    queueIce(pc);
    state.outPeers.set(viewerId, pc);
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
    preferScreenCodec(pc);

    const q = state.localQuality;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = q.bitrate;
      p.encodings[0].maxFramerate = q.fps;
      p.degradationPreference = state.localFluid ? 'maintain-framerate' : 'maintain-resolution';
      sender.setParameters(p).catch(() => {});
      pc._video = sender;
      pc._bitrate = q.bitrate;
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('signal', { to: viewerId, data: { dir: 'toViewer', candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState) && state.outPeers.get(viewerId) === pc) {
        pc.close();
        state.outPeers.delete(viewerId);
        renderViewerCount();
      } else if (pc.connectionState === 'connected') {
        renderViewerCount();
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: viewerId, data: { dir: 'toViewer', sdp: pc.localDescription } });
    renderViewerCount();
  }

  // ---------- transmitir pelo servidor (para quem assiste na Atividade do Discord) ----------
  // Um gravador só (WebM VP8/Opus) atende todos os espectadores "pelo servidor".
  // Quando entra alguém novo o gravador recomeça, para o vídeo dele abrir do início.

  const RELAY_SLICE = 256 * 1024;
  const RELAY_BACKLOG = 6 * 1024 * 1024;
  let relayRec = null;
  let relayGen = 0;
  let relayTimer;
  let relayChain = Promise.resolve();
  let relayBitrate = 3_000_000;

  function stopRelay() {
    clearTimeout(relayTimer);
    relayGen++;
    const rec = relayRec;
    relayRec = null;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* já parado */ } }
  }

  function scheduleRelay(ms = 200) {
    clearTimeout(relayTimer);
    relayTimer = setTimeout(startRelay, ms);
  }

  function relayUnsupported() {
    socket.emit('relay-fail');
    state.relayViewers.clear();
    renderViewerCount();
    toast('Este navegador não consegue enviar o vídeo para quem está na Atividade do Discord. Use Chrome ou Edge.');
  }

  function dropRelayViewerLocal(viewerId) {
    if (state.relayViewers.delete(viewerId) && !state.relayViewers.size) stopRelay();
  }

  function startRelay() {
    stopRelay();
    const stream = state.localStream;
    if (!stream || !state.relayViewers.size || !socket.connected) return;
    const audio = stream.getAudioTracks().length > 0;
    const mimeType = `video/webm;codecs=vp8${audio ? ',opus' : ''}`;
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mimeType)) { relayUnsupported(); return; }
    let rec;
    try {
      rec = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: Math.min(state.localQuality.bitrate, relayBitrate),
        audioBitsPerSecond: 128_000,
      });
    } catch {
      relayUnsupported();
      return;
    }
    const gen = relayGen;
    relayRec = rec;
    socket.emit('relay-start', { gen, audio });
    rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      relayChain = relayChain.then(async () => {
        if (gen !== relayGen || !socket.connected) return;
        const buf = await e.data.arrayBuffer();
        if (gen !== relayGen || !socket.connected) return;
        for (let i = 0; i < buf.byteLength; i += RELAY_SLICE) {
          socket.emit('relay-chunk', { gen, data: buf.slice(i, i + RELAY_SLICE) });
        }
        // Internet de quem transmite não dá conta: baixa a qualidade e recomeça.
        const waiting = socket.io.engine?.transport?.ws?.bufferedAmount || 0;
        if (waiting > RELAY_BACKLOG) {
          relayBitrate = Math.max(500_000, Math.round(relayBitrate / 2));
          toast('Sua internet não está dando conta: baixei a qualidade para quem assiste pelo Discord.');
          stopRelay();
          scheduleRelay(3000);
        }
      }).catch(() => {});
    };
    rec.onerror = () => { if (gen === relayGen) scheduleRelay(2000); };
    rec.start(150);
  }

  // ---------- assistir ----------

  function watch(streamerId) {
    const relay = useRelay();
    if (relay && !window.MediaSource) {
      toast('Este aparelho não consegue assistir por aqui. Abra o Telão no navegador.');
      return;
    }
    state.watching.add(streamerId);
    state.focus = streamerId;
    socket.emit('watch', { streamerId, relay });
    renderAll();
  }

  function unwatch(streamerId) {
    state.watching.delete(streamerId);
    closeIn(streamerId);
    socket.emit('unwatch', { streamerId });
    if (state.focus === streamerId) state.focus = null;
    renderAll();
  }

  function closeIn(streamerId) {
    const entry = state.inPeers.get(streamerId);
    if (entry) entry.pc.close();
    state.inPeers.delete(streamerId);
    const r = state.inRelay.get(streamerId);
    if (r) {
      r.dead = true;
      state.inRelay.delete(streamerId);
      if (r.video && r.video.dataset.relay === r.url) {
        delete r.video.dataset.relay;
        r.video.removeAttribute('src');
        r.video.load();
      }
      URL.revokeObjectURL(r.url);
    }
  }

  // ---------- assistir pelo servidor (sem WebRTC) ----------

  const relayRetries = new Map(); // streamerId -> horários das últimas tentativas

  function pumpRelay(id, r) {
    if (r.dead || !r.sb || r.sb.updating || r.ms.readyState !== 'open') return;
    try {
      const v = r.video;
      // Mantém só os últimos segundos na memória.
      const b = r.sb.buffered;
      if (b.length) {
        const start = b.start(0);
        const end = b.end(b.length - 1);
        if (v && v.currentTime - start > 30) { r.sb.remove(0, v.currentTime - 10); return; }
        // Vídeo parado (som bloqueado, aba escondida): não deixa a memória encher.
        if (end - start > 45) { r.sb.remove(0, end - 15); return; }
      }
      const next = r.queue.shift();
      if (next) r.sb.appendBuffer(next);
    } catch {
      relayBroken(id, r);
    }
  }

  function relayBroken(id, r) {
    if (state.inRelay.get(id) !== r) return;
    closeIn(id);
    const now = Date.now();
    const tries = (relayRetries.get(id) || []).filter((t) => now - t < 60_000);
    if (tries.length >= 3 || !state.watching.has(id)) {
      relayRetries.delete(id);
      if (state.watching.has(id)) {
        toast('Não deu para manter o vídeo por aqui. Tente assistir de novo.');
        unwatch(id);
      }
      return;
    }
    tries.push(now);
    relayRetries.set(id, tries);
    setTimeout(() => {
      if (state.watching.has(id) && !state.inRelay.has(id) && socket.connected) socket.emit('watch', { streamerId: id, relay: true });
    }, 1500);
  }

  socket.on('relay-start', ({ from, gen, audio }) => {
    if (!state.watching.has(from)) return;
    closeIn(from);
    const mime = `video/webm; codecs="vp8${audio ? ',opus' : ''}"`;
    if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) {
      toast('Este aparelho não consegue assistir por aqui. Abra o Telão no navegador.');
      unwatch(from);
      return;
    }
    const ms = new MediaSource();
    const r = { gen, ms, url: URL.createObjectURL(ms), sb: null, queue: [], video: null, dead: false };
    state.inRelay.set(from, r);
    ms.addEventListener('sourceopen', () => {
      if (r.dead || r.sb) return;
      try {
        r.sb = ms.addSourceBuffer(mime);
        r.sb.addEventListener('updateend', () => pumpRelay(from, r));
        r.sb.addEventListener('error', () => relayBroken(from, r));
      } catch {
        relayBroken(from, r);
        return;
      }
      pumpRelay(from, r);
    });
    attachStream(from);
  });

  socket.on('relay-chunk', ({ from, gen, data }) => {
    const r = state.inRelay.get(from);
    if (!r || r.gen !== gen || !data) return;
    r.queue.push(data);
    if (r.queue.length > 400) { relayBroken(from, r); return; }
    pumpRelay(from, r);
  });

  socket.on('relay-dropped', ({ from, reason }) => {
    if (!state.watching.has(from)) return;
    toast(reason === 'slow' ? 'Sua internet não acompanhou o vídeo. Clique em "Assistir transmissão" para tentar de novo.'
      : reason === 'unsupported' ? 'Quem transmite precisa usar Chrome ou Edge para o vídeo chegar ao Discord.'
        : 'O vídeo foi interrompido. Clique em "Assistir transmissão" para tentar de novo.');
    state.watching.delete(from);
    closeIn(from);
    if (state.focus === from) state.focus = null;
    renderAll();
  });

  socket.on('relay-limit', () => {
    relayBitrate = Math.max(500_000, Math.round(relayBitrate / 2));
    state.relayViewers.clear();
    stopRelay();
    renderViewerCount();
    toast('O vídeo para o Discord passou do limite do servidor e foi interrompido. Quem assiste pode clicar em "Assistir transmissão" de novo.');
  });

  // Mantém quem assiste pelo servidor perto do "ao vivo" e pula buracos no vídeo.
  function relayTick() {
    for (const [id, r] of state.inRelay) {
      const v = r.video;
      if (!v || !v.buffered.length) continue;
      const b = v.buffered;
      const t = v.currentTime;
      const end = b.end(b.length - 1);
      let inside = false;
      let nextStart = null;
      for (let i = 0; i < b.length; i++) {
        if (t >= b.start(i) - 0.05 && t < b.end(i) - 0.05) inside = true;
        else if (b.start(i) > t && nextStart == null) nextStart = b.start(i);
      }
      const lag = end - t;
      if (lag > 2.5) v.currentTime = Math.max(end - 0.4, b.start(b.length - 1));
      else if (!inside && nextStart != null) v.currentTime = nextStart + 0.01;
      else v.playbackRate = lag > 1 ? 1.1 : 1;
      if (v.paused) v.play().catch(() => {});
      const badge = el.grid.querySelector(`[data-id="${CSS.escape(id)}"]`)?.querySelector('.net');
      if (badge && v.videoHeight) {
        badge.hidden = false;
        badge.className = 'net';
        badge.textContent = `${v.videoHeight}p · pequeno atraso`;
        badge.title = 'O vídeo chega passando pelo Telão (um pouco mais de atraso)';
      }
    }
  }

  async function handleOffer(from, sdp) {
    if (!state.watching.has(from)) return;
    closeIn(from);
    const pc = newPeer();
    queueIce(pc);
    const entry = { pc, stream: null };
    state.inPeers.set(from, entry);
    pc.ontrack = (e) => {
      entry.stream = e.streams[0] || new MediaStream([e.track]);
      attachStream(from);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('signal', { to: from, data: { dir: 'toStreamer', candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && state.inPeers.get(from)?.pc === pc) {
        toast('A conexão com a transmissão caiu. Tentando de novo…');
        socket.emit('watch', { streamerId: from });
      }
    };
    await pc.setRemoteDescription(sdp);
    await pc._flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { dir: 'toStreamer', sdp: pc.localDescription } });
  }

  function attachStream(streamerId) {
    const tile = el.grid.querySelector(`[data-id="${CSS.escape(streamerId)}"]`);
    const video = tile?.querySelector('video');
    if (!video) return;
    const play = () => {
      video.volume = state.volumes.get(streamerId) ?? 1;
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
        toast('Som bloqueado pelo navegador — clique no ícone de som da transmissão.');
      });
    };
    const r = state.inRelay.get(streamerId);
    if (r) {
      r.video = video;
      if (video.dataset.relay !== r.url) {
        video.srcObject = null;
        video.dataset.relay = r.url;
        video.src = r.url;
        play();
      }
      return;
    }
    const entry = state.inPeers.get(streamerId);
    if (!entry?.stream) return;
    if (video.srcObject !== entry.stream) {
      video.srcObject = entry.stream;
      play();
    }
  }

  // ---------- eventos do servidor ----------

  socket.on('connect', () => {
    renderSelf();
    sendAuth();
    // Reconexão: o id muda; entra de novo na sala.
    if (state.room) {
      const room = state.room;
      const wasStreaming = Boolean(state.localStream);
      state.room = null;
      socket.emit('join', { room, name: state.identity.name, code: state.code }, (res) => {
        if (res?.error) {
          // Na Atividade não há botão de entrar: a saída é abrir de novo.
          toast(inActivity ? 'Sua entrada expirou. Feche e abra a atividade de novo.' : res.error);
          resetMedia({ keepLocal: false });
          state.members = [];
          el.controls.hidden = true;
          renderAll();
          return;
        }
        state.iceServers = res.iceServers || null;
        for (const pc of state.outPeers.values()) pc.close();
        state.outPeers.clear();
        stopRelay();
        state.relayViewers.clear();
        for (const id of [...state.inPeers.keys(), ...state.inRelay.keys()]) closeIn(id);
        state.watching.clear();
        state.room = room;
        state.selfId = res.self.id;
        if (wasStreaming) socket.emit('stream-start');
        renderAll();
      });
    }
  });

  socket.on('disconnect', () => { renderSelf(); toast('Conexão perdida. Reconectando…'); });

  socket.on('lobby', (lobby) => { state.lobby = lobby; renderRooms(); });

  socket.on('room-state', ({ room, members }) => {
    if (room !== state.room) return;
    state.members = members;
    const live = new Set(members.filter((m) => m.streaming).map((m) => m.id));
    for (const id of [...state.watching]) {
      if (!live.has(id)) { state.watching.delete(id); closeIn(id); if (state.focus === id) state.focus = null; }
    }
    if (state.focus && state.focus !== state.selfId && !live.has(state.focus)) state.focus = null;
    renderAll();
  });

  socket.on('viewer-request', ({ viewerId, name, relay }) => {
    if (!state.localStream) return;
    state.viewerNames.set(viewerId, String(name || '').slice(0, 32));
    if (relay) {
      state.outPeers.get(viewerId)?.close();
      state.outPeers.delete(viewerId);
      state.relayViewers.add(viewerId);
      scheduleRelay();
      renderViewerCount();
      return;
    }
    dropRelayViewerLocal(viewerId);
    createOutPeer(viewerId).catch((e) => console.error(e));
  });

  socket.on('viewer-left', ({ viewerId }) => {
    state.outPeers.get(viewerId)?.close();
    state.outPeers.delete(viewerId);
    dropRelayViewerLocal(viewerId);
    state.viewerNames.delete(viewerId);
    renderViewerCount();
  });

  socket.on('stream-ended', ({ id }) => {
    if (state.watching.has(id)) toast('A transmissão terminou.');
    state.watching.delete(id);
    closeIn(id);
    if (state.focus === id) state.focus = null;
    renderAll();
  });

  socket.on('peer-left', ({ id }) => {
    state.outPeers.get(id)?.close();
    state.outPeers.delete(id);
    dropRelayViewerLocal(id);
    state.viewerNames.delete(id);
    renderViewerCount();
    state.watching.delete(id);
    closeIn(id);
    if (state.focus === id) state.focus = null;
  });

  socket.on('signal', async ({ from, data }) => {
    try {
      if (data.dir === 'toViewer') {
        if (data.sdp?.type === 'offer') await handleOffer(from, data.sdp);
        else if (data.candidate) await state.inPeers.get(from)?.pc._addIce(data.candidate);
      } else if (data.dir === 'toStreamer') {
        const pc = state.outPeers.get(from);
        if (!pc) return;
        if (data.sdp?.type === 'answer') { await pc.setRemoteDescription(data.sdp); await pc._flushIce(); }
        else if (data.candidate) await pc._addIce(data.candidate);
      }
    } catch (err) {
      console.error('[sinal]', err);
    }
  });

  function resetMedia({ keepLocal }) {
    if (!keepLocal && state.localStream) stopShare();
    for (const id of [...state.inPeers.keys(), ...state.inRelay.keys()]) closeIn(id);
    state.watching.clear();
  }

  const isViewer = (id) => state.outPeers.has(id) || state.relayViewers.has(id);

  // ---------- desenho ----------

  function renderAll() {
    renderSelf();
    renderRooms();
    renderHeader();
    renderGrid();
    el.shareBtn.classList.toggle('on', Boolean(state.localStream));
    el.shareBtn.querySelector('span').textContent = state.localStream ? 'Parar transmissão' : SHARE_LABEL[el.source.value] || SHARE_LABEL.screen;
    el.quality.disabled = Boolean(state.localStream);
    el.source.disabled = Boolean(state.localStream);
    el.camera.disabled = Boolean(state.localStream);
    el.chatTitle.textContent = state.room ? `Chat de #${state.room}` : 'Chat';
    el.chatInput.placeholder = state.room ? `Conversar em #${state.room}` : 'Conversar';
  }

  function renderRooms() {
    const names = [...new Set([...(state.config?.rooms || []), ...Object.keys(state.lobby)])];
    if (state.room && !names.includes(state.room)) names.push(state.room);
    el.roomList.replaceChildren();
    for (const name of names) {
      const members = state.room === name && state.members.length ? state.members : state.lobby[name] || [];
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = `room${state.room === name ? ' active' : ''}`;
      btn.append(svgIcon(ICON_SCREEN));
      const nm = document.createElement('span');
      nm.className = 'room-name';
      nm.textContent = name;
      btn.append(nm);
      if (members.some((m) => m.streaming)) {
        const l = document.createElement('span'); l.className = 'live'; l.textContent = 'AO VIVO'; btn.append(l);
      }
      btn.addEventListener('click', () => joinRoom(name));
      const row = document.createElement('div');
      row.className = 'room-row';
      row.append(btn);
      const isDefault = (state.config?.rooms || []).includes(name);
      if (!isDefault && !members.length && name !== state.room) {
        const del = document.createElement('button');
        del.className = 'room-del';
        del.title = `Apagar a sala ${name}`;
        del.setAttribute('aria-label', `Apagar a sala ${name}`);
        del.textContent = '🗑';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          socket.emit('room-delete', { room: name }, (res) => toast(res?.error || `Sala #${name} apagada.`));
        });
        row.append(del);
      }
      li.append(row);
      if (members.length) {
        const ul = document.createElement('ul');
        ul.className = 'room-members';
        for (const m of members) {
          const r = document.createElement('li');
          r.className = 'room-member';
          const t = document.createElement('span'); t.className = 'nm'; t.textContent = m.name;
          r.append(avatarEl(m, 'xs'), t);
          if (m.streaming) { const l = document.createElement('span'); l.className = 'live'; l.textContent = 'AO VIVO'; r.append(l); }
          ul.append(r);
        }
        li.append(ul);
      }
      el.roomList.append(li);
    }
  }

  function renderHeader() {
    if (!state.room) {
      el.roomTitle.textContent = 'Escolha uma sala';
      el.roomMeta.textContent = '';
      return;
    }
    el.roomTitle.textContent = state.room;
    const live = state.members.filter((m) => m.streaming).length;
    el.roomMeta.replaceChildren();
    const count = document.createElement('span');
    count.className = 'count-part';
    count.textContent = `· ${state.members.length} na sala${live ? ` · ${live} ao vivo` : ''} `;
    el.roomMeta.append(count);
    const watchedNames = state.members.filter((m) => state.watching.has(m.id)).map((m) => m.name);
    const tag = document.createElement('span');
    tag.className = 'watching-tag';
    const names = [...state.viewerNames.entries()].filter(([id]) => isViewer(id)).map(([, n]) => n);
    if (state.localStream) tag.textContent = `· você está ao vivo (${names.length ? `assistindo: ${names.join(', ')}` : 'ninguém assistindo ainda'})`;
    else if (watchedNames.length) tag.textContent = `· assistindo ${watchedNames.join(', ')}`;
    else if (!live) { tag.className = 'watching-tag idle'; tag.textContent = '· ninguém transmitindo ainda'; }
    el.roomMeta.append(tag);
  }

  function viewerText() {
    const n = state.outPeers.size + state.relayViewers.size;
    return n === 1 ? '1 assistindo' : `${n} assistindo`;
  }

  function viewerTitle() {
    const names = [...state.viewerNames.entries()].filter(([id]) => isViewer(id)).map(([, n]) => n);
    return names.length ? `Assistindo: ${names.join(', ')}` : 'Ninguém assistindo ainda';
  }

  function renderViewerCount() {
    const badge = el.grid.querySelector('.viewers');
    if (badge) { badge.textContent = `👁 ${viewerText()}`; badge.title = viewerTitle(); }
    renderHeader();
  }

  function renderGrid() {
    // Guarda vídeos já tocando para não reiniciar.
    const keep = new Map();
    for (const v of el.grid.querySelectorAll('video')) keep.set(v.dataset.for, v);

    el.grid.replaceChildren();
    const inRoom = Boolean(state.room);
    el.empty.hidden = inRoom && state.members.length > 0;
    if (!inRoom) {
      el.empty.querySelector('h2').textContent = 'Escolha uma sala';
      el.empty.querySelector('p').innerHTML = inActivity
        ? 'Entre numa sala na lista ao lado para assistir.'
        : 'Entre numa sala na lista ao lado e clique em <b>Compartilhar tela</b>.';
      return;
    }

    const ordered = [...state.members].sort((a, b) => Number(b.streaming) - Number(a.streaming));
    const tiles = ordered.map((m) => buildTile(m, keep));
    const focusTile = state.focus && tiles.find((t) => t.dataset.id === state.focus);

    el.grid.classList.toggle('focus', Boolean(focusTile));
    if (focusTile) {
      el.grid.append(focusTile);
      const strip = document.createElement('div');
      strip.className = 'strip';
      for (const t of tiles) if (t !== focusTile) strip.append(t);
      if (strip.childElementCount) el.grid.append(strip);
    } else {
      el.grid.append(...tiles);
    }
    for (const id of [...state.inPeers.keys(), ...state.inRelay.keys()]) attachStream(id);
  }

  function buildTile(m, keep) {
    const tile = document.createElement('div');
    tile.className = `tile${m.streaming ? ' is-live' : ''}${m.id === state.selfId ? ' self' : ''}`;
    tile.dataset.id = m.id;
    const isSelf = m.id === state.selfId;

    const label = document.createElement('div');
    label.className = 'label';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = isSelf ? `${m.name} (você)` : m.name;
    label.append(nm);
    if (m.streaming) { const l = document.createElement('span'); l.className = 'live'; l.textContent = 'AO VIVO'; label.prepend(l); }

    const tools = document.createElement('div');
    tools.className = 'tools';

    if (isSelf && state.localStream) {
      const v = keep.get('self') || document.createElement('video');
      v.dataset.for = 'self';
      v.muted = true; v.autoplay = true; v.playsInline = true;
      if (v.srcObject !== state.localStream) v.srcObject = state.localStream;
      tile.append(v);
      const viewers = document.createElement('div');
      viewers.className = 'viewers';
      viewers.textContent = `👁 ${viewerText()}`;
      viewers.title = viewerTitle();
      tile.append(viewers);
      tools.append(focusButton(m.id));
    } else if (m.streaming && state.watching.has(m.id)) {
      const v = keep.get(m.id) || document.createElement('video');
      v.dataset.for = m.id;
      v.autoplay = true; v.playsInline = true;
      tile.append(v);
      tools.append(volumeTool(m.id, v), focusButton(m.id), fullscreenButton(tile), stopWatchButton(m.id));
      const net = document.createElement('div');
      net.className = 'net';
      net.hidden = true;
      tile.append(net);
      if (!v.dataset.dbl) {
        v.dataset.dbl = '1';
        v.addEventListener('dblclick', () => { const t = v.closest('.tile'); if (t) toggleFullscreen(t); });
      }
    } else if (m.streaming) {
      const c = document.createElement('div');
      c.className = 'center';
      const b = document.createElement('button');
      b.className = 'btn watch';
      b.append(svgIcon(ICON_EYE), document.createTextNode('Assistir transmissão'));
      b.addEventListener('click', () => watch(m.id));
      c.append(avatarEl(m, 'lg'), b);
      tile.append(c);
    } else {
      const c = document.createElement('div');
      c.className = 'center';
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = isSelf && !inActivity ? 'Clique em "Compartilhar tela" para transmitir' : isSelf && !state.members.some((x) => x.streaming) ? 'Ninguém está transmitindo ainda' : 'Na sala';
      c.append(avatarEl(m, 'lg'), hint);
      tile.append(c);
    }

    tile.append(label);
    if (tools.childElementCount) tile.append(tools);
    return tile;
  }

  function toolButton(title, text, onClick) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = text;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function focusButton(id) {
    const focused = state.focus === id;
    return toolButton(focused ? 'Ver todos' : 'Ampliar', focused ? '▦' : '⤢', () => {
      state.focus = focused ? null : id;
      renderAll();
    });
  }

  function fullscreenButton(tile) {
    return toolButton('Tela cheia', '⛶', () => toggleFullscreen(tile));
  }

  function toggleFullscreen(tile) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else tile.requestFullscreen?.().catch(() => {});
  }

  function stopWatchButton(id) {
    return toolButton('Parar de assistir', '✕', () => unwatch(id));
  }

  function volumeTool(id, video) {
    const wrap = document.createElement('label');
    wrap.className = 'tool';
    wrap.title = 'Volume da transmissão';
    const icon = document.createElement('span');
    const range = document.createElement('input');
    range.type = 'range'; range.min = '0'; range.max = '1'; range.step = '0.05';
    range.setAttribute('aria-label', 'Volume');
    const sync = () => { icon.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊'; range.value = video.muted ? 0 : video.volume; };
    range.addEventListener('input', () => {
      video.muted = false;
      video.volume = Number(range.value);
      state.volumes.set(id, video.volume);
      sync();
    });
    icon.addEventListener('click', (e) => {
      e.preventDefault();
      video.muted = !video.muted;
      if (!video.muted && video.volume === 0) video.volume = 1;
      sync();
    });
    range.addEventListener('click', (e) => e.stopPropagation());
    sync();
    wrap.append(icon, range);
    return wrap;
  }

  window.addEventListener('beforeunload', () => { if (state.localStream) socket.emit('stream-stop'); });


  // ---------- chat ----------

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function linkify(node, text) {
    const re = /https?:\/\/[^\s<>"']+/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) node.append(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // Na Atividade, links só abrem pelo próprio Discord.
      if (inActivity) {
        a.addEventListener('click', (e) => {
          if (!sdk) return;
          e.preventDefault();
          sdk.commands.openExternalLink({ url: a.href }).catch(() => {});
        });
      }
      node.append(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.append(document.createTextNode(text.slice(last)));
  }

  function nearBottom() {
    const l = el.chatList;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
  }

  function addChat(msg, { fromHistory = false } = {}) {
    const stick = fromHistory || nearBottom();
    el.chatList.querySelector('.chat-empty')?.remove();
    const prev = el.chatList.lastElementChild;
    const cont = prev?.dataset.from === msg.from && msg.ts - Number(prev.dataset.ts) < 5 * 60 * 1000;
    const li = document.createElement('li');
    li.className = `msg${cont ? ' cont' : ''}`;
    li.dataset.from = msg.from;
    li.dataset.ts = msg.ts;
    const av = avatarEl({ name: msg.name, avatar: msg.avatar }, 'sm');
    const body = document.createElement('div');
    body.className = 'body-txt';
    if (!cont) {
      const head = document.createElement('div');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = msg.name;
      who.style.color = colorFor(msg.name);
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = fmtTime(msg.ts);
      head.append(who, when);
      body.append(head);
    }
    const txt = document.createElement('div');
    txt.className = 'txt';
    linkify(txt, msg.text);
    body.append(txt);
    li.append(av, body);
    el.chatList.append(li);
    if (stick) el.chatList.scrollTop = el.chatList.scrollHeight;
    if (!fromHistory && msg.from !== state.selfId && (el.chat.hidden || document.hidden)) {
      state.unread++;
      renderUnread();
      beep('msg');
    }
  }

  function addSystem(kind, text) {
    const stick = nearBottom();
    el.chatList.querySelector('.chat-empty')?.remove();
    const li = document.createElement('li');
    li.className = `sys sys-${kind}`;
    li.textContent = `${text} · ${fmtTime(Date.now())}`;
    el.chatList.append(li);
    if (stick) el.chatList.scrollTop = el.chatList.scrollHeight;
  }

  function loadChat(list) {
    el.chatList.replaceChildren();
    state.unread = 0;
    renderUnread();
    if (!list.length) {
      const e = document.createElement('li');
      e.className = 'chat-empty';
      e.textContent = 'Nenhuma mensagem ainda. Diga oi! 👋';
      el.chatList.append(e);
      return;
    }
    for (const m of list) addChat(m, { fromHistory: true });
  }

  function renderUnread() {
    el.unread.hidden = state.unread === 0;
    el.unread.textContent = state.unread > 9 ? '9+' : String(state.unread);
  }

  function setChatOpen(open) {
    state.chatOpen = open;
    el.chat.hidden = !open || !state.room;
    el.chatBtn.setAttribute('aria-pressed', String(open));
    if (open) {
      state.unread = 0;
      renderUnread();
      el.chatList.scrollTop = el.chatList.scrollHeight;
      if (window.innerWidth > 760) el.chatInput.focus({ preventScroll: true });
    }
  }

  el.chatBtn.addEventListener('click', () => setChatOpen(el.chat.hidden));
  el.closeChat.addEventListener('click', () => setChatOpen(false));
  el.chatBtn.setAttribute('aria-pressed', String(state.chatOpen));

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text || !state.room) return;
    socket.emit('chat', { text });
    el.chatInput.value = '';
  });

  socket.on('chat', (msg) => { if (state.room) addChat(msg); });

  socket.on('notice', ({ kind, name }) => {
    if (kind === 'slow') { toast('Calma! Muitas mensagens seguidas.'); return; }
    if (kind === 'alone' && state.room) {
      addSystem('leave', `Ninguém conectou ainda em #${state.room}. Seu amigo precisa abrir o SEU convite (botão Convidar) ou colar o nome exato "${state.room}" em "+ criar sala ou colar convite". Se o nome já é o mesmo e mesmo assim não se veem, a internet de um de vocês está bloqueando a conexão direta (teste com outra rede, ex. roteador de casa em vez de 4G).`);
      return;
    }
    if (!state.room) return;
    if (kind === 'join') { addSystem('join', `${name} entrou na sala`); beep('join'); }
    else if (kind === 'leave') { addSystem('leave', `${name} saiu da sala`); beep('leave'); }
    else if (kind === 'live') {
      addSystem('live', `${name} começou a transmitir`);
      toast(`🔴 ${name} começou a transmitir`);
      beep('live');
    }
  });

  // ---------- sons de aviso (gerados, sem arquivos) ----------

  let audioCtx = null;
  function beep(kind) {
    if (!state.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const notes = { join: [660, 880], leave: [660, 440], live: [523, 659, 784], msg: [880] }[kind] || [700];
      const t0 = audioCtx.currentTime;
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        const t = t0 + i * 0.09;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g).connect(audioCtx.destination);
        o.start(t);
        o.stop(t + 0.18);
      });
    } catch {
      /* sem áudio */
    }
  }

  function renderSoundBtn() {
    el.soundBtn.textContent = state.sound ? '🔔' : '🔕';
    el.soundBtn.setAttribute('aria-pressed', String(state.sound));
    el.soundBtn.title = state.sound ? 'Sons de aviso ligados' : 'Sons de aviso desligados';
  }
  el.soundBtn.addEventListener('click', () => {
    state.sound = !state.sound;
    store.set('telao_som', state.sound ? '1' : '0');
    renderSoundBtn();
    if (state.sound) beep('msg');
  });
  renderSoundBtn();

  // ---------- convite ----------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  // Na Atividade: abre o Telão no navegador de quem quer transmitir.
  document.getElementById('activityHint')?.addEventListener('click', () => {
    const base = (state.config?.publicUrl || `${location.origin}${BASE_PATH}`).replace(/\/+$/, '');
    const url = state.room ? `${base}/?sala=${encodeURIComponent(state.room)}` : base;
    if (sdk) sdk.commands.openExternalLink({ url }).catch(() => toast(`Abra no navegador: ${base}`));
    else window.open(url, '_blank', 'noopener');
  });

  el.inviteBtn.addEventListener('click', async () => {
    if (!state.room) return;
    const base = (state.config?.publicUrl || `${location.origin}${BASE_PATH}`).replace(/\/+$/, '');
    const params = new URLSearchParams({ sala: state.room });
    if (state.code) params.set('codigo', state.code);
    const text = `Bora assistir comigo no Telão! 📺\n${base}/?${params}\n(abre no Chrome ou Edge e coloca seu nome)`;
    if (await copyText(text)) toast('Convite copiado! Cole no WhatsApp ou no Discord.');
    else toast(`Copie o link: ${base}/?${params}`);
  });

  // ---------- qualidade da conexão ----------

  async function viewerStats(streamerId, entry) {
    const report = await entry.pc.getStats();
    let fps = 0;
    let height = 0;
    let rtt = null;
    let lost = 0;
    let recv = 0;
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        fps = r.framesPerSecond || 0;
        height = r.frameHeight || 0;
        lost = r.packetsLost || 0;
        recv = r.packetsReceived || 0;
      }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) {
        rtt = Math.round(r.currentRoundTripTime * 1000);
      }
    });
    const prev = entry.lastLoss || { lost, recv };
    const dLost = lost - prev.lost;
    const dRecv = recv - prev.recv;
    entry.lastLoss = { lost, recv };
    const lossPct = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
    const tile = el.grid.querySelector(`[data-id="${CSS.escape(streamerId)}"]`);
    const badge = tile?.querySelector('.net');
    if (!badge || !height) return;
    const bad = lossPct > 5 || (rtt != null && rtt > 300) || fps < 10;
    const mid = !bad && (lossPct > 1 || (rtt != null && rtt > 150) || fps < 20);
    badge.hidden = false;
    badge.className = `net${bad ? ' bad' : mid ? ' mid' : ''}`;
    badge.textContent = `${height}p · ${Math.round(fps)} fps${rtt != null ? ` · ${rtt} ms` : ''}`;
    badge.title = bad ? 'Conexão fraca' : mid ? 'Conexão razoável' : 'Conexão boa';
  }

  // Quem transmite ajusta a taxa de cada espectador conforme a perda e o atraso dele.
  async function adaptOut(pc) {
    if (!pc._video || pc.connectionState !== 'connected') return;
    const report = await pc.getStats(pc._video.track);
    let loss = null;
    let rtt = null;
    report.forEach((r) => {
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
        loss = r.fractionLost ?? null;
        rtt = r.roundTripTime ?? null;
      }
    });
    if (loss == null) return;
    const max = state.localQuality.bitrate;
    let next = pc._bitrate;
    if (loss > 0.05 || (rtt != null && rtt > 0.4)) next = Math.max(MIN_BITRATE, Math.round(pc._bitrate * 0.7));
    else if (loss < 0.01 && (rtt == null || rtt < 0.25)) next = Math.min(max, Math.round(pc._bitrate * 1.15));
    if (Math.abs(next - pc._bitrate) / pc._bitrate < 0.05) return;
    const p = pc._video.getParameters();
    if (!p.encodings?.length) return;
    p.encodings[0].maxBitrate = next;
    try {
      await pc._video.setParameters(p);
      pc._bitrate = next;
    } catch {
      /* tenta na próxima */
    }
  }

  // Ganchos só para os testes automáticos (somente leitura).
  window.__telaoPeers = () => [...state.inPeers.values()].map((e) => e.pc);
  window.__telaoLocalHint = () => state.localStream?.getVideoTracks()[0]?.contentHint || null;
  window.__telaoRelay = () => ({ viewers: state.relayViewers.size, in: [...state.inRelay.keys()], activity: inActivity, base: apiBase });

  setInterval(relayTick, 1000);

  setInterval(() => {
    for (const [id, entry] of state.inPeers) viewerStats(id, entry).catch(() => {});
    if (state.localStream) for (const pc of state.outPeers.values()) adaptOut(pc).catch(() => {});
  }, 2000);

  boot();
})();
