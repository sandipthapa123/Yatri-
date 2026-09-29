import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';

import { HomeScreen } from '../screens/HomeScreen';
import { OtpVerificationScreen } from '../screens/OtpVerificationScreen';
import { PhoneEntryScreen } from '../screens/PhoneEntryScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { ProfileSetupScreen } from '../screens/ProfileSetupScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';

export type RootStackParamList = {
  Welcome: undefined;
  PhoneEntry: undefined;
  OtpVerification: { phoneNumber: string };
  ProfileSetup: undefined;
  Home: undefined;
  Profile: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * One stack, two logical phases: unauthenticated screens (Welcome -> phone
 * -> OTP) or authenticated ones (optional profile setup -> Home). Swapping
 * the screen list on `status` — rather than nesting separate navigators —
 * is React Navigation's documented pattern for auth flows, and it means a
 * successful verify-otp naturally lands on the right screen with no manual
 * `navigate()` call.
 */
export function RootNavigator() {
  const { status, isNewUser } = useAuth();

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false }}
        initialRouteName={status === 'authenticated' && isNewUser ? 'ProfileSetup' : undefined}
      >
        {status === 'authenticated' ? (
          <>
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="ProfileSetup" component={ProfileSetupScreen} />
            <Stack.Screen name="Profile" component={ProfileScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="PhoneEntry" component={PhoneEntryScreen} />
            <Stack.Screen name="OtpVerification" component={OtpVerificationScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
