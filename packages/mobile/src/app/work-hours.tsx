import type { WorkHours } from '@sakuga-software/boo-core/quiet';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_WORK_HOURS, phoneZone, shiftHour, withWorkHours } from '../quiet/quiet';
import { useSettings } from '../settings/settings-context';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { Card, divider, Label, Toggle } from '../ui/kit';
import type { Palette } from '../ui/theme';
import { usePalette } from '../ui/use-palette';

// Monday first, as a week of work reads.
const WEEK = [
  { day: 1, label: 'M', name: 'Monday' },
  { day: 2, label: 'T', name: 'Tuesday' },
  { day: 3, label: 'W', name: 'Wednesday' },
  { day: 4, label: 'T', name: 'Thursday' },
  { day: 5, label: 'F', name: 'Friday' },
  { day: 6, label: 'S', name: 'Saturday' },
  { day: 0, label: 'S', name: 'Sunday' },
];

function Stepper({
  palette,
  label,
  value,
  onChange,
  index,
}: {
  palette: Palette;
  label: string;
  value: string;
  onChange: (value: string) => void;
  index: number;
}) {
  const step = (minutes: number, icon: 'chevronLeft' | 'chevronRight', words: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} ${words}`}
      onPress={() => onChange(shiftHour(value, minutes))}
      style={({ pressed }) => [styles.step, { backgroundColor: palette.surface2 }, pressed && styles.pressed]}
    >
      <Icon name={icon} size={16} color={palette.accentText} strokeWidth={2.4} />
    </Pressable>
  );
  return (
    <View style={[styles.row, divider(palette, index)]}>
      <Label size={15} color={palette.text} style={styles.grow}>
        {label}
      </Label>
      {step(-30, 'chevronLeft', '30 minutes earlier')}
      <Label weight={700} size={17} color={palette.text} style={styles.hour} accessibilityLabel={`${label} ${value}`}>
        {value}
      </Label>
      {step(30, 'chevronRight', '30 minutes later')}
    </View>
  );
}

/** BOO-35: the work hours. Outside them the relay holds the pushes, and their end sends the recap of the day. */
export default function WorkHoursScreen() {
  const palette = usePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { remote, save } = useSettings();
  const stored = remote.status === 'ready' ? remote.config.settings.quiet?.workHours : undefined;
  const [draft, setDraft] = useState<WorkHours | null>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const hours = draft === undefined ? stored : (draft ?? undefined);
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/settings'));
  const edit = (patch: Partial<WorkHours>) =>
    setDraft({ ...(hours ?? DEFAULT_WORK_HOURS()), ...patch, timeZone: phoneZone() });

  const submit = async () => {
    if (remote.status !== 'ready') return;
    if (hours && hours.start >= hours.end) return setProblem('The end must come after the start.');
    if (hours && hours.days.length === 0) return setProblem('Choose one day or more.');
    setBusy(true);
    const failed = await save(withWorkHours(remote.config, hours));
    setBusy(false);
    if (failed) return setProblem(failed);
    leave();
  };

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <Pressable accessibilityRole="button" onPress={leave} hitSlop={8} style={styles.back}>
          <Icon name="chevronLeft" size={20} color={palette.accent} />
          <Label size={16} color={palette.accent}>
            Settings
          </Label>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Label weight={700} size={22} color={palette.text} style={styles.title}>
          Work hours
        </Label>
        {remote.status !== 'ready' ? (
          <Label size={15} color={palette.muted} lines={3}>
            Read the settings first: open the Settings tab again.
          </Label>
        ) : (
          <>
            <Card palette={palette}>
              <Pressable
                accessibilityRole="switch"
                accessibilityLabel="Hold pushes outside work hours"
                accessibilityState={{ checked: hours !== undefined }}
                onPress={() => setDraft(hours ? null : (stored ?? DEFAULT_WORK_HOURS()))}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <Label size={15} color={palette.text} style={styles.grow}>
                  Hold pushes outside work hours
                </Label>
                <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                  <Toggle palette={palette} label="" value={hours !== undefined} onChange={() => {}} />
                </View>
              </Pressable>
            </Card>
            {hours ? (
              <>
                <View style={styles.days} accessibilityLabel="Work days">
                  {WEEK.map(({ day, label, name }) => {
                    const on = hours.days.includes(day);
                    return (
                      <Pressable
                        key={day}
                        accessibilityRole="checkbox"
                        accessibilityLabel={name}
                        accessibilityState={{ checked: on }}
                        onPress={() =>
                          edit({ days: on ? hours.days.filter((other) => other !== day) : [...hours.days, day].sort() })
                        }
                        style={({ pressed }) => [
                          styles.day,
                          { backgroundColor: on ? palette.accent : palette.surface, boxShadow: palette.cardShadow },
                          pressed && styles.pressed,
                        ]}
                      >
                        <Label weight={700} size={15} color={on ? palette.onAccent : palette.muted}>
                          {label}
                        </Label>
                      </Pressable>
                    );
                  })}
                </View>
                <Card palette={palette}>
                  <Stepper
                    palette={palette}
                    index={0}
                    label="Start"
                    value={hours.start}
                    onChange={(start) => edit({ start })}
                  />
                  <Stepper
                    palette={palette}
                    index={1}
                    label="End"
                    value={hours.end}
                    onChange={(end) => edit({ end })}
                  />
                </Card>
                <Label size={13} color={palette.muted} lines={4}>
                  {`At ${hours.end}, boo sends the recap of the day. Outside these hours it holds pushes, and sends what happened when the next work day starts. Time zone: ${hours.timeZone}.`}
                </Label>
              </>
            ) : (
              <Label size={13} color={palette.muted} lines={3}>
                Off: every push goes out at once, and there is no recap of the day.
              </Label>
            )}
            {problem ? (
              <Label size={14} color={palette.tones.red} lines={3}>
                {problem}
              </Label>
            ) : null}
            <Button
              label={busy ? 'Saving…' : 'Save'}
              onPress={() => void submit()}
              palette={palette}
              disabled={busy || draft === undefined}
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 8 },
  back: {
    height: 44,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'flex-start',
  },
  content: { paddingHorizontal: 16, paddingBottom: 40, gap: 12 },
  title: { letterSpacing: -0.44, marginBottom: 4 },
  row: { minHeight: 52, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  days: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  day: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  step: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  hour: { minWidth: 56, textAlign: 'center' },
  grow: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.6 },
});
