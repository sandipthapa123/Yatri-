import { registerRootComponent } from 'expo';

import App from './src/App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App),
// and sets up the environment correctly whether loaded from Expo Go, a
// development build, or a production build.
registerRootComponent(App);
