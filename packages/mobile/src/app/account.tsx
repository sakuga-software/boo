import { Redirect } from 'expo-router';

// The account lives in the settings now. An older link to /account opens them.
export default function Account() {
  return <Redirect href="/settings" />;
}
