import { ApiError, useAuth } from '@yatri/mobile-auth';
import { ActionButton, Announcer, Card, type UiProps } from '@yatri/mobile-ride';
import { useNews, usePolled } from '@yatri/mobile-support';
import type { LedgerEntryInfo } from '@yatri/types';
import { useCallback, useState } from 'react';
import { Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { rewardsApi } from '../rewardsApi';
import {
  NO_HISTORY_TEXT,
  NO_OFFERS_TEXT,
  balanceSentence,
  codeResultSentence,
  historyLine,
  howPointsWork,
  offerLine,
  referralSentences,
} from '../rewardsText';

const problem = (e: unknown) =>
  e instanceof ApiError
    ? e.message
    : 'That did not work. Please check your connection and try again.';

/**
 * Offers, reward points and invites, for a rider, on one screen. Every figure and rule comes from the server: the
 * balance, what an offer does, whether a code works and what an invite is worth. Each part is a heading with plain
 * sentences (nothing depends on colour or on an icon), results of a typed code are announced, and a refusal is read as
 * a problem in words. Nothing here works out an amount.
 */
export function RewardsCenter(props: UiProps & { onExit: () => void }) {
  const { colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  const { getAccessToken } = useAuth();
  const [news, say] = useNews();

  const summary = usePolled(async () => rewardsApi.rewards(await getAccessToken()), null);
  const offers = usePolled(async () => rewardsApi.offers(await getAccessToken()), null);
  const referral = usePolled(async () => rewardsApi.referral(await getAccessToken()), null);
  const first = usePolled(async () => rewardsApi.history(await getAccessToken()), null);

  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [codeResult, setCodeResult] = useState<string | null>(null);
  const [invite, setInvite] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [extra, setExtra] = useState<LedgerEntryInfo[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await rewardsApi.checkCode(await getAccessToken(), code);
      const text = codeResultSentence(r);
      setCodeResult(text);
      say(text);
    } catch (e) {
      setCodeResult(problem(e));
      say(problem(e));
    } finally {
      setChecking(false);
    }
  }, [code, getAccessToken, say]);

  const useInvite = useCallback(async () => {
    setInviteBusy(true);
    try {
      const r = await rewardsApi.applyReferral(await getAccessToken(), invite);
      say(r.message);
      setInvite('');
      void referral.reload();
      void offers.reload();
    } catch (e) {
      say(problem(e));
    } finally {
      setInviteBusy(false);
    }
  }, [invite, getAccessToken, say, referral, offers]);

  const more = useCallback(async () => {
    const before = next === undefined ? (first.data?.nextBefore ?? null) : next;
    if (!before) return;
    try {
      const page = await rewardsApi.history(await getAccessToken(), before);
      setExtra((x) => [...x, ...page.items]);
      setNext(page.nextBefore);
    } catch (e) {
      say(problem(e));
    }
  }, [next, first.data, getAccessToken, say]);

  const history = [...(first.data?.items ?? []), ...extra];
  const nextBefore = next === undefined ? (first.data?.nextBefore ?? null) : next;

  return (
    <View style={styles.container}>
      <Announcer {...ui} polite={news} />

      <Card {...ui} title="Your reward points">
        {summary.error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: colors.error }}
          >{`Problem: ${summary.error}`}</Text>
        ) : summary.data ? (
          <>
            <Text
              accessibilityRole="text"
              style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '700' }}
            >
              {balanceSentence(summary.data)}
            </Text>
            <Text style={{ color: colors.textSecondary }}>{howPointsWork(summary.data)}</Text>
          </>
        ) : (
          <Text style={{ color: colors.textSecondary }}>Loading your points…</Text>
        )}
      </Card>

      <Card {...ui} title="Offers for you">
        {offers.error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: colors.error }}
          >{`Problem: ${offers.error}`}</Text>
        ) : offers.data ? (
          offers.data.length === 0 ? (
            <Text style={{ color: colors.textPrimary }}>{NO_OFFERS_TEXT}</Text>
          ) : (
            offers.data.map((o) => (
              <Text
                key={o.campaignId}
                accessibilityRole="text"
                style={{ color: colors.textPrimary }}
              >
                {offerLine(o)}
              </Text>
            ))
          )
        ) : (
          <Text style={{ color: colors.textSecondary }}>Loading offers…</Text>
        )}
        <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Have a promo code?</Text>
        <TextInput
          accessibilityLabel="Promo code"
          value={code}
          onChangeText={(v) => setCode(v.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={20}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
        />
        <ActionButton
          {...ui}
          label="Check the code"
          busy={checking}
          disabled={code.trim() === ''}
          onPress={() => void check()}
        />
        {codeResult ? (
          <Text accessibilityRole="text" style={{ color: colors.textPrimary }}>
            {codeResult}
          </Text>
        ) : null}
      </Card>

      <Card {...ui} title="Invite friends">
        {referral.error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: colors.error }}
          >{`Problem: ${referral.error}`}</Text>
        ) : referral.data ? (
          <>
            {referralSentences(referral.data).map((s) => (
              <Text key={s} style={{ color: colors.textPrimary }}>
                {s}
              </Text>
            ))}
            <ActionButton
              {...ui}
              label="Share my invite code"
              hint="Opens the share sheet with your code in a message"
              onPress={() => void Share.share({ message: referral.data?.shareText ?? '' })}
            />
            {!referral.data.usedInvite ? (
              <>
                <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
                  Were you invited? Enter your friend&apos;s code.
                </Text>
                <TextInput
                  accessibilityLabel="A friend's invite code"
                  value={invite}
                  onChangeText={(v) => setInvite(v.toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={8}
                  style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
                />
                <ActionButton
                  {...ui}
                  label="Use this invite code"
                  busy={inviteBusy}
                  disabled={invite.trim().length !== 8}
                  onPress={() => void useInvite()}
                />
              </>
            ) : (
              <Text style={{ color: colors.textSecondary }}>You have used an invite code.</Text>
            )}
            {referral.data.referrals.map((r, i) => (
              <Text key={`${r.invitedAt}-${i}`} style={{ color: colors.textSecondary }}>
                {`Friend invited ${new Date(r.invitedAt).toLocaleDateString()}: ${r.statusText}.`}
              </Text>
            ))}
          </>
        ) : (
          <Text style={{ color: colors.textSecondary }}>Loading your invite code…</Text>
        )}
      </Card>

      <Card {...ui} title="Points history">
        {first.error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: colors.error }}
          >{`Problem: ${first.error}`}</Text>
        ) : history.length === 0 && first.data ? (
          <Text style={{ color: colors.textPrimary }}>{NO_HISTORY_TEXT}</Text>
        ) : (
          history.map((e) => (
            <Text key={e.id} accessibilityRole="text" style={{ color: colors.textPrimary }}>
              {historyLine(e)}
            </Text>
          ))
        )}
        {nextBefore ? (
          <ActionButton {...ui} label="Show older entries" onPress={() => void more()} />
        ) : null}
      </Card>

      <ActionButton {...ui} label="Back" onPress={props.onExit} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 14 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    minHeight: 48,
    fontSize: 18,
    letterSpacing: 1,
  },
});
