import { io, type Socket } from 'socket.io-client';
import { SOCKET, type GameKey, type GameRound } from '@bigboss/shared';
import { ApiError, getState, placeBet, type GameState } from './api';
import { apiOrigin, currentToken, embedded, postToApp, refreshToken } from './bridge';
import { sfx } from './sound';
import './styles.css';

export interface OptionMeta {
  label: string;
  icon: string;
  color: string;
}

export interface Stage {
  /** Betting is open: idle animation. */
  idle(): void;
  /** Outcome is locked: animate to it over `durationMs`. */
  reveal(outcome: string, reveal: Record<string, unknown> | undefined, durationMs: number): void;
}

export interface ClientGame {
  key: GameKey;
  title: string;
  rules: string[];
  options: Record<string, OptionMeta>;
  /** Grid columns for the option tiles. */
  columns: number;
  mountStage(el: HTMLElement): Stage;
}

const fmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/**
 * Shared game shell: HUD, betting grid, chips, timer and the round state machine. The server
 * is authoritative — this only renders `game:round` events and places bets over REST.
 */
export function startGame(def: ClientGame): void {
  const root = document.getElementById('app')!;
  root.className = `bb-game bb-${def.key}`;

  // ── Layout ──────────────────────────────────────────────────────────────
  const header = h('header', 'bb-header');
  const close = h('button', 'bb-icon-btn', '✕');
  close.setAttribute('aria-label', 'Close');
  close.onclick = () => (embedded ? postToApp({ type: 'close' }) : history.back());
  const title = h('h1', 'bb-title', def.title);
  const balance = h('button', 'bb-balance');
  balance.onclick = () => postToApp({ type: 'recharge' });
  const rulesBtn = h('button', 'bb-icon-btn', '?');
  rulesBtn.setAttribute('aria-label', 'Rules');
  header.append(close, title, balance, rulesBtn);

  const stageEl = h('section', 'bb-stage');
  const status = h('div', 'bb-status');
  const timerBar = h('div', 'bb-timer');
  const timerFill = h('div', 'bb-timer-fill');
  timerBar.append(timerFill);
  stageEl.append(status, timerBar);

  const grid = h('section', 'bb-grid');
  grid.style.gridTemplateColumns = `repeat(${def.columns}, 1fr)`;
  const tiles = new Map<string, { el: HTMLButtonElement; pot: HTMLElement; mine: HTMLElement }>();
  for (const [key, meta] of Object.entries(def.options)) {
    const el = h('button', 'bb-tile') as HTMLButtonElement;
    el.style.setProperty('--tile', meta.color);
    const icon = h('div', 'bb-tile-icon', meta.icon);
    const label = h('div', 'bb-tile-label', meta.label);
    const mult = h('div', 'bb-tile-mult');
    mult.dataset.key = key;
    const pot = h('div', 'bb-tile-pot');
    const mine = h('div', 'bb-tile-mine');
    el.append(icon, label, mult, pot, mine);
    el.onclick = () => void bet(key);
    grid.append(el);
    tiles.set(key, { el, pot, mine });
  }

  const chipsRow = h('section', 'bb-chips');
  const historyRow = h('section', 'bb-history');
  const toast = h('div', 'bb-toast');
  const rules = h('dialog', 'bb-rules');
  rules.innerHTML = `<h2>How to play</h2><ul>${def.rules.map((r) => `<li>${r}</li>`).join('')}</ul><p class="bb-fair">Provably fair: each round publishes sha256(serverSeed) before betting and reveals the seed after settlement.</p><button class="bb-btn">Got it</button>`;
  rules.querySelector('button')!.addEventListener('click', () => rules.close());
  rulesBtn.onclick = () => rules.showModal();

  root.append(header, stageEl, grid, chipsRow, historyRow, toast, rules);
  const stage = def.mountStage(stageEl);

  // ── State ───────────────────────────────────────────────────────────────
  let state: GameState | null = null;
  let round: GameRound | null = null;
  let myBets: Record<string, number> = {};
  let chip = 0;
  let clockOffset = 0;
  let diamonds = 0;
  let lastRevealed: string | null = null;
  const serverNow = () => Date.now() + clockOffset;

  let toastTimer: number | undefined;
  function showToast(text: string, kind: 'info' | 'win' | 'error' = 'info') {
    toast.textContent = text;
    toast.className = `bb-toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.className = 'bb-toast'), 2600);
  }

  function renderBalance() {
    balance.innerHTML = `<span>💎</span> ${new Intl.NumberFormat('en-US').format(diamonds)} <b>+</b>`;
    postToApp({ type: 'balance', diamonds });
  }

  function renderChips() {
    chipsRow.replaceChildren(
      ...(state?.game.chips ?? []).map((c) => {
        const b = h('button', `bb-chip${c === chip ? ' active' : ''}`, fmt.format(c));
        b.onclick = () => {
          chip = c;
          sfx.tick();
          renderChips();
        };
        return b;
      }),
    );
  }

  function renderHistory() {
    historyRow.replaceChildren(
      h('span', 'bb-history-label', 'Recent'),
      ...(state?.history ?? []).slice(0, 12).map((r) => {
        const meta = def.options[r.outcome];
        const dot = h('span', 'bb-history-dot', meta?.icon ?? '·');
        dot.title = `#${r.roundNo} ${meta?.label ?? r.outcome}`;
        return dot;
      }),
    );
  }

  function renderTiles() {
    const open =
      round?.status === 'betting' && new Date(round.bettingEndsAt).getTime() > serverNow();
    for (const [key, t] of tiles) {
      t.pot.textContent = round ? fmt.format(round.totals[key] ?? 0) : '0';
      t.mine.textContent = myBets[key] ? `You ${fmt.format(myBets[key]!)}` : '';
      t.el.disabled = !open;
      t.el.classList.toggle('winner', round?.status !== 'betting' && round?.outcome === key);
      const mult = t.el.querySelector<HTMLElement>('.bb-tile-mult');
      if (mult && state) mult.textContent = `×${state.game.payouts[key] ?? ''}`;
    }
  }

  function applyRound(next: GameRound, reveal?: Record<string, unknown>) {
    const isNewRound = !round || round.id !== next.id;
    round = next;
    if (isNewRound) {
      myBets = {};
      lastRevealed = null;
    }
    if (next.status === 'betting') {
      stage.idle();
      status.textContent = 'Place your bets';
    } else if (next.status === 'locked' && next.outcome && lastRevealed !== next.id) {
      lastRevealed = next.id;
      status.textContent = 'No more bets';
      sfx.spin();
      stage.reveal(
        next.outcome,
        reveal ?? next.reveal ?? undefined,
        Math.max(1500, new Date(next.settlesAt).getTime() - serverNow() - 400),
      );
    } else if (next.status === 'settled' && next.outcome) {
      const meta = def.options[next.outcome];
      status.textContent = `${meta?.icon ?? ''} ${meta?.label ?? next.outcome} wins!`;
      if (state && state.history[0]?.roundNo !== next.roundNo) {
        state.history.unshift({ roundNo: next.roundNo, outcome: next.outcome });
        renderHistory();
      }
    }
    renderTiles();
  }

  async function bet(option: string) {
    if (!round || !chip) return;
    if (chip > diamonds) {
      showToast('Not enough diamonds — tap your balance to recharge', 'error');
      return;
    }
    // Optimistic: show the stake immediately, roll back on failure.
    myBets[option] = (myBets[option] ?? 0) + chip;
    diamonds -= chip;
    renderTiles();
    renderBalance();
    sfx.chip();
    try {
      const res = await placeBet(def.key, round.id, option, chip);
      diamonds = res.diamonds;
      renderBalance();
    } catch (err) {
      myBets[option] = Math.max(0, (myBets[option] ?? 0) - chip);
      diamonds += chip;
      renderTiles();
      renderBalance();
      showToast(err instanceof ApiError ? err.message : 'Bet failed', 'error');
    }
  }

  async function load() {
    try {
      state = await getState(def.key);
      clockOffset = new Date(state.serverTime).getTime() - Date.now();
      diamonds = state.diamonds;
      myBets = { ...state.myBets };
      chip = chip || state.game.chips[0] || 0;
      renderBalance();
      renderChips();
      renderHistory();
      if (state.round) applyRound(state.round);
      if (!state.game.enabled) status.textContent = 'This game is under maintenance';
    } catch (err) {
      status.textContent = err instanceof ApiError ? err.message : 'Unable to load the game';
    }
  }

  // Countdown bar, driven by server time.
  function tick() {
    if (round?.status === 'betting') {
      const end = new Date(round.bettingEndsAt).getTime();
      const total = Math.max(1, end - new Date(round.bettingStartedAt).getTime());
      const left = Math.max(0, end - serverNow());
      timerFill.style.width = `${Math.min(100, (left / total) * 100)}%`;
      status.dataset.timer = left > 0 ? `${Math.ceil(left / 1000)}s` : '';
      if (left === 0) renderTiles();
    } else {
      timerFill.style.width = '0%';
      status.dataset.timer = '';
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ── Realtime ────────────────────────────────────────────────────────────
  const socket: Socket = io(`${apiOrigin}${SOCKET.namespaces.games}`, {
    transports: ['websocket'],
    auth: (cb) => cb({ token: currentToken() }),
  });
  socket.on('connect', () => {
    socket.emit(SOCKET.games.subscribe, def.key, (s: GameState | null) => {
      if (s) void load();
    });
  });
  socket.on('connect_error', async (err) => {
    if (err.message === 'unauthorized') await refreshToken();
  });
  socket.on(SOCKET.games.round, (msg: { round: GameRound; reveal?: Record<string, unknown> }) => {
    if (msg.round.game !== def.key) return;
    applyRound(msg.round, msg.reveal);
    if (msg.round.status === 'settled')
      void getState(def.key).then((s) => {
        diamonds = s.diamonds;
        renderBalance();
      });
  });
  socket.on(SOCKET.games.totals, (msg: { roundId: string; totals: Record<string, number> }) => {
    if (round && msg.roundId === round.id) {
      round.totals = msg.totals;
      renderTiles();
    }
  });
  socket.on(SOCKET.games.settled, (msg: { payout: number }) => {
    sfx.win();
    showToast(`You won 💎 ${new Intl.NumberFormat('en-US').format(msg.payout)}!`, 'win');
  });

  void load();
  postToApp({ type: 'ready', game: def.key });
}
