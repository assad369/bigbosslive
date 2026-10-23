import { ObjectId } from 'mongodb';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import type { BannerDoc } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';

export const bannerInput = z.object({
  title: z.string().trim().min(1).max(80),
  imageUrl: z.url(),
  linkUrl: z.string().max(2048).nullable().default(null),
  placement: z.enum(['home', 'live', 'wallet', 'games']).default('home'),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
  startsAt: z.coerce.date().nullable().default(null),
  endsAt: z.coerce.date().nullable().default(null),
});

export class BannersService {
  constructor(private readonly ctx: Ctx) {}

  async active(placement: BannerDoc['placement']) {
    const now = this.ctx.clock.now();
    const docs = await this.ctx.col.banners
      .find({
        placement,
        active: true,
        $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }],
      })
      .sort({ sortOrder: 1 })
      .limit(20)
      .toArray();
    return docs.map((b) => ({ id: String(b._id), title: b.title, imageUrl: b.imageUrl, linkUrl: b.linkUrl }));
  }

  async all() {
    return this.ctx.col.banners.find().sort({ placement: 1, sortOrder: 1 }).toArray();
  }

  async upsert(id: ObjectId | null, input: z.infer<typeof bannerInput>): Promise<BannerDoc> {
    if (!id) {
      const doc: BannerDoc = { _id: new ObjectId(), ...input, createdAt: this.ctx.clock.now() };
      await this.ctx.col.banners.insertOne(doc);
      return doc;
    }
    const res = await this.ctx.col.banners.findOneAndUpdate({ _id: id }, { $set: input }, { returnDocument: 'after' });
    if (!res) throw notFound('Banner');
    return res;
  }

  async remove(id: ObjectId): Promise<void> {
    const res = await this.ctx.col.banners.deleteOne({ _id: id });
    if (!res.deletedCount) throw notFound('Banner');
  }
}
