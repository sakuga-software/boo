// app.json holds the config. Two variables of the environment change where the app signs in, for a
// local relay: BOO_RELAY_URL (the relay) and BOO_GITHUB_URL (a fake GitHub, for a demo only).
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    ...(process.env.BOO_RELAY_URL && { relayUrl: process.env.BOO_RELAY_URL }),
    ...(process.env.BOO_GITHUB_URL && { githubUrl: process.env.BOO_GITHUB_URL }),
  },
});
