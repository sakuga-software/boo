// app.json holds the config. Variables of the environment change where the app signs in, for a local
// relay: BOO_RELAY_URL (the relay), BOO_GITHUB_URL (a fake GitHub, for a demo only) and
// BOO_EXPO_PUSH_URL (a fake Expo service that gives the push token, for a demo only).
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    ...(process.env.BOO_RELAY_URL && { relayUrl: process.env.BOO_RELAY_URL }),
    ...(process.env.BOO_GITHUB_URL && { githubUrl: process.env.BOO_GITHUB_URL }),
    ...(process.env.BOO_EXPO_PUSH_URL && { expoPushUrl: process.env.BOO_EXPO_PUSH_URL }),
  },
});
