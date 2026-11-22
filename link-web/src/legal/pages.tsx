import type { FC, PropsWithChildren } from 'hono/jsx';
import type { View } from '../pages.js';
import { OPERATOR as O } from './operator.js';

/** Legal pages change rarely; an hour of caching keeps them cheap and fresh enough. */
const LEGAL_MAX_AGE = 3600;

export const LEGAL_PAGES = [
  { path: '/legal/terms', title: 'Terms of Service' },
  { path: '/legal/privacy', title: 'Privacy Policy' },
  { path: '/legal/community-guidelines', title: 'Community Guidelines' },
  { path: '/legal/child-safety', title: 'Child Safety Standards' },
  { path: '/legal/refunds', title: 'Purchases and Refunds' },
  { path: '/delete-account', title: 'Delete your account' },
] as const;

const Doc: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <main class="card doc">
    <div class="body">
      <h1>{title}</h1>
      <p class="muted">
        {O.appName} · operated by {O.name} · effective {O.effectiveDate}
      </p>
      {children}
      <nav class="legal-nav" aria-label="Legal">
        {LEGAL_PAGES.map((p) => (
          <a href={p.path}>{p.title}</a>
        ))}
      </nav>
    </div>
  </main>
);

const Mail: FC<{ to: string }> = ({ to }) => <a href={`mailto:${to}`}>{to}</a>;

function legalView(title: string, description: string, body: unknown, noindex = false): View {
  return {
    status: 200,
    title: `${title} · ${O.appName}`,
    description,
    image: null,
    noindex,
    openInApp: false,
    maxAge: LEGAL_MAX_AGE,
    body,
  };
}

export function legalIndexView(): View {
  return legalView(
    'Legal',
    `Terms, privacy and safety policies for ${O.appName}.`,
    <Doc title="Legal and safety">
      <p>
        These documents govern your use of {O.appName}. Questions go to <Mail to={O.supportEmail} />
        .
      </p>
      <ul>
        {LEGAL_PAGES.map((p) => (
          <li>
            <a href={p.path}>{p.title}</a>
          </li>
        ))}
      </ul>
    </Doc>,
  );
}

