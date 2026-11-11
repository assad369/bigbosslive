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
import { LiveSummaryService } from './modules/live/live-summary.service.js';
import { MaintenanceService } from './modules/config/maintenance.service.js';
import { ModerationService } from './modules/moderation/moderation.service.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { PkService } from './modules/pk/pk.service.js';
import { PlatformModeratorsService } from './modules/moderation/platform-moderators.service.js';
import { StorageSettingsService } from './modules/config/storage-settings.service.js';
import { ShareService } from './modules/share/share.service.js';
import { SightGuardEventsService } from './modules/sightguard/sightguard-events.service.js';
import { SightGuardService } from './modules/sightguard/sightguard.service.js';
import { StoreService } from './modules/store/store.service.js';
import { UsersService } from './modules/users/users.service.js';
import { TierPackagesService } from './modules/vip/tier-packages.service.js';
import { IapService } from './modules/wallet/iap.service.js';
import { WalletService } from './modules/wallet/wallet.service.js';
import { WithdrawalsService } from './modules/withdrawals/withdrawals.service.js';
import { YouTubeService } from './modules/youtube/youtube.service.js';

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
  liveSummary: LiveSummaryService;
  maintenance: MaintenanceService;
  moderation: ModerationService;
  notifications: NotificationsService;
  pk: PkService;
  platformModerators: PlatformModeratorsService;
  share: ShareService;
  sightguard: SightGuardService;
  sightguardEvents: SightGuardEventsService;
  stats: StatsService;
  storageSettings: StorageSettingsService;
  store: StoreService;
  tierPackages: TierPackagesService;
  users: UsersService;
  wallet: WalletService;
  withdrawals: WithdrawalsService;
  youtube: YouTubeService;
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
    liveSummary: new LiveSummaryService(ctx),
    maintenance: new MaintenanceService(ctx),
    moderation: new ModerationService(ctx),
    notifications: new NotificationsService(ctx),
    pk: new PkService(ctx),
    platformModerators: new PlatformModeratorsService(ctx),
    share: new ShareService(ctx),
    sightguard: new SightGuardService(ctx),
    sightguardEvents: new SightGuardEventsService(ctx),
    stats: new StatsService(ctx),
    storageSettings: new StorageSettingsService(ctx),
    store: new StoreService(ctx),
    tierPackages: new TierPackagesService(ctx),
    users: new UsersService(ctx),
    wallet: new WalletService(ctx),
    withdrawals: new WithdrawalsService(ctx),
    youtube: new YouTubeService(ctx),
  };
}
