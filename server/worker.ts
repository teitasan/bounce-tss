// Worker エントリ。/ws だけ処理し、それ以外は静的アセット（ゲーム本体）に任せる
import { ROOM_RE } from '../src/shell/protocol';

export { Room } from './room';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const code = (url.searchParams.get('r') || '').toLowerCase();
    if (!ROOM_RE.test(code)) return new Response('invalid room', { status: 400 });
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export interface Env {
  ROOM: DurableObjectNamespace<import('./room').Room>;
}
