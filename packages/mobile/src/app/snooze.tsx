import { snoozePresets } from '@sakuga-software/boo-core/quiet';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { phoneZone, untilWords } from '../quiet/quiet';
import { useQuiet } from '../quiet/quiet-context';
import { useSettings } from '../settings/settings-context';
import { BigButton, Card, Label, Toggle } from '../ui/kit';
import { useNow } from '../ui/use-now';
import { usePalette } from '../ui/use-palette';

/**
 * BOO-35: the snooze sheet. One tap on a preset snoozes every phone and closes the sheet. The presets
 * depend on the time and on the work hours (`snoozePresets` of core).
 */
export default function SnoozeSheet() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { remote } = useSettings();
  const quiet = useQuiet();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const now = useNow(15_000);
  const config = remote.status === 'ready' ? remote.config : undefined;
  const presets = snoozePresets(config?.settings.quiet, now, phoneZone());
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const apply = async (until: Date | undefined) => {
    if (!quiet.snooze || busy) return;
    setBusy(true);
    const result = await quiet.snooze(until);
    setBusy(false);
    if (result) setProblem(result);
    else close();
  };

  return (
    <View style={styles.screen}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={close}
        style={[StyleSheet.absoluteFill, { backgroundColor: palette.overlay }]}
      />
      <View
        accessibilityViewIsModal
        style={[styles.sheet, { backgroundColor: palette.background, paddingBottom: Math.max(insets.bottom, 16) + 14 }]}
      >
        <View style={[styles.grabber, { backgroundColor: palette.grabber }]} />
        <ScrollView contentContainerStyle={styles.body} bounces={false}>
          <View style={styles.titles}>
            <Label weight={700} size={20} color={palette.text}>
              {quiet.until ? `Snoozed until ${untilWords(quiet.until, now)}` : 'Snooze notifications'}
            </Label>
            <Label size={14} color={palette.muted} lines={4}>
              On all your phones. boo keeps watching and sends one recap when the snooze ends.
            </Label>
          </View>
          <View style={styles.grid}>
            {presets.map((preset) => (
              <Pressable
                key={preset.label}
                accessibilityRole="button"
                accessibilityLabel={`Snooze ${preset.label.toLowerCase()}, ${preset.detail}`}
                disabled={!quiet.snooze || busy}
                onPress={() => void apply(preset.until)}
                style={({ pressed }) => [
                  styles.chip,
                  { backgroundColor: palette.surface, boxShadow: palette.cardShadow },
                  pressed && styles.pressed,
                ]}
              >
                <Label weight={700} size={15} color={palette.text} lines={2}>
                  {preset.label}
                </Label>
                <Label size={12} color={palette.muted} lines={2}>
                  {preset.detail}
                </Label>
              </Pressable>
            ))}
          </View>
          <Card palette={palette}>
            <View style={styles.switchRow}>
              <View style={styles.grow}>
                <Label weight={500} size={14} color={palette.text} lines={2}>
                  Still notify: Ready to merge
                </Label>
                <Label size={13} color={palette.muted} lines={2}>
                  A pull request that can merge does not wait
                </Label>
              </View>
              <Toggle
                palette={palette}
                label="Still notify when a pull request is ready to merge"
                value={quiet.readyThrough}
                disabled={!quiet.setReadyThrough || busy}
                onChange={(on) => void quiet.setReadyThrough?.(on).then(setProblem)}
              />
            </View>
          </Card>
          {quiet.until ? (
            <BigButton
              label="Resume notifications"
              icon="bell"
              onPress={() => void apply(undefined)}
              disabled={busy}
              bg={palette.surface2}
              fg={palette.accentText}
            />
          ) : null}
          {problem ? (
            <Label size={13} color={palette.tones.red} lines={3}>
              {problem}
            </Label>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '90%',
    paddingTop: 6,
    paddingHorizontal: 16,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    boxShadow: '0 -12px 40px rgba(10,6,20,0.3)',
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginBottom: 8 },
  body: { gap: 16, paddingTop: 6 },
  titles: { gap: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexGrow: 1, flexBasis: '45%', minHeight: 60, borderRadius: 14, padding: 12, gap: 2 },
  switchRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  grow: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.6 },
});
