import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { SOCKET, type ChatMessage } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { ConversationDoc, MessageDoc } from '../../db/schema.js';
import { badRequest, forbidden, isDuplicateKeyError, notFound } from '../../lib/errors.js';
import { afterCursor, encodeCursor } from '../../lib/http.js';

export const sendMessageInput = z
  .object({
    toUserId: z.string().min(1).max(128),
    type: z.enum(['text', 'image']),
    text: z.string().trim().max(2000).nullable().default(null),
    mediaUrl: z.url().nullable().default(null),
    clientId: z.string().min(8).max(64).nullable().default(null),
  })
  .refine(
    (m) => (m.type === 'text' ? Boolean(m.text) : Boolean(m.mediaUrl)),
    'Text messages need text; image messages need mediaUrl',
  );

const pairKey = (a: string, b: string) => [a, b].sort().join(':');

export function toChatMessage(m: MessageDoc): ChatMessage {
  return {
    id: String(m._id),
    conversationId: String(m.conversationId),
    senderId: m.senderId,
    type: m.type,
    text: m.text,
    mediaUrl: m.mediaUrl,
    createdAt: m.createdAt.toISOString(),
  };
}

/** One-to-one direct messages. Delivery is Socket.IO to online devices plus FCM push. */
export class ChatService {
  constructor(private readonly ctx: Ctx) {}

  async conversationWith(uid: string, other: string): Promise<ConversationDoc> {
    if (uid === other) throw badRequest('You cannot message yourself');
    await this.ctx.services.users.get(other);
    const key = pairKey(uid, other);
    const now = this.ctx.clock.now();
    const res = await this.ctx.col.conversations.findOneAndUpdate(
      { key },
      {
        $setOnInsert: {
          _id: new ObjectId(),
          key,
          participants: [uid, other].sort() as [string, string],
          lastMessage: null,
          unread: { [uid]: 0, [other]: 0 },
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return res!;
  }

  async send(senderId: string, input: z.infer<typeof sendMessageInput>): Promise<ChatMessage> {
    if (await this.ctx.services.users.isBlockedEitherWay(senderId, input.toUserId))
      throw forbidden('You cannot message this user');
    const text = input.text
      ? await this.ctx.services.moderation.assertClean(input.text, 'message')
      : null;
    const conv = await this.conversationWith(senderId, input.toUserId);
    const now = this.ctx.clock.now();
    const doc: MessageDoc = {
      _id: new ObjectId(),
      conversationId: conv._id,
      senderId,
      type: input.type,
      text,
      mediaUrl: input.mediaUrl,
      clientId: input.clientId,
      deletedFor: [],
      createdAt: now,
    };
    try {
      await this.ctx.col.messages.insertOne(doc);
    } catch (err) {
      // Client retry with the same clientId: return the stored message.
      if (isDuplicateKeyError(err) && input.clientId) {
        const existing = await this.ctx.col.messages.findOne({
          conversationId: conv._id,
          senderId,
          clientId: input.clientId,
        });
        if (existing) return toChatMessage(existing);
      }
      throw err;
    }
    await this.ctx.col.conversations.updateOne(
      { _id: conv._id },
      {
        $set: {
          lastMessage: { text: text ?? '📷 Photo', senderId, type: input.type, at: now },
          updatedAt: now,
        },
        $inc: { [`unread.${input.toUserId}`]: 1 },
      },
    );
    const message = toChatMessage(doc);
    this.ctx.realtime.toUser(
      SOCKET.namespaces.app,
      input.toUserId,
      SOCKET.app.chatMessage,
      message,
    );
    this.ctx.realtime.toUser(SOCKET.namespaces.app, senderId, SOCKET.app.chatMessage, message);

    const sender = await this.ctx.col.users.findOne(
      { _id: senderId },
      { projection: { displayName: 1 } },
    );
    await this.ctx.jobs.enqueue('push.user', {
      userId: input.toUserId,
      title: sender?.displayName ?? 'New message',
      body: text ?? '📷 Photo',
      data: { type: 'chat', conversationId: String(conv._id), senderId },
    });
    return message;
  }

  async conversations(uid: string, cursor: string | undefined, limit: number) {
    const rows = await this.ctx.col.conversations
      .find({ participants: uid, lastMessage: { $ne: null }, ...afterCursor(cursor, 'updatedAt') })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const others = page.map((c) =>
      c.participants[0] === uid ? c.participants[1] : c.participants[0],
    );
    const briefs = await this.ctx.services.users.briefs(others);
    const last = page.at(-1);
    return {
      items: page.map((c, i) => ({
        id: String(c._id),
        peer: briefs.get(others[i]!) ?? null,
        lastMessage: c.lastMessage
          ? { ...c.lastMessage, at: c.lastMessage.at.toISOString() }
          : null,
        unread: c.unread[uid] ?? 0,
        updatedAt: c.updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last ? encodeCursor(last.updatedAt, String(last._id)) : null,
    };
  }

  private async assertParticipant(uid: string, conversationId: ObjectId): Promise<ConversationDoc> {
    const conv = await this.ctx.col.conversations.findOne({ _id: conversationId });
    if (!conv || !conv.participants.includes(uid)) throw notFound('Conversation');
    return conv;
  }

  async messages(uid: string, conversationId: ObjectId, cursor: string | undefined, limit: number) {
    await this.assertParticipant(uid, conversationId);
    const rows = await this.ctx.col.messages
      .find({ conversationId, deletedFor: { $ne: uid }, ...afterCursor(cursor) })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toChatMessage),
      nextCursor:
        rows.length > limit && last ? encodeCursor(last.createdAt, String(last._id)) : null,
    };
  }

  async markRead(uid: string, conversationId: ObjectId): Promise<void> {
    const conv = await this.assertParticipant(uid, conversationId);
    await this.ctx.col.conversations.updateOne(
      { _id: conversationId },
      { $set: { [`unread.${uid}`]: 0 } },
    );
    const peer = conv.participants[0] === uid ? conv.participants[1] : conv.participants[0];
    this.ctx.realtime.toUser(SOCKET.namespaces.app, peer, SOCKET.app.chatRead, {
      conversationId: String(conversationId),
      by: uid,
      at: this.ctx.clock.now().toISOString(),
    });
  }

  async deleteMessage(uid: string, messageId: ObjectId): Promise<void> {
    const msg = await this.ctx.col.messages.findOne({ _id: messageId });
    if (!msg) throw notFound('Message');
    await this.assertParticipant(uid, msg.conversationId);
    await this.ctx.col.messages.updateOne({ _id: messageId }, { $addToSet: { deletedFor: uid } });
  }

  async unreadTotal(uid: string): Promise<number> {
    const [row] = await this.ctx.col.conversations
      .aggregate<{ total: number }>([
        { $match: { participants: uid } },
        { $group: { _id: null, total: { $sum: { $ifNull: [`$unread.${uid}`, 0] } } } },
      ])
      .toArray();
    return row?.total ?? 0;
  }

  async isParticipant(uid: string, conversationId: string): Promise<string | null> {
    if (!ObjectId.isValid(conversationId)) return null;
    const conv = await this.ctx.col.conversations.findOne(
      { _id: new ObjectId(conversationId), participants: uid },
      { projection: { participants: 1 } },
    );
    if (!conv) return null;
    return conv.participants[0] === uid ? conv.participants[1] : conv.participants[0];
  }
}
