// 1部屋 = 1 Durable Object。入退室とホストの管理、メッセージの中継だけを行う（ゲームの計算はしない）
import { DurableObject } from 'cloudflare:workers';
import { MAX_PLAYERS, type ClientMsg, type RoomPlayer, type ServerMsg } from '../src/shell/protocol';
import type { Env } from './worker';

// 何も届かないまま繋ぎっぱなしだと稼働時間を消費し続けるので切断する
const IDLE_MS = 10 * 60 * 1000;

type Peer = RoomPlayer & { ws: WebSocket; joined: number; lastAct: number };

export class Room extends DurableObject<Env> {
  private peers = new Map<string, Peer>();
  private inMatch = false;
  private seq = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  async fetch(_request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (this.peers.size >= MAX_PLAYERS) {
      this.send(server, { t: 'full' });
      server.close(1013, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = crypto.randomUUID().slice(0, 8);
    const peer: Peer = { id, name: 'player', ws: server, joined: this.seq++, lastAct: Date.now() };
    this.peers.set(id, peer);
    this.send(server, { t: 'welcome', you: id });

    server.addEventListener('message', (ev) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      peer.lastAct = Date.now();
      this.onMessage(peer, msg);
    });
    const leave = () => {
      if (!this.peers.delete(id)) return;
      if (this.peers.size === 0) this.inMatch = false;
      this.broadcastRoom();
    };
    server.addEventListener('close', leave);
    server.addEventListener('error', leave);

    this.ensureIdleTimer();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 一番早く入った人がホスト。ホストが抜けると次の人が引き継ぐ */
  private host(): Peer | undefined {
    let best: Peer | undefined;
    for (const p of this.peers.values()) if (!best || p.joined < best.joined) best = p;
    return best;
  }

  private onMessage(peer: Peer, msg: ClientMsg) {
    const host = this.host();
    switch (msg.t) {
      case 'hello':
        peer.name = String(msg.name || 'player').slice(0, 12);
        this.broadcastRoom();
        break;
      case 'phase':
        if (peer === host) {
          this.inMatch = !!msg.inMatch;
          this.broadcastRoom();
        }
        break;
      case 'toHost':
        if (host && peer !== host) this.send(host.ws, { t: 'fromPeer', from: peer.id, d: msg.d });
        break;
      case 'toAll':
        if (peer === host) {
          const out = JSON.stringify({ t: 'fromHost', d: msg.d } satisfies ServerMsg);
          for (const p of this.peers.values()) if (p !== host) this.sendRaw(p.ws, out);
        }
        break;
    }
  }

  private broadcastRoom() {
    const host = this.host();
    const players = [...this.peers.values()].sort((a, b) => a.joined - b.joined).map(({ id, name }) => ({ id, name }));
    const out = JSON.stringify({ t: 'room', players, host: host?.id ?? '', inMatch: this.inMatch } satisfies ServerMsg);
    for (const p of this.peers.values()) this.sendRaw(p.ws, out);
  }

  private ensureIdleTimer() {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const p of this.peers.values()) if (now - p.lastAct > IDLE_MS) p.ws.close(1000, 'idle');
      if (this.peers.size === 0 && this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
    }, 60_000);
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, data: string) {
    try {
      ws.send(data);
    } catch {
      /* 閉じかけの接続は無視 */
    }
  }
}
