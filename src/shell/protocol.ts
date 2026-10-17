/**
 * オンライン対戦の通信。サーバー（Durable Object）は部屋の出入りを管理し、メッセージを中継するだけ。
 * ゲームの計算はホスト（最初に入った人）のブラウザが行い、状態を全員に配る。
 */

export interface RoomPlayer {
  id: string;
  name: string;
}

/** クライアント → サーバー */
export type ClientMsg =
  | { t: 'hello'; name: string }
  /** ホストだけ：対戦中かどうか（対戦中に入った人は次の試合まで観戦） */
  | { t: 'phase'; inMatch: boolean }
  /** 参加者 → ホスト */
  | { t: 'toHost'; d: GuestMsg }
  /** ホスト → 参加者全員 */
  | { t: 'toAll'; d: HostMsg };

/** サーバー → クライアント */
export type ServerMsg =
  | { t: 'welcome'; you: string }
  | { t: 'room'; players: RoomPlayer[]; host: string; inMatch: boolean }
  | { t: 'full' }
  | { t: 'fromPeer'; from: string; d: GuestMsg }
  | { t: 'fromHost'; d: HostMsg };

/** 参加者 → ホスト */
export type GuestMsg =
  | { k: 'input'; mx: number; my: number; aim: number; fire: boolean; slow?: boolean }
  | { k: 'draftApply'; ci: number; ti: number }
  | { k: 'draftPass' };

/** ホスト → 参加者（中身はゲーム側で決める。サーバーは見ない） */
export type HostMsg = { k: string; [key: string]: unknown };

export const MAX_PLAYERS = 4;
export const ROOM_RE = /^[a-z0-9-]{1,24}$/;
