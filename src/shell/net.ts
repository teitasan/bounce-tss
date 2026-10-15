import type { ClientMsg, GuestMsg, HostMsg, RoomPlayer, ServerMsg } from './protocol';

/** 部屋の WebSocket。ホストかどうかはサーバーから届く room の host で決まる */
export class Net {
  private ws: WebSocket;
  you = '';
  host = '';
  players: RoomPlayer[] = [];
  inMatch = false;

  onRoom: () => void = () => {};
  onPeer: (from: string, d: GuestMsg) => void = () => {};
  onHost: (d: HostMsg) => void = () => {};
  onClose: (reason: string) => void = () => {};

  constructor(
    readonly room: string,
    name: string,
  ) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws?r=${encodeURIComponent(room)}`);
    this.ws.addEventListener('open', () => this.send({ t: 'hello', name }));
    this.ws.addEventListener('message', (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.t) {
        case 'welcome':
          this.you = msg.you;
          break;
        case 'room':
          this.players = msg.players;
          this.host = msg.host;
          this.inMatch = msg.inMatch;
          this.onRoom();
          break;
        case 'full':
          this.onClose('部屋が満員です（4人まで）');
          break;
        case 'fromPeer':
          this.onPeer(msg.from, msg.d);
          break;
        case 'fromHost':
          this.onHost(msg.d);
          break;
      }
    });
    this.ws.addEventListener('close', (ev) => this.onClose(ev.reason === 'full' ? '部屋が満員です（4人まで）' : '切断されました'));
  }

  get isHost() {
    return this.you !== '' && this.you === this.host;
  }

  get open() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg) {
    if (this.open) this.ws.send(JSON.stringify(msg));
  }

  toHost(d: GuestMsg) {
    this.send({ t: 'toHost', d });
  }

  toAll(d: HostMsg) {
    this.send({ t: 'toAll', d });
  }

  close() {
    this.onClose = () => {};
    this.ws.close(1000, 'leave');
  }
}
