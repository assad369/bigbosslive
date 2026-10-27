import {
  AccessToken,
  DataPacket_Kind,
  RoomServiceClient,
  TrackType,
  WebhookReceiver,
  type WebhookEvent,
} from 'livekit-server-sdk';
import type { Env } from '../config/env.js';

export interface TokenRequest {
  room: string;
  identity: string;
  name: string;
  canPublish: boolean;
  /** Server-minted metadata (level, VIP, role). Clients read this instead of trusting each other. */
  metadata: Record<string, unknown>;
  hidden?: boolean;
}

/**
 * Everything the backend asks of LiveKit. In-room realtime (chat, gifts, PK, seats) rides the
 * LiveKit data channel via `sendData`, so the API servers hold no per-room socket state.
 */
export interface LiveKitGateway {
  readonly url: string;
  createToken(req: TokenRequest): Promise<string>;
  sendData(room: string, topic: string, payload: unknown, identities?: string[]): Promise<void>;
  removeParticipant(room: string, identity: string): Promise<void>;
  /** Grant/revoke publishing and, optionally, replace the server-minted metadata (role). */
  updateParticipant(
    room: string,
    identity: string,
    update: { canPublish: boolean; metadata?: Record<string, unknown> },
  ): Promise<void>;
  /**
   * Mute (or allow unmuting of) a participant's published tracks of one kind on the SFU. A
   * server mute holds even against a modified client; unmuting is left to the participant.
   */
  muteTracks(
    room: string,
    identity: string,
    kind: 'audio' | 'video',
    muted: boolean,
  ): Promise<void>;
  deleteRoom(room: string): Promise<void>;
  /** Server-side SFU forwarding of a host's tracks into another room (PK battles). */
  forwardParticipant(sourceRoom: string, identity: string, destinationRoom: string): Promise<void>;
  unforwardParticipant(
    sourceRoom: string,
    identity: string,
    destinationRoom: string,
  ): Promise<void>;
  receiveWebhook(body: string, authHeader: string | undefined): Promise<WebhookEvent>;
}

export function createLiveKitGateway(env: Env): LiveKitGateway {
  const httpUrl = env.LIVEKIT_URL.replace(/^ws(s?):\/\//, 'http$1://');
  const rooms = new RoomServiceClient(httpUrl, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  const encoder = new TextEncoder();

  return {
    url: env.LIVEKIT_URL,
    async createToken(req) {
      const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity: req.identity,
        name: req.name,
        metadata: JSON.stringify(req.metadata),
        ttl: env.LIVEKIT_TOKEN_TTL_SECONDS,
      });
      at.addGrant({
        room: req.room,
        roomJoin: true,
        canPublish: req.canPublish,
        canSubscribe: true,
        canPublishData: true,
        // Metadata is server-authoritative; clients must not rewrite their own level/role.
        canUpdateOwnMetadata: false,
        hidden: req.hidden ?? false,
      });
      return at.toJwt();
    },
    async sendData(room, topic, payload, identities) {
      await rooms.sendData(
        room,
        encoder.encode(JSON.stringify({ topic, payload, ts: Date.now() })),
        DataPacket_Kind.RELIABLE,
        { topic, ...(identities?.length ? { destinationIdentities: identities } : {}) },
      );
    },
    async removeParticipant(room, identity) {
      await rooms.removeParticipant(room, identity);
    },
    async updateParticipant(room, identity, { canPublish, metadata }) {
      await rooms.updateParticipant(room, identity, {
        permission: { canPublish, canSubscribe: true, canPublishData: true },
        ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
      });
    },
    async muteTracks(room, identity, kind, muted) {
      const participant = await rooms.getParticipant(room, identity);
      const type = kind === 'audio' ? TrackType.AUDIO : TrackType.VIDEO;
      await Promise.all(
        participant.tracks
          .filter((t) => t.type === type && t.muted !== muted)
          .map((t) => rooms.mutePublishedTrack(room, identity, t.sid, muted)),
      );
    },
    async deleteRoom(room) {
      await rooms.deleteRoom(room);
    },
    async forwardParticipant(src, identity, dest) {
      await rooms.forwardParticipant(src, identity, dest);
    },
    async unforwardParticipant(_src, identity, dest) {
      // A forwarded participant is removed by calling RemoveParticipant in the destination room.
      await rooms.removeParticipant(dest, identity);
    },
    receiveWebhook: (body, authHeader) => receiver.receive(body, authHeader),
  };
}