export function termsView(): View {
  return legalView(
    'Terms of Service',
    `The rules for using ${O.appName}.`,
    <Doc title="Terms of Service">
      <p>
        These Terms are an agreement between you and {O.name} ({O.address}, {O.country}) for the use
        of the {O.appName} app and related services ("{O.appName}"). By creating an account you
        accept these Terms, the <a href="/legal/community-guidelines">Community Guidelines</a>, the{' '}
        <a href="/legal/child-safety">Child Safety Standards</a> and the{' '}
        <a href="/legal/privacy">Privacy Policy</a>. If you do not accept them, do not use{' '}
        {O.appName}.
      </p>

      <h2>1. Who may use {O.appName}</h2>
      <p>
        You must be <b>18 or older</b>. We ask for your date of birth when you join and lock any
        account that gives a date under 18. We remove accounts we believe belong to someone under
        18. You may hold one account for yourself only, and you are responsible for everything done
        with it.
      </p>

      <h2>2. Your content and conduct</h2>
      <p>
        You can go live, chat, send messages, share photos, voice messages and posts. You keep
        ownership of what you create, and you give us a worldwide, non-exclusive, royalty-free
        licence to host, show, transmit and moderate it so the service works. You must have the
        rights to anything you share.
      </p>
      <p>
        <b>We have zero tolerance for objectionable content and abusive users.</b> You must not
        share or do anything the Community Guidelines prohibit, including sexual content involving
        minors, nudity or pornography, harassment, hate, threats, violence, self-harm promotion,
        illegal goods, scams, spam, impersonation, or content that infringes someone else's rights.
        Anyone can report content or a user from inside the app and block other users. We review
        reports, remove content that breaks these rules, and suspend or permanently ban accounts and
        devices that break them.
      </p>

      <h2>3. Moderation</h2>
      <p>
        To keep people safe we review content automatically and with human moderators, including
        live video and audio, chat, messages, photos and profile details. We may remove content, end
        a live, restrict features, or suspend an account, with or without notice, when we believe it
        breaks these Terms or the law. Platform moderators appointed by us may act in any live room.
        We report child sexual abuse material to the authorities.
      </p>

      <h2>4. Diamonds</h2>
      <p>
        Diamonds are {O.appName}'s virtual currency. You can buy them in the app through Google Play
        or the App Store, or from an official {O.appName} agent. Purchases from an agent are made
        with the agent, not through the app store. Diamonds are used for gifts, items, memberships
        and games in {O.appName}.
      </p>
      <p>
        Diamonds you hold, including diamonds received as gifts, can be withdrawn as money at the
        rate and minimum shown in the app at the time of the request, through the payout methods the
        app offers. Every withdrawal is reviewed. We may ask you to verify your identity and may
        refuse or delay a withdrawal connected to fraud, chargebacks, refunds, money laundering, a
        breach of these Terms, or a legal restriction. We may change the rate, minimum and methods
        for future requests. A platform fee and, for agency members, an agency fee are taken from
        gifts received, as shown in the app.
      </p>
      <p>
        Diamonds are not a bank deposit and earn no interest. If your account is deleted or
        permanently banned for breaking these Terms, diamonds left in it are forfeited, except where
        the law requires otherwise.
      </p>

      <h2>5. Games</h2>
      <p>
        {O.appName} offers games supplied by a third-party provider. Some are games of chance: you
        stake diamonds and can lose them. Games are for adults only, may be unavailable in some
        places, and you are responsible for making sure playing is legal where you are. We may
        limit, suspend or close games, or block an account from them, at any time. Play responsibly,
        and stop if it stops being fun.
      </p>

      <h2>6. Purchases</h2>
      <p>
        In-app purchases are processed by Google Play or the App Store under their terms. Refunds
        are described in <a href="/legal/refunds">Purchases and Refunds</a>. Memberships (VIP and
        other tiers) and decorations bought with diamonds last for the period shown when you buy
        them and do not renew automatically.
      </p>

      <h2>7. Agencies and agents</h2>
      <p>
        Hosts may join an agency, whose owner earns a commission on gifts the host receives, as
        shown in the app. Agents may resell diamonds. Agencies and agents are independent: they are
        not our employees, and arrangements you make with them are between you and them.
      </p>

      <h2>8. Ending your account</h2>
      <p>
        You can delete your account at any time in the app (Settings → Delete account) or on the{' '}
        <a href="/delete-account">account deletion page</a>. We may suspend or end your access if
        you break these Terms or the law, or to protect other users.
      </p>

      <h2>9. Disclaimers and liability</h2>
      <p>
        {O.appName} is provided "as is". To the extent the law allows, we are not liable for
        indirect or consequential losses, for content other users share, or for outages. Nothing in
        these Terms limits rights you have under consumer law that cannot be waived.
      </p>

      <h2>10. Changes and law</h2>
      <p>
        We may update these Terms. When the change is material, the app asks you to accept the new
        version before you continue. These Terms are governed by {O.governingLaw}.
      </p>

      <h2>Contact</h2>
      <p>
        {O.name}, {O.address}, {O.country}. Email: <Mail to={O.supportEmail} />.
      </p>
    </Doc>,
  );
}

