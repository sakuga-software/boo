import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { detailSections, type Line } from '../../../../pulls/detail';
import { usePullsContext } from '../../../../pulls/pulls-context';
import { stateView } from '../../../../pulls/view';
import { useRelayContext } from '../../../../relay/relay-context';
import { Button } from '../../../../ui/button';
import type { Palette } from '../../../../ui/theme';
import { useNow } from '../../../../ui/use-now';
import { usePalette } from '../../../../ui/use-palette';

// The details of one pull request: every part of an unfolded row of the list of boo in the terminal.
export default function PullDetail() {
  const palette = usePalette();
  const router = useRouter();
  const relay = useRelayContext();
  const { pulls, refresh } = usePullsContext();
  const { owner, repo, number } = useLocalSearchParams<{ owner: string; repo: string; number: string }>();
  const [failedToOpen, setFailedToOpen] = useState(false);
  const now = useNow();
  if (relay.state.status !== 'signedIn') return <Redirect href="/" />;

  const reports = pulls.state?.reports ?? [];
  const report = reports.find((item) => item.repo === `${owner}/${repo}` && String(item.number) === number);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const muted = { color: palette.muted };

  let body;
  if (!report || !pulls.state)
    body = (
      <View style={styles.missing}>
        <Text style={[styles.message, { color: palette.text }]}>
          {owner}/{repo}#{number} is no longer in the list of the relay.
        </Text>
      </View>
    );
  else {
    const state = stateView(report);
    const tone = palette.tones[state.tone];
    const sections = detailSections(report, reports, new Date(pulls.state.at), now);
    const open = () =>
      Linking.openURL(report.url).then(
        () => setFailedToOpen(false),
        () => setFailedToOpen(true),
      );
    body = (
      <>
        <View style={styles.head}>
          <Text style={[styles.state, { color: tone }, state.stale && styles.stale]}>
            {state.spins ? '⟳' : state.mark} {state.label}
            {state.stale ? <Text style={[styles.small, muted]}> stale</Text> : null}
          </Text>
          <Text style={[styles.title, { color: palette.text }]}>{report.title || 'No title'}</Text>
          <Text style={[styles.small, styles.name, { color: palette.text }]}>
            {report.repo}#{report.number}
            {report.base ? <Text style={muted}> → {report.base}</Text> : null}
          </Text>
        </View>
        {sections.map((section) => (
          <View key={section.label} style={[styles.section, { borderColor: palette.border }]}>
            <Text style={[styles.label, muted]}>{section.label}</Text>
            {section.lines.map((line, index) => (
              <LineText key={index} line={line} palette={palette} />
            ))}
          </View>
        ))}
        <View style={styles.actions}>
          <Button label="Open on GitHub" onPress={() => void open()} palette={palette} />
          {failedToOpen ? (
            <Text style={[styles.small, { color: palette.tones.red }]}>The phone could not open {report.url}.</Text>
          ) : null}
        </View>
      </>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.screen, { backgroundColor: palette.background }]}>
      <Pressable accessibilityRole="button" hitSlop={12} onPress={back} style={styles.back}>
        <Text style={[styles.backText, { color: palette.tones.blue }]}>‹ Pull requests</Text>
      </Pressable>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={pulls.refreshing} onRefresh={refresh} tintColor={palette.muted} />}
      >
        {body}
      </ScrollView>
    </SafeAreaView>
  );
}

function LineText({ line, palette }: { line: Line; palette: Palette }) {
  return (
    <Text style={[styles.line, { color: palette.text }]}>
      {line.map((segment, index) => (
        <Text
          key={index}
          style={[
            segment.tone && { color: palette.tones[segment.tone] },
            segment.dim && !segment.tone && { color: palette.muted },
            segment.bold && styles.bold,
          ]}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  back: { paddingHorizontal: 16, paddingVertical: 12, alignSelf: 'flex-start' },
  backText: { fontSize: 17 },
  content: { paddingBottom: 32 },
  head: { paddingHorizontal: 16, paddingBottom: 12, gap: 6 },
  state: { fontSize: 17, fontWeight: '700' },
  stale: { fontWeight: '400', opacity: 0.7 },
  title: { fontSize: 20, fontWeight: '600' },
  name: { fontWeight: '600' },
  small: { fontSize: 13 },
  section: { paddingHorizontal: 16, paddingVertical: 10, gap: 4, borderTopWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  line: { fontSize: 14, lineHeight: 20, fontVariant: ['tabular-nums'] },
  bold: { fontWeight: '700' },
  actions: { alignItems: 'center', gap: 8, paddingTop: 16, paddingHorizontal: 16 },
  missing: { padding: 24 },
  message: { fontSize: 16, textAlign: 'center' },
});
