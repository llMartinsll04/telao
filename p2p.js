// Telão sem servidor: imita o "socket" do servidor Node usando Trystero
// (sinalização P2P por relays Nostr públicos). Assim o app.js funciona igual
// num site estático (GitHub Pages) — o vídeo continua indo direto, por WebRTC.
(() => {
  'use strict';

  const APP_ID = 'telao.llmartinsll04.github.io/v1';
  const ROOM_RE = /^[a-z0-9-]{1,24}$/;
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const SAVED_KEY = 'telao_salas';
  const MAX_SAVED = 20;
  const MAX_MEMBERS = 12;

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
      await this.on_leave();
      if (seq !== this.joinSeq) return { error: 'Troca de sala cancelada.' };

      const { joinRoom } = window.TelaoTrystero;
      const r = joinRoom({ appId: APP_ID, identity: 'none', rtcConfig: { iceServers: ICE } }, room);
      this.room = r;
      this.roomName = room;
      this.members.clear();
      const self = await r.getSelf();
      // Trocou de sala ou saiu enquanto esta entrada ainda conectava.
      if (this.room !== r || seq !== this.joinSeq) {
        if (this.room !== r) r.leave().catch(() => {});
        return { error: 'Troca de sala cancelada.' };
      }
      this.me = { id: self.peerId, name: clean, avatar: null, discordId: null, streaming: false };

      const mk = (n) => r.makeAction(n);
      const a = { hello: mk('hello'), sig: mk('sig'), watch: mk('watch'), unwatch: mk('unwatch'), chat: mk('chat'), ended: mk('ended') };
      this.act = a;
      const mine = () => this.room === r;

      r.onPeerJoin(({ peerId }) => { if (mine()) a.hello.send(this.me, { target: peerId }).catch(() => {}); });
      r.onPeerLeave(({ peerId }) => {
        if (!mine()) return;
        const m = this.members.get(peerId);
        if (!m) return;
        this.members.delete(peerId);
        this.fire('peer-left', { id: peerId });
        this.fire('notice', { kind: 'leave', name: m.name });
        this.sendRoomState();
      });
      a.hello.onMessage((msg, { peerId }) => {
        if (!mine() || !msg || typeof msg !== 'object') return;
        const prev = this.members.get(peerId);
        if (!prev && this.members.size + 1 >= MAX_MEMBERS) return;
        const m = { id: peerId, name: cleanName(msg.name) || 'Convidado', avatar: null, discordId: null, streaming: msg.streaming === true };
        this.members.set(peerId, m);
        if (!prev) this.fire('notice', { kind: 'join', name: m.name });
        if (m.streaming && !prev?.streaming) this.fire('notice', { kind: 'live', name: m.name, id: peerId });
        if (prev?.streaming && !m.streaming) this.fire('stream-ended', { id: peerId });
        this.sendRoomState();
      });
      a.sig.onMessage((data, { peerId }) => {
        if (mine() && this.members.has(peerId) && data && typeof data === 'object') this.fire('signal', { from: peerId, data });
      });
      a.watch.onMessage((_d, { peerId }) => {
        const m = this.members.get(peerId);
        if (mine() && m && this.me.streaming) this.fire('viewer-request', { viewerId: peerId, name: m.name, relay: false });
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

      // Sozinho depois de um tempo: avisa uma vez com o nome exato da sala.
      setTimeout(() => { if (mine() && this.members.size === 0) this.fire('notice', { kind: 'alone' }); }, 25000);

      const list = savedRooms().filter((x) => x !== room);
      saveRooms([room, ...list]);
      setTimeout(() => this.sendRoomState(), 0);
      return { ok: true, self: this.me, iceServers: ICE, chat: [] };
    }

    async on_leave() {
      const r = this.room;
      if (!r) return;
      this.room = null;
      this.roomName = null;
      this.act = null;
      this.members.clear();
      this.me = null;
      try { await r.leave(); } catch { /* já saiu */ }
      this.sendLobby();
    }

    on_stream_start() {
      if (!this.me || this.me.streaming) return;
      this.me.streaming = true;
      this.act?.hello.send(this.me).catch(() => {});
      this.sendRoomState();
    }

    on_stream_stop() {
      if (!this.me || !this.me.streaming) return;
      this.me.streaming = false;
      this.act?.ended.send({}).catch(() => {});
      this.act?.hello.send(this.me).catch(() => {});
      this.sendRoomState();
    }

    on_watch({ streamerId }) {
      if (this.act && this.members.get(streamerId)?.streaming) this.act.watch.send({}, { target: streamerId }).catch(() => {});
    }

    on_unwatch({ streamerId }) {
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

  window.io = () => new P2PSocket();
})();