export function privacyView(): View {
  return legalView(
    'Privacy Policy',
    `How ${O.appName} collects, uses and shares your data.`,
    <Doc title="Privacy Policy">
      <p>
        This policy explains what data {O.name} ("we") collects when you use {O.appName}, why, who
        we share it with, how long we keep it, and your choices. {O.name} is responsible for your
        data. Contact us at <Mail to={O.privacyEmail} />.
      </p>

      <h2>Data we collect</h2>
      <ul>
        <li>
          <b>Account:</b> your phone number, or the email address, name and photo from Google or
          Apple sign-in; a user ID and a public numeric ID.
        </li>
        <li>
          <b>Profile:</b> display name, photo, bio, gender, country and date of birth. Your date of
          birth is used to confirm you are 18 or older and is never shown to others.
        </li>
        <li>
          <b>Content you create:</b> live video and audio, live chat and voice messages, private
          messages and photos, posts and comments, room covers and backgrounds, reports you make.
        </li>
        <li>
          <b>Activity:</b> who you follow and block, lives you join, gifts you send and receive,
          reactions, levels, memberships, items, and game play (stakes and results).
        </li>
        <li>
          <b>Purchases and payouts:</b> your diamond purchases (Google Play and App Store send us a
          receipt, never your card details), your diamond balance and history, and for withdrawals
          the payout details you enter (for example a mobile wallet or bank account number, the
          account holder's name, or a PayPal email).
        </li>
        <li>
          <b>Device and technical data:</b> a random ID created when the app is installed, a push
          notification token, platform, app version, device model and operating system, IP address,
          and crash reports.
        </li>
      </ul>
      <p>
        We do not collect your precise location, contacts or advertising ID, and we show no ads. The
        app uses your camera and microphone only when you go live, join a stage or record a voice
        message, and your photos only when you pick one.
      </p>

      <h2>How we use it</h2>
      <ul>
        <li>To run {O.appName}: accounts, lives, chat, messages, gifts, games and payouts.</li>
        <li>
          To keep people safe: automated and human review of content (including live video, audio,
          images and text), age checks, handling reports, and preventing fraud and ban evasion.
        </li>
        <li>
          To process purchases, credit diamonds, review withdrawals and keep financial records.
        </li>
        <li>To send notifications you can turn off in your phone's settings.</li>
        <li>To fix crashes and improve the app.</li>
        <li>To comply with the law and respond to lawful requests.</li>
      </ul>

      <h2>What others can see</h2>
      <p>
        Your profile (name, photo, bio, numeric ID, country, gender, level, badges, followers) is
        public in the app. <b>Your diamond balance is public</b>: it appears on your profile and,
        while you are on stage in a live, to everyone in the room. Gifts you send in a live, your
        chat, and anything you broadcast are seen by the people in that room. Share links you create
        show a short preview on the web. Private messages are seen by you and the recipient, and by
        our moderators when needed for safety.
      </p>
      <p>
        Private messages may contain phone numbers. Be careful what you share with people you don't
        know.
      </p>

      <h2>Who we share it with</h2>
      <ul>
        <li>
          <b>Google Firebase</b> for sign-in, push notifications and crash reports.
        </li>
        <li>
          <b>Google Play and the Apple App Store</b> to process purchases.
        </li>
        <li>
          <b>LiveKit</b> to carry live audio and video.
        </li>
        <li>
          <b>SightGuard</b>, our content-moderation provider, which analyses live video and audio,
          images and text for policy violations.
        </li>
        <li>
          <b>Our games provider</b>, which receives your user ID, display name, photo and game
          activity when you play.
        </li>
        <li>
          <b>YouTube</b>, when a host plays music in a live (YouTube's own terms apply to the
          player).
        </li>
        <li>
          <b>Cloud hosting and storage providers</b> (including Cloudflare) that store our data and
          uploads.
        </li>
        <li>
          <b>Agency owners</b> see the earnings and live time of hosts in their agency.
        </li>
        <li>
          <b>Authorities</b>, when the law requires it. We report child sexual abuse material to the
          National Center for Missing &amp; Exploited Children (NCMEC) or the relevant authority.
        </li>
      </ul>
      <p>We do not sell your personal data.</p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Live chat: 7 days. Notifications and live viewer lists: 90 days.</li>
        <li>Push tokens: until you sign out, or 120 days without use.</li>
        <li>Your account, profile, messages and posts: until you delete them or your account.</li>
        <li>
          Purchases, gifts, game transactions and withdrawals: {O.financialRetention}, as financial
          law requires, even after you delete your account.
        </li>
        <li>
          Reports, moderation decisions and security logs: as long as needed to keep the service
          safe and meet legal duties. Evidence of child sexual abuse is preserved as the law
          requires.
        </li>
      </ul>

      <h2>Deleting your account</h2>
      <p>
        Delete your account in the app (Settings → Delete account), or ask on the{' '}
        <a href="/delete-account">account deletion page</a>. We then remove your profile details,
        follows, blocks, posts, comments, likes, the text and photos of messages you sent, your
        uploads and your sign-in. We keep the financial records and safety records described above.
        Diamonds left in the account are forfeited. A withdrawal under review must finish first.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct, delete or export
        your data, and to object to or restrict how we use it. Email <Mail to={O.privacyEmail} />.
        You can also complain to your data protection authority.
      </p>

      <h2>Children</h2>
      <p>
        {O.appName} is only for people 18 and older. We do not knowingly collect data from anyone
        younger. If we learn an account belongs to a minor, we lock and delete it. See our{' '}
        <a href="/legal/child-safety">Child Safety Standards</a>.
      </p>

      <h2>Security and transfers</h2>
      <p>
        Data travels encrypted (HTTPS/TLS) and access is limited to people who need it. Our
        providers may process data in other countries, with safeguards the law requires.
      </p>

      <h2>Changes</h2>
      <p>
        We will post changes here and, when they are material, ask you to accept them in the app.
      </p>
    </Doc>,
  );
}

export function guidelinesView(): View {
  return legalView(
    'Community Guidelines',
    `What is and isn't allowed on ${O.appName}.`,
    <Doc title="Community Guidelines">
      <p>
        {O.appName} is for adults to go live, chat and have fun together. These rules apply to
        lives, chat, voice messages, private messages, posts, comments, profiles, room covers and
        backgrounds. Breaking them can get content removed, a live ended, and an account or device
        banned.
      </p>

      <h2>Never allowed</h2>
      <ul>
        <li>
          <b>Anything that sexualises, exploits or endangers a minor</b>, including grooming. This
          is reported to the authorities. See the{' '}
          <a href="/legal/child-safety">Child Safety Standards</a>.
        </li>
        <li>Anyone under 18 using {O.appName}, or appearing on camera in a live.</li>
        <li>Nudity, sexual acts, pornography, or offering or soliciting sex.</li>
        <li>Harassment, bullying, threats, doxxing, or sharing someone's private information.</li>
        <li>Hate speech or attacks based on who someone is.</li>
        <li>Violence, gore, terrorism, or promoting self-harm or suicide.</li>
        <li>Selling or promoting drugs, weapons or other illegal goods and services.</li>
        <li>
          Scams, fraud, selling diamonds outside official channels, or tricking people into sending
          gifts.
        </li>
        <li>Spam, impersonation, fake accounts, or evading a ban.</li>
        <li>Content you don't have the rights to.</li>
      </ul>

      <h2>Report and block</h2>
      <p>
        Tap <b>Report</b> on a profile, a live, a chat message, a private message, a post or a
        comment. Tap <b>Block</b> to stop someone from messaging you, following you or joining your
        lives. To report a child safety concern, choose "Child sexual exploitation or endangerment",
        or go to Settings → Safety. Reports are confidential.
      </p>

      <h2>What we do</h2>
      <p>
        Moderators and automated tools review content and reports. Depending on how serious it is,
        we warn, remove content, mute or remove someone from a live, end a live, restrict features,
        suspend, or permanently ban an account and its devices. Child safety violations lead to a
        permanent ban and a report to the authorities.
      </p>
    </Doc>,
  );
}

export function childSafetyView(): View {
  return legalView(
    'Child Safety Standards',
    `${O.appName}'s standards against child sexual abuse and exploitation (CSAE).`,
    <Doc title="Child Safety Standards">
      <p>
        {O.name} has zero tolerance for child sexual abuse and exploitation (CSAE) on {O.appName}.
        These standards apply to every part of the app: lives, chat, voice messages, private
        messages, posts, comments, profiles and images.
      </p>

      <h2>What is prohibited</h2>
      <ul>
        <li>
          Child sexual abuse material (CSAM): any image, video, audio or text that depicts or
          describes a minor in a sexual way, including drawn, edited or AI-generated material.
        </li>
        <li>
          Grooming: building trust with a minor to sexually exploit them, asking a minor for sexual
          content, or arranging to meet a minor.
        </li>
        <li>Sexualising minors in any way, including comments, emojis or "jokes".</li>
        <li>Sextortion, trafficking, or advertising or requesting sexual services from minors.</li>
        <li>Sharing or asking for links to or ways of finding such material.</li>
      </ul>

      <h2>Minors are not allowed</h2>
      <p>
        {O.appName} is only for people 18 and older. Everyone gives their date of birth before using
        the app, and an account that gives an age under 18 is locked. Users can report someone who
        appears to be under 18, and we remove those accounts.
      </p>

      <h2>How to report</h2>
      <ul>
        <li>
          In the app: tap <b>Report</b> on the profile, live, message, post or comment and choose{' '}
          <b>Child sexual exploitation or endangerment</b>. You can also go to{' '}
          <b>Settings → Safety → Report a child safety concern</b>.
        </li>
        <li>
          By email: <Mail to={O.childSafetyEmail} />.
        </li>
        <li>
          If a child is in immediate danger, contact your local police or emergency services first.
          You can also report to the NCMEC CyberTipline at{' '}
          <a href="https://report.cybertip.org" rel="noopener">
            report.cybertip.org
          </a>
          .
        </li>
      </ul>

      <h2>What we do</h2>
      <ul>
        <li>
          Automated tools scan live video and audio, images and text, and child safety reports go to
          the top of our moderators' queue.
        </li>
        <li>
          We remove the content, end the live, and permanently ban the account and its devices.
        </li>
        <li>
          We preserve the evidence, and report confirmed CSAM to the National Center for Missing
          &amp; Exploited Children (NCMEC) and to the relevant authorities in {O.country}, as the
          law requires.
        </li>
        <li>We cooperate with law enforcement requests.</li>
      </ul>

      <h2>Child safety contact</h2>
      <p>
        {O.childSafetyContactName} is our designated child safety contact and can speak to our
        enforcement and review practices: <Mail to={O.childSafetyEmail} />.
      </p>
      <p>We comply with applicable child safety laws, including the laws of {O.country}.</p>
    </Doc>,
  );
}

export function refundsView(): View {
  return legalView(
    'Purchases and Refunds',
    `How purchases and refunds work on ${O.appName}.`,
    <Doc title="Purchases and Refunds">
      <h2>Diamonds bought in the app</h2>
      <p>
        Purchases on Android are processed by Google Play, and on iPhone by the App Store. To ask
        for a refund, use Google Play's refund process (play.google.com → Order history → Request a
        refund) or Apple's (reportaproblem.apple.com). Their refund rules apply.
      </p>
      <p>
        If a purchase is refunded or reversed, we may remove the diamonds it added, or the value of
        what they were spent on, from your account, and may refuse withdrawals until it is settled.
      </p>

      <h2>Diamonds bought from an agent</h2>
      <p>
        Purchases from an official agent are between you and the agent. Contact the agent first, and{' '}
        <Mail to={O.supportEmail} /> if you cannot resolve it.
      </p>

      <h2>Spending diamonds</h2>
      <p>
        Gifts, memberships, decorations and game stakes paid with diamonds are final once made,
        except where the law requires otherwise or we cancel something because of an error on our
        side. Memberships and decorations last for the period shown when you buy them and do not
        renew automatically.
      </p>

      <h2>Problems</h2>
      <p>
        If diamonds you paid for did not arrive, email <Mail to={O.supportEmail} /> with your
        numeric ID and the order number from your receipt.
      </p>
    </Doc>,
  );
}

