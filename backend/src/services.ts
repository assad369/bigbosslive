import type { Ctx } from './context.js';
import { AgenciesService } from './modules/agencies/agencies.service.js';
import { AuditService } from './modules/admin/audit.service.js';
import { StatsService } from './modules/admin/stats.service.js';
import { BannersService } from './modules/banners/banners.service.js';
import { ChatService } from './modules/chat/chat.service.js';
import { ConfigService } from './modules/config/config.service.js';
import { FeedService } from './modules/feed/feed.service.js';
import { FollowsService } from './modules/follows/follows.service.js';
import { GamesService } from './modules/games/games.service.js';
import { GiftsService } from './modules/gifts/gifts.service.js';
import { LevelsService } from './modules/levels/levels.service.js';
import { LiveService } from './modules/live/live.service.js';
import { ModerationService } from './modules/moderation/moderation.service.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { PkService } from './modules/pk/pk.service.js';
import { StoreService } from './modules/store/store.service.js';
import { UsersService } from './modules/users/users.service.js';
import { IapService } from './modules/wallet/iap.service.js';
import { WalletService } from './modules/wallet/wallet.service.js';
import { WithdrawalsService } from './modules/withdrawals/withdrawals.service.js';

export interface Services {
  agencies: AgenciesService;
  audit: AuditService;
  banners: BannersService;
  chat: ChatService;
  config: ConfigService;
  feed: FeedService;
  follows: FollowsService;
  games: GamesService;
  gifts: GiftsService;
  iap: IapService;
  levels: LevelsService;
  live: LiveService;
  moderation: ModerationService;
  notifications: NotificationsService;
  pk: PkService;
  stats: StatsService;
  store: StoreService;
  users: UsersService;
  wallet: WalletService;
  withdrawals: WithdrawalsService;
}

/**
 * Services reference each other through `ctx.services`, resolved at call time, so the
 * construction order does not matter and there are no import cycles between modules.
 */
export function createServices(ctx: Ctx): Services {
  return {
    agencies: new AgenciesService(ctx),
    audit: new AuditService(ctx),
    banners: new BannersService(ctx),
    chat: new ChatService(ctx),
    config: new ConfigService(ctx),
    feed: new FeedService(ctx),
    follows: new FollowsService(ctx),
    games: new GamesService(ctx),
    gifts: new GiftsService(ctx),
    iap: new IapService(ctx),
    levels: new LevelsService(ctx),
    live: new LiveService(ctx),
    moderation: new ModerationService(ctx),
    notifications: new NotificationsService(ctx),
    pk: new PkService(ctx),
    stats: new StatsService(ctx),
    store: new StoreService(ctx),
    users: new UsersService(ctx),
    wallet: new WalletService(ctx),
    withdrawals: new WithdrawalsService(ctx),
  };
}
