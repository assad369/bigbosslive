import { ObjectId } from 'mongodb';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import type { RechargePackageDoc } from '../../db/schema.js';
import type { IapGateway } from '../../infra/iap.js';
import { conflict, notFound } from '../../lib/errors.js';

export const iapVerifyInput = z.discriminatedUnion('store', [
  z.object({ store: z.literal('google'), productId: z.string().min(1).max(200), purchaseToken: z.string().min(10).max(4096) }),
  z.object({ store: z.literal('apple'), transactionId: z.string().min(1).max(200) }),
]);

export const rechargePackageInput = z.object({
  sku: z.string().trim().min(1).max(100),
  diamonds: z.number().int().positive(),
  bonusDiamonds: z.number().int().min(0).default(0),
  priceUsd: z.number().positive(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

/** Store purchases of diamond packages, verified server-side with Google Play / App Store. */
export class IapService {
  constructor(private readonly ctx: Ctx) {}

  private get gateway(): IapGateway {
    return this.ctx.iap;
  }

  async packages(includeInactive = false): Promise<RechargePackageDoc[]> {
    return this.ctx.col.rechargePackages.find(includeInactive ? {} : { active: true }).sort({ sortOrder: 1, diamonds: 1 }).toArray();
  }

  async upsertPackage(id: ObjectId | null, input: z.infer<typeof rechargePackageInput>): Promise<RechargePackageDoc> {
    if (!id) {
      const doc: RechargePackageDoc = { _id: new ObjectId(), ...input };
      try {
        await this.ctx.col.rechargePackages.insertOne(doc);
      } catch (err) {
        if ((err as { code?: number }).code === 11000) throw conflict('SKU already exists');
        throw err;
      }
      return doc;
    }
    const res = await this.ctx.col.rechargePackages.findOneAndUpdate({ _id: id }, { $set: input }, { returnDocument: 'after' });
    if (!res) throw notFound('Package');
    return res;
  }

  async verifyAndCredit(uid: string, input: z.infer<typeof iapVerifyInput>) {
    const purchase =
      input.store === 'google'
        ? await this.gateway.verifyGoogle(input.productId, input.purchaseToken)
        : await this.gateway.verifyApple(input.transactionId);
    const pkg = await this.ctx.col.rechargePackages.findOne({ sku: purchase.productId });
    if (!pkg) throw notFound('Recharge package for this product');

    // The store transaction id is globally unique, so one purchase can only ever credit once —
    // even if replayed by another account.
    const { recharge, replayed } = await this.ctx.services.wallet.recharge({
      uid,
      diamonds: pkg.diamonds + pkg.bonusDiamonds,
      source: 'iap',
      note: `${purchase.store}:${purchase.productId}`,
      idempotencyKey: `iap:${purchase.store}:${purchase.transactionId}`,
    });
    if (replayed && recharge.userId !== uid) throw conflict('This purchase was already redeemed');
    if (input.store === 'google') {
      await this.gateway.consumeGoogle(input.productId, input.purchaseToken).catch((err: unknown) =>
        this.ctx.log.error({ err }, 'google consume failed; purchase credited but not consumed'),
      );
    }
    const { diamonds } = await this.ctx.services.wallet.balances(uid);
    return { credited: replayed ? 0 : recharge.diamonds, diamonds, replayed };
  }
}
