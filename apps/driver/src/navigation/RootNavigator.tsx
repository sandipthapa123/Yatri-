import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';

import { DriverProfileSetupScreen } from '../screens/DriverProfileSetupScreen';
import { OnboardingScreen } from '../screens/onboarding/OnboardingScreen';
import { OtpVerificationScreen } from '../screens/OtpVerificationScreen';
import { PhoneEntryScreen } from '../screens/PhoneEntryScreen';
import { VerificationPendingScreen } from '../screens/VerificationPendingScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';

export type RootStackParamList = {
  Welcome: undefined;
  PhoneEntry: undefined;
  OtpVerification: { phoneNumber: string };
  DriverProfileSetup: undefined;
  Onboarding: undefined;
  VerificationPending: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Same "swap the screen list on auth status" pattern as the passenger app.
 * A returning driver always starts at Onboarding: it fetches live progress
 * from the server and immediately redirects to VerificationPending itself
 * once the application has been submitted, so routing never depends on the
 * AuthContext's `driverStatus` cache (which goes stale after an app restart
 * — it's only refreshed by login or an explicit profile update).
 */
export function RootNavigator() {
  const { status, isNewUser } = useAuth();

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false }}
        initialRouteName={
          status === 'authenticated' ? (isNewUser ? 'DriverProfileSetup' : 'Onboarding') : undefined
        }
      >
        {status === 'authenticated' ? (
          <>
            <Stack.Screen name="Onboarding" component={OnboardingScreen} />
            <Stack.Screen name="VerificationPending" component={VerificationPendingScreen} />
            <Stack.Screen name="DriverProfileSetup" component={DriverProfileSetupScreen} />
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
