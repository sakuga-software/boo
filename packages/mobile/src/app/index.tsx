import { StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// The home screen. The list of the pull requests comes with the relay client.
export default function Home() {
  const dark = useColorScheme() === 'dark';
  const text = dark ? styles.textDark : styles.textLight;

  return (
    <SafeAreaView style={[styles.screen, dark ? styles.screenDark : styles.screenLight]}>
      <View style={styles.body}>
        <Text style={[styles.title, text]}>boo</Text>
        <Text style={[styles.subtitle, text]}>The control tower for the pull requests of your coding agents.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenLight: { backgroundColor: '#ffffff' },
  screenDark: { backgroundColor: '#0d1117' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  title: { fontSize: 48, fontWeight: '700' },
  subtitle: { fontSize: 16, textAlign: 'center', opacity: 0.7 },
  textLight: { color: '#1f2328' },
  textDark: { color: '#e6edf3' },
});
