// app.json holds the app's settings; this adds only what cannot be static (packages/config/expo explains each).
const withGoogleServices = require('../../packages/config/expo/withGoogleServices');

module.exports = ({ config }) => withGoogleServices(config, __dirname);
