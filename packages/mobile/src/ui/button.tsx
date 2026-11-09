import { Pressable, StyleSheet, Text } from 'react-native';
import type { Palette } from './theme';

interface ButtonProps {
  label: string;
  onPress: () => void;
  palette: Palette;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
}

export function Button({ label, onPress, palette, kind = 'primary', disabled = false }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary'
          ? { backgroundColor: palette.accent }
          : { borderColor: palette.border, borderWidth: StyleSheet.hairlineWidth },
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <Text style={[styles.text, { color: kind === 'primary' ? '#ffffff' : palette.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minWidth: 260, minHeight: 48, borderRadius: 10, paddingHorizontal: 20, justifyContent: 'center' },
  text: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
