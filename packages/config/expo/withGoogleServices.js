// The one place an app's Firebase Android config (google-services.json) is wired in. Without it an Android phone gets no
// push address, so push registration is skipped (people still see everything in the in-app notification list).
//
// The file holds a Firebase app key and the repository is public, so it is git-ignored and never committed:
// - on a developer machine it sits in the app folder (apps/<app>/google-services.json);
// - on EAS Build it comes from the project's file environment variable GOOGLE_SERVICES_JSON (see docs/OPERATIONS.md).
// When neither is there (CI bundle exports, a fresh clone), the app builds without it.
const fs = require('node:fs');
const path = require('node:path');

/** @param {import('expo/config').ExpoConfig} config @param {string} appDir the app's folder (__dirname of app.config.js) */
module.exports = function withGoogleServices(config, appDir) {
  const local = path.join(appDir, 'google-services.json');
  const file =
    process.env.GOOGLE_SERVICES_JSON ||
    (fs.existsSync(local) ? './google-services.json' : undefined);
  if (!file) return config;
  return { ...config, android: { ...config.android, googleServicesFile: file } };
};