/** The form and its outcome. `sent` and `error` are no-store, the empty form is cached. */
export type DeletionFormState =
  | { kind: 'form'; contact?: string; reason?: string; problem?: string }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

export function deleteAccountView(state: DeletionFormState = { kind: 'form' }): View {
  const view = legalView(
    'Delete your account',
    `Delete your ${O.appName} account and data.`,
    <Doc title={`Delete your ${O.appName} account`}>
      <p>
        You can delete your {O.appName} account (developer: {O.name}) at any time.
      </p>
      <h2>Fastest: in the app</h2>
      <p>
        Open {O.appName}, go to <b>Me → Settings → Delete account</b>, and confirm. This works even
        if your account is banned.
      </p>

      <h2>Without the app</h2>
      {state.kind === 'sent' ? (
        <p class="notice">
          We received your request. We will match it to an account, may contact you to confirm it is
          yours, and delete the account within 30 days.
        </p>
      ) : (
        <form method="post" action="/delete-account" class="form">
          {state.kind === 'error' ? <p class="notice error">{state.message}</p> : null}
          {state.kind === 'form' && state.problem ? (
            <p class="notice error">{state.problem}</p>
          ) : null}
          <label for="contact">Phone number, email or numeric ID of the account</label>
          <input
            id="contact"
            name="contact"
            required
            minlength={3}
            maxlength={120}
            autocomplete="off"
            value={state.kind === 'form' ? (state.contact ?? '') : ''}
          />
          <label for="reason">Anything we should know (optional)</label>
          <textarea id="reason" name="reason" maxlength={500} rows={3}>
            {state.kind === 'form' ? (state.reason ?? '') : ''}
          </textarea>
          <button class="btn" type="submit">
            Request deletion
          </button>
          <p class="muted">
            Or email <Mail to={O.privacyEmail} /> from the email on your account.
          </p>
        </form>
      )}

      <h2>What is deleted</h2>
      <ul>
        <li>Your profile: name, photo, bio, phone, email, date of birth, gender and country.</li>
        <li>Your follows, followers and blocks, posts, comments and likes.</li>
        <li>The text and photos of messages you sent, and the files you uploaded.</li>
        <li>Your sign-in, so the account can't be used again.</li>
      </ul>
      <h2>What is kept</h2>
      <ul>
        <li>
          Purchase, gift, game and withdrawal records, for {O.financialRetention}, as financial law
          requires.
        </li>
        <li>
          Reports and moderation and security records, and evidence of child sexual abuse, as long
          as safety and the law require.
        </li>
      </ul>
      <p>
        Diamonds left in the account are forfeited. If a withdrawal is under review, it has to
        finish before the account can be deleted.
      </p>
    </Doc>,
    // A form page for people, not search engines.
    true,
  );
  return state.kind === 'form' && !state.problem ? view : { ...view, maxAge: 0 };
}
