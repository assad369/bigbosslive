import { Tabs } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/common';
import { GamesCatalog } from './GamesCatalog';
import { GamesOverview } from './GamesOverview';
import { GamesPlayers } from './GamesPlayers';
import { GamesSettings } from './GamesSettings';
import { GamesTransactions } from './GamesTransactions';

const TABS = ['overview', 'catalog', 'transactions', 'players', 'settings'] as const;
type Tab = (typeof TABS)[number];

/** AsadSoft games: platform win/loss, the catalogue and its switches, every wallet call. */
export function GamesPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as Tab)
    : 'overview';

  return (
    <>
      <PageHeader
        title="Games"
        subtitle="AsadSoft games: players stake diamonds from their wallet. Positive GGR is the platform's win."
      />
      <Tabs
        activeKey={tab}
        onChange={(t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
        destroyOnHidden
        items={[
          { key: 'overview', label: 'Overview', children: <GamesOverview /> },
          { key: 'catalog', label: 'Catalogue', children: <GamesCatalog /> },
          { key: 'transactions', label: 'Transactions', children: <GamesTransactions /> },
          { key: 'players', label: 'Players', children: <GamesPlayers /> },
          { key: 'settings', label: 'Settings', children: <GamesSettings /> },
        ]}
      />
    </>
  );
}
