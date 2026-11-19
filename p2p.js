// Telão sem servidor: imita o "socket" do servidor Node usando Trystero
// (sinalização P2P por relays Nostr públicos). Assim o app.js funciona igual
// num site estático (GitHub Pages) — o vídeo continua indo direto, por WebRTC.
(() => {
  'use strict';

  const APP_ID = 'telao.llmartinsll04.github.io/v1';
  const ROOM_RE = /^[a-z0-9-]{1,24}$/;
  // Retransmissor (TURN): usado só quando a conexão direta falha (4G, CGNAT, rede de empresa).
  // O antigo, no Linux da 3060, foi apagado em 18/11/2026, e a casa está atrás de CGNAT
  // (roteador com IP 100.64.x): um retransmissor em casa não é alcançável pelos amigos.
  // Precisa ser um serviço na internet; preencha TURN abaixo quando houver (ver LEIA-ME).
  const TURN = []; // ex.: [{ urls: ['turn:host:3478?transport=udp', 'turns:host:443?transport=tcp'], username: '...', credential: '...' }]
  const ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    ...TURN,
  ];
  // Servidores de encontro (Nostr). O sorteio padrão do Trystero caía em 5, um deles morto e
  // três lentos (teste de 19/11/2026); amigos às vezes não se achavam. Lista fixa e testada:
  // os 4 vivos do sorteio antigo (abas com a versão anterior continuam se achando) + 4 rápidos.
  // Conferir de vez em quando: node tools/relays-check.mjs
  const RELAYS = [
    'wss://fanfares.nostr1.com', 'wss://nostr.liberty.fans', 'wss://no.str.cr', 'wss://relay.angor.io',
    'wss://nostr-01.yakihonne.com', 'wss://nostr.azzamo.net', 'wss://nostr.sathoarder.com', 'wss://relay.primal.net',
  ];
  const SAVED_KEY = 'telao_salas';
  const MAX_SAVED = 20;
  const MAX_MEMBERS = 12;
  // Vigia da sala (ms): sinal de vida, quando alguém conta como sumido e quando reconectar sozinho.
  const BEAT_MS = 4000;
  const STALE_MS = 20000;
  const MISSING_RETRY_MS = 8000;
  const ALONE_RETRY_MS = 20000;
  const MAX_RETRY_MS = 60000;
  // Reabrir por "falta alguém" derruba por instantes as outras ligações: no máximo 3 a cada 5 min.
  const MISSING_REOPENS_MAX = 3;
  const MISSING_REOPENS_WINDOW_MS = 300000;

  window.TELAO_STATIC_CONFIG = {
    p2p: true,
    publicUrl: '',
    iceServers: ICE,
    rooms: [],
    discordLogin: false,
    discordClientId: '',
    requireDiscordLogin: false,
    discordWebhook: false,
    accessCodeRequired: false,
    user: null,
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
  };
  const savedRooms = () => {
    try {
      const list = JSON.parse(store.get(SAVED_KEY) || '[]');
      return Array.isArray(list) ? list.filter((r) => typeof r === 'string' && ROOM_RE.test(r)) : [];
    } catch { return []; }
  };
  const saveRooms = (list) => store.set(SAVED_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
  const randId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

  class P2PSocket {
    constructor() {
      this.handlers = new Map();
      this.connected = false;
      this.io = { opts: {} };
      this.auth = null;
      this.room = null; // objeto do Trystero
      this.roomName = null;
      this.me = null;
      this.members = new Map(); // peerId -> membro
      this.act = null;
      this.joinSeq = 0;
      this.peerSees = new Map(); // peerId -> ids que esse amigo vê
      this.pendingWatch = new Map(); // streamerId -> até quando reenviar o pedido de assistir
      this.earlyWatch = new Map(); // viewerId -> pedido de assistir que chegou antes do "olá"
      this.beat = null;
      this.onVisible = null;
      this.reopens = 0; // quantas vezes o vigia reconectou (para os testes)
      // Fechando ou atualizando a aba: avisa os outros na hora, sem deixar cartão fantasma.
      addEventListener('pagehide', () => { try { this.act?.bye.send({}).catch(() => {}); this.room?.leave().catch(() => {}); } catch { /* saindo */ } });
    }

    on(ev, fn) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, []);
      this.handlers.get(ev).push(fn);
      return this;
    }

    fire(ev, payload) {
      for (const fn of this.handlers.get(ev) || []) {
        try { fn(payload); } catch (err) { console.error('[telao p2p]', ev, err); }
      }
    }

    connect() {
      if (this.connected) return;
      this.connected = true;
      setTimeout(() => { this.fire('connect'); this.sendLobby(); }, 0);
    }

    emit(ev, data, ack) {
      const fn = this[`on_${ev.replace(/-/g, '_')}`];
      const out = fn ? fn.call(this, data && typeof data === 'object' ? data : {}) : undefined;
      Promise.resolve(out)
        .catch((err) => { console.error('[telao p2p]', ev, err); return { error: 'Falha na conexão. Tente de novo.' }; })
        .then((res) => { if (typeof ack === 'function') ack(res); });
    }

    // ---------- lista de salas (só as que você conhece neste navegador) ----------

    sendLobby() {
      const lobby = {};
      for (const r of new Set([...savedRooms(), ...(this.roomName ? [this.roomName] : [])])) {
        lobby[r] = r === this.roomName ? this.memberList() : [];
      }
      this.fire('lobby', lobby);
    }

    memberList() {
      return this.me ? [this.me, ...this.members.values()] : [];
    }

    sendRoomState() {
      if (!this.roomName) return;
      this.fire('room-state', { room: this.roomName, members: this.memberList() });
      this.sendLobby();
    }

    // ---------- pedidos do app ----------

    on_auth() { return { ok: true }; }

    async on_join({ room, name }) {
      room = String(room || '').toLowerCase();
      if (!ROOM_RE.test(room)) return { error: 'Nome de sala inválido.' };
      const clean = cleanName(name);
      if (!clean) return { error: 'Escolha um nome.' };
      const seq = ++this.joinSeq;
      await this.closeRoom();
      if (seq !== this.joinSeq) return { error: 'Troca de sala cancelada.' };

      this.roomName = room;
      this.members.clear();
      this.peerSees.clear();
      const r = await this.openRoom(seq);
      if (!r) return { error: 'Troca de sala cancelada.' };
      const self = await r.getSelf();
      if (this.room !== r || seq !== this.joinSeq) return { error: 'Troca de sala cancelada.' };
      this.me = { id: self.peerId, name: clean, avatar: null, discordId: null, streaming: false };
      this.startWatch(seq);

      // Sozinho depois de um tempo: avisa uma vez com o nome exato da sala.
      setTimeout(() => { if (seq === this.joinSeq && this.room && this.members.size === 0) this.fire('notice', { kind: 'alone' }); }, 25000);

      const list = savedRooms().filter((x) => x !== room);
      saveRooms([room, ...list]);
      setTimeout(() => this.sendRoomState(), 0);
      return { ok: true, self: this.me, iceServers: ICE, chat: [] };
    }

    // Abre (ou reabre) a sala do Trystero e liga as ações. Reabrir mantém o mesmo
    // id e a lista de membros: serve para forçar um novo anúncio quando alguém sumiu.
    async openRoom(seq) {
      const { joinRoom } = window.TelaoTrystero;
      const old = this.room;
      if (old) { this.room = null; await old.leave().catch(() => {}); }
      if (seq !== this.joinSeq) return null;
      const r = joinRoom({ appId: APP_ID, identity: 'none', rtcConfig: { iceServers: ICE }, relayConfig: { urls: RELAYS } }, this.roomName);
      this.room = r;

      const mk = (n) => r.makeAction(n);
      const a = { hello: mk('hello'), bye: mk('bye'), sig: mk('sig'), watch: mk('watch'), unwatch: mk('unwatch'), chat: mk('chat'), ended: mk('ended') };
      this.act = a;
      const mine = () => this.room === r && seq === this.joinSeq;

      r.onPeerJoin(({ peerId }) => { if (mine() && this.me) a.hello.send(this.helloMsg(), { target: peerId }).catch(() => {}); });
      r.onPeerLeave(({ peerId }) => { if (mine()) this.dropMember(peerId); });
      a.bye.onMessage((_d, { peerId }) => { if (mine()) this.dropMember(peerId); });
      a.hello.onMessage((msg, { peerId }) => {
        if (!mine() || !msg || typeof msg !== 'object' || peerId === this.me?.id) return;
        const prev = this.members.get(peerId);
        if (!prev && this.members.size + 1 >= MAX_MEMBERS) return;
        const name = cleanName(msg.name) || 'Convidado';
        const streaming = msg.streaming === true;
        this.members.set(peerId, { id: peerId, name, avatar: null, discordId: null, streaming, seen: Date.now() });
        // Quem esse amigo está vendo: serve para notar alguém que só eu não vejo.
        const sees = Array.isArray(msg.sees) ? msg.sees.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, MAX_MEMBERS) : [];
        this.peerSees.set(peerId, sees);
        // Pedido de assistir que se perdeu numa queda: envia assim que a pessoa reaparece transmitindo.
        const pend = this.pendingWatch.get(peerId);
        if (pend && streaming) {
          this.pendingWatch.delete(peerId);
          if (pend >= Date.now()) a.watch.send({}, { target: peerId }).catch(() => {});
        }
        const early = this.earlyWatch.get(peerId);
        if (early) {
          this.earlyWatch.delete(peerId);
          if (early >= Date.now() && this.me?.streaming) setTimeout(() => this.fire('viewer-request', { viewerId: peerId, name, relay: false }), 0);
        }
        if (prev && prev.name === name && prev.streaming === streaming) return; // só sinal de vida
        if (!prev) this.fire('notice', { kind: 'join', name });
        if (streaming && !prev?.streaming) this.fire('notice', { kind: 'live', name, id: peerId });
        if (prev?.streaming && !streaming) this.fire('stream-ended', { id: peerId });
        this.sendRoomState();
      });
      a.sig.onMessage((data, { peerId }) => {
        if (mine() && this.members.has(peerId) && data && typeof data === 'object') this.fire('signal', { from: peerId, data });
      });
      a.watch.onMessage((_d, { peerId }) => {
        if (!mine() || !this.me?.streaming) return;
        const m = this.members.get(peerId);
        // Pedido chegou antes do "olá" da pessoa: guarda e atende quando ela aparecer.
        if (!m) { this.earlyWatch.set(peerId, Date.now() + 30000); return; }
        this.fire('viewer-request', { viewerId: peerId, name: m.name, relay: false });
      });
      a.unwatch.onMessage((_d, { peerId }) => { if (mine()) this.fire('viewer-left', { viewerId: peerId }); });
      a.ended.onMessage((_d, { peerId }) => {
        const m = this.members.get(peerId);
        if (!mine() || !m) return;
        m.streaming = false;
        this.fire('stream-ended', { id: peerId });
        this.sendRoomState();
      });
      a.chat.onMessage((msg, { peerId }) => {
        const m = this.members.get(peerId);
        if (!mine() || !m || !msg || typeof msg.text !== 'string') return;
        const text = msg.text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500);
        if (text) this.fire('chat', { id: randId(), from: peerId, name: m.name, avatar: null, text, ts: Date.now() });
      });
      return r;
    }

    helloMsg() {
      return { name: this.me.name, streaming: this.me.streaming, sees: [...this.members.keys()] };
    }

    dropMember(peerId) {
      const m = this.members.get(peerId);
      this.peerSees.delete(peerId);
      if (!m) return;
      this.members.delete(peerId);
      this.fire('peer-left', { id: peerId });
      this.fire('notice', { kind: 'leave', name: m.name });
      this.sendRoomState();
    }

    // Vigia da sala: sinal de vida, limpeza de quem sumiu e reconexão sozinha
    // (antes era preciso apertar F5 quando um amigo não aparecia).
    startWatch(seq) {
      this.stopWatch();
      let missingSince = 0;
      let aloneSince = Date.now();
      let wait = MISSING_RETRY_MS;
      let lastReopen = Date.now();
      let busy = false;
      const missingReopens = [];
      const tick = async () => {
        if (busy || seq !== this.joinSeq || !this.room || !this.me) return;
        const r = this.room;
        const now = Date.now();
        this.act?.hello.send(this.helloMsg()).catch(() => {});
        const connected = new Set(Object.keys(r.getPeers() || {}));
        for (const [id, m] of [...this.members]) {
          if (!connected.has(id) && now - (m.seen || 0) > STALE_MS) this.dropMember(id);
        }
        // Alguém que os outros veem e eu não: falta a ligação direta com essa pessoa.
        let missing = false;
        for (const [from, list] of this.peerSees) {
          if (!connected.has(from)) continue;
          for (const id of list) if (id !== this.me.id && !connected.has(id)) missing = true;
        }
        missingSince = missing ? missingSince || now : 0;
        aloneSince = connected.size === 0 ? aloneSince || now : 0;
        while (missingReopens.length && now - missingReopens[0] > MISSING_REOPENS_WINDOW_MS) missingReopens.shift();
        const byMissing = missingSince && now - missingSince >= wait && missingReopens.length < MISSING_REOPENS_MAX;
        const byAlone = aloneSince && now - aloneSince >= Math.max(wait, ALONE_RETRY_MS);
        const stuck = byMissing || byAlone;
        if (!stuck) { if (!missing && connected.size > 0) wait = MISSING_RETRY_MS; return; }
        if (now - lastReopen < wait) return;
        busy = true;
        try {
          lastReopen = now;
          if (!byAlone) missingReopens.push(now);
          missingSince = 0;
          aloneSince = 0;
          wait = Math.min(wait * 2, MAX_RETRY_MS);
          this.reopens += 1;
          const before = this.me.id;
          const nr = await this.openRoom(seq);
          const self = nr && (await nr.getSelf().catch(() => null));
          if (self && self.peerId !== before) console.warn('[telao p2p] id mudou ao reconectar', before, self.peerId);
        } finally { busy = false; }
      };
      this.beat = setInterval(() => { tick().catch((e) => console.error('[telao p2p] vigia', e)); }, BEAT_MS);
      this.onVisible = () => { if (!document.hidden) tick().catch(() => {}); };
      document.addEventListener('visibilitychange', this.onVisible);
    }

    stopWatch() {
      clearInterval(this.beat);
      this.beat = null;
      if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
      this.onVisible = null;
    }

    async on_leave() {
      this.joinSeq += 1; // cancela entradas e reconexões em andamento
      await this.closeRoom();
    }

    async closeRoom() {
      this.stopWatch();
      const r = this.room;
      const hadRoom = Boolean(r || this.roomName);
      if (r) this.act?.bye.send({}).catch(() => {});
      this.pendingWatch.clear();
      this.earlyWatch.clear();
      this.room = null;
      this.roomName = null;
      this.act = null;
      this.members.clear();
      this.peerSees.clear();
      this.me = null;
      if (r) { try { await r.leave(); } catch { /* já saiu */ } }
      if (hadRoom) this.sendLobby();
    }

    on_stream_start() {
      if (!this.me || this.me.streaming) return;
      this.me.streaming = true;
      this.act?.hello.send(this.helloMsg()).catch(() => {});
      this.sendRoomState();
    }

    on_stream_stop() {
      if (!this.me || !this.me.streaming) return;
      this.me.streaming = false;
      this.act?.ended.send({}).catch(() => {});
      this.act?.hello.send(this.helloMsg()).catch(() => {});
      this.sendRoomState();
    }

    on_watch({ streamerId }) {
      if (typeof streamerId !== 'string') return;
      if (this.act && this.room && this.members.get(streamerId)?.streaming) this.act.watch.send({}, { target: streamerId }).catch(() => {});
      else if (this.roomName) this.pendingWatch.set(streamerId, Date.now() + 60000);
    }

    on_unwatch({ streamerId }) {
      this.pendingWatch.delete(streamerId);
      if (this.act && this.members.has(streamerId)) this.act.unwatch.send({}, { target: streamerId }).catch(() => {});
    }

    on_signal({ to, data }) {
      if (this.act && this.members.has(to)) this.act.sig.send(plain(data), { target: to }).catch(() => {});
    }

    on_chat({ text }) {
      if (!this.act || typeof text !== 'string') return;
      const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500);
      if (!clean) return;
      this.act.chat.send({ text: clean }).catch(() => {});
      this.fire('chat', { id: randId(), from: this.me.id, name: this.me.name, avatar: null, text: clean, ts: Date.now() });
    }

    on_room_delete({ room }) {
      if (room === this.roomName) return { error: 'Saia da sala antes de tirá-la da lista.' };
      saveRooms(savedRooms().filter((x) => x !== room));
      this.sendLobby();
      return { ok: true };
    }

    // Vídeo pelo servidor não existe aqui.
    on_relay_start() {}
    on_relay_chunk() {}
    on_relay_fail() {}
  }

  // window.__telaoP2P: usado pelos testes para provocar falhas de conexão.
  window.io = () => (window.__telaoP2P = new P2PSocket());
})();
